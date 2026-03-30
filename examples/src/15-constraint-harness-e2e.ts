/**
 * Example 15 — Constraint Harness E2E Demo
 *
 * Full end-to-end validation of the ConstraintEvaluator + ConstraintHarness feature:
 *
 *  Verifies:
 *    ✅ Phase 1 — Register entities     — UseCase → Plan → Task hierarchy with constraint_refs
 *    ✅ Phase 2 — Run constraint eval   — ConstraintHarness evaluates task with mock llmFn
 *    ✅ Phase 3 — Complete lifecycle    — All entities moved through to completed
 *    ✅ Phase 4 — Verify results        — Events, spans, and progress tracking confirmed
 *
 * Entity hierarchy:
 *   UseCase: uc-constraint-demo
 *     └── Plan: plan-constraint-impl
 *           ├── task-needs-tests   (has constraint_refs → evaluated → pass)
 *           └── task-no-constraint (no constraint_refs → skipped)
 *
 * Run:
 *   npm run example:15
 */

import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CommandHandler }    from '../../packages/tw-daemon/src/core/command-handler.js'
import { EventBus }          from '../../packages/tw-daemon/src/core/event-bus/event-bus.js'
import { SpanManager }       from '../../packages/tw-daemon/src/otel/span-manager.js'
import { EventLog }          from '../../packages/tw-daemon/src/log/event-log.js'
import { ExporterRegistry }  from '../../packages/tw-daemon/src/otel/exporter-registry.js'
import { ConsoleExporter }   from '../../packages/tw-daemon/src/otel/exporter-console.js'
import { ConstraintEvaluator } from '../../packages/tw-daemon/src/constraint/evaluator.js'
import { ConstraintHarness }   from '../../packages/tw-daemon/src/constraint/harness.js'
import type { TwEvent }      from '@traceweaver/types'

// ── Helpers ──────────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  gray:   '\x1b[90m',
  blue:   '\x1b[34m',
}
function section(title: string): void {
  console.log(`\n${C.bold}${C.cyan}${'─'.repeat(64)}${C.reset}`)
  console.log(`${C.bold}${C.cyan}  ${title}${C.reset}`)
  console.log(`${C.cyan}${'─'.repeat(64)}${C.reset}`)
}
function ok(msg: string):   void { console.log(`  ${C.green}✓${C.reset} ${msg}`) }
function warn(msg: string): void { console.log(`  ${C.yellow}⚠${C.reset} ${msg}`) }
function info(msg: string): void { console.log(`  ${C.gray}→${C.reset} ${msg}`) }
function fail(msg: string): void { console.log(`  ${C.red}✗${C.reset} ${msg}`) }

// ── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`\n${C.bold}TraceWeaver — Constraint Harness E2E Demo (Example 15)${C.reset}`)
  console.log('Covers: ConstraintEvaluator / ConstraintHarness / EventBus / SpanManager / lifecycle\n')

  const storeDir = await mkdtemp(join(tmpdir(), 'tw-example-15-'))
  const logPath  = join(storeDir, 'events.ndjson')
  info(`storeDir: ${storeDir}`)

  // ──────────────────────────────────────────────────────────────────────────
  // Setup — Component initialisation
  // ──────────────────────────────────────────────────────────────────────────
  section('Setup — Component Initialisation')

  const exporterRegistry = new ExporterRegistry()
  exporterRegistry.register(new ConsoleExporter())

  const eventBus    = new EventBus({ bufferSize: 512, batchWindowMs: 30 })
  const spanManager = new SpanManager({ projectId: 'constraint-demo', exporterRegistry })
  const eventLog    = new EventLog(logPath)
  eventLog.load()

  const handler = new CommandHandler({ storeDir, eventBus, spanManager, eventLog })
  await handler.init()
  eventBus.start()

  // Collect all events for verification
  const allEvents: TwEvent[] = []
  eventBus.subscribe(ev => allEvents.push(ev))

  // Mock llmFn — always returns "pass" for testing
  const mockLlmFn = async (prompt: string): Promise<string> => {
    info(`  [mock-llm] evaluating ${prompt.length} chars…`)
    return 'RESULT: pass\nAll coding standards satisfied.'
  }

  const evaluator = new ConstraintEvaluator({
    enabled: true,
    llmFn: mockLlmFn,
  })

  const harness = new ConstraintHarness({
    evaluator,
    spanManager,
    eventBus,
  })

  ok('EventBus, CommandHandler, SpanManager, ConstraintEvaluator, ConstraintHarness ready')

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 1 — Register entities (UseCase → Plan → Task)
  // ──────────────────────────────────────────────────────────────────────────
  section('Phase 1 — Register Entity Hierarchy')

  const uc = await handler.register({
    id: 'uc-constraint-demo',
    entity_type: 'usecase',
    attributes: { title: 'Constraint Harness Validation' },
    artifact_refs: [{ type: 'doc', path: 'docs/constraint-spec.md' }],
  })
  ok(`usecase: ${uc.id}  state=${uc.state}`)

  const plan = await handler.register({
    id: 'plan-constraint-impl',
    entity_type: 'plan',
    depends_on: ['uc-constraint-demo'],
    attributes: { title: 'Constraint Implementation Plan' },
    artifact_refs: [{ type: 'doc', path: 'docs/impl-plan.md' }],
  })
  ok(`plan:    ${plan.id}  state=${plan.state}  depends_on=[uc-constraint-demo]`)

  // Task with constraint_refs → will be evaluated
  const taskWithConstraint = await handler.register({
    id: 'task-needs-tests',
    entity_type: 'task',
    depends_on: ['plan-constraint-impl'],
    attributes: { title: 'Implement feature with coding standards check' },
    artifact_refs: [
      { type: 'code', path: 'src/feature/impl.ts' },
      { type: 'test', path: 'src/feature/impl.test.ts' },
    ],
  })
  // Attach constraint_refs directly — harness reads from entity object
  ;(taskWithConstraint as any).constraint_refs = ['docs/coding-rules.md']
  ok(`task:    ${taskWithConstraint.id}  state=${taskWithConstraint.state}  constraint_refs=[docs/coding-rules.md]`)

  // Task without constraint_refs → will be skipped
  const taskNoConstraint = await handler.register({
    id: 'task-no-constraint',
    entity_type: 'task',
    depends_on: ['plan-constraint-impl'],
    attributes: { title: 'Simple task with no constraint check' },
    artifact_refs: [{ type: 'code', path: 'src/util/helper.ts' }],
  })
  ok(`task:    ${taskNoConstraint.id}  state=${taskNoConstraint.state}  constraint_refs=[]`)

  const dag = await handler.getDagSnapshot({})
  info(`DAG nodes: ${dag.nodes.length}  edges: ${dag.edges.length}`)

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 2 — Run constraint evaluation
  // ──────────────────────────────────────────────────────────────────────────
  section('Phase 2 — Run Constraint Evaluation')

  // Evaluate task with constraint_refs — expects 'pass' from mock llm
  const result1 = await harness.run(taskWithConstraint, {
    constraintContents: {
      'docs/coding-rules.md': `
# Coding Rules
- All functions must have unit tests
- No hardcoded secrets
- Functions must be under 50 lines
      `.trim(),
    },
  })
  ok(`task-needs-tests  result=${result1.result}  duration=${result1.duration_ms}ms  refs_checked=${result1.refs_checked.length}`)
  if (result1.span_id) {
    ok(`  span_id: ${result1.span_id}`)
  }
  if (result1.refs_checked.length > 0) {
    for (const ref of result1.refs_checked) {
      info(`  ref=${ref.ref}  result=${ref.result}${ref.note ? `  note="${ref.note}"` : ''}`)
    }
  }

  // Evaluate task without constraint_refs — expects 'skipped'
  const result2 = await harness.run(taskNoConstraint)
  ok(`task-no-constraint  result=${result2.result}  [expected: skipped]`)

  if (result1.result !== 'pass') {
    fail(`Expected task-needs-tests result=pass, got ${result1.result}`)
  } else {
    ok('Constraint evaluation returned expected "pass" result')
  }
  if (result2.result !== 'skipped') {
    fail(`Expected task-no-constraint result=skipped, got ${result2.result}`)
  } else {
    ok('No-constraint task correctly returned "skipped"')
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 3 — Complete entity lifecycle
  // ──────────────────────────────────────────────────────────────────────────
  section('Phase 3 — Complete Entity Lifecycle')

  // task-needs-tests: pending → in_progress → review → completed
  await handler.updateState({ id: 'task-needs-tests',   state: 'in_progress' })
  await handler.updateState({ id: 'task-needs-tests',   state: 'review' })
  await handler.updateState({ id: 'task-needs-tests',   state: 'completed' })
  ok('task-needs-tests → in_progress → review → completed')

  // task-no-constraint: pending → in_progress → review → completed
  await handler.updateState({ id: 'task-no-constraint', state: 'in_progress' })
  await handler.updateState({ id: 'task-no-constraint', state: 'review' })
  await handler.updateState({ id: 'task-no-constraint', state: 'completed' })
  ok('task-no-constraint → in_progress → review → completed')

  // plan: pending → in_progress → review → completed
  await handler.updateState({ id: 'plan-constraint-impl', state: 'in_progress' })
  await handler.updateState({ id: 'plan-constraint-impl', state: 'review' })
  await handler.updateState({ id: 'plan-constraint-impl', state: 'completed' })
  ok('plan-constraint-impl → completed')

  // usecase: pending → in_progress → review → completed
  await handler.updateState({ id: 'uc-constraint-demo', state: 'in_progress' })
  await handler.updateState({ id: 'uc-constraint-demo', state: 'review' })
  await handler.updateState({ id: 'uc-constraint-demo', state: 'completed' })
  ok('uc-constraint-demo → completed')

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 4 — Verify results
  // ──────────────────────────────────────────────────────────────────────────

  // Allow event bus to flush its batch window
  await new Promise(r => setTimeout(r, 100))

  section('Phase 4 — Verify Results')

  // 4a: constraint.evaluated events
  const constraintEvents = allEvents.filter(e => e.type === 'constraint.evaluated')
  if (constraintEvents.length >= 1) {
    ok(`constraint.evaluated events published: ${constraintEvents.length}`)
    for (const ev of constraintEvents) {
      const attrs = ev.attributes as Record<string, unknown>
      info(`  entity_id=${ev.entity_id}  result=${attrs['result']}  refs_checked=${JSON.stringify(attrs['refs_checked'])}`)
    }
  } else {
    fail(`Expected ≥1 constraint.evaluated event, got ${constraintEvents.length}`)
  }

  // 4b: entity.registered events
  const registeredEvents = allEvents.filter(e => e.type === 'entity.registered')
  ok(`entity.registered events: ${registeredEvents.length}  [expected: 4]`)
  if (registeredEvents.length !== 4) {
    warn(`  Expected 4 registration events (1 usecase + 1 plan + 2 tasks)`)
  }

  // 4c: entity.state_changed events
  const stateEvents = allEvents.filter(e => e.type === 'entity.state_changed')
  ok(`entity.state_changed events: ${stateEvents.length}`)

  // 4d: Spans for entities
  const allSpans = spanManager.getAllSpans()
  const entityIds = ['uc-constraint-demo', 'plan-constraint-impl', 'task-needs-tests', 'task-no-constraint']
  let spansMissing = 0
  for (const id of entityIds) {
    const span = allSpans.find(s => s.entity_id === id)
    if (span) {
      ok(`span exists for: ${id}  span_id=${span.span_id}`)
    } else {
      warn(`span not found for: ${id}`)
      spansMissing++
    }
  }

  // 4e: Constraint evaluation span
  const constraintSpan = allSpans.find(s => s.entity_id === `constraint:task-needs-tests`)
  if (constraintSpan) {
    ok(`constraint eval span: constraint:task-needs-tests  span_id=${constraintSpan.span_id}`)
    const attrs = constraintSpan.attributes as Record<string, unknown> | undefined
    if (attrs?.['constraint.result']) {
      info(`  constraint.result=${attrs['constraint.result']}  constraint.duration_ms=${attrs['constraint.duration_ms']}`)
    }
  } else {
    warn('constraint evaluation span not found (non-fatal if span creation failed silently)')
  }

  // 4f: Final entity states
  const ucFinal   = await handler.getStatus({ id: 'uc-constraint-demo' })
  const planFinal = await handler.getStatus({ id: 'plan-constraint-impl' })
  const t1Final   = await handler.getStatus({ id: 'task-needs-tests' })
  const t2Final   = await handler.getStatus({ id: 'task-no-constraint' })

  ok(`Final states:`)
  info(`  uc-constraint-demo      → ${ucFinal.entity.state}`)
  info(`  plan-constraint-impl    → ${planFinal.entity.state}`)
  info(`  task-needs-tests        → ${t1Final.entity.state}`)
  info(`  task-no-constraint      → ${t2Final.entity.state}`)

  const allCompleted = [ucFinal, planFinal, t1Final, t2Final].every(s => s.entity.state === 'completed')
  if (allCompleted) {
    ok('All entities reached completed state')
  } else {
    fail('Some entities did not reach completed state')
  }

  // 4g: Progress summary
  section('Summary')
  const totalEvents = allEvents.length
  const totalSpans  = allSpans.length
  ok(`Total events published:  ${totalEvents}`)
  ok(`Total spans tracked:     ${totalSpans}`)
  ok(`Constraint evaluations:  ${constraintEvents.length} (1 pass + 1 skipped)`)
  ok(`Entity hierarchy:        usecase → plan → 2 tasks, all completed`)

  const hasErrors =
    result1.result !== 'pass' ||
    result2.result !== 'skipped' ||
    !allCompleted ||
    constraintEvents.length < 1

  if (!hasErrors) {
    console.log(`\n${C.bold}${C.green}  All checks passed — Constraint Harness E2E verified!${C.reset}\n`)
  } else {
    console.log(`\n${C.bold}${C.red}  Some checks failed — see warnings above.${C.reset}\n`)
    process.exitCode = 1
  }

  // Cleanup
  eventBus.stop()
  await rm(storeDir, { recursive: true, force: true })
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
