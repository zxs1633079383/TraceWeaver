import { describe, it, expect } from 'vitest'
import { SpanMetrics } from './span-metrics.js'
import { SpanManager } from '../otel/span-manager.js'

function makeManager(): SpanManager {
  const sm = new SpanManager()
  sm.createSpan({ entity_id: 'task-1', entity_type: 'task' })
  sm.addEvent('task-1', 'state_changed_to_in_progress', { from: 'pending' })
  sm.addEvent('task-1', 'state_changed_to_review', { from: 'in_progress' })
  sm.addEvent('task-1', 'state_changed_to_completed', { from: 'review' })
  sm.endSpan('task-1', 'OK')

  sm.createSpan({ entity_id: 'task-2', entity_type: 'task' })
  sm.addEvent('task-2', 'state_changed_to_in_progress', { from: 'pending' })
  sm.addEvent('task-2', 'state_changed_to_rejected', { from: 'in_progress' })
  sm.endSpan('task-2', 'ERROR')

  sm.createSpan({ entity_id: 'uc-1', entity_type: 'usecase' })
  // uc-1 still active (in progress)
  return sm
}

describe('SpanMetrics', () => {
  it('getCycleTime returns phases with duration >= 0', () => {
    const metrics = new SpanMetrics(makeManager())
    const phases = metrics.getCycleTime('task-1')
    expect(phases.length).toBeGreaterThan(0)
    for (const p of phases) {
      expect(p.durationMs).toBeGreaterThanOrEqual(0)
      expect(p.phase).toBeTruthy()
    }
  })

  it('getCycleTime returns empty for unknown entity', () => {
    const metrics = new SpanMetrics(makeManager())
    expect(metrics.getCycleTime('no-such')).toEqual([])
  })

  it('getFailureRate counts rejected spans as failed', () => {
    const metrics = new SpanMetrics(makeManager())
    const rate = metrics.getFailureRate('task')
    expect(rate.total).toBe(2)
    expect(rate.rejected).toBe(1)
    expect(rate.rate).toBeCloseTo(0.5)
  })

  it('getFailureRate with no filter counts all types', () => {
    const metrics = new SpanMetrics(makeManager())
    const rate = metrics.getFailureRate()
    expect(rate.total).toBe(3) // task-1, task-2, uc-1
    expect(rate.rejected).toBe(1)
  })

  it('getThroughput counts completed spans in window', () => {
    const metrics = new SpanMetrics(makeManager())
    const t = metrics.getThroughput(60 * 60 * 1000) // 1h window
    expect(t.completed).toBe(1) // only task-1 is OK/completed
    expect(t.perHour).toBeGreaterThan(0)
  })

  it('getSummary returns all three metrics', () => {
    const metrics = new SpanMetrics(makeManager())
    const summary = metrics.getSummary()
    expect(summary).toHaveProperty('failureRate')
    expect(summary).toHaveProperty('throughput')
    expect(summary).toHaveProperty('activeSpans')
  })
})
