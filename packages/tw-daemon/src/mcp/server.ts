// packages/tw-daemon/src/mcp/server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { CommandHandler } from '../core/command-handler.js'

// Simple response envelope for MCP tool calls (no request_id needed)
type ToolOk<T> = { ok: true; data: T }
type ToolErr = { ok: false; error: { code: string; message: string } }
type ToolResult<T = unknown> = ToolOk<T> | ToolErr

function ok<T>(data: T): ToolOk<T> {
  return { ok: true, data }
}

function err(code: string, message: string): ToolErr {
  return { ok: false, error: { code, message } }
}

// ---------------------------------------------------------------------------
// Duration string helpers
// ---------------------------------------------------------------------------
const DURATION_RE = /^(\d+)(m|h|d)$/

function parseDurationToMs(since: string): number | null {
  const match = DURATION_RE.exec(since)
  if (!match) return null
  const value = Number(match[1])
  const unit = match[2]
  const multipliers: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }
  return value * multipliers[unit]
}

// ---------------------------------------------------------------------------
// Jaeger trace query
// ---------------------------------------------------------------------------
interface JaegerSpan {
  operationName: string
  duration: number
  tags?: Array<{ key: string; value: unknown }>
}

interface JaegerTrace {
  traceID: string
  spans: JaegerSpan[]
}

async function queryJaegerTraces(params: Record<string, unknown>): Promise<ToolResult> {
  const jaegerUrl = process.env.TW_JAEGER_URL ?? 'http://localhost:16686'
  const service = params.service as string | undefined
  if (!service) return err('MISSING_PARAM', 'service is required')

  const operation = params.operation as string | undefined
  const since = (params.since as string) ?? '5m'
  const limit = (params.limit as number) ?? 10
  const tags = params.tags as string | undefined

  const durationMs = parseDurationToMs(since)
  if (durationMs === null) return err('INVALID_PARAM', `Invalid since format: ${since}. Use e.g. "5m", "1h", "24h"`)

  const now = Date.now()
  const startMicros = (now - durationMs) * 1000
  const endMicros = now * 1000

  const url = new URL(`${jaegerUrl}/api/traces`)
  url.searchParams.set('service', service)
  url.searchParams.set('start', String(startMicros))
  url.searchParams.set('end', String(endMicros))
  url.searchParams.set('limit', String(limit))
  if (operation) url.searchParams.set('operation', operation)
  if (tags) url.searchParams.set('tags', JSON.stringify(Object.fromEntries([tags.split('=', 2) as [string, string]])))

  try {
    const resp = await fetch(url.toString())
    if (!resp.ok) return err('JAEGER_ERROR', `Jaeger returned HTTP ${resp.status}: ${await resp.text()}`)

    const body = (await resp.json()) as { data: JaegerTrace[] }
    const traces = (body.data ?? []).map((t) => {
      const durations = t.spans.map((s) => s.duration)
      const totalDuration = durations.length > 0 ? Math.max(...durations) : 0
      const hasError = t.spans.some((s) =>
        (s.tags ?? []).some((tag) => tag.key === 'error' && tag.value === true)
      )
      return {
        trace_id: t.traceID,
        span_count: t.spans.length,
        total_duration_us: totalDuration,
        has_error: hasError,
        spans: t.spans.map((s) => ({
          operation: s.operationName,
          duration_us: s.duration,
        })),
      }
    })
    return ok(traces)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return err('JAEGER_CONNECT_ERROR', `Failed to connect to Jaeger at ${jaegerUrl}: ${msg}`)
  }
}

// ---------------------------------------------------------------------------
// Prometheus instant query
// ---------------------------------------------------------------------------
async function queryPrometheusMetrics(params: Record<string, unknown>): Promise<ToolResult> {
  const promUrl = process.env.TW_PROMETHEUS_URL ?? 'http://localhost:9090'
  const query = params.query as string | undefined
  if (!query) return err('MISSING_PARAM', 'query is required')

  const time = params.time as string | undefined
  const unixTime = time ? Math.floor(new Date(time).getTime() / 1000) : Math.floor(Date.now() / 1000)

  if (time && Number.isNaN(unixTime)) return err('INVALID_PARAM', `Invalid time format: ${time}. Use ISO8601.`)

  const url = new URL(`${promUrl}/api/v1/query`)
  url.searchParams.set('query', query)
  url.searchParams.set('time', String(unixTime))

  try {
    const resp = await fetch(url.toString())
    if (!resp.ok) return err('PROMETHEUS_ERROR', `Prometheus returned HTTP ${resp.status}: ${await resp.text()}`)

    const body = (await resp.json()) as {
      status: string
      data: { resultType: string; result: unknown[] }
    }
    if (body.status !== 'success') return err('PROMETHEUS_ERROR', `Prometheus query failed: ${JSON.stringify(body)}`)

    return ok({
      result_type: body.data.resultType,
      results: body.data.result,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return err('PROMETHEUS_CONNECT_ERROR', `Failed to connect to Prometheus at ${promUrl}: ${msg}`)
  }
}

const TOOLS = [
  {
    name: 'tw_register',
    description: 'Register a UseCase, Plan, or Task entity with TraceWeaver',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_type: { type: 'string', enum: ['usecase', 'plan', 'task'] },
        id: { type: 'string' },
        parent_id: { type: 'string' },
        domain: { type: 'string' },
        depends_on: { type: 'array', items: { type: 'string' } },
        artifact_refs: { type: 'array' },
        attributes: { type: 'object' },
      },
      required: ['entity_type', 'id']
    }
  },
  {
    name: 'tw_update_state',
    description: 'Transition entity to a new state (enforces state machine guards)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' },
        state: { type: 'string', enum: ['in_progress', 'review', 'completed', 'rejected'] },
        reason: { type: 'string' },
      },
      required: ['id', 'state']
    }
  },
  {
    name: 'tw_update_attributes',
    description: 'Merge additional attributes into an entity (non-destructive)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' },
        attributes: { type: 'object' },
      },
      required: ['id', 'attributes']
    }
  },
  {
    name: 'tw_remove',
    description: 'Remove an entity from TraceWeaver',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  },
  {
    name: 'tw_get_context',
    description: 'Get full context for an entity: state, constraints, dependencies, artifacts',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' },
        depth: { type: 'number' },
      },
      required: ['id']
    }
  },
  {
    name: 'tw_get_status',
    description: 'Get project-level or entity-level status summary',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' },
        format: { type: 'string', enum: ['summary', 'tree', 'dag'] },
      }
    }
  },
  {
    name: 'tw_get_dag',
    description: 'Get DAG nodes and edges for dependency visualization',
    inputSchema: {
      type: 'object' as const,
      properties: { root_id: { type: 'string' } }
    }
  },
  {
    name: 'tw_link_artifact',
    description: 'Link an artifact (PRD, design, code, test) to an entity',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_id: { type: 'string' },
        artifact: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            path: { type: 'string' },
            section: { type: 'string' },
          },
          required: ['type', 'path']
        }
      },
      required: ['entity_id', 'artifact']
    }
  },
  {
    name: 'tw_emit_event',
    description: 'Emit a custom event for an entity (recorded in OTel span)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_id: { type: 'string' },
        event: { type: 'string' },
        attributes: { type: 'object' },
      },
      required: ['entity_id', 'event']
    }
  },
  {
    name: 'tw_query_events',
    description: 'Query event history for an entity or globally',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_id: { type: 'string' },
        event_type: { type: 'string' },
        since: { type: 'string' },
        limit: { type: 'number' },
      }
    }
  },
  {
    name: 'tw_query_traces',
    description: 'Query Jaeger traces for a service. Returns simplified trace summaries with span details. Configure Jaeger URL via TW_JAEGER_URL env var (default: http://localhost:16686).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        service: { type: 'string', description: 'Service name to query traces for' },
        operation: { type: 'string', description: 'Operation name filter (optional)' },
        since: { type: 'string', description: 'Time range, e.g. "5m", "1h", "24h" (default: "5m")' },
        limit: { type: 'number', description: 'Max number of traces to return (default: 10)' },
        tags: { type: 'string', description: 'Tag filter in "key=value" format (optional)' },
      },
      required: ['service']
    }
  },
  {
    name: 'tw_query_metrics',
    description: 'Query Prometheus metrics using PromQL. Returns instant query results. Configure Prometheus URL via TW_PROMETHEUS_URL env var (default: http://localhost:9090).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'PromQL expression' },
        time: { type: 'string', description: 'Query time in ISO8601 format (default: now)' },
      },
      required: ['query']
    }
  },
]

export class McpServer {
  private readonly server: Server

  constructor(private readonly handler: CommandHandler) {
    this.server = new Server(
      { name: 'traceweaver', version: '0.2.0' },
      { capabilities: { tools: {} } }
    )
    this.registerHandlers()
  }

  private registerHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS
    }))

    this.server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const result = await this.callTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        isError: !result.ok,
      }
    })
  }

  async callTool(name: string, params: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (name) {
        case 'tw_register': {
          const entity = await this.handler.register(params as any)
          return ok(entity)
        }

        case 'tw_update_state': {
          const entity = await this.handler.updateState(params as any)
          return ok({ current_state: entity.state, id: entity.id, entity_type: entity.entity_type })
        }

        case 'tw_update_attributes': {
          const entity = await this.handler.updateAttributes(params as any)
          return ok(entity)
        }

        case 'tw_remove': {
          await this.handler.remove(params.id as string)
          return ok({ id: params.id, removed: true })
        }

        case 'tw_get_context':
          // handler.get() already returns { ok, data } or { ok, error }
          return this.handler.get({ id: params.id as string }) as Promise<ToolResult>

        case 'tw_get_status': {
          const raw = await this.handler.getStatus(params as any)
          // Map `total` → `total_entities` for project-level status
          if ('total' in raw && !('entity' in raw)) {
            return ok({
              total_entities: raw.total,
              done: raw.done,
              percent: raw.percent,
            })
          }
          // Entity-level status: wrap in ok
          return ok(raw)
        }

        case 'tw_get_dag': {
          const dag = this.handler.getDagSnapshot()
          return ok(dag)
        }

        case 'tw_link_artifact':
          return this.handler.linkArtifact(params as any)

        case 'tw_emit_event':
          return this.handler.emitEvent(params as any)

        case 'tw_query_events':
          return this.handler.queryEvents(params as any)

        case 'tw_query_traces':
          return queryJaegerTraces(params)

        case 'tw_query_metrics':
          return queryPrometheusMetrics(params)

        default:
          return err('UNKNOWN_TOOL', `Unknown tool: ${name}`)
      }
    } catch (e: unknown) {
      const error = e as { code?: string; message?: string }
      return err(
        error.code ?? 'TOOL_ERROR',
        error.message ?? 'An unexpected error occurred'
      )
    }
  }

  async startStdio(): Promise<void> {
    const transport = new StdioServerTransport()
    await this.server.connect(transport)
  }
}
