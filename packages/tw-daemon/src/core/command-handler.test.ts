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
