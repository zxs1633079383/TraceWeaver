import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { CommandHandler } from './core/command-handler.js'
import { EventBus } from './core/event-bus/event-bus.js'
import { SpanManager } from './otel/span-manager.js'
import { EventLog } from './log/event-log.js'
import { ErrorBubbler } from './subscribers/error-bubbler.js'
import { ProgressTracker } from './subscribers/progress-tracker.js'
import { UsecaseMutationHandler } from './subscribers/usecase-mutation-handler.js'
import type { Entity } from '@traceweaver/types'

describe('Lifecycle Integration', () => {
  let tmpDir: string
  let handler: CommandHandler
  let eventBus: EventBus
  let spanManager: SpanManager
  let eventLog: EventLog

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tw-lifecycle-'))
    eventBus = new EventBus()
    eventBus.start()
    spanManager = new SpanManager()
    eventLog = new EventLog(join(tmpDir, 'events.ndjson'))
    eventLog.load()
    handler = new CommandHandler({ storeDir: tmpDir, eventBus, spanManager, eventLog })
    await handler.init()

    // Wire subscribers
    const errorBubbler = new ErrorBubbler({
      spanManager,
      getEntity: (id) => handler.getEntityById(id),
      updateAttributes: (id, attrs) => { void handler.updateAttributes({ id, attributes: attrs }) },
    })
    eventBus.subscribe(event => errorBubbler.handle(event))

    const progressTracker = new ProgressTracker({
      getEntity: (id) => handler.getEntityById(id),
      getChildrenOf: (parentId) => handler.getAllEntities().filter(e => e.parent_id === parentId),
      updateAttributes: (id, attrs) => { void handler.updateAttributes({ id, attributes: attrs }) },
    })
    eventBus.subscribe(event => progressTracker.handle(event))

    const mutationHandler = new UsecaseMutationHandler({
      getEntity: (id) => handler.getEntityById(id),
      getDescendants: (id) => {
        const result: Entity[] = []
        const collect = (pid: string) => {
          const children = handler.getAllEntities().filter(e => e.parent_id === pid)
          for (const child of children) { result.push(child); collect(child.id) }
        }
        collect(id)
        return result
      },
      updateState: (id, state, reason) => { void handler.updateState({ id, state: state as any, reason }) },
      spanAddEvent: (eid, name, attrs) => { spanManager.addEvent(eid, name, attrs) },
    })
    eventBus.subscribe(event => mutationHandler.handle(event))
  })

  afterEach(async () => {
    eventBus.stop()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('scenario: error bubbles from task to usecase', async () => {
    await handler.register({ entity_type: 'usecase', id: 'uc-1' })
    await handler.register({ entity_type: 'plan', id: 'plan-1', parent_id: 'uc-1' })
    await handler.register({ entity_type: 'task', id: 'task-1', parent_id: 'plan-1' })

    // Publish error.captured directly so ErrorBubbler subscriber receives the correct event type
    // (handler.emitEvent wraps as hook.received, which ErrorBubbler does not handle)
    eventBus.publish({
      id: randomUUID(),
      type: 'error.captured',
      entity_id: 'task-1',
      ts: new Date().toISOString(),
      attributes: { source: 'build', message: 'tsc error TS2345' },
    })

    // Allow EventBus batch drain
    await new Promise(r => setTimeout(r, 100))

    const ucSpan = spanManager.getSpan('uc-1')
    expect(ucSpan?.events.some(e => e.name === 'child_error')).toBe(true)
  })

  it('scenario: progress updates on task completion', async () => {
    await handler.register({ entity_type: 'usecase', id: 'uc-1' })
    await handler.register({ entity_type: 'plan', id: 'plan-1', parent_id: 'uc-1' })
    await handler.register({ entity_type: 'task', id: 'task-1', parent_id: 'plan-1' })
    await handler.register({ entity_type: 'task', id: 'task-2', parent_id: 'plan-1' })

    await handler.updateState({ id: 'task-1', state: 'in_progress' })
    await handler.updateState({ id: 'task-1', state: 'review' })
    await handler.updateState({ id: 'task-1', state: 'completed' })

    await new Promise(r => setTimeout(r, 100))

    const plan = handler.getEntityById('plan-1')!
    const progress = plan.attributes?.progress as any
    expect(progress.done).toBe(1)
    expect(progress.total).toBe(2)
    expect(progress.percent).toBe(50)
  })

  it('scenario: usecase update drains downstream', async () => {
    await handler.register({ entity_type: 'usecase', id: 'uc-1' })
    await handler.register({ entity_type: 'plan', id: 'plan-1', parent_id: 'uc-1' })
    await handler.register({ entity_type: 'task', id: 'task-1', parent_id: 'plan-1' })
    await handler.updateState({ id: 'task-1', state: 'in_progress' })

    await handler.usecaseMutate({ id: 'uc-1', mutation_type: 'update', context: 'new requirements' })

    await new Promise(r => setTimeout(r, 200))

    const task = handler.getEntityById('task-1')!
    expect(task.state).toBe('paused')
  })

  it('scenario: session rebind migrates events', async () => {
    await handler.register({ entity_type: 'task', id: 'session-anon' })
    spanManager.addEvent('session-anon', 'tool.invoked', { tool: 'Bash' })

    await handler.register({ entity_type: 'usecase', id: 'uc-1' })
    await handler.register({ entity_type: 'plan', id: 'plan-1', parent_id: 'uc-1' })
    await handler.register({ entity_type: 'task', id: 'task-real', parent_id: 'plan-1' })

    await handler.sessionRebind({ old_entity_id: 'session-anon', new_entity_id: 'task-real' })

    const newSpan = spanManager.getSpan('task-real')!
    expect(newSpan.events.some(e => e.name === 'tool.invoked')).toBe(true)

    const oldEntity = handler.getEntityById('session-anon')!
    expect(oldEntity.state).toBe('superseded')
  })
})
