# TraceWeaver Phase 3: Agent Interfaces — MCP Server + HTTP API

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose TraceWeaver's Command Handler through two additional interfaces — a full MCP Server (10 tools for AI agent integration) and a Fastify HTTP API with inbound webhook support — all sharing the same CommandHandler, state machine guards, and event bus.

**Architecture:** Three interfaces (CLI, MCP, HTTP) all funnel through the same CommandHandler. MCP Server uses @modelcontextprotocol/sdk. HTTP Server uses Fastify. Inbound webhook handler validates Bearer token and triggers batch register or state update.

**Tech Stack:** TypeScript 5, @modelcontextprotocol/sdk, fastify, zod (validation), Vitest

**Spec:** `docs/superpowers/specs/2026-03-23-traceweaver-design.md` §6 (MCP Tools + HTTP API)

---

## File Map

```
packages/tw-daemon/
  src/
    mcp/
      server.ts          # MCP Server — registers 10 tools, maps to CommandHandler
      server.test.ts     # in-process MCP tool invocation tests
    http/
      server.ts          # Fastify server — mounts routes, error handler
      routes.ts          # Route handlers — delegates to CommandHandler
      webhook.ts         # Inbound webhook handler (Bearer auth + batch register)
      server.test.ts     # HTTP endpoint tests using fastify inject
    index.ts             # MODIFY: start MCP + HTTP servers alongside IPC
```

## Dependencies to Install

```bash
npm install --workspace=packages/tw-daemon \
  @modelcontextprotocol/sdk \
  fastify \
  zod

npm install --workspace=packages/tw-daemon --save-dev \
  @types/node
```

---

## Task 1: MCP Server

**Files:**
- Create: `packages/tw-daemon/src/mcp/server.ts`
- Create: `packages/tw-daemon/src/mcp/server.test.ts`

- [ ] **Step 1: 安装 MCP 依赖**

```bash
cd /Users/mac28/workspace/frontend/TraceWeaver
npm install --workspace=packages/tw-daemon @modelcontextprotocol/sdk zod
```

- [ ] **Step 2: 编写 MCP Server 测试**

```typescript
// mcp/server.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { McpServer } from './server.js'
import { CommandHandler } from '../core/command-handler.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

async function makeHandler(dir: string) {
  const handler = new CommandHandler({ storeDir: dir })
  await handler.init()
  return handler
}

describe('McpServer tool dispatch', () => {
  let tmpDir: string
  let handler: CommandHandler
  let mcp: McpServer

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'tw-mcp-'))
    handler = await makeHandler(tmpDir)
    mcp = new McpServer(handler)
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('tw_register creates entity', async () => {
    const result = await mcp.callTool('tw_register', {
      entity_type: 'usecase', id: 'UC-001'
    })
    expect(result.ok).toBe(true)
    expect((result.data as any).id).toBe('UC-001')
    expect((result.data as any).state).toBe('pending')
  })

  it('tw_update_state transitions state', async () => {
    await mcp.callTool('tw_register', { entity_type: 'usecase', id: 'UC-001' })
    const result = await mcp.callTool('tw_update_state', { id: 'UC-001', state: 'in_progress' })
    expect(result.ok).toBe(true)
    expect((result.data as any).current_state).toBe('in_progress')
  })

  it('tw_update_state returns error for invalid transition', async () => {
    await mcp.callTool('tw_register', { entity_type: 'usecase', id: 'UC-001' })
    const result = await mcp.callTool('tw_update_state', { id: 'UC-001', state: 'completed' })
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('INVALID_TRANSITION')
  })

  it('tw_get_status returns project overview', async () => {
    const result = await mcp.callTool('tw_get_status', {})
    expect(result.ok).toBe(true)
  })

  it('tw_remove removes entity', async () => {
    await mcp.callTool('tw_register', { entity_type: 'usecase', id: 'UC-001' })
    const result = await mcp.callTool('tw_remove', { id: 'UC-001' })
    expect(result.ok).toBe(true)
  })

  it('unknown tool returns error', async () => {
    const result = await mcp.callTool('tw_unknown', {})
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('UNKNOWN_TOOL')
  })
})
```

- [ ] **Step 3: 实现 McpServer**

```typescript
// mcp/server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { CommandHandler } from '../core/command-handler.js'
import type { TwResponse } from '@traceweaver/types'

const TOOLS = [
  {
    name: 'tw_register',
    description: 'Register a UseCase, Plan, or Task entity with TraceWeaver',
    inputSchema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', enum: ['usecase', 'plan', 'task'] },
        id: { type: 'string' },
        parent_id: { type: 'string' },
        domain: { type: 'string' },
        depends_on: { type: 'array', items: { type: 'string' } },
        artifact_refs: { type: 'array' },
        constraint_refs: { type: 'array', items: { type: 'string' } },
        attributes: { type: 'object' },
      },
      required: ['entity_type', 'id']
    }
  },
  {
    name: 'tw_update_state',
    description: 'Transition entity to a new state (enforces state machine guards)',
    inputSchema: {
      type: 'object',
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
      type: 'object',
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
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  },
  {
    name: 'tw_get_context',
    description: 'Get full context for an entity: state, constraints, dependencies, artifacts, children',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        depth: { type: 'number', description: '0=self only, 1=direct children, -1=all' },
      },
      required: ['id']
    }
  },
  {
    name: 'tw_get_status',
    description: 'Get project-level or entity-level status summary',
    inputSchema: {
      type: 'object',
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
      type: 'object',
      properties: { root_id: { type: 'string' } }
    }
  },
  {
    name: 'tw_link_artifact',
    description: 'Link an artifact (PRD, design, code, test) to an entity',
    inputSchema: {
      type: 'object',
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
      type: 'object',
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
      type: 'object',
      properties: {
        entity_id: { type: 'string' },
        event_type: { type: 'string' },
        since: { type: 'string' },
        limit: { type: 'number' },
      }
    }
  },
] as const

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
      const result = await this.callTool(req.params.name, req.params.arguments ?? {})
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !result.ok,
      }
    })
  }

  async callTool(name: string, params: Record<string, unknown>): Promise<TwResponse<unknown>> {
    switch (name) {
      case 'tw_register':
        return this.handler.register(params as any)

      case 'tw_update_state':
        return this.handler.updateState(params as any)

      case 'tw_update_attributes':
        return this.handler.updateAttributes(params as any)

      case 'tw_remove':
        return this.handler.remove(params as any)

      case 'tw_get_context': {
        const entity = await this.handler.get({ id: params.id as string })
        if (!entity.ok) return entity
        return { ok: true, data: entity.data }
      }

      case 'tw_get_status':
        return this.handler.getStatus(params as any)

      case 'tw_get_dag': {
        const dag = this.handler.getDagSnapshot()
        return { ok: true, data: dag }
      }

      case 'tw_link_artifact':
        return this.handler.linkArtifact(params as any)

      case 'tw_emit_event':
        return this.handler.emitEvent(params as any)

      case 'tw_query_events':
        return this.handler.queryEvents(params as any)

      default:
        return { ok: false, error: { code: 'UNKNOWN_TOOL', message: `Unknown tool: ${name}` } } as any
    }
  }

  async start(transport: 'stdio'): Promise<void> {
    if (transport === 'stdio') {
      const t = new StdioServerTransport()
      await this.server.connect(t)
    }
  }
}
```

- [ ] **Step 4: 在 CommandHandler 添加 MCP 所需方法**

CommandHandler 需要添加：
- `get({ id })` — 返回单个实体
- `getStatus({ id?, format? })` — 返回状态汇总
- `getDagSnapshot()` — 返回 DAG 节点和边
- `linkArtifact({ entity_id, artifact })` — 追加 artifact_ref
- `emitEvent({ entity_id, event, attributes? })` — 追加 OTel 事件
- `queryEvents({ entity_id?, event_type?, since?, limit? })` — 查询事件历史

- [ ] **Step 5: 运行 MCP 测试**

```bash
npm test --workspace=packages/tw-daemon -- --testPathPattern "mcp"
```

Expected: All MCP tests pass

- [ ] **Step 6: Commit**

```bash
git add packages/tw-daemon/src/mcp/
git commit -m "feat(mcp): MCP Server with 10 tools — tw_register, update_state, get_context, emit_event, etc."
```

---

## Task 2: HTTP API (Fastify)

**Files:**
- Create: `packages/tw-daemon/src/http/server.ts`
- Create: `packages/tw-daemon/src/http/routes.ts`
- Create: `packages/tw-daemon/src/http/webhook.ts`
- Create: `packages/tw-daemon/src/http/server.test.ts`

- [ ] **Step 1: 安装 Fastify**

```bash
npm install --workspace=packages/tw-daemon fastify
```

- [ ] **Step 2: 编写 HTTP API 测试**

```typescript
// http/server.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildHttpServer } from './server.js'
import { CommandHandler } from '../core/command-handler.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

async function makeTestServer() {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'tw-http-'))
  const handler = new CommandHandler({ storeDir: tmpDir })
  await handler.init()
  const app = buildHttpServer(handler, { inboundToken: 'test-token' })
  await app.ready()
  return { app, tmpDir }
}

describe('HTTP API', () => {
  let app: Awaited<ReturnType<typeof makeTestServer>>['app']
  let tmpDir: string

  beforeEach(async () => {
    const s = await makeTestServer()
    app = s.app
    tmpDir = s.tmpDir
  })

  afterEach(async () => {
    await app.close()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('POST /api/v1/entities registers entity', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/entities',
      payload: { entity_type: 'usecase', id: 'UC-001' }
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.id).toBe('UC-001')
  })

  it('PATCH /api/v1/entities/:id transitions state', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/entities', payload: { entity_type: 'usecase', id: 'UC-001' } })
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/entities/UC-001',
      payload: { state: 'in_progress' }
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.current_state).toBe('in_progress')
  })

  it('GET /api/v1/entities/:id returns entity', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/entities', payload: { entity_type: 'usecase', id: 'UC-001' } })
    const res = await app.inject({ method: 'GET', url: '/api/v1/entities/UC-001' })
    expect(res.statusCode).toBe(200)
  })

  it('DELETE /api/v1/entities/:id removes entity', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/entities', payload: { entity_type: 'usecase', id: 'UC-001' } })
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/entities/UC-001' })
    expect(res.statusCode).toBe(200)
  })

  it('GET /api/v1/status returns project status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/status' })
    expect(res.statusCode).toBe(200)
  })

  it('POST /api/v1/webhooks/inbound requires Bearer token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/inbound',
      payload: { source: 'test', type: 'usecase.create', usecase: { id: 'UC-W1', mutation: 'new' } }
    })
    expect(res.statusCode).toBe(401)
  })

  it('POST /api/v1/webhooks/inbound with valid token registers entity', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/inbound',
      headers: { Authorization: 'Bearer test-token' },
      payload: { source: 'req-system', type: 'usecase.create', usecase: { id: 'UC-W1', mutation: 'new' } }
    })
    expect(res.statusCode).toBe(200)
  })
})
```

- [ ] **Step 3: 实现 Fastify HTTP Server**

```typescript
// http/server.ts
import Fastify from 'fastify'
import type { CommandHandler } from '../core/command-handler.js'
import { registerRoutes } from './routes.js'
import { registerWebhook } from './webhook.js'

export interface HttpServerOptions {
  inboundToken?: string
  port?: number
  host?: string
}

export function buildHttpServer(handler: CommandHandler, opts: HttpServerOptions = {}) {
  const app = Fastify({ logger: false })

  // Global error handler
  app.setErrorHandler((err, _req, reply) => {
    const code = (err as any).code ?? 'INTERNAL_ERROR'
    reply.status(500).send({ ok: false, error: { code, message: err.message } })
  })

  registerRoutes(app, handler)
  registerWebhook(app, handler, opts.inboundToken)

  return app
}
```

```typescript
// http/routes.ts
import type { FastifyInstance } from 'fastify'
import type { CommandHandler } from '../core/command-handler.js'

export function registerRoutes(app: FastifyInstance, handler: CommandHandler) {
  // POST /api/v1/entities — register
  app.post('/api/v1/entities', async (req, reply) => {
    const result = await handler.register(req.body as any)
    reply.status(result.ok ? 201 : 400).send(result)
  })

  // PATCH /api/v1/entities/:id — update state or attributes
  app.patch('/api/v1/entities/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as any
    if (body.state !== undefined) {
      const result = await handler.updateState({ id, state: body.state, reason: body.reason })
      reply.status(result.ok ? 200 : 400).send(result)
    } else if (body.attributes !== undefined) {
      const result = await handler.updateAttributes({ id, attributes: body.attributes })
      reply.status(result.ok ? 200 : 400).send(result)
    } else {
      reply.status(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: 'Provide state or attributes' } })
    }
  })

  // GET /api/v1/entities/:id
  app.get('/api/v1/entities/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const result = await handler.get({ id })
    reply.status(result.ok ? 200 : 404).send(result)
  })

  // DELETE /api/v1/entities/:id
  app.delete('/api/v1/entities/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const result = await handler.remove({ id })
    reply.status(result.ok ? 200 : 404).send(result)
  })

  // GET /api/v1/entities/:id/dag
  app.get('/api/v1/entities/:id/dag', async (req, reply) => {
    const dag = handler.getDagSnapshot()
    reply.send({ ok: true, data: dag })
  })

  // POST /api/v1/entities/:id/artifacts
  app.post('/api/v1/entities/:id/artifacts', async (req, reply) => {
    const { id } = req.params as { id: string }
    const result = await handler.linkArtifact({ entity_id: id, artifact: req.body as any })
    reply.status(result.ok ? 200 : 400).send(result)
  })

  // GET /api/v1/status
  app.get('/api/v1/status', async (_req, reply) => {
    const result = await handler.getStatus({})
    reply.send(result)
  })

  // POST /api/v1/events
  app.post('/api/v1/events', async (req, reply) => {
    const result = await handler.emitEvent(req.body as any)
    reply.status(result.ok ? 201 : 400).send(result)
  })

  // GET /api/v1/events
  app.get('/api/v1/events', async (req, reply) => {
    const query = req.query as any
    const result = await handler.queryEvents(query)
    reply.send(result)
  })
}
```

```typescript
// http/webhook.ts
import type { FastifyInstance } from 'fastify'
import type { CommandHandler } from '../core/command-handler.js'

export function registerWebhook(
  app: FastifyInstance,
  handler: CommandHandler,
  inboundToken?: string
) {
  app.post('/api/v1/webhooks/inbound', async (req, reply) => {
    // Auth check
    if (inboundToken) {
      const auth = (req.headers.authorization ?? '')
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      if (token !== inboundToken) {
        return reply.status(401).send({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } })
      }
    }

    const body = req.body as any
    const results: unknown[] = []

    // usecase.create — register usecase + optional plans
    if (body.type === 'usecase.create' && body.usecase) {
      const r = await handler.register({
        entity_type: 'usecase',
        id: body.usecase.id,
        attributes: { mutation: body.usecase.mutation, source: body.source },
        artifact_refs: body.usecase.artifact_refs,
      })
      results.push(r)

      for (const plan of body.plans ?? []) {
        const pr = await handler.register({
          entity_type: 'plan',
          id: plan.id,
          parent_id: body.usecase.id,
          domain: plan.domain,
          depends_on: plan.depends_on,
          constraint_refs: plan.constraint_refs,
        })
        results.push(pr)
      }
    }

    // task.rejected — post-hoc rejection callback
    if (body.type === 'task.rejected' && body.entity_id) {
      const r = await handler.updateState({
        id: body.entity_id,
        state: 'rejected',
        reason: body.reason,
      })
      results.push(r)
    }

    reply.send({ ok: true, data: results })
  })
}
```

- [ ] **Step 4: 运行 HTTP 测试**

```bash
npm test --workspace=packages/tw-daemon -- --testPathPattern "http"
```

Expected: All HTTP tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/tw-daemon/src/http/
git commit -m "feat(http): Fastify HTTP API — entity CRUD, status, events, inbound webhook"
```

---

## Task 3: Wire MCP + HTTP into Daemon Entry Point

**Files:**
- Modify: `packages/tw-daemon/src/index.ts`

- [ ] **Step 1: 更新 index.ts 启动 HTTP Server**

在 daemon 启动时，如果 `TW_HTTP_PORT` 环境变量存在，启动 Fastify HTTP server。MCP server 通过 `TW_MCP_STDIO=1` 环境变量启用（由 MCP client 管理进程时自动注入）。

```typescript
// 在 index.ts 中添加
if (process.env.TW_HTTP_PORT) {
  const port = parseInt(process.env.TW_HTTP_PORT, 10)
  const { buildHttpServer } = await import('./http/server.js')
  const httpServer = buildHttpServer(handler, {
    inboundToken: process.env.TW_INBOUND_TOKEN,
  })
  await httpServer.listen({ port, host: '127.0.0.1' })
  console.error(`[tw-daemon] HTTP API listening on port ${port}`)
}

if (process.env.TW_MCP_STDIO) {
  const { McpServer } = await import('./mcp/server.js')
  const mcp = new McpServer(handler)
  await mcp.start('stdio')
}
```

- [ ] **Step 2: 运行全量测试确保无回归**

```bash
npm test --workspace=packages/tw-daemon && npm test --workspace=packages/tw-cli
```

Expected: All tests pass (100+ total)

- [ ] **Step 3: Commit**

```bash
git add packages/tw-daemon/src/index.ts
git commit -m "feat(daemon): wire MCP + HTTP servers into daemon startup via env vars"
```

---

## Task 4: Phase 3 Integration Test

**Files:**
- Create: `packages/tw-cli/src/phase3-integration.test.ts`

- [ ] **Step 1: 编写 Phase 3 端到端集成测试**

测试 MCP tool 调用路径：注册 → 状态变更 → 错误路径。

```typescript
// phase3-integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { McpServer } from '../../tw-daemon/src/mcp/server.js'
import { CommandHandler } from '../../tw-daemon/src/core/command-handler.js'
import { buildHttpServer } from '../../tw-daemon/src/http/server.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

describe('Phase 3: MCP + HTTP integration', () => {
  let tmpDir: string
  let handler: CommandHandler
  let mcp: McpServer

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'tw-p3-'))
    handler = new CommandHandler({ storeDir: tmpDir })
    await handler.init()
    mcp = new McpServer(handler)
  })

  afterEach(() => rm(tmpDir, { recursive: true, force: true }))

  it('UseCase → Plan → Task full lifecycle via MCP tools', async () => {
    // Register UseCase
    let r = await mcp.callTool('tw_register', { entity_type: 'usecase', id: 'UC-P3' })
    expect(r.ok).toBe(true)

    // Register Plan under UseCase
    r = await mcp.callTool('tw_register', { entity_type: 'plan', id: 'P-P3', parent_id: 'UC-P3', domain: 'backend' })
    expect(r.ok).toBe(true)

    // Register Task under Plan
    r = await mcp.callTool('tw_register', { entity_type: 'task', id: 'T-P3', parent_id: 'P-P3' })
    expect(r.ok).toBe(true)

    // Progress Task through states
    r = await mcp.callTool('tw_update_state', { id: 'T-P3', state: 'in_progress' })
    expect(r.ok).toBe(true)

    r = await mcp.callTool('tw_update_state', { id: 'T-P3', state: 'review' })
    expect(r.ok).toBe(true)

    r = await mcp.callTool('tw_update_state', { id: 'T-P3', state: 'completed' })
    expect(r.ok).toBe(true)

    // Get status
    const status = await mcp.callTool('tw_get_status', { id: 'UC-P3' })
    expect(status.ok).toBe(true)
  })

  it('tw_emit_event records event for entity', async () => {
    await mcp.callTool('tw_register', { entity_type: 'task', id: 'T-EV' })
    const r = await mcp.callTool('tw_emit_event', { entity_id: 'T-EV', event: 'code_generated', attributes: { lines: 100 } })
    expect(r.ok).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试**

```bash
npm test --workspace=packages/tw-cli -- --testPathPattern phase3-integration
```

- [ ] **Step 3: 运行全量测试**

```bash
npm test --workspace=packages/tw-daemon && npm test --workspace=packages/tw-cli
```

- [ ] **Step 4: Commit**

```bash
git commit -m "test(phase3): MCP + HTTP API integration test — UseCase → Plan → Task lifecycle"
git tag v0.3.0-phase3
```
