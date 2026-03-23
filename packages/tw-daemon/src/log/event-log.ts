import { appendFileSync, readFileSync, existsSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TwEvent, TwEventType, EventRecord } from '@traceweaver/types'

export interface EventLogQuery {
  entity_id?: string
  event_type?: TwEventType
  since?: string
  until?: string
  limit?: number
}

export class EventLog {
  private history: EventRecord[] = []
  private seq = 0

  constructor(private readonly logPath: string) {}

  load(): void {
    if (!existsSync(this.logPath)) return
    const raw = readFileSync(this.logPath, 'utf8')
    for (const line of raw.trim().split('\n').filter(Boolean)) {
      try {
        const record = JSON.parse(line) as EventRecord
        this.history.push(record)
        if (record.seq > this.seq) this.seq = record.seq
      } catch { /* skip malformed line */ }
    }
  }

  append(event: TwEvent): void {
    this.seq++
    const record: EventRecord = { ...event, seq: this.seq }
    this.history.push(record)
    mkdirSync(dirname(this.logPath), { recursive: true })
    appendFileSync(this.logPath, JSON.stringify(record) + '\n', 'utf8')
  }

  getHistory(since?: string): EventRecord[] {
    if (!since) return [...this.history]
    return this.history.filter(e => e.ts >= since)
  }

  query(params: EventLogQuery): EventRecord[] {
    let result = [...this.history]
    if (params.entity_id)  result = result.filter(e => e.entity_id  === params.entity_id)
    if (params.event_type) result = result.filter(e => e.type        === params.event_type)
    if (params.since)      result = result.filter(e => e.ts          >= params.since!)
    if (params.until)      result = result.filter(e => e.ts          <= params.until!)
    if (params.limit)      result = result.slice(-params.limit)
    return result
  }
}
