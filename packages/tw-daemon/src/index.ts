// packages/tw-daemon/src/index.ts
import { join } from 'node:path'
import { writeFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { IpcServer } from './ipc-server.js'
import { CommandHandler } from './core/command-handler.js'
import { EventBus } from './core/event-bus/event-bus.js'
import { SpanManager } from './otel/span-manager.js'
import { NotifyEngine } from './notify/engine.js'
import { InboxAdapter } from './notify/inbox.js'
import { FsWatcher } from './watcher/fs-watcher.js'
import { EventLog } from './log/event-log.js'
import { SpanMetrics } from './metrics/span-metrics.js'
import { HarnessLoader } from './harness/loader.js'
import { TriggerExecutor } from './trigger/executor.js'
import { ConstraintEvaluator } from './constraint/evaluator.js'
import { loadConfig, resolveWatchDirs } from './config/loader.js'
import type { NotifyRule } from './notify/engine.js'

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

  const spanManager = new SpanManager({ projectId: 'default' })
  const spanMetrics = new SpanMetrics(spanManager)

  const handler = new CommandHandler({ storeDir: STORE_DIR, eventBus, spanManager, eventLog })
  await handler.init()

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
  // Dirs come from config.watch.dirs, defaulting to project root.
  const watchDirs = resolveWatchDirs(config, PROJECT_ROOT, STORE_DIR)
  const fsWatcher = new FsWatcher(watchDirs, eventBus, {
    extraIgnored: config.watch?.ignored,
  })
  await fsWatcher.start()

  const harnessLoader = new HarnessLoader(join(STORE_DIR, 'harness'))
  await harnessLoader.scan()

  const evaluator = new ConstraintEvaluator({
    enabled: !!process.env.ANTHROPIC_API_KEY,
    apiKey: process.env.ANTHROPIC_API_KEY,
  })
  const triggerExecutor = new TriggerExecutor({ handler, evaluator, harness: harnessLoader, eventBus, inbox })
  triggerExecutor.start()

  // ── file.changed → ImpactResolver → artifact.modified ──────────────────
  // Standard pipeline: FsWatcher emits file.changed (from config.watch.dirs)
  // → ImpactResolver maps file path to directly + transitively affected entities
  // → emit artifact.modified per entity so the rest of the pipeline (NotifyEngine,
  //   TriggerExecutor, EventLog) can react to it through the standard event bus.
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
    }
  })

  // Conditional MCP startup (when spawned by MCP client with TW_MCP_STDIO=1)
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
    harnessLoader,
    triggerExecutor,
  })
  await server.start()

  await writeFile(PID_FILE, String(process.pid), 'utf8')

  console.log(`tw-daemon started. socket=${SOCKET_PATH} pid=${process.pid}`)

  // Idle watchdog: shut down after 30 minutes of inactivity
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
    triggerExecutor.stop()
    notifyEngine.stop()
    await fsWatcher.stop()
    eb.stop()
    await s.stop()
    try { await rm(PID_FILE) } catch {}
    process.exit(0)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
