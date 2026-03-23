// packages/tw-daemon/src/ipc-server.ts
import { createServer, type Server, type Socket } from 'node:net'
import { rm } from 'node:fs/promises'
import type { TwRequest, TwResponse } from '@traceweaver/types'
import type { CommandHandler } from './core/command-handler.js'
import type { InboxAdapter } from './notify/inbox.js'
import type { EventLog } from './log/event-log.js'
import type { SpanMetrics } from './metrics/span-metrics.js'
import type { HarnessLoader } from './harness/loader.js'
import type { TriggerExecutor } from './trigger/executor.js'

export interface IpcServerOptions {
  inbox?: InboxAdapter
  eventLog?: EventLog
  spanMetrics?: SpanMetrics
  harnessLoader?: HarnessLoader
  triggerExecutor?: TriggerExecutor
}

export class IpcServer {
  private server: Server | null = null
  private readonly inbox?: InboxAdapter
  private readonly eventLog?: EventLog
  private readonly spanMetrics?: SpanMetrics
  private readonly harnessLoader?: HarnessLoader
  private readonly triggerExecutor?: TriggerExecutor

  constructor(
    private readonly socketPath: string,
    private readonly handler: CommandHandler,
    private readonly onActivity?: () => void,
    opts?: IpcServerOptions,
  ) {
    this.inbox = opts?.inbox
    this.eventLog = opts?.eventLog
    this.spanMetrics = opts?.spanMetrics
    this.harnessLoader = opts?.harnessLoader
    this.triggerExecutor = opts?.triggerExecutor
  }

  async start(): Promise<void> {
    // Remove stale socket file if present
    try { await rm(this.socketPath) } catch {}
    await new Promise<void>((resolve) => {
      this.server = createServer(socket => this.handleConnection(socket))
      this.server.listen(this.socketPath, resolve)
    })
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) { resolve(); return }
      this.server.close(() => resolve())
    })
    try { await rm(this.socketPath) } catch {}
  }

  private handleConnection(socket: Socket): void {
    let buf = ''
    socket.on('data', (chunk) => {
      void (async () => {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const req = JSON.parse(line) as TwRequest
            const res = await this.dispatch(req)
            socket.write(JSON.stringify(res) + '\n')
          } catch (e) {
            socket.write(JSON.stringify({
              request_id: 'unknown',
              ok: false,
              error: { code: 'PARSE_ERROR', message: String(e) },
            }) + '\n')
          }
        }
      })().catch(() => socket.destroy())
    })
    socket.on('error', () => socket.destroy())
  }

  // NOTE: Full per-method param validation is deferred to Phase 3 when Zod schemas
  // will be added for the MCP/HTTP API layer.
  private async dispatch(req: TwRequest): Promise<TwResponse> {
    const { request_id, method, params } = req
    try {
      let data: unknown
      if (method === 'register') {
        data = await this.handler.register(params as any)
      } else if (method === 'update_state') {
        data = await this.handler.updateState(params as any)
      } else if (method === 'update_attributes') {
        data = await this.handler.updateAttributes(params as any)
      } else if (method === 'remove') {
        if (typeof params.id !== 'string') {
          throw Object.assign(new Error('Missing required param: id'), { code: 'INVALID_PARAMS' })
        }
        await this.handler.remove(params.id)
        data = { id: params.id }
      } else if (method === 'get_status') {
        data = await this.handler.getStatus(params as any)
      } else if (method === 'inbox_list') {
        if (!this.inbox) {
          throw Object.assign(new Error('Inbox not available'), { code: 'NOT_AVAILABLE' })
        }
        data = await this.inbox.list({ unackedOnly: !!(params as any).unackedOnly })
      } else if (method === 'inbox_ack') {
        if (!this.inbox) {
          throw Object.assign(new Error('Inbox not available'), { code: 'NOT_AVAILABLE' })
        }
        if (typeof (params as any).id !== 'string') {
          throw Object.assign(new Error('Missing required param: id'), { code: 'INVALID_PARAMS' })
        }
        await this.inbox.ack((params as any).id)
        data = { id: (params as any).id }
      } else if (method === 'query_events') {
        const result = await this.handler.queryEvents(params as any)
        data = result.data ?? result
      } else if (method === 'get_dag') {
        data = this.handler.getDagSnapshot()
      } else if (method === 'log_query') {
        data = this.eventLog?.query(params as any) ?? []
      } else if (method === 'get_metrics') {
        data = this.spanMetrics?.getSummary() ?? { error: 'SpanMetrics not available' }
      } else if (method === 'resolve_impact') {
        if (typeof (params as any).artifact_path !== 'string') {
          throw Object.assign(new Error('Missing required param: artifact_path'), { code: 'INVALID_PARAMS' })
        }
        const { artifact_path, section } = params as { artifact_path: string; section?: string }
        data = this.handler.resolveImpact(artifact_path, section)
      } else if (method === 'harness_list') {
        data = this.harnessLoader?.list() ?? []
      } else if (method === 'harness_show') {
        if (typeof (params as any).id !== 'string') {
          throw Object.assign(new Error('Missing required param: id'), { code: 'INVALID_PARAMS' })
        }
        const { id } = params as { id: string }
        const entry = this.harnessLoader?.get(id)
        if (!entry) throw Object.assign(new Error(`Harness '${id}' not found`), { code: 'NOT_FOUND' })
        data = entry
      } else if (method === 'harness_run') {
        if (typeof (params as any).entity_id !== 'string' || typeof (params as any).harness_id !== 'string') {
          throw Object.assign(new Error('Missing required params: entity_id, harness_id'), { code: 'INVALID_PARAMS' })
        }
        const { entity_id, harness_id } = params as { entity_id: string; harness_id: string }
        if (!this.harnessLoader || !this.triggerExecutor) {
          throw Object.assign(new Error('Harness not available'), { code: 'NOT_AVAILABLE' })
        }
        const entry = this.harnessLoader.get(harness_id)
        if (!entry) throw Object.assign(new Error(`Harness '${harness_id}' not found`), { code: 'NOT_FOUND' })
        const entityResult = await this.handler.get({ id: entity_id })
        if (!entityResult.ok) throw Object.assign(new Error(entityResult.error.message), { code: entityResult.error.code })
        data = await this.triggerExecutor.runHarness(entityResult.data, entry)
      } else {
        throw Object.assign(new Error(`Unknown method: ${method}`), { code: 'UNKNOWN_METHOD' })
      }
      this.onActivity?.()
      return { request_id, ok: true, data }
    } catch (e: any) {
      return { request_id, ok: false, error: { code: e.code ?? 'ERROR', message: e.message } }
    }
  }
}
