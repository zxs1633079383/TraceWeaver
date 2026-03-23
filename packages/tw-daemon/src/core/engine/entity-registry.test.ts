// packages/tw-daemon/src/core/engine/entity-registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { EntityRegistry } from './entity-registry.js'
import { TransitionError } from '@traceweaver/types'

let registry: EntityRegistry

beforeEach(() => { registry = new EntityRegistry() })

describe('register', () => {
  it('registers a usecase', () => {
    const e = registry.register({ entity_type: 'usecase', id: 'UC-001' })
    expect(e.id).toBe('UC-001')
    expect(e.state).toBe('pending')
    expect(e.entity_type).toBe('usecase')
  })

  it('registers a plan with parent', () => {
    registry.register({ entity_type: 'usecase', id: 'UC-001' })
    const plan = registry.register({
      entity_type: 'plan', id: 'FE-PLAN', parent_id: 'UC-001', domain: 'frontend',
    })
    expect(plan.parent_id).toBe('UC-001')
  })

  it('throws on duplicate id', () => {
    registry.register({ entity_type: 'usecase', id: 'UC-001' })
    expect(() => registry.register({ entity_type: 'usecase', id: 'UC-001' }))
      .toThrow('DUPLICATE_ID')
  })

  it('throws when parent_id not found', () => {
    expect(() =>
      registry.register({ entity_type: 'plan', id: 'FE-PLAN', parent_id: 'MISSING' })
    ).toThrow('PARENT_NOT_FOUND')
  })
})

describe('updateState', () => {
  it('transitions state via guard', () => {
    registry.register({ entity_type: 'usecase', id: 'UC-001' })
    const updated = registry.updateState('UC-001', 'in_progress')
    expect(updated.state).toBe('in_progress')
  })

  it('throws TransitionError on invalid transition', () => {
    registry.register({ entity_type: 'usecase', id: 'UC-001' })
    expect(() => registry.updateState('UC-001', 'completed')).toThrow(TransitionError)
  })

  it('throws when entity not found', () => {
    expect(() => registry.updateState('MISSING', 'in_progress')).toThrow('ENTITY_NOT_FOUND')
  })
})

describe('updateAttributes', () => {
  it('merges attributes', () => {
    registry.register({ entity_type: 'usecase', id: 'UC-001', attributes: { a: 1 } })
    const updated = registry.updateAttributes('UC-001', { b: 2 })
    expect(updated.attributes).toEqual({ a: 1, b: 2 })
  })
})

describe('remove', () => {
  it('removes entity', () => {
    registry.register({ entity_type: 'usecase', id: 'UC-001' })
    registry.remove('UC-001')
    expect(registry.get('UC-001')).toBeUndefined()
  })
})

describe('getChildrenOf', () => {
  it('returns direct children', () => {
    registry.register({ entity_type: 'usecase', id: 'UC-001' })
    registry.register({ entity_type: 'plan', id: 'FE-PLAN', parent_id: 'UC-001' })
    registry.register({ entity_type: 'plan', id: 'BE-PLAN', parent_id: 'UC-001' })
    expect(registry.getChildrenOf('UC-001').map(e => e.id)).toEqual(['FE-PLAN', 'BE-PLAN'])
  })
})
