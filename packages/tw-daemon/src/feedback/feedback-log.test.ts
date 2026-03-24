import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FeedbackLog } from './feedback-log.js'
import type { FeedbackRecordInput } from './feedback-log.js'

function makeInput(overrides: Partial<FeedbackRecordInput> = {}): FeedbackRecordInput {
  return {
    harness_id: 'harness-a',
    entity_id: 'entity-1',
    entity_type: 'task',
    trigger_state: 'review',
    result: 'pass',
    reason: 'All checks passed',
    duration_ms: 100,
    ...overrides,
  }
}

describe('FeedbackLog', () => {
  let dir: string
  let log: FeedbackLog

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tw-feedbacklog-'))
    log = new FeedbackLog(join(dir, 'feedback.ndjson'))
    log.load()
  })

  afterEach(() => rmSync(dir, { recursive: true }))

  // Test 1: record + getHistory returns correct entry, seq=1, id and ts non-empty
  it('record + getHistory returns correct entry with seq=1, non-empty id and ts', () => {
    const entry = log.record(makeInput())
    const history = log.getHistory()
    expect(history).toHaveLength(1)
    expect(entry.seq).toBe(1)
    expect(entry.id).toBeTruthy()
    expect(entry.ts).toBeTruthy()
    expect(history[0].seq).toBe(1)
    expect(history[0].id).toBeTruthy()
    expect(history[0].ts).toBeTruthy()
  })

  // Test 2: seq is 1 for first, 2 for second
  it('seq increments: first=1, second=2', () => {
    const e1 = log.record(makeInput())
    const e2 = log.record(makeInput())
    expect(e1.seq).toBe(1)
    expect(e2.seq).toBe(2)
  })

  // Test 3: query by harness_id filters correctly
  it('query by harness_id filters correctly', () => {
    log.record(makeInput({ harness_id: 'harness-a' }))
    log.record(makeInput({ harness_id: 'harness-b' }))
    const result = log.query({ harness_id: 'harness-a' })
    expect(result).toHaveLength(1)
    expect(result[0].harness_id).toBe('harness-a')
  })

  // Test 4: query by result filters correctly
  it('query by result filters correctly', () => {
    log.record(makeInput({ result: 'pass' }))
    log.record(makeInput({ result: 'fail' }))
    log.record(makeInput({ result: 'skipped' }))
    const result = log.query({ result: 'fail' })
    expect(result).toHaveLength(1)
    expect(result[0].result).toBe('fail')
  })

  // Test 5: query by limit (5 entries, limit=3, returns last 3)
  it('query limit=3 returns last 3 of 5 entries', () => {
    for (let i = 0; i < 5; i++) {
      log.record(makeInput({ reason: `reason-${i}` }))
    }
    const result = log.query({ limit: 3 })
    expect(result).toHaveLength(3)
    expect(result[0].seq).toBe(3)
    expect(result[2].seq).toBe(5)
  })

  // Test 6: persistence - new instance after load() has same history length
  it('persistence: new instance after load() has same history length', () => {
    log.record(makeInput({ entity_id: 'persist-me' }))
    log.record(makeInput({ entity_id: 'persist-me-2' }))
    const log2 = new FeedbackLog(join(dir, 'feedback.ndjson'))
    log2.load()
    expect(log2.getHistory()).toHaveLength(2)
  })

  // Test 7: getSummary total/pass/fail/failure_rate correct (2 fail 1 pass → rate≈0.667)
  it('getSummary total/pass/fail/failure_rate correct', () => {
    log.record(makeInput({ harness_id: 'h1', result: 'pass' }))
    log.record(makeInput({ harness_id: 'h1', result: 'fail', reason: 'reason-1' }))
    log.record(makeInput({ harness_id: 'h1', result: 'fail', reason: 'reason-2' }))
    const summary = log.getSummary('h1')
    expect(summary.total).toBe(3)
    expect(summary.pass).toBe(1)
    expect(summary.fail).toBe(2)
    expect(summary.failure_rate).toBeCloseTo(2 / 3, 5)
  })

  // Test 8: getSummary consecutive_failures = 3 (3 consecutive fails)
  it('getSummary consecutive_failures = 3', () => {
    log.record(makeInput({ harness_id: 'h1', result: 'pass' }))
    log.record(makeInput({ harness_id: 'h1', result: 'fail' }))
    log.record(makeInput({ harness_id: 'h1', result: 'fail' }))
    log.record(makeInput({ harness_id: 'h1', result: 'fail' }))
    const summary = log.getSummary('h1')
    expect(summary.consecutive_failures).toBe(3)
  })

  // Test 9: pass breaks consecutive streak → consecutive_failures = 0
  it('getSummary: pass breaks consecutive streak → consecutive_failures = 0', () => {
    log.record(makeInput({ harness_id: 'h1', result: 'fail' }))
    log.record(makeInput({ harness_id: 'h1', result: 'fail' }))
    log.record(makeInput({ harness_id: 'h1', result: 'pass' }))
    const summary = log.getSummary('h1')
    expect(summary.consecutive_failures).toBe(0)
  })

  // Test 10: getSummary trend=degrading (first 3 pass, last 3 fail)
  it('getSummary trend=degrading when first half passes, second half fails', () => {
    log.record(makeInput({ harness_id: 'h1', result: 'pass' }))
    log.record(makeInput({ harness_id: 'h1', result: 'pass' }))
    log.record(makeInput({ harness_id: 'h1', result: 'pass' }))
    log.record(makeInput({ harness_id: 'h1', result: 'fail' }))
    log.record(makeInput({ harness_id: 'h1', result: 'fail' }))
    log.record(makeInput({ harness_id: 'h1', result: 'fail' }))
    const summary = log.getSummary('h1')
    expect(summary.trend).toBe('degrading')
  })

  // Test 11: getSummary trend=improving (first 3 fail, last 3 pass)
  it('getSummary trend=improving when first half fails, second half passes', () => {
    log.record(makeInput({ harness_id: 'h1', result: 'fail' }))
    log.record(makeInput({ harness_id: 'h1', result: 'fail' }))
    log.record(makeInput({ harness_id: 'h1', result: 'fail' }))
    log.record(makeInput({ harness_id: 'h1', result: 'pass' }))
    log.record(makeInput({ harness_id: 'h1', result: 'pass' }))
    log.record(makeInput({ harness_id: 'h1', result: 'pass' }))
    const summary = log.getSummary('h1')
    expect(summary.trend).toBe('improving')
  })

  // Test 12: getAllSummaries groups by harness_id, two different ids → length 2
  it('getAllSummaries groups by harness_id, returns length 2', () => {
    log.record(makeInput({ harness_id: 'harness-x', result: 'pass' }))
    log.record(makeInput({ harness_id: 'harness-y', result: 'fail' }))
    log.record(makeInput({ harness_id: 'harness-x', result: 'fail' }))
    const summaries = log.getAllSummaries()
    expect(summaries).toHaveLength(2)
    const ids = summaries.map(s => s.harness_id).sort()
    expect(ids).toEqual(['harness-x', 'harness-y'])
  })
})
