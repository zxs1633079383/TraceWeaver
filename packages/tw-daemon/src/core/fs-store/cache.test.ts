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

describe('EntityCache', () => {
  it('stores and retrieves an entity', () => {
    cache.set(e)
    expect(cache.get('UC-001')).toEqual(e)
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
    const all = cache.getAll()
    expect(all).toHaveLength(2)
    expect(all.map(x => x.id).sort()).toEqual(['UC-001', 'UC-002'])
  })

  it('clears all entries', () => {
    cache.set(e)
    cache.clear()
    expect(cache.getAll()).toHaveLength(0)
  })

  it('mutating the original entity after set does not affect the cache', () => {
    const original = { ...e, depends_on: ['DEP-1'] }
    cache.set(original)
    original.depends_on!.push('DEP-2') // mutate original
    const cached = cache.get('UC-001')!
    expect(cached.depends_on).toEqual(['DEP-1']) // cache should be unaffected
  })

  it('mutating the returned entity does not affect the cache', () => {
    cache.set({ ...e, depends_on: ['DEP-1'] })
    const result = cache.get('UC-001')!
    result.depends_on!.push('DEP-2') // mutate returned copy
    const cached2 = cache.get('UC-001')!
    expect(cached2.depends_on).toEqual(['DEP-1']) // cache should be unaffected
  })
})
