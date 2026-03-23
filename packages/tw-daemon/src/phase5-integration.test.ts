// packages/tw-daemon/src/phase5-integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandHandler } from './core/command-handler.js'
import { EventBus } from './core/event-bus/event-bus.js'
import { SpanManager } from './otel/span-manager.js'
import { EventLog } from './log/event-log.js'
import { SpanMetrics } from './metrics/span-metrics.js'
import { HarnessLoader } from './harness/loader.js'
import { TriggerExecutor } from './trigger/executor.js'
import { ConstraintEvaluator } from './constraint/evaluator.js'

describe('Phase 5 integration', () => {
  let dir: string
  let eventBus: EventBus
  let handler: CommandHandler
  let eventLog: EventLog
  let spanManager: SpanManager

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tw-phase5-'))
    eventBus = new EventBus({ batchWindowMs: 20 })
    spanManager = new SpanManager()
    eventLog = new EventLog(join(dir, 'events.ndjson'))
    eventLog.load()
    handler = new CommandHandler({ storeDir: dir, eventBus, spanManager, eventLog })
    await handler.init()
    eventBus.start()
  })

  afterEach(() => {
    eventBus.stop()
    rmSync(dir, { recursive: true })
  })

  it('EventLog persists events across handler operations', async () => {
    await handler.register({ id: 'persist-1', entity_type: 'task' })
    await handler.updateState({ id: 'persist-1', state: 'in_progress' })
    await new Promise(r => setTimeout(r, 100))
    const history = eventLog.getHistory()
    expect(history.some(e => e.type === 'entity.registered')).toBe(true)
    expect(history.some(e => e.type === 'entity.state_changed')).toBe(true)
  })

  it('EventLog query filters by entity_id', async () => {
    await handler.register({ id: 'q-1', entity_type: 'task' })
    await handler.register({ id: 'q-2', entity_type: 'task' })
    const result = eventLog.query({ entity_id: 'q-1' })
    expect(result.every(e => e.entity_id === 'q-1')).toBe(true)
  })

  it('ImpactResolver resolves directly affected entities', async () => {
    await handler.register({ id: 'imp-1', entity_type: 'task', artifact_refs: [{ type: 'code', path: 'src/auth.ts' }] })
    await handler.register({ id: 'imp-2', entity_type: 'task', artifact_refs: [{ type: 'code', path: 'src/db.ts' }] })
    const result = handler.resolveImpact('src/auth.ts')
    expect(result.directly_affected.map(e => e.id)).toContain('imp-1')
    expect(result.directly_affected.map(e => e.id)).not.toContain('imp-2')
  })

  it('SpanMetrics getSummary returns valid shape', async () => {
    await handler.register({ id: 'sm-1', entity_type: 'task' })
    const metrics = new SpanMetrics(spanManager)
    const summary = metrics.getSummary()
    expect(summary).toHaveProperty('failureRate')
    expect(summary).toHaveProperty('throughput')
    expect(summary).toHaveProperty('activeSpans')
  })

  it('TriggerExecutor auto-rejects entity on harness fail', async () => {
    const harnessDir = join(dir, 'harness')
    mkdirSync(harnessDir)
    writeFileSync(join(harnessDir, 'strict.md'), `---
id: strict
applies_to:
  - task
trigger_on:
  - review
---
Always fail.
`)
    const harness = new HarnessLoader(harnessDir)
    await harness.scan()

    const evaluator = new ConstraintEvaluator({ enabled: true, llmFn: async () => 'RESULT: fail\nViolation' })
    const executor = new TriggerExecutor({ handler, evaluator, harness, eventBus })
    executor.start()

    await handler.register({ id: 'auto-1', entity_type: 'task', constraint_refs: ['strict'] })
    await handler.updateState({ id: 'auto-1', state: 'in_progress' })
    await handler.updateState({ id: 'auto-1', state: 'review' })
    await new Promise(r => setTimeout(r, 400))
    executor.stop()

    const status = await handler.getStatus({ id: 'auto-1' })
    expect(status.entity.state).toBe('rejected')
  })
})
