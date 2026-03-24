// packages/tw-daemon/src/core/command-handler.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CommandHandler } from './command-handler.js'

let tmpDir: string
let handler: CommandHandler

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'tw-cmd-test-'))
  handler = new CommandHandler(tmpDir)
  await handler.init()
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true })
})

describe('register', () => {
  it('registers usecase and persists to store', async () => {
    const entity = await handler.register({ entity_type: 'usecase', id: 'UC-001' })
    expect(entity.id).toBe('UC-001')
    expect(entity.state).toBe('pending')
  })

  it('registers plan with parent usecase', async () => {
    await handler.register({ entity_type: 'usecase', id: 'UC-001' })
    const plan = await handler.register({
      entity_type: 'plan', id: 'BE-PLAN', parent_id: 'UC-001', domain: 'backend',
    })
    expect(plan.parent_id).toBe('UC-001')
  })
})

describe('updateState', () => {
  it('transitions state and writes WAL entry', async () => {
    await handler.register({ entity_type: 'usecase', id: 'UC-001' })
    const updated = await handler.updateState({ id: 'UC-001', state: 'in_progress' })
    expect(updated.state).toBe('in_progress')
  })

  it('rejects invalid transition with INVALID_TRANSITION', async () => {
    await handler.register({ entity_type: 'usecase', id: 'UC-001' })
    await expect(handler.updateState({ id: 'UC-001', state: 'completed' }))
      .rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
  })
})

describe('getStatus', () => {
  it('returns project summary when no id given', async () => {
    await handler.register({ entity_type: 'usecase', id: 'UC-001' })
    const status = await handler.getStatus({})
    expect(status.total).toBeGreaterThanOrEqual(1)
  })

  it('returns entity with children when id given', async () => {
    await handler.register({ entity_type: 'usecase', id: 'UC-001' })
    await handler.register({ entity_type: 'plan', id: 'FE-PLAN', parent_id: 'UC-001' })
    const status = await handler.getStatus({ id: 'UC-001' })
    expect(status.entity.id).toBe('UC-001')
  })
})

describe('updateAttributes', () => {
  it('merges attributes', async () => {
    await handler.register({ entity_type: 'usecase', id: 'UC-001', attributes: { a: 1 } })
    const updated = await handler.updateAttributes({ id: 'UC-001', attributes: { b: 2 } })
    expect(updated.attributes).toEqual({ a: 1, b: 2 })
  })
})

describe('remove', () => {
  it('removes entity from registry and store', async () => {
    await handler.register({ entity_type: 'usecase', id: 'UC-001' })
    await handler.remove('UC-001')
    await expect(handler.getStatus({ id: 'UC-001' }))
      .rejects.toMatchObject({ code: 'ENTITY_NOT_FOUND' })
  })
})

describe('init — WAL replay', () => {
  it('restores state from WAL on re-init', async () => {
    await handler.register({ entity_type: 'usecase', id: 'UC-001' })
    await handler.updateState({ id: 'UC-001', state: 'in_progress' })

    // Simulate crash: create fresh handler with same store dir
    const handler2 = new CommandHandler(tmpDir)
    await handler2.init()
    const status = await handler2.getStatus({ id: 'UC-001' })
    expect(status.entity.state).toBe('in_progress')
  })
})

describe('cascadeUpdate', () => {
  it('updates target entity and emits upstream_updated for each descendant', async () => {
    await handler.register({ id: 'uc-1', entity_type: 'usecase' })
    await handler.register({ id: 'plan-1', entity_type: 'plan', parent_id: 'uc-1', depends_on: ['uc-1'] })
    await handler.register({ id: 'task-1', entity_type: 'task', parent_id: 'plan-1', depends_on: ['plan-1'] })

    const result = await handler.cascadeUpdate({
      id: 'uc-1',
      attributes: { description: 'v2' },
      cascade: true,
    })

    expect(result.ok).toBe(true)
    expect(result.data.updated_count).toBe(3) // uc-1 + plan-1 + task-1
  })

  it('cascade:false behaves like update_attributes (updated_count=1)', async () => {
    await handler.register({ id: 'uc-1', entity_type: 'usecase' })
    await handler.register({ id: 'plan-1', entity_type: 'plan', depends_on: ['uc-1'] })

    const result = await handler.cascadeUpdate({
      id: 'uc-1',
      attributes: { description: 'v2' },
      cascade: false,
    })
    expect(result.data.updated_count).toBe(1)
  })

  it('returns ENTITY_NOT_FOUND for unknown id', async () => {
    const result = await handler.cascadeUpdate({
      id: 'nonexistent',
      attributes: {},
      cascade: true,
    })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('ENTITY_NOT_FOUND')
  })
})

describe('remediationNext', () => {
  it('returns null when pending dir is empty', async () => {
    const result = await handler.remediationNext(tmpDir + '/rem-queue')
    expect(result).toBeNull()
  })

  it('moves first pending item to in-progress and returns it', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const queueDir = tmpDir + '/rem-queue'
    await mkdir(queueDir + '/pending', { recursive: true })
    const item = { entity_id: 'task-1', rem_id: 'rem-001', ts: '2026-01-01T00:00:00Z' }
    await writeFile(queueDir + '/pending/rem-001.json', JSON.stringify(item))

    const result = await handler.remediationNext(queueDir)
    expect(result).not.toBeNull()
    expect(result!.rem_id).toBe('rem-001')

    // File should now be in in-progress
    const { readdir } = await import('node:fs/promises')
    const inProg = await readdir(queueDir + '/in-progress')
    expect(inProg).toContain('rem-001.json')
  })
})

describe('remediationDone', () => {
  it('returns ok:false when rem_id not found', async () => {
    const result = await handler.remediationDone({ remId: 'nonexistent', queueDir: tmpDir + '/rem-queue' })
    expect(result.ok).toBe(false)
  })

  it('moves item from in-progress to done', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const queueDir = tmpDir + '/rem-queue2'
    await mkdir(queueDir + '/in-progress', { recursive: true })
    const item = { entity_id: 'task-1', rem_id: 'rem-002', ts: '2026-01-01T00:00:00Z' }
    await writeFile(queueDir + '/in-progress/rem-002.json', JSON.stringify(item))

    const result = await handler.remediationDone({ remId: 'rem-002', queueDir })
    expect(result.ok).toBe(true)

    const { readdir } = await import('node:fs/promises')
    const done = await readdir(queueDir + '/done')
    expect(done).toContain('rem-002.json')
  })
})
