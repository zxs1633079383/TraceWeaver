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

describe('usecaseMutate', () => {
  it('insert: registers multiple entities under usecase', async () => {
    await handler.register({ id: 'uc-1', entity_type: 'usecase' })

    const result = await handler.usecaseMutate({
      id: 'uc-1',
      mutation_type: 'insert',
      entities: [
        { id: 'plan-a', entity_type: 'plan', parent_id: 'uc-1' },
        { id: 'plan-b', entity_type: 'plan', parent_id: 'uc-1' },
      ],
    })

    expect(result.ok).toBe(true)
    expect(result.data?.registered_count).toBe(2)
    expect(handler.getEntityById('plan-a')).toBeDefined()
    expect(handler.getEntityById('plan-b')).toBeDefined()
  })

  it('update: emits usecase.mutated event and stores mutation_context', async () => {
    const { EventBus } = await import('./event-bus/event-bus.js')
    const eventBus = new EventBus()
    eventBus.start()
    const localTmpDir = await (await import('node:fs/promises')).mkdtemp(
      join((await import('node:os')).tmpdir(), 'tw-cmd-mutate-')
    )
    const { CommandHandler: CH } = await import('./command-handler.js')
    const h = new CH({ storeDir: localTmpDir, eventBus })
    await h.init()

    await h.register({ id: 'uc-1', entity_type: 'usecase' })

    const captured: any[] = []
    eventBus.subscribe(ev => captured.push(ev))

    const result = await h.usecaseMutate({
      id: 'uc-1',
      mutation_type: 'update',
      context: 'added new requirements',
    })

    expect(result.ok).toBe(true)

    const entity = h.getEntityById('uc-1')
    expect(entity?.attributes?.mutation_context).toBe('added new requirements')
    expect(entity?.attributes?.mutation_type).toBe('update')

    // Wait for EventBus drain window (50ms default)
    await new Promise(resolve => setTimeout(resolve, 100))

    const mutatedEvent = captured.find(ev => ev.type === 'usecase.mutated')
    expect(mutatedEvent).toBeDefined()
    expect(mutatedEvent.entity_id).toBe('uc-1')
    expect(mutatedEvent.attributes?.context).toBe('added new requirements')

    eventBus.stop()
    await (await import('node:fs/promises')).rm(localTmpDir, { recursive: true })
  })

  it('fails for non-existent usecase', async () => {
    const result = await handler.usecaseMutate({
      id: 'nonexistent',
      mutation_type: 'insert',
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('ENTITY_NOT_FOUND')
  })
})

describe('usecaseReplace', () => {
  it('supersedes listed entities and registers new ones', async () => {
    await handler.register({ id: 'uc-1', entity_type: 'usecase' })
    await handler.register({ id: 'plan-1', entity_type: 'plan', parent_id: 'uc-1' })
    await handler.register({ id: 'task-1', entity_type: 'task', parent_id: 'plan-1' })

    // Transition task-1 to paused so it can be superseded
    await handler.updateState({ id: 'task-1', state: 'in_progress' })
    await handler.updateState({ id: 'task-1', state: 'paused' })

    const result = await handler.usecaseReplace({
      id: 'uc-1',
      supersede: ['task-1'],
      new_entities: [
        { id: 'task-2', entity_type: 'task', parent_id: 'plan-1' },
      ],
    })

    expect(result.ok).toBe(true)
    expect(result.data?.superseded_count).toBe(1)
    expect(result.data?.registered_count).toBe(1)

    const supersededTask = handler.getEntityById('task-1')
    expect(supersededTask?.state).toBe('superseded')

    expect(handler.getEntityById('task-2')).toBeDefined()
  })

  it('returns ENTITY_NOT_FOUND for non-existent base entity', async () => {
    const result = await handler.usecaseReplace({
      id: 'nonexistent',
      supersede: [],
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('ENTITY_NOT_FOUND')
  })
})

describe('sessionRebind', () => {
  it('migrates events from old entity to new entity and supersedes old', async () => {
    const { EventBus } = await import('./event-bus/event-bus.js')
    const { SpanManager } = await import('../otel/span-manager.js')
    const eventBus = new EventBus()
    eventBus.start()
    const spanManager = new SpanManager()
    const localTmpDir = await (await import('node:fs/promises')).mkdtemp(
      join((await import('node:os')).tmpdir(), 'tw-cmd-rebind-')
    )
    const { CommandHandler: CH } = await import('./command-handler.js')
    const h = new CH({ storeDir: localTmpDir, eventBus, spanManager })
    await h.init()

    await h.register({ id: 'session-abc', entity_type: 'usecase' })
    await h.register({ id: 'task-real', entity_type: 'task' })

    // Add an event to the session-abc span
    spanManager.addEvent('session-abc', 'user_action', { detail: 'clicked' })

    const captured: any[] = []
    eventBus.subscribe(ev => captured.push(ev))

    const result = await h.sessionRebind({
      old_entity_id: 'session-abc',
      new_entity_id: 'task-real',
    })

    expect(result.ok).toBe(true)

    // Old entity should be superseded
    const oldEntity = h.getEntityById('session-abc')
    expect(oldEntity?.state).toBe('superseded')

    // Wait for EventBus drain window (50ms default)
    await new Promise(resolve => setTimeout(resolve, 100))

    // session.rebound event should be emitted
    const reboundEvent = captured.find(ev => ev.type === 'session.rebound')
    expect(reboundEvent).toBeDefined()
    expect(reboundEvent.entity_id).toBe('task-real')
    expect(reboundEvent.attributes?.old_entity_id).toBe('session-abc')

    eventBus.stop()
    await (await import('node:fs/promises')).rm(localTmpDir, { recursive: true })
  })

  it('returns ENTITY_NOT_FOUND when old entity does not exist', async () => {
    await handler.register({ id: 'task-real', entity_type: 'task' })
    const result = await handler.sessionRebind({
      old_entity_id: 'nonexistent',
      new_entity_id: 'task-real',
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('ENTITY_NOT_FOUND')
  })

  it('returns ENTITY_NOT_FOUND when new entity does not exist', async () => {
    await handler.register({ id: 'session-abc', entity_type: 'usecase' })
    const result = await handler.sessionRebind({
      old_entity_id: 'session-abc',
      new_entity_id: 'nonexistent',
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('ENTITY_NOT_FOUND')
  })
})
