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
