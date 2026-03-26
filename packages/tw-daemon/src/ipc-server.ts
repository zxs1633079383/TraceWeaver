// packages/tw-daemon/src/ipc-server.ts
import { createServer, type Server, type Socket } from 'node:net'
import { rm } from 'node:fs/promises'
import type { TwRequest, TwResponse } from '@traceweaver/types'
import type { CommandHandler } from './core/command-handler.js'
import type { InboxAdapter } from './notify/inbox.js'
import type { EventLog } from './log/event-log.js'
import type { SpanMetrics } from './metrics/span-metrics.js'
import type { TraceQueryEngine } from './otel/trace-query.js'
import type { ReportGenerator } from './report/report-generator.js'

export interface IpcServerOptions {
  inbox?: InboxAdapter
  eventLog?: EventLog
  spanMetrics?: SpanMetrics
  traceQuery?: TraceQueryEngine
  reportGenerator?: ReportGenerator
}

export class IpcServer {
  private server: Server | null = null
  private readonly inbox?: InboxAdapter
  private readonly eventLog?: EventLog
  private readonly spanMetrics?: SpanMetrics
  private readonly traceQuery?: TraceQueryEngine
  private readonly reportGenerator?: ReportGenerator

  constructor(
    private readonly socketPath: string,
    private readonly handler: CommandHandler,
    private readonly onActivity?: () => void,
    opts?: IpcServerOptions,
  ) {
    this.inbox = opts?.inbox
    this.eventLog = opts?.eventLog
    this.spanMetrics = opts?.spanMetrics
    this.traceQuery = opts?.traceQuery
    this.reportGenerator = opts?.reportGenerator
  }

  async start(): Promise<void> {
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
        if (!this.inbox) throw Object.assign(new Error('Inbox not available'), { code: 'NOT_AVAILABLE' })
        data = await this.inbox.list({ unackedOnly: !!(params as any).unackedOnly })
      } else if (method === 'inbox_ack') {
        if (!this.inbox) throw Object.assign(new Error('Inbox not available'), { code: 'NOT_AVAILABLE' })
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
      } else if (method === 'emit_event') {
        if (typeof (params as any).entity_id !== 'string') {
          throw Object.assign(new Error('Missing required param: entity_id'), { code: 'INVALID_PARAMS' })
        }
        data = await this.handler.emitEvent(params as any)
      } else if (method === 'cascade_update') {
        if (typeof (params as any).id !== 'string') {
          throw Object.assign(new Error('Missing required param: id'), { code: 'INVALID_PARAMS' })
        }
        const { id, attributes, cascade } = params as { id: string; attributes: Record<string, unknown>; cascade: boolean }
        const result = await this.handler.cascadeUpdate({ id, attributes: attributes ?? {}, cascade: cascade ?? false })
        if (!result.ok) throw Object.assign(new Error(result.error!.message), { code: result.error!.code })
        data = result.data
      } else if (method === 'trace_spans') {
        if (!this.traceQuery) throw Object.assign(new Error('TraceQueryEngine not available'), { code: 'NOT_AVAILABLE' })
        const { trace_id, entity_id } = params as { trace_id?: string; entity_id?: string }
        const resolvedId = trace_id ?? (entity_id ? this.traceQuery.findTraceId(entity_id) : undefined)
        if (!resolvedId) throw Object.assign(new Error('trace_not_found'), { code: 'NOT_FOUND' })
        const tree = this.traceQuery.buildSpanTree(resolvedId)
        if (!tree) throw Object.assign(new Error('trace_not_found'), { code: 'NOT_FOUND' })
        data = { trace_id: resolvedId, tree }
      } else if (method === 'trace_info') {
        if (!this.traceQuery) throw Object.assign(new Error('TraceQueryEngine not available'), { code: 'NOT_AVAILABLE' })
        const { trace_id, entity_id } = params as { trace_id?: string; entity_id?: string }
        const resolvedId = trace_id ?? (entity_id ? this.traceQuery.findTraceId(entity_id) : undefined)
        if (!resolvedId) throw Object.assign(new Error('trace_not_found'), { code: 'NOT_FOUND' })
        const info = this.traceQuery.buildTraceInfo(resolvedId)
        if (!info) throw Object.assign(new Error('trace_not_found'), { code: 'NOT_FOUND' })
        data = info
      } else if (method === 'report_generate') {
        if (!this.reportGenerator) throw Object.assign(new Error('ReportGenerator not available'), { code: 'NOT_AVAILABLE' })
        const { trace_id, all } = params as { trace_id?: string; all?: boolean }
        const paths = await this.reportGenerator.generate({ traceId: trace_id, all })
        data = { paths }
      } else if (method === 'report_list') {
        if (!this.reportGenerator) throw Object.assign(new Error('ReportGenerator not available'), { code: 'NOT_AVAILABLE' })
        const { date } = params as { date?: string }
        const reports = await this.reportGenerator.listReports(date)
        data = { reports }
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
