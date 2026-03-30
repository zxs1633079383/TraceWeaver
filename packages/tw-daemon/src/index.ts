// packages/tw-daemon/src/index.ts
import { join } from 'node:path'
import { writeFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import chokidar from 'chokidar'
import { IpcServer } from './ipc-server.js'
import { CommandHandler } from './core/command-handler.js'
import { EventBus } from './core/event-bus/event-bus.js'
import { SpanManager } from './otel/span-manager.js'
import { NotifyEngine } from './notify/engine.js'
import { InboxAdapter } from './notify/inbox.js'
import { FsWatcher } from './watcher/fs-watcher.js'
import { EventLog } from './log/event-log.js'
import { SpanMetrics } from './metrics/span-metrics.js'
import { loadConfig, resolveWatchDirs } from './config/loader.js'
import { ExporterRegistry } from './otel/exporter-registry.js'
import { ConsoleExporter } from './otel/exporter-console.js'
import { OtlpHttpExporter } from './otel/exporter-http.js'
import { OtlpGrpcExporter } from './otel/exporter-grpc.js'
import type { NotifyRule } from './notify/engine.js'
import { homedir } from 'node:os'
import { TraceQueryEngine } from './otel/trace-query.js'
import { ReportGenerator } from './report/report-generator.js'
import { ReportScheduler } from './report/report-scheduler.js'
import { ErrorBubbler } from './subscribers/error-bubbler.js'
import { ProgressTracker } from './subscribers/progress-tracker.js'
import { UsecaseMutationHandler } from './subscribers/usecase-mutation-handler.js'
import { ConstraintEvaluator } from './constraint/evaluator.js'
import { ConstraintHarness } from './constraint/harness.js'
import type { Entity } from '@traceweaver/types'

const PROJECT_ROOT = process.cwd()
const STORE_DIR    = process.env.TW_STORE ?? join(PROJECT_ROOT, '.traceweaver')
const SOCKET_PATH  = process.env.TW_SOCKET ?? join(STORE_DIR, 'tw.sock')
const PID_FILE     = join(STORE_DIR, 'daemon.pid')
const IDLE_MS     = 30 * 60 * 1000

let lastActivity = Date.now()

async function main() {
  // Load project config (.traceweaver/config.yaml) — all fields optional
  const config = loadConfig(STORE_DIR)

  const eventBus = new EventBus()
  eventBus.start()

  const eventLog = new EventLog(join(STORE_DIR, 'events.ndjson'))
  eventLog.load()

  const exporterRegistry = new ExporterRegistry()
  const exporterType = process.env.TW_OTEL_EXPORTER ?? config.otel?.exporter ?? 'console'
  const exporterEndpoint = process.env.TW_OTEL_ENDPOINT ?? config.otel?.endpoint ?? 'localhost:4317'

  if (exporterType === 'console') {
    exporterRegistry.register(new ConsoleExporter())
  } else if (exporterType === 'otlp-http') {
    exporterRegistry.register(new OtlpHttpExporter({ endpoint: exporterEndpoint }))
  } else if (exporterType === 'otlp-grpc') {
    exporterRegistry.register(new OtlpGrpcExporter({ endpoint: exporterEndpoint }))
  }

  const spanManager = new SpanManager({ projectId: 'default', exporterRegistry })
  const spanMetrics = new SpanMetrics(spanManager)

  const constraintEvaluator = new ConstraintEvaluator({
    enabled: true,
    model: 'claude-opus-4-6',
  })

  const constraintHarness = new ConstraintHarness({
    evaluator: constraintEvaluator,
    spanManager,
    eventBus,
    timeoutMs: 30_000,
  })

  const handler = new CommandHandler({ storeDir: STORE_DIR, eventBus, spanManager, eventLog })
  await handler.init()

  // ── Subscribers ─────────────────────────────────────────────────────────
  const errorBubbler = new ErrorBubbler({
    spanManager,
    getEntity: (id: string) => handler.getEntityById(id),
    updateAttributes: (id: string, attrs: Record<string, unknown>) => {
      void handler.updateAttributes({ id, attributes: attrs })
    },
  })
  eventBus.subscribe(event => errorBubbler.handle(event))

  const progressTracker = new ProgressTracker({
    getEntity: (id: string) => handler.getEntityById(id),
    getChildrenOf: (parentId: string) => handler.getAllEntities().filter(e => e.parent_id === parentId),
    updateAttributes: (id: string, attrs: Record<string, unknown>) => {
      void handler.updateAttributes({ id, attributes: attrs })
    },
  })
  eventBus.subscribe(event => progressTracker.handle(event))

  const usecaseMutationHandler = new UsecaseMutationHandler({
    getEntity: (id: string) => handler.getEntityById(id),
    getDescendants: (id: string) => {
      const result: Entity[] = []
      const collect = (parentId: string) => {
        const children = handler.getAllEntities().filter(e => e.parent_id === parentId)
        for (const child of children) {
          result.push(child)
          collect(child.id)
        }
      }
      collect(id)
      return result
    },
    updateState: (id: string, state: string, reason: string) => {
      void handler.updateState({ id, state: state as any, reason })
    },
    spanAddEvent: (entityId: string, name: string, attrs: Record<string, unknown>) => {
      spanManager.addEvent(entityId, name, attrs)
    },
  })
  eventBus.subscribe(event => usecaseMutationHandler.handle(event))

  const traceQuery = new TraceQueryEngine({
    spanManager,
    getAllEntities: () => handler.getAllEntities(),
    getEntity: (id: string) => handler.getEntityById(id),
  })

  const reportOutputDir = config?.report?.output_dir ?? join(homedir(), '.traceweaver', 'reports')
  const reportGenerator = new ReportGenerator({
    traceQuery,
    eventLog,
    outputDir: reportOutputDir,
  })

  let reportScheduler: ReportScheduler | null = null
  if (config?.report?.schedule) {
    reportScheduler = new ReportScheduler({
      scheduleTime: config.report.schedule,
      generate: async () => {
        const today = new Date().toISOString().slice(0, 10)
        await reportGenerator.generate({ all: true, date: today })
      },
      hasReportTodayInEventLog: async () => {
        const today = new Date().toISOString().slice(0, 10)
        const events = eventLog.query({
          event_type: 'report.generated',
          since: new Date(today).toISOString(),
        })
        return events.length > 0
      },
    })
    reportScheduler.start()
  }

  const inbox = new InboxAdapter(join(STORE_DIR, 'inbox'))
  const defaultRules: NotifyRule[] = [
    { event: 'entity.state_changed', state: 'rejected' },
    { event: 'entity.state_changed', state: 'completed' },
  ]
  const configRules = config.notify?.rules as NotifyRule[] | undefined
  const notifyEngine = new NotifyEngine(eventBus, {
    inbox,
    rules: configRules ?? defaultRules,
  })
  notifyEngine.start()

  // Watch project files (NOT the store dir).
  const watchDirs = resolveWatchDirs(config, PROJECT_ROOT, STORE_DIR)
  const fsWatcher = new FsWatcher(watchDirs, eventBus, {
    extraIgnored: config.watch?.ignored,
  })
  await fsWatcher.start()

  // ── file.changed → ImpactResolver → artifact.modified ──────────────────
  eventBus.subscribe(event => {
    if (event.type !== 'file.changed') return
    const filePath = event.attributes?.path as string | undefined
    if (!filePath) return

    const impact = handler.resolveImpact(filePath)
    const directly   = impact.directly_affected
    const transitively = impact.transitively_affected
    if (directly.length + transitively.length === 0) return

    for (const entity of directly) {
      eventBus.publish({
        id: randomUUID(),
        type: 'artifact.modified',
        entity_id: entity.id,
        entity_type: entity.entity_type,
        ts: new Date().toISOString(),
        attributes: { trigger_file: filePath, impact_type: 'direct' },
      })
      spanManager.addEvent(entity.id, 'artifact.modified', {
        'tw.file.path': filePath,
        'tw.impact.type': 'direct',
      })
    }
    for (const entity of transitively) {
      eventBus.publish({
        id: randomUUID(),
        type: 'artifact.modified',
        entity_id: entity.id,
        entity_type: entity.entity_type,
        ts: new Date().toISOString(),
        attributes: { trigger_file: filePath, impact_type: 'transitive' },
      })
      spanManager.addEvent(entity.id, 'artifact.modified', {
        'tw.file.path': filePath,
        'tw.impact.type': 'transitive',
      })
    }
  })

  // Conditional MCP startup
  if (process.env.TW_MCP_STDIO) {
    const { McpServer } = await import('./mcp/server.js')
    const mcp = new McpServer(handler)
    await mcp.startStdio()
  }

  // Conditional HTTP startup
  if (process.env.TW_HTTP_PORT) {
    const port = parseInt(process.env.TW_HTTP_PORT, 10)
    const { buildHttpServer } = await import('./http/server.js')
    const httpServer = buildHttpServer(handler, {
      inboundToken: process.env.TW_INBOUND_TOKEN,
    })
    await httpServer.listen({ port, host: '127.0.0.1' })
    console.error(`[tw-daemon] HTTP API listening on port ${port}`)
  }

  const server = new IpcServer(SOCKET_PATH, handler, () => { lastActivity = Date.now() }, {
    inbox,
    eventLog,
    spanMetrics,
    traceQuery,
    reportGenerator,
    constraintHarness,
  })
  await server.start()

  await writeFile(PID_FILE, String(process.pid), 'utf8')

  console.log(`tw-daemon started. socket=${SOCKET_PATH} pid=${process.pid}`)

  // Idle watchdog
  const watchdog = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_MS) {
      console.log('tw-daemon idle timeout — shutting down')
      cleanup(server, eventBus).catch(console.error)
    }
  }, 60_000)
  watchdog.unref()

  process.on('SIGTERM', () => cleanup(server, eventBus).catch(console.error))
  process.on('SIGINT',  () => cleanup(server, eventBus).catch(console.error))

  async function cleanup(s: IpcServer, eb: EventBus) {
    clearInterval(watchdog)
    reportScheduler?.stop()
    notifyEngine.stop()
    await fsWatcher.stop()
    eb.stop()
    await s.stop()
    await exporterRegistry.shutdown()
    try { await rm(PID_FILE) } catch {}
    process.exit(0)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
