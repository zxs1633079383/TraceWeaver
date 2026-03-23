// packages/tw-daemon/src/phase3-integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { McpServer } from './mcp/server.js'
import { buildHttpServer } from './http/server.js'
import { CommandHandler } from './core/command-handler.js'

describe('Phase 3 Integration: MCP + HTTP', () => {
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

    // Progress Task: pending → in_progress → review → completed
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

  it('MCP invalid transition returns INVALID_TRANSITION error', async () => {
    await mcp.callTool('tw_register', { entity_type: 'task', id: 'T-INV' })
    const r = await mcp.callTool('tw_update_state', { id: 'T-INV', state: 'completed' })
    expect(r.ok).toBe(false)
    expect((r as any).error.code).toBe('INVALID_TRANSITION')
  })

  it('HTTP webhook bulk registers UseCase + Plans', async () => {
    const httpDir = await mkdtemp(path.join(tmpdir(), 'tw-http-p3-'))
    const h2 = new CommandHandler({ storeDir: httpDir })
    await h2.init()
    const app = buildHttpServer(h2, { inboundToken: 'secret' })
    await app.ready()

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/inbound',
        headers: { Authorization: 'Bearer secret' },
        payload: {
          source: 'requirement-system',
          type: 'usecase.create',
          usecase: { id: 'UC-WH', mutation: 'new' },
          plans: [
            { id: 'FE-PLAN-WH', domain: 'frontend' },
            { id: 'BE-PLAN-WH', domain: 'backend' }
          ]
        }
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.data).toHaveLength(3) // 1 usecase + 2 plans
    } finally {
      await app.close()
      await rm(httpDir, { recursive: true, force: true })
    }
  })

  it('tw_emit_event + tw_query_events roundtrip', async () => {
    await mcp.callTool('tw_register', { entity_type: 'task', id: 'T-EH' })
    await mcp.callTool('tw_emit_event', { entity_id: 'T-EH', event: 'code_generated', attributes: { lines: 150 } })

    const r = await mcp.callTool('tw_query_events', { entity_id: 'T-EH' })
    expect(r.ok).toBe(true)
    // Events from event bus history
    const events = (r as any).data as any[]
    expect(Array.isArray(events)).toBe(true)
  })
})
