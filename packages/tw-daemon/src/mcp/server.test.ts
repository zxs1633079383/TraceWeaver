// packages/tw-daemon/src/mcp/server.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

describe('tw_query_traces', () => {
  let tmpDir: string
  let mcp: McpServer

  beforeEach(async () => {
    const s = await makeServer()
    tmpDir = s.tmpDir
    mcp = s.mcp
  })

  afterEach(() => {
    rm(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('returns error when service is missing', async () => {
    const result = await mcp.callTool('tw_query_traces', {})
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('MISSING_PARAM')
  })

  it('returns error for invalid since format', async () => {
    const result = await mcp.callTool('tw_query_traces', { service: 'my-svc', since: 'abc' })
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('INVALID_PARAM')
  })

  it('returns simplified traces on success', async () => {
    const jaegerResponse = {
      data: [
        {
          traceID: 'abc123',
          spans: [
            { operationName: 'GET /api', duration: 5000, tags: [] },
            { operationName: 'db.query', duration: 3000, tags: [{ key: 'error', value: true }] },
          ],
        },
      ],
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => jaegerResponse,
    } as Response)

    const result = await mcp.callTool('tw_query_traces', { service: 'my-svc' })
    expect(result.ok).toBe(true)
    const data = (result as any).data
    expect(data).toHaveLength(1)
    expect(data[0].trace_id).toBe('abc123')
    expect(data[0].span_count).toBe(2)
    expect(data[0].total_duration_us).toBe(5000)
    expect(data[0].has_error).toBe(true)
    expect(data[0].spans).toHaveLength(2)
    expect(data[0].spans[0].operation).toBe('GET /api')
  })

  it('returns connect error when Jaeger is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const result = await mcp.callTool('tw_query_traces', { service: 'my-svc' })
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('JAEGER_CONNECT_ERROR')
    expect((result as any).error.message).toContain('ECONNREFUSED')
  })

  it('returns error on non-ok HTTP response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    } as Response)

    const result = await mcp.callTool('tw_query_traces', { service: 'my-svc' })
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('JAEGER_ERROR')
  })
})

describe('tw_query_metrics', () => {
  let tmpDir: string
  let mcp: McpServer

  beforeEach(async () => {
    const s = await makeServer()
    tmpDir = s.tmpDir
    mcp = s.mcp
  })

  afterEach(() => {
    rm(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('returns error when query is missing', async () => {
    const result = await mcp.callTool('tw_query_metrics', {})
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('MISSING_PARAM')
  })

  it('returns error for invalid time format', async () => {
    const result = await mcp.callTool('tw_query_metrics', { query: 'up', time: 'not-a-date' })
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('INVALID_PARAM')
  })

  it('returns simplified metrics on success', async () => {
    const promResponse = {
      status: 'success',
      data: {
        resultType: 'vector',
        result: [
          { metric: { __name__: 'up', instance: 'localhost:9090' }, value: [1234567890, '1'] },
        ],
      },
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => promResponse,
    } as Response)

    const result = await mcp.callTool('tw_query_metrics', { query: 'up' })
    expect(result.ok).toBe(true)
    const data = (result as any).data
    expect(data.result_type).toBe('vector')
    expect(data.results).toHaveLength(1)
  })

  it('returns connect error when Prometheus is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const result = await mcp.callTool('tw_query_metrics', { query: 'up' })
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('PROMETHEUS_CONNECT_ERROR')
  })

  it('returns error on Prometheus query failure status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'error', errorType: 'bad_data', error: 'parse error' }),
    } as Response)

    const result = await mcp.callTool('tw_query_metrics', { query: 'invalid{' })
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('PROMETHEUS_ERROR')
  })
})
