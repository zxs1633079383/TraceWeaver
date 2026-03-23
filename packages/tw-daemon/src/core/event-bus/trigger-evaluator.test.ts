import { describe, it, expect } from 'vitest'
import { TriggerEvaluator } from './trigger-evaluator.js'
import type { TriggerRule, TwEvent } from '@traceweaver/types'

const stateChangedRule: TriggerRule = {
  id: 'r1',
  on: { event: 'entity.state_changed', entity_type: 'task', state: 'completed' },
  actions: [{ type: 'propagate', params: { direction: 'bubble_up' } }]
}

const wildcardRule: TriggerRule = {
  id: 'r2',
  on: { event: '*' },
  actions: [{ type: 'otel', params: { event: 'any' } }]
}

describe('TriggerEvaluator', () => {
  it('matches event matching all criteria', () => {
    const ev: TwEvent = {
      id: 'e1', type: 'entity.state_changed', entity_type: 'task', state: 'completed', ts: new Date().toISOString()
    }
    const evaluator = new TriggerEvaluator([stateChangedRule, wildcardRule])
    const matched = evaluator.match(ev)
    expect(matched).toHaveLength(2)
    expect(matched[0].id).toBe('r1')
    expect(matched[1].id).toBe('r2')
  })

  it('does not match event with wrong state', () => {
    const ev: TwEvent = {
      id: 'e2', type: 'entity.state_changed', entity_type: 'task', state: 'rejected', ts: new Date().toISOString()
    }
    const evaluator = new TriggerEvaluator([stateChangedRule])
    expect(evaluator.match(ev)).toHaveLength(0)
  })

  it('wildcard event matches any type', () => {
    const ev: TwEvent = { id: 'e3', type: 'git.commit', ts: new Date().toISOString() }
    const evaluator = new TriggerEvaluator([wildcardRule])
    expect(evaluator.match(ev)).toHaveLength(1)
  })

  it('entity_type filter filters correctly', () => {
    const rule: TriggerRule = {
      id: 'r3',
      on: { event: 'entity.state_changed', entity_type: 'plan' },
      actions: []
    }
    const evaluator = new TriggerEvaluator([rule])
    const taskEv: TwEvent = { id: 'e4', type: 'entity.state_changed', entity_type: 'task', ts: '' }
    const planEv: TwEvent = { id: 'e5', type: 'entity.state_changed', entity_type: 'plan', ts: '' }
    expect(evaluator.match(taskEv)).toHaveLength(0)
    expect(evaluator.match(planEv)).toHaveLength(1)
  })

  it('empty rules matches nothing', () => {
    const evaluator = new TriggerEvaluator([])
    const ev: TwEvent = { id: 'e6', type: 'entity.registered', ts: '' }
    expect(evaluator.match(ev)).toHaveLength(0)
  })
})
