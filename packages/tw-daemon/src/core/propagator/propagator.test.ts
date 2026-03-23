import { describe, it, expect } from 'vitest'
import { Propagator } from './propagator.js'
import type { Entity } from '@traceweaver/types'

function makeTask(id: string, parent_id: string, state: Entity['state']): Entity {
  return { id, entity_type: 'task', state, parent_id, created_at: '', updated_at: '' }
}

function makePlan(id: string, parent_id: string, state: Entity['state']): Entity {
  return { id, entity_type: 'plan', state, parent_id, created_at: '', updated_at: '' }
}

function makeUseCase(id: string, state: Entity['state']): Entity {
  return { id, entity_type: 'usecase', state, created_at: '', updated_at: '' }
}

describe('Propagator.bubbleUp', () => {
  it('completes plan when all tasks complete', () => {
    const entities: Entity[] = [
      makeUseCase('UC-1', 'in_progress'),
      makePlan('P-1', 'UC-1', 'in_progress'),
      makeTask('T-1', 'P-1', 'completed'),
      makeTask('T-2', 'P-1', 'completed'),
    ]
    const p = new Propagator(entities)
    const result = p.bubbleUp('T-2', 'completed', 'review')
    const planUpdate = result.updated.find(u => u.id === 'P-1')
    expect(planUpdate?.new_state).toBe('completed')
  })

  it('updates plan progress when some tasks remain', () => {
    const entities: Entity[] = [
      makeUseCase('UC-1', 'in_progress'),
      makePlan('P-1', 'UC-1', 'in_progress'),
      makeTask('T-1', 'P-1', 'completed'),
      makeTask('T-2', 'P-1', 'in_progress'),
    ]
    const p = new Propagator(entities)
    const result = p.bubbleUp('T-1', 'completed', 'review')
    expect(result.updated.find(u => u.id === 'P-1')).toBeUndefined()
    const prog = result.progress_updates.find(u => u.id === 'P-1')
    expect(prog?.done).toBe(1)
    expect(prog?.total).toBe(2)
  })

  it('propagates rejected task back up to plan (in_progress)', () => {
    const entities: Entity[] = [
      makePlan('P-1', 'UC-1', 'completed'),
      makeTask('T-1', 'P-1', 'rejected'),
      makeTask('T-2', 'P-1', 'completed'),
    ]
    const p = new Propagator(entities)
    const result = p.bubbleUp('T-1', 'rejected', 'completed')
    const planUpdate = result.updated.find(u => u.id === 'P-1')
    expect(planUpdate?.new_state).toBe('in_progress')
  })

  it('returns empty result if entity has no parent', () => {
    const entities: Entity[] = [makeUseCase('UC-1', 'in_progress')]
    const p = new Propagator(entities)
    const result = p.bubbleUp('UC-1', 'completed', 'in_progress')
    expect(result.updated).toHaveLength(0)
    expect(result.progress_updates).toHaveLength(0)
  })

  it('recursively bubbles up through plan to usecase', () => {
    const entities: Entity[] = [
      makeUseCase('UC-1', 'in_progress'),
      makePlan('P-1', 'UC-1', 'in_progress'),
      makeTask('T-1', 'P-1', 'completed'),
    ]
    const p = new Propagator(entities)
    const result = p.bubbleUp('T-1', 'completed', 'review')
    // Only 1 task in plan → plan should complete → UC-1 progress update
    const planUpdate = result.updated.find(u => u.id === 'P-1')
    expect(planUpdate?.new_state).toBe('completed')
  })
})

describe('Propagator.cascadeDown', () => {
  it('rejects all plans and tasks when usecase is rejected', () => {
    const entities: Entity[] = [
      makeUseCase('UC-1', 'rejected'),
      makePlan('P-1', 'UC-1', 'in_progress'),
      makeTask('T-1', 'P-1', 'in_progress'),
      makeTask('T-2', 'P-1', 'completed'),
    ]
    const p = new Propagator(entities)
    const result = p.cascadeDown('UC-1', 'rejected')
    const updatedIds = result.updated.map(u => u.id)
    expect(updatedIds).toContain('P-1')
    expect(updatedIds).toContain('T-1')
    expect(updatedIds).toContain('T-2')
  })

  it('does not cascade if entity has no children', () => {
    const entities: Entity[] = [makeTask('T-1', 'P-1', 'in_progress')]
    const p = new Propagator(entities)
    const result = p.cascadeDown('T-1', 'rejected')
    expect(result.updated).toHaveLength(0)
  })
})
