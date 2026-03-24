import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TriggerExecutor } from './executor.js'
import { HarnessLoader } from '../harness/loader.js'
import { EventBus } from '../core/event-bus/event-bus.js'
import { CommandHandler } from '../core/command-handler.js'
import { ConstraintEvaluator } from '../constraint/evaluator.js'
import { FeedbackLog } from '../feedback/feedback-log.js'

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

  it('Test A: feedbackLog.record() is called with correct data after a fail evaluation', async () => {
    writeFileSync(join(harnessDir, 'always-fail.md'), FAIL_HARNESS)
    const harness = new HarnessLoader(harnessDir)
    await harness.scan()

    const evaluator = new ConstraintEvaluator({
      enabled: true,
      llmFn: async () => 'RESULT: fail\nTest constraint failure',
    })

    const feedbackLog = new FeedbackLog(join(dir, 'feedback', 'feedback.ndjson'))

    const inbox: { messages: string[] } = { messages: [] }
    const inboxAdapter = {
      write: async (msg: { event_type: string; entity_id: string; message: string }) => {
        inbox.messages.push(msg.message)
      },
    }

    const executor = new TriggerExecutor({ handler, evaluator, harness, eventBus, feedbackLog, inbox: inboxAdapter })
    executor.start()

    await handler.register({ id: 'feedback-task-1', entity_type: 'task', constraint_refs: ['always-fail'] })
    await handler.updateState({ id: 'feedback-task-1', state: 'in_progress' })
    await handler.updateState({ id: 'feedback-task-1', state: 'review' })

    await new Promise(r => setTimeout(r, 400))
    executor.stop()

    const history = feedbackLog.getHistory()
    expect(history).toHaveLength(1)
    expect(history[0].result).toBe('fail')
    expect(history[0].harness_id).toBe('always-fail')
    expect(history[0].entity_id).toBe('feedback-task-1')
  })

  it('Test B: inbox receives [FEEDBACK] message after 3 consecutive fail evaluations on same harness', async () => {
    writeFileSync(join(harnessDir, 'always-fail.md'), FAIL_HARNESS)
    const harness = new HarnessLoader(harnessDir)
    await harness.scan()

    const evaluator = new ConstraintEvaluator({
      enabled: true,
      llmFn: async () => 'RESULT: fail\nTest constraint failure',
    })

    const feedbackLog = new FeedbackLog(join(dir, 'feedback2', 'feedback.ndjson'))

    const inboxMessages: string[] = []
    const inboxAdapter = {
      write: async (msg: { event_type: string; entity_id: string; message: string }) => {
        inboxMessages.push(msg.message)
      },
    }

    const executor = new TriggerExecutor({ handler, evaluator, harness, eventBus, feedbackLog, inbox: inboxAdapter })
    executor.start()

    // Register 3 separate entities with different IDs to avoid inFlight guard
    for (let i = 1; i <= 3; i++) {
      await handler.register({ id: `fb-task-${i}`, entity_type: 'task', constraint_refs: ['always-fail'] })
      await handler.updateState({ id: `fb-task-${i}`, state: 'in_progress' })
      await handler.updateState({ id: `fb-task-${i}`, state: 'review' })
      // Wait for each evaluation to complete before the next to ensure sequential recording
      await new Promise(r => setTimeout(r, 400))
    }

    executor.stop()

    const feedbackMessage = inboxMessages.find(m => m.includes('[FEEDBACK]'))
    expect(feedbackMessage).toBeDefined()
    expect(feedbackMessage).toContain('[FEEDBACK]')
    expect(feedbackMessage).toContain('always-fail')
  })
})
