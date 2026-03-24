import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface FeedbackRecordInput {
  harness_id: string
  entity_id: string
  entity_type: string
  trigger_state: string
  result: 'pass' | 'fail' | 'skipped'
  reason: string
  duration_ms: number
}

export interface FeedbackEntry extends FeedbackRecordInput {
  id: string    // UUID
  ts: string    // ISO 8601
  seq: number   // globally incrementing
}

export interface FeedbackQuery {
  harness_id?: string
  entity_id?: string
  result?: 'pass' | 'fail' | 'skipped'
  since?: string
  limit?: number
}

export interface HarnessFeedbackSummary {
  harness_id: string
  total: number
  pass: number
  fail: number
  skipped: number
  failure_rate: number
  consecutive_failures: number
  recent_reasons: string[]   // last 3 failure reasons
  trend: 'improving' | 'degrading' | 'stable' | 'unknown'
  last_evaluated: string
}

export class FeedbackLog {
  private history: FeedbackEntry[] = []
  private seq = 0
  private loaded = false
  private dirReady = false

  constructor(private readonly logPath: string) {}

  private ensureDir(): void {
    if (this.dirReady) return
    mkdirSync(dirname(this.logPath), { recursive: true })
    this.dirReady = true
  }

  load(): void {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.logPath)) return
    const raw = readFileSync(this.logPath, 'utf8')
    for (const line of raw.trim().split('\n').filter(Boolean)) {
      try {
        const entry = JSON.parse(line) as FeedbackEntry
        this.history.push(entry)
        if (entry.seq > this.seq) this.seq = entry.seq
      } catch { /* skip malformed line */ }
    }
  }

  record(input: FeedbackRecordInput): FeedbackEntry {
    this.ensureDir()
    this.seq++
    const entry: FeedbackEntry = {
      ...input,
      id: randomUUID(),
      ts: new Date().toISOString(),
      seq: this.seq,
    }
    this.history.push(entry)
    appendFileSync(this.logPath, JSON.stringify(entry) + '\n', 'utf8')
    return entry
  }

  getHistory(since?: string): FeedbackEntry[] {
    if (!since) return [...this.history]
    return this.history.filter(e => e.ts >= since)
  }

  query(params: FeedbackQuery): FeedbackEntry[] {
    let result = [...this.history]
    if (params.harness_id) result = result.filter(e => e.harness_id === params.harness_id)
    if (params.entity_id)  result = result.filter(e => e.entity_id  === params.entity_id)
    if (params.result)     result = result.filter(e => e.result      === params.result)
    if (params.since)      result = result.filter(e => e.ts          >= params.since!)
    if (params.limit)      result = result.slice(-params.limit)
    return result
  }

  getSummary(harness_id: string): HarnessFeedbackSummary {
    const entries = this.history.filter(e => e.harness_id === harness_id)
    const total = entries.length
    const pass = entries.filter(e => e.result === 'pass').length
    const fail = entries.filter(e => e.result === 'fail').length
    const skipped = entries.filter(e => e.result === 'skipped').length
    const failure_rate = total === 0 ? 0 : fail / total

    // consecutive_failures: count from tail until non-fail
    let consecutive_failures = 0
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].result === 'fail') {
        consecutive_failures++
      } else {
        break
      }
    }

    // recent_reasons: last 3 failure reasons
    const failEntries = entries.filter(e => e.result === 'fail')
    const recent_reasons = failEntries.slice(-3).map(e => e.reason)

    // trend: split into two halves, compare failure rates
    let trend: HarnessFeedbackSummary['trend'] = 'unknown'
    if (total >= 4) {
      const mid = Math.floor(total / 2)
      const firstHalf = entries.slice(0, mid)
      const secondHalf = entries.slice(mid)
      const firstFailRate = firstHalf.filter(e => e.result === 'fail').length / firstHalf.length
      const secondFailRate = secondHalf.filter(e => e.result === 'fail').length / secondHalf.length
      const diff = secondFailRate - firstFailRate
      if (diff > 0.1) {
        trend = 'degrading'
      } else if (diff < -0.1) {
        trend = 'improving'
      } else {
        trend = 'stable'
      }
    }

    const last_evaluated = entries.length > 0
      ? entries[entries.length - 1].ts
      : new Date().toISOString()

    return {
      harness_id,
      total,
      pass,
      fail,
      skipped,
      failure_rate,
      consecutive_failures,
      recent_reasons,
      trend,
      last_evaluated,
    }
  }

  getAllSummaries(): HarnessFeedbackSummary[] {
    const ids = [...new Set(this.history.map(e => e.harness_id))]
    return ids.map(id => this.getSummary(id))
  }
}
