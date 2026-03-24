// packages/tw-daemon/src/harness/validator.test.ts
import { describe, it, expect } from 'vitest'
import type { HarnessEntry } from './loader.js'
import type { FeedbackLog, HarnessFeedbackSummary } from '../feedback/feedback-log.js'
import { HarnessValidator } from './validator.js'
import type { Entity } from '@traceweaver/types'

// Mock HarnessLoader
const makeLoader = (entries: HarnessEntry[]) => ({
  list: () => entries,
  get: (id: string) => entries.find(e => e.id === id),
})

// Mock FeedbackLog
const makeLog = (summaries: Record<string, Partial<HarnessFeedbackSummary>>) => ({
  getSummary: (id: string) => ({
    harness_id: id,
    total: 0,
    pass: 0,
    fail: 0,
    skipped: 0,
    failure_rate: 0,
    consecutive_failures: 0,
    recent_reasons: [],
    trend: 'unknown',
    last_evaluated: new Date().toISOString(),
    ...summaries[id],
  } as HarnessFeedbackSummary),
}) as unknown as FeedbackLog

// Mock Entity
const makeEntity = (
  id: string,
  type: 'usecase' | 'plan' | 'task',
  refs: string[] = [],
): Entity => ({
  id,
  entity_type: type,
  constraint_refs: refs,
  state: 'pending',
  created_at: '',
  updated_at: '',
  artifact_refs: [],
  parent_id: undefined,
})

// A valid harness entry
const makeHarness = (
  id: string,
  applies_to: ('usecase' | 'plan' | 'task')[] = ['task'],
): HarnessEntry => ({
  id,
  path: `.traceweaver/harness/${id}.md`,
  applies_to,
  trigger_on: ['review'],
  content: `# ${id} constraint`,
})

describe('HarnessValidator', () => {
  it('1. returns empty array when all entities and harnesses are aligned', () => {
    const harness = makeHarness('check-tests', ['task'])
    const entity = makeEntity('task-1', 'task', ['check-tests'])
    const loader = makeLoader([harness])
    const log = makeLog({})
    const validator = new HarnessValidator(loader, log)

    const issues = validator.validate([entity])

    expect(issues).toEqual([])
  })

  it('2. orphaned_ref: detects entity referencing non-existent harness', () => {
    const entity = makeEntity('task-1', 'task', ['missing-harness'])
    const loader = makeLoader([]) // no harnesses loaded
    const log = makeLog({})
    const validator = new HarnessValidator(loader, log)

    const issues = validator.validate([entity])

    expect(issues).toHaveLength(1)
    expect(issues[0].type).toBe('orphaned_ref')
    expect(issues[0].entity_id).toBe('task-1')
    expect(issues[0].harness_id).toBe('missing-harness')
    expect(issues[0].severity).toBe('error')
  })

  it('3. dead_harness: detects harness with applies_to that has no matching entity type', () => {
    const harness = makeHarness('plan-harness', ['plan']) // applies_to plan
    const entity = makeEntity('task-1', 'task') // only task entity, no plan
    const loader = makeLoader([harness])
    const log = makeLog({})
    const validator = new HarnessValidator(loader, log)

    const issues = validator.validate([entity])

    expect(issues).toHaveLength(1)
    expect(issues[0].type).toBe('dead_harness')
    expect(issues[0].harness_id).toBe('plan-harness')
    expect(issues[0].severity).toBe('warning')
  })

  it('4. persistent_failure: consecutive_failures >= threshold is reported', () => {
    const harness = makeHarness('flaky-check', ['task'])
    const entity = makeEntity('task-1', 'task')
    const loader = makeLoader([harness])
    const log = makeLog({ 'flaky-check': { consecutive_failures: 3 } })
    const validator = new HarnessValidator(loader, log)

    const issues = validator.validate([entity])

    const pfIssues = issues.filter(i => i.type === 'persistent_failure')
    expect(pfIssues).toHaveLength(1)
    expect(pfIssues[0].harness_id).toBe('flaky-check')
    expect(pfIssues[0].severity).toBe('warning')
  })

  it('5. persistent_failure: consecutive_failures < threshold is NOT reported', () => {
    const harness = makeHarness('ok-check', ['task'])
    const entity = makeEntity('task-1', 'task')
    const loader = makeLoader([harness])
    const log = makeLog({ 'ok-check': { consecutive_failures: 2 } }) // default threshold is 3
    const validator = new HarnessValidator(loader, log)

    const issues = validator.validate([entity])

    const pfIssues = issues.filter(i => i.type === 'persistent_failure')
    expect(pfIssues).toHaveLength(0)
  })

  it('6. orphaned_ref severity is explicitly "error"', () => {
    const entity = makeEntity('uc-1', 'usecase', ['ghost-ref'])
    const loader = makeLoader([])
    const log = makeLog({})
    const validator = new HarnessValidator(loader, log)

    const issues = validator.validate([entity])

    const orphaned = issues.find(i => i.type === 'orphaned_ref')
    expect(orphaned).toBeDefined()
    expect(orphaned!.severity).toBe('error')
  })

  it('7. suggestion is a non-empty string for all three issue types', () => {
    // Setup to trigger all three issue types simultaneously
    const deadHarness = makeHarness('plan-only', ['plan'])
    const flakyHarness = makeHarness('flaky', ['task'])
    const entity = makeEntity('task-1', 'task', ['orphan-ref']) // task entity → dead plan harness + orphaned ref

    const loader = makeLoader([deadHarness, flakyHarness])
    const log = makeLog({ flaky: { consecutive_failures: 5 } })
    const validator = new HarnessValidator(loader, log)

    const issues = validator.validate([entity])

    const orphanedIssue = issues.find(i => i.type === 'orphaned_ref')
    const deadIssue = issues.find(i => i.type === 'dead_harness')
    const pfIssue = issues.find(i => i.type === 'persistent_failure')

    expect(orphanedIssue).toBeDefined()
    expect(typeof orphanedIssue!.suggestion).toBe('string')
    expect(orphanedIssue!.suggestion!.length).toBeGreaterThan(0)

    expect(deadIssue).toBeDefined()
    expect(typeof deadIssue!.suggestion).toBe('string')
    expect(deadIssue!.suggestion!.length).toBeGreaterThan(0)

    expect(pfIssue).toBeDefined()
    expect(typeof pfIssue!.suggestion).toBe('string')
    expect(pfIssue!.suggestion!.length).toBeGreaterThan(0)
  })
})
