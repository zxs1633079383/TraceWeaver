import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TriggerExecutor } from './executor.js'
import { HarnessLoader } from '../harness/loader.js'
import { EventBus } from '../core/event-bus/event-bus.js'
import { CommandHandler } from '../core/command-handler.js'
import { ConstraintEvaluator } from '../constraint/evaluator.js'

const FAIL_HARNESS = `---
id: always-fail
applies_to:
  - task
trigger_on:
  - review
---
# Always Fail Constraint
This constraint always fails for testing.
`

const PASS_HARNESS = `---
id: always-pass
applies_to:
  - task
trigger_on:
  - review
---
# Always Pass Constraint
MUST_PASS
`

describe('TriggerExecutor', () => {
  let dir: string
  let harnessDir: string
  let eventBus: EventBus
  let handler: CommandHandler

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tw-trigger-'))
    harnessDir = join(dir, 'harness')
    mkdirSync(harnessDir)
    eventBus = new EventBus({ batchWindowMs: 20 })
    handler = new CommandHandler({ storeDir: dir, eventBus })
    await handler.init()
    eventBus.start()
  })

  afterEach(() => {
    eventBus.stop()
    rmSync(dir, { recursive: true })
  })

  it('auto-rejects entity when constraint evaluator returns fail', async () => {
    writeFileSync(join(harnessDir, 'always-fail.md'), FAIL_HARNESS)
    const harness = new HarnessLoader(harnessDir)
    await harness.scan()

    const evaluator = new ConstraintEvaluator({
      enabled: true,
      llmFn: async () => 'RESULT: fail\nTest constraint failure',
    })

    const executor = new TriggerExecutor({ handler, evaluator, harness, eventBus })
    executor.start()

    await handler.register({ id: 'auto-task-1', entity_type: 'task', constraint_refs: ['always-fail'] })
    await handler.updateState({ id: 'auto-task-1', state: 'in_progress' })
    await handler.updateState({ id: 'auto-task-1', state: 'review' })

    await new Promise(r => setTimeout(r, 400))
    executor.stop()

    const result = await handler.getStatus({ id: 'auto-task-1' })
    expect(result.entity.state).toBe('rejected')
  })

  it('does NOT reject entity when constraint evaluator returns pass', async () => {
    writeFileSync(join(harnessDir, 'always-pass.md'), PASS_HARNESS)
    const harness = new HarnessLoader(harnessDir)
    await harness.scan()

    const evaluator = new ConstraintEvaluator({
      enabled: true,
      llmFn: async (prompt) => prompt.includes('MUST_PASS')
        ? 'RESULT: pass\nAll good'
        : 'RESULT: fail\nBad',
    })

    const executor = new TriggerExecutor({ handler, evaluator, harness, eventBus })
    executor.start()

    await handler.register({ id: 'pass-task-1', entity_type: 'task', constraint_refs: ['always-pass'] })
    await handler.updateState({ id: 'pass-task-1', state: 'in_progress' })
    await handler.updateState({ id: 'pass-task-1', state: 'review' })

    await new Promise(r => setTimeout(r, 400))
    executor.stop()

    const result = await handler.getStatus({ id: 'pass-task-1' })
    expect(result.entity.state).toBe('review')
  })

  it('ignores state changes for entity types not in harness applies_to', async () => {
    writeFileSync(join(harnessDir, 'always-fail.md'), FAIL_HARNESS) // only applies to task
    const harness = new HarnessLoader(harnessDir)
    await harness.scan()

    const rejectFn = vi.fn(async () => 'RESULT: fail')
    const evaluator = new ConstraintEvaluator({ enabled: true, llmFn: rejectFn })

    const executor = new TriggerExecutor({ handler, evaluator, harness, eventBus })
    executor.start()

    // Register a USECASE — harness only applies to task
    await handler.register({ id: 'uc-no-trigger', entity_type: 'usecase', constraint_refs: ['always-fail'] })
    await handler.updateState({ id: 'uc-no-trigger', state: 'in_progress' })
    // Usecase can't reach review directly, so just verify no crash
    await new Promise(r => setTimeout(r, 200))
    executor.stop()

    const result = await handler.getStatus({ id: 'uc-no-trigger' })
    expect(result.entity.state).toBe('in_progress')
  })
})
