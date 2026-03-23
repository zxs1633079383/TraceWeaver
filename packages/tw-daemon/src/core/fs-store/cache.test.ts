// packages/tw-daemon/src/core/fs-store/cache.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { EntityCache } from './cache.js'
import type { Entity } from '@traceweaver/types'

const e: Entity = {
  id: 'UC-001', entity_type: 'usecase', state: 'pending',
  created_at: '', updated_at: '',
}

let cache: EntityCache

beforeEach(() => { cache = new EntityCache() })

it('stores and retrieves an entity', () => {
  cache.set(e)
  expect(cache.get('UC-001')).toMatchObject({ id: 'UC-001' })
})

it('returns undefined for missing key', () => {
  expect(cache.get('MISSING')).toBeUndefined()
})

it('invalidates an entry', () => {
  cache.set(e)
  cache.invalidate('UC-001')
  expect(cache.get('UC-001')).toBeUndefined()
})

it('returns all entries', () => {
  cache.set(e)
  cache.set({ ...e, id: 'UC-002' })
  expect(cache.getAll()).toHaveLength(2)
})

it('clears all entries', () => {
  cache.set(e)
  cache.clear()
  expect(cache.getAll()).toHaveLength(0)
})
