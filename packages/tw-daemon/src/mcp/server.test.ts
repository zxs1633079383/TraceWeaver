// packages/tw-daemon/src/mcp/server.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { McpServer } from './server.js'
import { CommandHandler } from '../core/command-handler.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

async function makeServer() {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'tw-mcp-'))
  const handler = new CommandHandler({ storeDir: tmpDir })
  await handler.init()
  const mcp = new McpServer(handler)
  return { mcp, tmpDir }
}

describe('McpServer tool dispatch', () => {
  let tmpDir: string
  let mcp: McpServer

  beforeEach(async () => {
    const s = await makeServer()
    tmpDir = s.tmpDir
    mcp = s.mcp
  })

  afterEach(() => rm(tmpDir, { recursive: true, force: true }))

  it('tw_register creates entity', async () => {
    const result = await mcp.callTool('tw_register', {
      entity_type: 'usecase', id: 'UC-001'
    })
    expect(result.ok).toBe(true)
    expect((result as any).data.id).toBe('UC-001')
    expect((result as any).data.state).toBe('pending')
  })

  it('tw_update_state transitions state', async () => {
    await mcp.callTool('tw_register', { entity_type: 'usecase', id: 'UC-001' })
    const result = await mcp.callTool('tw_update_state', { id: 'UC-001', state: 'in_progress' })
    expect(result.ok).toBe(true)
    expect((result as any).data.current_state).toBe('in_progress')
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
    expect((result as any).data).toHaveProperty('total_entities')
  })

  it('tw_remove removes entity', async () => {
    await mcp.callTool('tw_register', { entity_type: 'usecase', id: 'UC-001' })
    const result = await mcp.callTool('tw_remove', { id: 'UC-001' })
    expect(result.ok).toBe(true)
  })

  it('tw_get_context returns entity data', async () => {
    await mcp.callTool('tw_register', { entity_type: 'task', id: 'T-CTX' })
    const result = await mcp.callTool('tw_get_context', { id: 'T-CTX' })
    expect(result.ok).toBe(true)
    expect((result as any).data.id).toBe('T-CTX')
  })

  it('tw_get_dag returns nodes and edges', async () => {
    const result = await mcp.callTool('tw_get_dag', {})
    expect(result.ok).toBe(true)
    expect((result as any).data).toHaveProperty('nodes')
    expect((result as any).data).toHaveProperty('edges')
  })

  it('tw_emit_event records event', async () => {
    await mcp.callTool('tw_register', { entity_type: 'task', id: 'T-EV' })
    const result = await mcp.callTool('tw_emit_event', { entity_id: 'T-EV', event: 'code_generated' })
    expect(result.ok).toBe(true)
  })

  it('unknown tool returns UNKNOWN_TOOL error', async () => {
    const result = await mcp.callTool('tw_unknown_xyz', {})
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('UNKNOWN_TOOL')
  })
})
