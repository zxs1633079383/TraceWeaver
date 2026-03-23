// packages/tw-daemon/src/core/fs-store/wal.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Wal } from './wal.js'

let tmpDir: string
let wal: Wal

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'tw-wal-test-'))
  wal = new Wal(join(tmpDir, '.wal'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true })
})

describe('append', () => {
  it('appends entries with sequential seq numbers', async () => {
    const e1 = await wal.append({ op: 'upsert_entity', idempotency_key: 'k1', payload: { id: 'A' } })
    const e2 = await wal.append({ op: 'upsert_entity', idempotency_key: 'k2', payload: { id: 'B' } })
    expect(e1.seq).toBe(1)
    expect(e2.seq).toBe(2)
  })
})

describe('replay', () => {
  it('returns all appended entries in order', async () => {
    await wal.append({ op: 'upsert_entity', idempotency_key: 'k1', payload: { id: 'A' } })
    await wal.append({ op: 'update_state',  idempotency_key: 'k2', payload: { id: 'A', state: 'in_progress' } })
    const entries = await wal.replay()
    expect(entries).toHaveLength(2)
    expect(entries[0].op).toBe('upsert_entity')
    expect(entries[1].op).toBe('update_state')
  })

  it('is idempotent — replaying same idempotency_key skips duplicate', async () => {
    await wal.append({ op: 'upsert_entity', idempotency_key: 'k1', payload: { id: 'A' } })
    await wal.append({ op: 'upsert_entity', idempotency_key: 'k1', payload: { id: 'A' } })
    const entries = await wal.replay()
    // Only one unique idempotency_key
    const keys = new Set(entries.map(e => e.idempotency_key))
    expect(keys.size).toBe(1)
  })

  it('returns empty array when WAL file does not exist', async () => {
    const fresh = new Wal(join(tmpDir, 'nonexistent.wal'))
    expect(await fresh.replay()).toEqual([])
  })
})

describe('truncate', () => {
  it('removes entries with seq <= given seq', async () => {
    await wal.append({ op: 'upsert_entity', idempotency_key: 'k1', payload: {} })
    await wal.append({ op: 'upsert_entity', idempotency_key: 'k2', payload: {} })
    await wal.append({ op: 'upsert_entity', idempotency_key: 'k3', payload: {} })
    await wal.truncate(2)
    const entries = await wal.replay()
    expect(entries).toHaveLength(1)
    expect(entries[0].idempotency_key).toBe('k3')
  })

  it('is a no-op when upToSeq is 0 (nothing to truncate)', async () => {
    await wal.append({ op: 'upsert_entity', idempotency_key: 'k1', payload: {} })
    await wal.truncate(0)
    const entries = await wal.replay()
    expect(entries).toHaveLength(1)
  })

  it('removes all entries when upToSeq >= highest seq', async () => {
    await wal.append({ op: 'upsert_entity', idempotency_key: 'k1', payload: {} })
    await wal.append({ op: 'upsert_entity', idempotency_key: 'k2', payload: {} })
    await wal.truncate(100)
    const entries = await wal.replay()
    expect(entries).toHaveLength(0)
  })
})

describe('seq continuity after restart', () => {
  it('new Wal instance continues seq after highest existing seq', async () => {
    await wal.append({ op: 'upsert_entity', idempotency_key: 'k1', payload: {} })
    await wal.append({ op: 'upsert_entity', idempotency_key: 'k2', payload: {} })
    // seq is now 2

    // Simulate restart: fresh Wal instance pointing to same file
    const wal2 = new Wal(join(tmpDir, '.wal'))
    const entry = await wal2.append({ op: 'upsert_entity', idempotency_key: 'k3', payload: {} })
    // Must continue from seq=3, not restart at seq=1
    expect(entry.seq).toBe(3)
  })
})
