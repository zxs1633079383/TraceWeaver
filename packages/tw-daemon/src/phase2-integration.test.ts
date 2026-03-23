// packages/tw-daemon/src/phase2-integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventBus } from './core/event-bus/event-bus.js'
import { TriggerEvaluator } from './core/event-bus/trigger-evaluator.js'
import { SpanManager } from './otel/span-manager.js'
import { CommandHandler } from './core/command-handler.js'
import type { TriggerRule, TwEvent } from '@traceweaver/types'

describe('Phase 2 Integration: EventBus + SpanManager + CommandHandler', () => {
  let tmpDir: string
  let eventBus: EventBus
  let spanManager: SpanManager
  let handler: CommandHandler

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'tw-p2-'))
    eventBus = new EventBus({ bufferSize: 64, batchWindowMs: 10 })
    spanManager = new SpanManager({ export: false })
    eventBus.start()
    handler = new CommandHandler({ storeDir: tmpDir, eventBus, spanManager })
    await handler.init()
  })

  afterEach(async () => {
    eventBus.stop()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('entity.registered event fires after register()', async () => {
    const events: TwEvent[] = []
    eventBus.subscribe(ev => events.push(ev))

    await handler.register({ entity_type: 'task', id: 'T-1' })
    await new Promise(r => setTimeout(r, 50))

    const registered = events.find(e => e.type === 'entity.registered' && e.entity_id === 'T-1')
    expect(registered).toBeDefined()
    expect(registered?.entity_type).toBe('task')
  })

  it('OTel span created on register, event added on state change', async () => {
    await handler.register({ entity_type: 'task', id: 'T-2' })

    // Span should exist
    expect(spanManager.getSpan('T-2')).toBeDefined()
    expect(spanManager.getSpan('T-2')?.status).toBe('UNSET')

    await handler.updateState({ id: 'T-2', state: 'in_progress' })

    // Span should have event
    const span = spanManager.getSpan('T-2')
    expect(span?.events.some(e => e.name.includes('state_changed'))).toBe(true)
  })

  it('span ends with OK on completed state', async () => {
    await handler.register({ entity_type: 'usecase', id: 'UC-P2' })
    await handler.updateState({ id: 'UC-P2', state: 'in_progress' })
    await handler.updateState({ id: 'UC-P2', state: 'review' })
    await handler.updateState({ id: 'UC-P2', state: 'completed' })

    const span = spanManager.getSpan('UC-P2')
    expect(span?.status).toBe('OK')
    expect(span?.end_time).toBeDefined()
    expect(spanManager.hasActiveSpans()).toBe(false)
  })

  it('span ends with ERROR on rejected state', async () => {
    await handler.register({ entity_type: 'task', id: 'T-REJ' })
    await handler.updateState({ id: 'T-REJ', state: 'in_progress' })
    await handler.updateState({ id: 'T-REJ', state: 'rejected' })

    const span = spanManager.getSpan('T-REJ')
    expect(span?.status).toBe('ERROR')
  })

  it('trigger evaluator fires on state_changed → completed', async () => {
    const rule: TriggerRule = {
      id: 'r1',
      on: { event: 'entity.state_changed', state: 'completed' },
      actions: [{ type: 'propagate', params: { direction: 'bubble_up' } }]
    }
    const evaluator = new TriggerEvaluator([rule])
    const firedRules: string[] = []

    eventBus.subscribe(ev => {
      const matched = evaluator.match(ev)
      matched.forEach(r => firedRules.push(r.id))
    })

    await handler.register({ entity_type: 'usecase', id: 'UC-T' })
    await handler.updateState({ id: 'UC-T', state: 'in_progress' })
    await handler.updateState({ id: 'UC-T', state: 'review' })
    await handler.updateState({ id: 'UC-T', state: 'completed' })
    await new Promise(r => setTimeout(r, 50))

    expect(firedRules).toContain('r1')
  })

  it('entity.removed event fires after remove()', async () => {
    const events: TwEvent[] = []
    eventBus.subscribe(ev => events.push(ev))

    await handler.register({ entity_type: 'task', id: 'T-RM' })
    await handler.remove('T-RM')
    await new Promise(r => setTimeout(r, 50))

    const removed = events.find(e => e.type === 'entity.removed' && e.entity_id === 'T-RM')
    expect(removed).toBeDefined()
  })

  it('getHistory returns events in sequence order', async () => {
    eventBus.start()
    await handler.register({ entity_type: 'task', id: 'T-HIST' })
    await handler.updateState({ id: 'T-HIST', state: 'in_progress' })
    await new Promise(r => setTimeout(r, 50))

    const history = eventBus.getHistory()
    const seqs = history.map(e => e.seq)
    // Verify monotonically increasing
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
    }
  })
})
