import { describe, it, expect, beforeEach } from 'vitest'
import { SpanManager } from './span-manager.js'
import type { Entity } from '@traceweaver/types'

describe('SpanManager', () => {
  let sm: SpanManager

  beforeEach(() => { sm = new SpanManager({ export: false }) })

  it('creates a span with entity attributes', () => {
    sm.createSpan({ entity_id: 'T-1', entity_type: 'task' })
    const meta = sm.getSpan('T-1')
    expect(meta).toBeDefined()
    expect(meta?.entity_id).toBe('T-1')
    expect(meta?.entity_type).toBe('task')
    expect(meta?.status).toBe('UNSET')
    expect(meta?.end_time).toBeUndefined()
    expect(meta?.trace_id).toBeDefined()
    expect(meta?.span_id).toBeDefined()
  })

  it('addEvent appends to span events', () => {
    sm.createSpan({ entity_id: 'T-1', entity_type: 'task' })
    sm.addEvent('T-1', 'task_started', { assignee: 'agent' })
    const meta = sm.getSpan('T-1')
    expect(meta?.events).toHaveLength(1)
    expect(meta?.events[0].name).toBe('task_started')
    expect(meta?.events[0].attributes?.assignee).toBe('agent')
  })

  it('endSpan sets status and end_time', () => {
    sm.createSpan({ entity_id: 'T-1', entity_type: 'task' })
    sm.endSpan('T-1', 'OK')
    const meta = sm.getSpan('T-1')
    expect(meta?.status).toBe('OK')
    expect(meta?.end_time).toBeDefined()
  })

  it('maps entity states to OTel statuses correctly', () => {
    const cases: Array<[Entity['state'], 'UNSET' | 'OK' | 'ERROR']> = [
      ['pending', 'UNSET'],
      ['in_progress', 'UNSET'],
      ['review', 'UNSET'],
      ['completed', 'OK'],
      ['rejected', 'ERROR'],
    ]
    for (const [state, expected] of cases) {
      expect(SpanManager.stateToStatus(state)).toBe(expected)
    }
  })

  it('does not create duplicate spans for same entity', () => {
    sm.createSpan({ entity_id: 'T-1', entity_type: 'task' })
    sm.createSpan({ entity_id: 'T-1', entity_type: 'task' }) // duplicate
    expect(sm.getSpan('T-1')?.events).toHaveLength(0)
  })

  it('getActiveSpans returns only unended spans', () => {
    sm.createSpan({ entity_id: 'T-1', entity_type: 'task' })
    sm.createSpan({ entity_id: 'T-2', entity_type: 'task' })
    sm.endSpan('T-1', 'OK')
    expect(sm.getActiveSpans().map(s => s.entity_id)).toEqual(['T-2'])
  })

  it('hasActiveSpans returns false when all ended', () => {
    sm.createSpan({ entity_id: 'T-1', entity_type: 'task' })
    sm.endSpan('T-1', 'ERROR')
    expect(sm.hasActiveSpans()).toBe(false)
  })

  it('updateAttributes merges into existing attrs', () => {
    sm.createSpan({ entity_id: 'T-1', entity_type: 'task' })
    sm.updateAttributes('T-1', { 'tw.task.retry_count': 2 })
    expect(sm.getSpan('T-1')?.attributes['tw.task.retry_count']).toBe(2)
  })
})

describe('trace_id inheritance', () => {
  let sm: SpanManager

  beforeEach(() => { sm = new SpanManager({ export: false }) })

  it('root span (no parent) generates its own trace_id', () => {
    sm.createSpan({ entity_id: 'uc-1', entity_type: 'usecase' })
    const uc = sm.getSpan('uc-1')!
    expect(uc.trace_id).toBeDefined()
    expect(uc.trace_id).toHaveLength(32)
  })

  it('child span inherits parent trace_id', () => {
    sm.createSpan({ entity_id: 'uc-1', entity_type: 'usecase' })
    const ucSpanId = sm.getSpan('uc-1')!.span_id
    sm.createSpan({ entity_id: 'plan-1', entity_type: 'plan', parent_span_id: ucSpanId })
    expect(sm.getSpan('plan-1')!.trace_id).toBe(sm.getSpan('uc-1')!.trace_id)
  })

  it('grandchild span inherits same trace_id across 3 levels', () => {
    sm.createSpan({ entity_id: 'uc-1', entity_type: 'usecase' })
    const ucSpanId = sm.getSpan('uc-1')!.span_id
    sm.createSpan({ entity_id: 'plan-1', entity_type: 'plan', parent_span_id: ucSpanId })
    const planSpanId = sm.getSpan('plan-1')!.span_id
    sm.createSpan({ entity_id: 'task-1', entity_type: 'task', parent_span_id: planSpanId })
    const ucTraceId = sm.getSpan('uc-1')!.trace_id
    expect(sm.getSpan('plan-1')!.trace_id).toBe(ucTraceId)
    expect(sm.getSpan('task-1')!.trace_id).toBe(ucTraceId)
  })

  it('two different root entities get different trace_ids', () => {
    sm.createSpan({ entity_id: 'uc-1', entity_type: 'usecase' })
    sm.createSpan({ entity_id: 'uc-2', entity_type: 'usecase' })
    expect(sm.getSpan('uc-1')!.trace_id).not.toBe(sm.getSpan('uc-2')!.trace_id)
  })

  it('orphan entity (unknown parent_span_id) generates own trace_id', () => {
    sm.createSpan({ entity_id: 'task-orphan', entity_type: 'task', parent_span_id: 'nonexistent' })
    expect(sm.getSpan('task-orphan')!.trace_id).toBeDefined()
  })
})
