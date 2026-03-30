// packages/tw-daemon/src/constraint/integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandHandler } from '../core/command-handler.js'
import { EventBus } from '../core/event-bus/event-bus.js'
import { SpanManager } from '../otel/span-manager.js'
import { ConstraintEvaluator } from './evaluator.js'
import { ConstraintHarness } from './harness.js'
import type { TwEvent } from '@traceweaver/types'

describe('Constraint harness integration', () => {
  let dir: string
  let eventBus: EventBus
  let spanManager: SpanManager
  let handler: CommandHandler
  const capturedEvents: TwEvent[] = []

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tw-constraint-integration-'))
    eventBus = new EventBus({ batchWindowMs: 20 })
    spanManager = new SpanManager({ projectId: 'test' })
    handler = new CommandHandler({ storeDir: dir, eventBus, spanManager })
    await handler.init()
    eventBus.start()
    capturedEvents.length = 0
    eventBus.subscribe(event => { capturedEvents.push(event) })
  })

  afterEach(() => {
    eventBus.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it('full pass flow: registers entity, runs harness, verifies result and events', async () => {
    // Register entity with constraint_refs
    const entityId = 'integ-pass-1'
    await handler.register({
      id: entityId,
      entity_type: 'task',
      artifact_refs: [{ type: 'code', path: 'src/main.ts' }],
      attributes: { constraint_refs: ['coding-rules.md'] },
    } as any)

    const entity = handler.getEntityById(entityId)!
    // Attach constraint_refs directly (as the harness reads them from the entity object)
    ;(entity as any).constraint_refs = ['coding-rules.md']

    const evaluator = new ConstraintEvaluator({
      enabled: true,
      llmFn: async () => 'RESULT: pass\nAll constraints satisfied.',
    })
    const harness = new ConstraintHarness({
      evaluator,
      spanManager,
      eventBus,
      timeoutMs: 5_000,
    })

    const result = await harness.run(entity, {
      constraintContents: { 'coding-rules.md': 'Functions must be under 50 lines.' },
    })

    // Result should be pass
    expect(result.entity_id).toBe(entityId)
    expect(result.result).toBe('pass')
    expect(result.refs_checked).toHaveLength(1)
    expect(result.refs_checked[0].result).toBe('pass')
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
    expect(result.error).toBeUndefined()

    // SpanManager should have the constraint span
    const constraintSpan = spanManager.getSpan(`constraint:${entityId}`)
    expect(constraintSpan).toBeDefined()
    expect(constraintSpan?.status).toBe('OK')
    expect(constraintSpan?.end_time).toBeDefined()

    // EventBus should have received constraint.evaluated event
    // Allow a small window for the event bus to drain
    await new Promise(r => setTimeout(r, 60))
    const constraintEvent = capturedEvents.find(e => e.type === 'constraint.evaluated')
    expect(constraintEvent).toBeDefined()
    expect(constraintEvent?.entity_id).toBe(entityId)
    expect(constraintEvent?.attributes?.result).toBe('pass')
  })

  it('full fail flow: harness returns fail when constraint is violated', async () => {
    const entityId = 'integ-fail-1'
    await handler.register({
      id: entityId,
      entity_type: 'task',
      artifact_refs: [],
    } as any)

    const entity = handler.getEntityById(entityId)!
    ;(entity as any).constraint_refs = ['style.md']

    const evaluator = new ConstraintEvaluator({
      enabled: true,
      llmFn: async () => 'RESULT: fail\nFunction exceeds 50 lines.',
    })
    const harness = new ConstraintHarness({
      evaluator,
      spanManager,
      eventBus,
      timeoutMs: 5_000,
    })

    const result = await harness.run(entity, {
      constraintContents: { 'style.md': 'All functions must be under 50 lines.' },
    })

    expect(result.result).toBe('fail')
    expect(result.refs_checked[0].result).toBe('fail')

    const constraintSpan = spanManager.getSpan(`constraint:${entityId}`)
    expect(constraintSpan?.status).toBe('ERROR')

    await new Promise(r => setTimeout(r, 60))
    const ev = capturedEvents.find(e => e.type === 'constraint.evaluated')
    expect(ev?.attributes?.result).toBe('fail')
  })

  it('fault isolation: evaluator throws but main runtime still works', async () => {
    const entityId = 'integ-fault-1'
    await handler.register({
      id: entityId,
      entity_type: 'task',
      artifact_refs: [],
    } as any)

    const entity = handler.getEntityById(entityId)!
    ;(entity as any).constraint_refs = ['rules.md']

    // Evaluator that always throws
    const evaluator = new ConstraintEvaluator({
      enabled: true,
      llmFn: async () => { throw new Error('LLM service unavailable') },
    })
    const harness = new ConstraintHarness({
      evaluator,
      spanManager,
      eventBus,
      timeoutMs: 5_000,
    })

    // Running the harness should not throw — it returns skipped
    const result = await harness.run(entity, {
      constraintContents: { 'rules.md': 'Rule content.' },
    })
    expect(result.result).toBe('skipped')
    expect(result.error).toContain('LLM service unavailable')

    // Main runtime should still work: update entity state (pending → in_progress → review → rejected)
    await handler.updateState({ id: entityId, state: 'in_progress', reason: 'starting' })
    await expect(
      handler.updateState({ id: entityId, state: 'rejected', reason: 'done after constraint failure' })
    ).resolves.toBeDefined()

    const updated = handler.getEntityById(entityId)
    expect(updated?.state).toBe('rejected')

    // And can register new entities
    await expect(
      handler.register({ id: 'post-fault-entity', entity_type: 'task' } as any)
    ).resolves.toBeDefined()
    expect(handler.getEntityById('post-fault-entity')).toBeDefined()
  })

  it('skipped when entity has no constraint_refs', async () => {
    const entityId = 'integ-skip-1'
    await handler.register({
      id: entityId,
      entity_type: 'task',
      artifact_refs: [],
    } as any)

    const entity = handler.getEntityById(entityId)!
    // No constraint_refs attached

    const llmFn = async () => 'RESULT: pass\nOK'
    const evaluator = new ConstraintEvaluator({ enabled: true, llmFn })
    const harness = new ConstraintHarness({ evaluator, spanManager, eventBus })

    const result = await harness.run(entity)

    expect(result.result).toBe('skipped')
    // No constraint span created
    expect(spanManager.getSpan(`constraint:${entityId}`)).toBeUndefined()
    // No constraint.evaluated event emitted
    await new Promise(r => setTimeout(r, 60))
    const ev = capturedEvents.find(e => e.type === 'constraint.evaluated')
    expect(ev).toBeUndefined()
  })

  it('span attributes are correctly set on constraint span', async () => {
    const entityId = 'integ-span-attrs'
    await handler.register({
      id: entityId,
      entity_type: 'task',
      artifact_refs: [{ type: 'code', path: 'src/api.ts' }],
    } as any)

    const entity = handler.getEntityById(entityId)!
    ;(entity as any).constraint_refs = ['ref-a.md', 'ref-b.md']

    const evaluator = new ConstraintEvaluator({
      enabled: true,
      llmFn: async () => 'RESULT: pass\nOK',
    })
    const harness = new ConstraintHarness({
      evaluator,
      spanManager,
      eventBus,
      timeoutMs: 5_000,
    })

    const result = await harness.run(entity, {
      constraintContents: {
        'ref-a.md': 'Rule A',
        'ref-b.md': 'Rule B',
      },
    })

    expect(result.result).toBe('pass')
    expect(result.refs_checked).toHaveLength(2)

    const span = spanManager.getSpan(`constraint:${entityId}`)
    expect(span).toBeDefined()
    expect(span?.attributes['constraint.result']).toBe('pass')
    expect(span?.attributes['constraint.refs_count']).toBe(2)
    expect(span?.attributes['constraint.duration_ms']).toBeGreaterThanOrEqual(0)
  })
})
