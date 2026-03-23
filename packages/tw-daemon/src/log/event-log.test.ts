import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventLog } from './event-log.js'
import type { TwEvent } from '@traceweaver/types'

function makeEvent(overrides: Partial<TwEvent> = {}): TwEvent {
  return {
    id: crypto.randomUUID(),
    type: 'entity.state_changed',
    entity_id: 'ent-1',
    entity_type: 'task',
    state: 'in_progress',
    ts: new Date().toISOString(),
    ...overrides,
  }
}

describe('EventLog', () => {
  let dir: string
  let log: EventLog

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tw-eventlog-'))
    log = new EventLog(join(dir, 'events.ndjson'))
    log.load()
  })
  afterEach(() => rmSync(dir, { recursive: true }))

  it('appends and retrieves all events', () => {
    log.append(makeEvent({ entity_id: 'a' }))
    log.append(makeEvent({ entity_id: 'b' }))
    const history = log.getHistory()
    expect(history).toHaveLength(2)
    expect(history[0].seq).toBe(1)
    expect(history[1].seq).toBe(2)
  })

  it('survives reload from disk', () => {
    log.append(makeEvent({ entity_id: 'persist-me' }))
    const log2 = new EventLog(join(dir, 'events.ndjson'))
    log2.load()
    const history = log2.getHistory()
    expect(history).toHaveLength(1)
    expect(history[0].entity_id).toBe('persist-me')
    expect(history[0].seq).toBe(1)
  })

  it('query filters by entity_id', () => {
    log.append(makeEvent({ entity_id: 'x' }))
    log.append(makeEvent({ entity_id: 'y' }))
    const result = log.query({ entity_id: 'x' })
    expect(result).toHaveLength(1)
    expect(result[0].entity_id).toBe('x')
  })

  it('query filters by event_type', () => {
    log.append(makeEvent({ type: 'entity.registered' }))
    log.append(makeEvent({ type: 'entity.state_changed' }))
    const result = log.query({ event_type: 'entity.registered' })
    expect(result).toHaveLength(1)
  })

  it('query filters by since', () => {
    const past = new Date(Date.now() - 10000).toISOString()
    const future = new Date(Date.now() + 10000).toISOString()
    log.append(makeEvent({ ts: past }))
    log.append(makeEvent({ ts: future }))
    const result = log.query({ since: new Date(Date.now() - 5000).toISOString() })
    expect(result).toHaveLength(1)
    expect(result[0].ts).toBe(future)
  })

  it('query respects limit', () => {
    for (let i = 0; i < 10; i++) log.append(makeEvent())
    const result = log.query({ limit: 3 })
    expect(result).toHaveLength(3)
  })
})
