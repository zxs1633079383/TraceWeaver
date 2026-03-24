import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemediationEngine } from './remediation-engine.js'
import type { EventBus } from '../core/event-bus/event-bus.js'
import type { CommandHandler } from '../core/command-handler.js'
import type { FeedbackLog } from '../feedback/feedback-log.js'

function makeEventBus() {
  const subs: Array<(events: any[]) => void> = []
  return {
    subscribeBatch: vi.fn((cb: any) => { subs.push(cb); return () => {} }),
    publish: vi.fn(),
    emit: (events: any[]) => subs.forEach(s => s(events)),
  }
}

function makeHandler() {
  return {
    get: vi.fn().mockResolvedValue({
      ok: true,
      data: { id: 'task-1', entity_type: 'task', state: 'rejected', artifact_refs: [] },
    }),
    updateState: vi.fn().mockResolvedValue({}),
  } as unknown as CommandHandler
}

function makeFeedbackLog() {
  return {
    query: vi.fn().mockReturnValue([{
      harness_id: 'needs-review',
      reason: '缺少测试覆盖',
      ts: new Date().toISOString(),
    }]),
  } as unknown as FeedbackLog
}

let queueDir: string
let bus: ReturnType<typeof makeEventBus>
let handler: CommandHandler
let feedbackLog: FeedbackLog
let engine: RemediationEngine

beforeEach(async () => {
  queueDir = await mkdtemp(join(tmpdir(), 'rem-test-'))
  bus = makeEventBus()
  handler = makeHandler()
  feedbackLog = makeFeedbackLog()
  engine = new RemediationEngine({
    eventBus: bus as unknown as EventBus,
    handler,
    feedbackLog,
    queueDir,
    maxAttempts: 3,
  })
  engine.start()
})

afterEach(async () => {
  engine.stop()
  await rm(queueDir, { recursive: true, force: true })
})

describe('RemediationEngine', () => {
  it('enqueues a pending item when entity is rejected', async () => {
    bus.emit([{
      type: 'entity.state_changed',
      entity_id: 'task-1',
      state: 'rejected',
      ts: new Date().toISOString(),
    }])
    await new Promise(r => setTimeout(r, 50))
    const files = await readdir(join(queueDir, 'pending')).catch(() => [])
    expect(files.length).toBe(1)
    expect(files[0]).toMatch(/rem-.*\.json/)
  })

  it('does not enqueue if max attempts exceeded', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(queueDir, 'done'), { recursive: true })
    for (let i = 1; i <= 3; i++) {
      await writeFile(join(queueDir, 'done', `rem-00${i}-task-1.json`), JSON.stringify({ entity_id: 'task-1', attempt: i }))
    }
    bus.emit([{
      type: 'entity.state_changed',
      entity_id: 'task-1',
      state: 'rejected',
      ts: new Date().toISOString(),
    }])
    await new Promise(r => setTimeout(r, 50))
    const files = await readdir(join(queueDir, 'pending')).catch(() => [])
    expect(files.length).toBe(0)
  })

  it('deduplicates identical rejection events (same entity_id + ts)', async () => {
    const event = { type: 'entity.state_changed', entity_id: 'task-1', state: 'rejected', ts: '2026-03-24T10:00:00Z' }
    bus.emit([event])
    bus.emit([event])
    await new Promise(r => setTimeout(r, 50))
    const files = await readdir(join(queueDir, 'pending')).catch(() => [])
    expect(files.length).toBe(1)
  })
})
