// packages/tw-daemon/src/ipc-server.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { createConnection } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IpcServer } from './ipc-server.js'
import { CommandHandler } from './core/command-handler.js'
import type { FeedbackEntry, FeedbackQuery, HarnessFeedbackSummary } from './feedback/feedback-log.js'
import type { AlignmentIssue } from './harness/validator.js'

let tmpDir: string
let server: IpcServer

async function startServer(opts?: {
  feedbackLog?: { query: (q: FeedbackQuery) => FeedbackEntry[]; getSummary: (id: string) => HarnessFeedbackSummary; getAllSummaries: () => HarnessFeedbackSummary[] }
  harnessValidator?: { validate: (entities: any[]) => AlignmentIssue[] }
}) {
  tmpDir = await mkdtemp(join(tmpdir(), 'tw-ipc-test-'))
  const handler = new CommandHandler(tmpDir)
  await handler.init()
  const socketPath = join(tmpDir, 'tw.sock')
  server = new IpcServer(socketPath, handler, undefined, opts)
  await server.start()
  return { socketPath, handler }
}

async function sendRequest(socketPath: string, req: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath)
    let buf = ''
    client.on('data', (d) => {
      buf += d.toString()
      if (buf.includes('\n')) {
        resolve(JSON.parse(buf.trim()))
        client.destroy()
      }
    })
    client.on('error', reject)
    client.on('connect', () => {
      client.write(JSON.stringify(req) + '\n')
    })
  })
}

afterEach(async () => {
  await server?.stop()
  if (tmpDir) await rm(tmpDir, { recursive: true })
})

describe('IpcServer', () => {
  it('responds to register command', async () => {
    const { socketPath } = await startServer()
    const res = await sendRequest(socketPath, {
      request_id: 'r1',
      method: 'register',
      params: { entity_type: 'usecase', id: 'UC-001' },
    })
    expect(res.ok).toBe(true)
    expect(res.data.id).toBe('UC-001')
  })

  it('responds with error on invalid transition', async () => {
    const { socketPath } = await startServer()
    await sendRequest(socketPath, {
      request_id: 'r1', method: 'register', params: { entity_type: 'usecase', id: 'UC-001' },
    })
    const res = await sendRequest(socketPath, {
      request_id: 'r2', method: 'update_state', params: { id: 'UC-001', state: 'completed' },
    })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('INVALID_TRANSITION')
  })

  it('responds to unknown method with error', async () => {
    const { socketPath } = await startServer()
    const res = await sendRequest(socketPath, {
      request_id: 'r1', method: 'unknown_method', params: {},
    })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('UNKNOWN_METHOD')
  })

  it('feedback_query dispatches to feedbackLog.query() and returns result', async () => {
    const mockEntries: FeedbackEntry[] = [
      {
        id: 'entry-1',
        seq: 1,
        ts: '2024-01-01T00:00:00.000Z',
        harness_id: 'my-harness',
        entity_id: 'UC-001',
        entity_type: 'usecase',
        trigger_state: 'review',
        result: 'pass',
        reason: 'All checks passed',
        duration_ms: 100,
      },
    ]
    const mockFeedbackLog = {
      query: (_q: FeedbackQuery) => mockEntries,
      getSummary: (_id: string) => ({ harness_id: _id, total: 0, pass: 0, fail: 0, skipped: 0, failure_rate: 0, consecutive_failures: 0, recent_reasons: [], trend: 'unknown' as const, last_evaluated: '' }),
      getAllSummaries: () => [],
    }
    const { socketPath } = await startServer({ feedbackLog: mockFeedbackLog })
    const res = await sendRequest(socketPath, {
      request_id: 'fq1',
      method: 'feedback_query',
      params: { harness_id: 'my-harness' },
    })
    expect(res.ok).toBe(true)
    expect(Array.isArray(res.data)).toBe(true)
    expect(res.data).toHaveLength(1)
    expect(res.data[0].harness_id).toBe('my-harness')
  })

  it('feedback_summary with harness_id returns single summary', async () => {
    const mockSummary: HarnessFeedbackSummary = {
      harness_id: 'test-harness',
      total: 5,
      pass: 3,
      fail: 2,
      skipped: 0,
      failure_rate: 0.4,
      consecutive_failures: 1,
      recent_reasons: ['timeout'],
      trend: 'degrading',
      last_evaluated: '2024-01-01T00:00:00.000Z',
    }
    const mockFeedbackLog = {
      query: (_q: FeedbackQuery) => [],
      getSummary: (_id: string) => mockSummary,
      getAllSummaries: () => [],
    }
    const { socketPath } = await startServer({ feedbackLog: mockFeedbackLog })
    const res = await sendRequest(socketPath, {
      request_id: 'fs1',
      method: 'feedback_summary',
      params: { harness_id: 'test-harness' },
    })
    expect(res.ok).toBe(true)
    expect(res.data.harness_id).toBe('test-harness')
    expect(res.data.total).toBe(5)
    expect(res.data.trend).toBe('degrading')
  })

  it('harness_validate returns AlignmentIssue array from validator', async () => {
    const mockIssues: AlignmentIssue[] = [
      {
        severity: 'error',
        type: 'orphaned_ref',
        harness_id: 'missing-harness',
        entity_id: 'UC-001',
        message: "Entity 'UC-001' references non-existent harness 'missing-harness'",
      },
    ]
    const mockValidator = {
      validate: (_entities: any[]) => mockIssues,
    }
    const { socketPath } = await startServer({ harnessValidator: mockValidator })
    const res = await sendRequest(socketPath, {
      request_id: 'hv1',
      method: 'harness_validate',
      params: {},
    })
    expect(res.ok).toBe(true)
    expect(Array.isArray(res.data)).toBe(true)
    expect(res.data).toHaveLength(1)
    expect(res.data[0].severity).toBe('error')
    expect(res.data[0].type).toBe('orphaned_ref')
    expect(res.data[0].harness_id).toBe('missing-harness')
  })

  it('emit_event adds span event and returns ok', async () => {
    const { socketPath } = await startServer()
    await sendRequest(socketPath, {
      request_id: 'ee-reg',
      method: 'register',
      params: { id: 'task-e1', entity_type: 'task' },
    })
    const res = await sendRequest(socketPath, {
      request_id: 'ee1',
      method: 'emit_event',
      params: { entity_id: 'task-e1', event: 'custom.hook', attributes: { source: 'test' } },
    })
    expect(res.ok).toBe(true)
  })

  it('cascade_update calls handler.cascadeUpdate and returns updated_count', async () => {
    const { socketPath } = await startServer()
    await sendRequest(socketPath, {
      request_id: 'cu-reg1',
      method: 'register',
      params: { id: 'uc-1', entity_type: 'usecase' },
    })
    await sendRequest(socketPath, {
      request_id: 'cu-reg2',
      method: 'register',
      params: { id: 'plan-1', entity_type: 'plan', depends_on: ['uc-1'] },
    })
    const res = await sendRequest(socketPath, {
      request_id: 'cu1',
      method: 'cascade_update',
      params: { id: 'uc-1', attributes: { description: 'v2' }, cascade: true },
    })
    expect(res.ok).toBe(true)
    expect((res as any).data.updated_count).toBeGreaterThanOrEqual(1)
  })

  it('cascade_update with unknown id returns error', async () => {
    const { socketPath } = await startServer()
    const res = await sendRequest(socketPath, {
      request_id: 'cu-bad',
      method: 'cascade_update',
      params: { id: 'nope', attributes: {}, cascade: true },
    })
    expect(res.ok).toBe(false)
  })
})
