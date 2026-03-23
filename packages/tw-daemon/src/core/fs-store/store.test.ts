// packages/tw-daemon/src/core/fs-store/store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FsStore } from './store.js'
import type { Entity } from '@traceweaver/types'

let tmpDir: string
let store: FsStore

const entity: Entity = {
  id: 'UC-001', entity_type: 'usecase', state: 'pending',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'tw-store-test-'))
  store = new FsStore(tmpDir)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true })
})

describe('writeEntity / readEntity', () => {
  it('writes and reads back an entity', async () => {
    await store.writeEntity(entity)
    const result = await store.readEntity('UC-001', 'usecase')
    expect(result).toEqual(entity)
  })

  it('returns null when entity does not exist', async () => {
    expect(await store.readEntity('MISSING', 'usecase')).toBeNull()
  })
})

describe('listEntities', () => {
  it('lists all entities of a given type', async () => {
    await store.writeEntity(entity)
    await store.writeEntity({ ...entity, id: 'UC-002' })
    const list = await store.listEntities('usecase')
    expect(list.map(e => e.id).sort()).toEqual(['UC-001', 'UC-002'])
  })

  it('returns empty array when directory does not exist', async () => {
    expect(await store.listEntities('plan')).toEqual([])
  })
})

describe('deleteEntity', () => {
  it('deletes entity file', async () => {
    await store.writeEntity(entity)
    await store.deleteEntity('UC-001', 'usecase')
    expect(await store.readEntity('UC-001', 'usecase')).toBeNull()
  })

  it('is a no-op when entity does not exist', async () => {
    await expect(store.deleteEntity('MISSING', 'usecase')).resolves.toBeUndefined()
  })
})
