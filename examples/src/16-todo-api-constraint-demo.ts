/**
 * Example 16 — Todo API Constraint Demo (Comprehensive)
 *
 * Full-scale demo simulating the Todo API project with constraint harness integration.
 * Covers all major TraceWeaver features in a single end-to-end scenario:
 *
 *  Phase 1: Setup — Components + Jaeger gRPC + Subscribers
 *  Phase 2: Register Entity Hierarchy — 3 UseCases, ~20 Tasks
 *  Phase 3: Execute UC1 (CRUD) — Normal flow with constraint evaluation
 *  Phase 4: Execute UC2 (Validation) — Constraint FAIL + fix + re-evaluate
 *  Phase 5: Execute UC3 (Search) — UseCase mutation (drain + replace)
 *  Phase 6: Verify — Events, Spans, Progress, Constraints
 *  Phase 7: Flush to Jaeger + Summary
 *
 * Run:
 *   JAEGER_ENDPOINT=localhost:4317 npm run example:16
 */

import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CommandHandler }          from '../../packages/tw-daemon/src/core/command-handler.js'
import { EventBus }                from '../../packages/tw-daemon/src/core/event-bus/event-bus.js'
import { SpanManager }             from '../../packages/tw-daemon/src/otel/span-manager.js'
import { EventLog }                from '../../packages/tw-daemon/src/log/event-log.js'
import { ExporterRegistry }        from '../../packages/tw-daemon/src/otel/exporter-registry.js'
import { OtlpGrpcExporter }       from '../../packages/tw-daemon/src/otel/exporter-grpc.js'
import { ConstraintEvaluator }     from '../../packages/tw-daemon/src/constraint/evaluator.js'
import { ConstraintHarness }       from '../../packages/tw-daemon/src/constraint/harness.js'
import { TraceQueryEngine }         from '../../packages/tw-daemon/src/otel/trace-query.js'
import { ErrorBubbler }            from '../../packages/tw-daemon/src/subscribers/error-bubbler.js'
import { ProgressTracker }         from '../../packages/tw-daemon/src/subscribers/progress-tracker.js'
import { UsecaseMutationHandler }  from '../../packages/tw-daemon/src/subscribers/usecase-mutation-handler.js'
import type { TwEvent, Entity, RegisterParams } from '@traceweaver/types'

// ── Colored Output Helpers ──────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  gray:   '\x1b[90m',
  blue:   '\x1b[34m',
  magenta:'\x1b[35m',
}

function section(title: string): void {
  console.log(`\n${C.bold}${C.cyan}${'═'.repeat(68)}${C.reset}`)
  console.log(`${C.bold}${C.cyan}  ${title}${C.reset}`)
  console.log(`${C.cyan}${'═'.repeat(68)}${C.reset}`)
}

function subsection(title: string): void {
  console.log(`\n${C.bold}${C.blue}  ── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}${C.reset}`)
}

function ok(msg: string):   void { console.log(`  ${C.green}✓${C.reset} ${msg}`) }
function fail(msg: string): void { console.log(`  ${C.red}✗${C.reset} ${msg}`) }
function info(msg: string): void { console.log(`  ${C.gray}→${C.reset} ${msg}`) }
function warn(msg: string): void { console.log(`  ${C.yellow}⚠${C.reset} ${msg}`) }

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

// ── Main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`\n${C.bold}${C.magenta}TraceWeaver — Example 16: Todo API Constraint Demo${C.reset}`)
  console.log(`${C.gray}The most comprehensive demo: 3 UseCases, constraints, error bubbling,`)
  console.log(`progress tracking, usecase mutation (drain + replace), and Jaeger export.${C.reset}\n`)

  const JAEGER_ENDPOINT    = process.env.JAEGER_ENDPOINT ?? 'localhost:4317'
  const PROJECT_ID         = `todo-api-demo-${new Date().toISOString().slice(0, 10)}`
  const TODO_PROJECT_ROOT  = process.env.TODO_PROJECT_ROOT ?? '/Users/mac28/workspace/temp/todo-api-demo'
  const storeDir           = await mkdtemp(join(tmpdir(), 'tw-example-16-'))

  info(`Jaeger endpoint : ${JAEGER_ENDPOINT}`)
  info(`Project ID      : ${PROJECT_ID}`)
  info(`Todo project    : ${TODO_PROJECT_ROOT}`)
  info(`Store dir       : ${storeDir}`)

  // Track constraint evaluations for summary
  let constraintPassCount = 0
  let constraintFailCount = 0
  let constraintSkipCount = 0

  // Track whether task-schema-test mock should return fail or pass
  let schemaTestFixed = false

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 1: Setup
  // ══════════════════════════════════════════════════════════════════════════
  section('Phase 1: Setup — Components + Jaeger gRPC + Subscribers')

  const exporterRegistry = new ExporterRegistry()
  const grpcExporter = new OtlpGrpcExporter({ endpoint: JAEGER_ENDPOINT })
  exporterRegistry.register(grpcExporter)
  ok(`OtlpGrpcExporter registered → ${JAEGER_ENDPOINT}`)

  const eventBus    = new EventBus({ bufferSize: 1024, batchWindowMs: 30 })
  const spanManager = new SpanManager({ projectId: PROJECT_ID, exporterRegistry })
  const eventLog    = new EventLog(join(storeDir, 'events.ndjson'))
  eventLog.load()

  const handler = new CommandHandler({ storeDir, eventBus, spanManager, eventLog })
  await handler.init()
  eventBus.start()
  ok('EventBus, SpanManager, CommandHandler, EventLog initialized')

  // Collect all events
  const allEvents: TwEvent[] = []
  eventBus.subscribe(ev => allEvents.push(ev))

  // Wire ErrorBubbler
  const errorBubbler = new ErrorBubbler({
    spanManager,
    getEntity: (id: string) => handler.getEntityById(id),
    updateAttributes: (id: string, attrs: Record<string, unknown>) => {
      void handler.updateAttributes({ id, attributes: attrs })
    },
  })
  eventBus.subscribe(event => errorBubbler.handle(event))
  ok('ErrorBubbler subscriber wired')

  // Wire ProgressTracker
  const progressTracker = new ProgressTracker({
    getEntity: (id: string) => handler.getEntityById(id),
    getChildrenOf: (parentId: string) => handler.getAllEntities().filter(e => e.parent_id === parentId),
    updateAttributes: (id: string, attrs: Record<string, unknown>) => {
      void handler.updateAttributes({ id, attributes: attrs })
    },
  })
  eventBus.subscribe(event => progressTracker.handle(event))
  ok('ProgressTracker subscriber wired')

  // Wire UsecaseMutationHandler
  const usecaseMutationHandler = new UsecaseMutationHandler({
    getEntity: (id: string) => handler.getEntityById(id),
    getDescendants: (id: string) => {
      const result: Entity[] = []
      const collect = (parentId: string) => {
        const children = handler.getAllEntities().filter(e => e.parent_id === parentId)
        for (const child of children) {
          result.push(child)
          collect(child.id)
        }
      }
      collect(id)
      return result
    },
    updateState: (id: string, state: string, reason: string) => {
      void handler.updateState({ id, state: state as any, reason })
    },
    spanAddEvent: (entityId: string, name: string, attrs: Record<string, unknown>) => {
      spanManager.addEvent(entityId, name, attrs)
    },
  })
  eventBus.subscribe(event => usecaseMutationHandler.handle(event))
  ok('UsecaseMutationHandler subscriber wired')

  // Smart mock LLM: reads real files from todo-api-demo, checks constraints
  const smartLlmFn = async (prompt: string): Promise<string> => {
    const taskMatch = prompt.match(/TASK:\s*(\S+)/)
    const taskId = taskMatch?.[1] ?? ''

    // For task-schema-test: read the REAL test file and check for edge case
    if (taskId === 'task-schema-test') {
      const testFilePath = join(TODO_PROJECT_ROOT, 'src/schemas/todo.test.ts')
      try {
        const testContent = await readFile(testFilePath, 'utf8')
        info(`  [smart-llm] Reading real file: ${testFilePath} (${testContent.length} chars)`)

        // Check if test file has empty string edge case assertion
        const hasEmptyStringTest = testContent.includes("''") || testContent.includes('""')
          || testContent.includes('empty string') && testContent.includes('expect')
          && !testContent.includes('// BUG')

        if (!hasEmptyStringTest) {
          return 'RESULT: fail\nTest file src/schemas/todo.test.ts has no assertion for edge case: empty title string. coding-rules.md requires: "Edge cases required: empty string". Add: it(\'rejects empty title\', () => { expect(validateCreateTodo({ title: \'\' }).success).toBe(false) })'
        }
        return 'RESULT: pass\nAll edge cases covered including empty string validation.'
      } catch {
        return 'RESULT: skipped\nCould not read test file'
      }
    }

    // For other tasks: read constraint file and do basic check
    info(`  [smart-llm] Evaluating ${taskId} against coding-rules.md`)
    return 'RESULT: pass\nAll coding standards satisfied.'
  }

  const evaluator = new ConstraintEvaluator({ enabled: true, llmFn: smartLlmFn, projectRoot: TODO_PROJECT_ROOT })
  const harness = new ConstraintHarness({ evaluator, spanManager, eventBus })
  ok('ConstraintEvaluator + ConstraintHarness created')

  // ── Helper: move task through lifecycle ────────────────────────────────
  async function advanceTask(id: string, states: string[]): Promise<void> {
    for (const state of states) {
      await handler.updateState({ id, state: state as any })
    }
    await wait(40)
  }

  async function progressReport(entityId: string): Promise<void> {
    const status = await handler.getStatus({ id: entityId })
    const progress = status.entity.attributes?.progress as any
    if (progress) {
      info(`  ${entityId} progress: ${progress.done}/${progress.total} (${progress.percent}%)`)
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 2: Register Entity Hierarchy
  // ══════════════════════════════════════════════════════════════════════════
  section('Phase 2: Register Entity Hierarchy (3 UseCases, ~20 Tasks)')

  // ── UC1: uc-crud ──────────────────────────────────────────────────────
  subsection('UC1: uc-crud (Todo CRUD API)')

  await handler.register({ id: 'uc-crud', entity_type: 'usecase', attributes: { title: 'Todo CRUD API' } })
  ok('usecase: uc-crud')

  // plan-setup
  await handler.register({ id: 'plan-setup', entity_type: 'plan', parent_id: 'uc-crud', depends_on: ['uc-crud'], attributes: { title: 'Project Scaffolding' } })
  await handler.register({ id: 'task-init-project', entity_type: 'task', parent_id: 'plan-setup', depends_on: ['plan-setup'], attributes: { title: 'npm init + tsconfig' } })
  await handler.register({ id: 'task-setup-express', entity_type: 'task', parent_id: 'plan-setup', depends_on: ['plan-setup'], attributes: { title: 'Express setup' } })
  ok('plan-setup: 2 tasks')

  // plan-model
  await handler.register({ id: 'plan-model', entity_type: 'plan', parent_id: 'uc-crud', depends_on: ['uc-crud'], attributes: { title: 'Data Model' } })
  await handler.register({ id: 'task-todo-interface', entity_type: 'task', parent_id: 'plan-model', depends_on: ['plan-model'], attributes: { title: 'Todo interface definition' } })
  await handler.register({ id: 'task-storage-layer', entity_type: 'task', parent_id: 'plan-model', depends_on: ['plan-model'], attributes: { title: 'In-memory storage layer' } })
  ok('plan-model: 2 tasks')

  // plan-endpoints (tasks have constraint_refs)
  await handler.register({ id: 'plan-endpoints', entity_type: 'plan', parent_id: 'uc-crud', depends_on: ['uc-crud'], attributes: { title: 'REST Endpoints' } })

  const taskCreate = await handler.register({ id: 'task-create-endpoint', entity_type: 'task', parent_id: 'plan-endpoints', depends_on: ['plan-endpoints'],
    attributes: { title: 'POST /todos' }, artifact_refs: [{ type: 'code', path: 'src/routes/create.ts' }] })
  ;(taskCreate as any).constraint_refs = ['docs/coding-rules.md']

  const taskRead = await handler.register({ id: 'task-read-endpoint', entity_type: 'task', parent_id: 'plan-endpoints', depends_on: ['plan-endpoints'],
    attributes: { title: 'GET /todos' }, artifact_refs: [{ type: 'code', path: 'src/routes/read.ts' }] })
  ;(taskRead as any).constraint_refs = ['docs/coding-rules.md']

  const taskDelete = await handler.register({ id: 'task-delete-endpoint', entity_type: 'task', parent_id: 'plan-endpoints', depends_on: ['plan-endpoints'],
    attributes: { title: 'DELETE /todos/:id' }, artifact_refs: [{ type: 'code', path: 'src/routes/delete.ts' }] })
  ;(taskDelete as any).constraint_refs = ['docs/coding-rules.md']

  ok('plan-endpoints: 3 tasks (all with constraint_refs: [docs/coding-rules.md])')

  // ── UC2: uc-validation ────────────────────────────────────────────────
  subsection('UC2: uc-validation (Input Validation)')

  await handler.register({ id: 'uc-validation', entity_type: 'usecase', attributes: { title: 'Input Validation' } })
  ok('usecase: uc-validation')

  // plan-schema
  await handler.register({ id: 'plan-schema', entity_type: 'plan', parent_id: 'uc-validation', depends_on: ['uc-validation'], attributes: { title: 'Validation Schemas' } })

  const taskZodSchema = await handler.register({ id: 'task-zod-schema', entity_type: 'task', parent_id: 'plan-schema', depends_on: ['plan-schema'],
    attributes: { title: 'Zod schema definitions' }, artifact_refs: [{ type: 'code', path: 'src/schemas/todo.ts' }] })
  ;(taskZodSchema as any).constraint_refs = ['docs/coding-rules.md']

  const taskSchemaTest = await handler.register({ id: 'task-schema-test', entity_type: 'task', parent_id: 'plan-schema', depends_on: ['plan-schema'],
    attributes: { title: 'Schema unit tests (will FAIL constraint)' }, artifact_refs: [{ type: 'test', path: 'src/schemas/todo.test.ts' }] })
  ;(taskSchemaTest as any).constraint_refs = ['docs/coding-rules.md']

  ok('plan-schema: 2 tasks (task-schema-test will intentionally FAIL constraint)')

  // plan-error-handling
  await handler.register({ id: 'plan-error-handling', entity_type: 'plan', parent_id: 'uc-validation', depends_on: ['uc-validation'], attributes: { title: 'Error Handling' } })
  await handler.register({ id: 'task-error-middleware', entity_type: 'task', parent_id: 'plan-error-handling', depends_on: ['plan-error-handling'], attributes: { title: 'Error middleware' } })
  await handler.register({ id: 'task-error-test', entity_type: 'task', parent_id: 'plan-error-handling', depends_on: ['plan-error-handling'], attributes: { title: 'Error handling tests' } })
  ok('plan-error-handling: 2 tasks')

  // ── UC3: uc-search ────────────────────────────────────────────────────
  subsection('UC3: uc-search (Search & Pagination) — will have mutation')

  await handler.register({ id: 'uc-search', entity_type: 'usecase', attributes: { title: 'Search & Pagination' } })
  ok('usecase: uc-search')

  // plan-pagination
  await handler.register({ id: 'plan-pagination', entity_type: 'plan', parent_id: 'uc-search', depends_on: ['uc-search'], attributes: { title: 'Pagination' } })
  await handler.register({ id: 'task-paginate-logic', entity_type: 'task', parent_id: 'plan-pagination', depends_on: ['plan-pagination'], attributes: { title: 'Pagination logic' } })
  await handler.register({ id: 'task-paginate-test', entity_type: 'task', parent_id: 'plan-pagination', depends_on: ['plan-pagination'], attributes: { title: 'Pagination tests' } })
  ok('plan-pagination: 2 tasks')

  // plan-search (will be mutated)
  await handler.register({ id: 'plan-search', entity_type: 'plan', parent_id: 'uc-search', depends_on: ['uc-search'], attributes: { title: 'Search' } })

  const taskSearchImpl = await handler.register({ id: 'task-search-impl', entity_type: 'task', parent_id: 'plan-search', depends_on: ['plan-search'],
    attributes: { title: 'Search implementation' }, artifact_refs: [{ type: 'code', path: 'src/search/engine.ts' }] })
  ;(taskSearchImpl as any).constraint_refs = ['docs/coding-rules.md']

  await handler.register({ id: 'task-search-test', entity_type: 'task', parent_id: 'plan-search', depends_on: ['plan-search'], attributes: { title: 'Search tests' } })
  ok('plan-search: 2 tasks (will be superseded by mutation)')

  await wait(80) // let event bus drain

  const dag = handler.getDagSnapshot()
  ok(`DAG: ${dag.nodes.length} nodes, ${dag.edges.length} edges`)

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 3: Execute UC1 — Normal flow with constraint evaluation
  // ══════════════════════════════════════════════════════════════════════════
  section('Phase 3: Execute UC1 — Normal flow + Constraint Evaluation')

  subsection('plan-setup: task-init-project, task-setup-express')
  await advanceTask('task-init-project', ['in_progress', 'review', 'completed'])
  ok('task-init-project → completed')
  await advanceTask('task-setup-express', ['in_progress', 'review', 'completed'])
  ok('task-setup-express → completed')
  await advanceTask('plan-setup', ['in_progress', 'review', 'completed'])
  ok('plan-setup → completed')
  await progressReport('uc-crud')

  subsection('plan-model: task-todo-interface, task-storage-layer')
  await advanceTask('task-todo-interface', ['in_progress', 'review', 'completed'])
  ok('task-todo-interface → completed')
  await advanceTask('task-storage-layer', ['in_progress', 'review', 'completed'])
  ok('task-storage-layer → completed')
  await advanceTask('plan-model', ['in_progress', 'review', 'completed'])
  ok('plan-model → completed')
  await progressReport('uc-crud')

  subsection('plan-endpoints: constraint evaluation on endpoint tasks')

  // task-create-endpoint
  await handler.updateState({ id: 'task-create-endpoint', state: 'in_progress' })
  const r1 = await harness.run(taskCreate, {})
  if (r1.result === 'pass') { constraintPassCount++; ok(`task-create-endpoint constraint: PASS`) }
  else { constraintFailCount++; fail(`task-create-endpoint constraint: ${r1.result}`) }
  await advanceTask('task-create-endpoint', ['review', 'completed'])
  ok('task-create-endpoint → completed')

  // task-read-endpoint
  await handler.updateState({ id: 'task-read-endpoint', state: 'in_progress' })
  const r2 = await harness.run(taskRead, {})
  if (r2.result === 'pass') { constraintPassCount++; ok(`task-read-endpoint constraint: PASS`) }
  else { constraintFailCount++; fail(`task-read-endpoint constraint: ${r2.result}`) }
  await advanceTask('task-read-endpoint', ['review', 'completed'])
  ok('task-read-endpoint → completed')

  // task-delete-endpoint
  await handler.updateState({ id: 'task-delete-endpoint', state: 'in_progress' })
  const r3 = await harness.run(taskDelete, {})
  if (r3.result === 'pass') { constraintPassCount++; ok(`task-delete-endpoint constraint: PASS`) }
  else { constraintFailCount++; fail(`task-delete-endpoint constraint: ${r3.result}`) }
  await advanceTask('task-delete-endpoint', ['review', 'completed'])
  ok('task-delete-endpoint → completed')

  await advanceTask('plan-endpoints', ['in_progress', 'review', 'completed'])
  ok('plan-endpoints → completed')

  // Complete UC1
  await advanceTask('uc-crud', ['in_progress', 'review', 'completed'])
  ok('uc-crud → completed')
  await progressReport('uc-crud')

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 4: Execute UC2 — Constraint FAIL scenario
  // ══════════════════════════════════════════════════════════════════════════
  section('Phase 4: Execute UC2 — Constraint FAIL + Fix + Re-evaluate')

  subsection('plan-schema: task-zod-schema (pass) + task-schema-test (FAIL)')

  // task-zod-schema: normal pass
  await handler.updateState({ id: 'task-zod-schema', state: 'in_progress' })
  const r4 = await harness.run(taskZodSchema, {})
  if (r4.result === 'pass') { constraintPassCount++; ok(`task-zod-schema constraint: PASS`) }
  else { constraintFailCount++; fail(`task-zod-schema constraint: ${r4.result}`) }
  await advanceTask('task-zod-schema', ['review', 'completed'])
  ok('task-zod-schema → completed')

  // task-schema-test: constraint FAIL
  await handler.updateState({ id: 'task-schema-test', state: 'in_progress' })
  const r5 = await harness.run(taskSchemaTest, {})
  if (r5.result === 'fail') {
    constraintFailCount++
    fail(`task-schema-test constraint: FAIL — "${r5.refs_checked[0]?.note ?? 'unknown'}"`)

    // Publish error.captured event (message from harness result, not hardcoded)
    eventBus.publish({
      id: crypto.randomUUID(),
      type: 'error.captured',
      entity_id: 'task-schema-test',
      entity_type: 'task',
      ts: new Date().toISOString(),
      attributes: {
        source: 'constraint',
        message: r5.refs_checked[0]?.note ?? 'constraint evaluation failed',
        constraint_ref: r5.refs_checked[0]?.ref,
        constraint_result: r5.result,
      },
    })
    await wait(80)

    // Verify error bubbled up
    const ucValStatus = await handler.getStatus({ id: 'uc-validation' })
    const ucErrors = ucValStatus.entity.attributes?.errors as any[] | undefined
    if (ucErrors && ucErrors.length > 0) {
      ok(`ErrorBubbler: error bubbled to uc-validation (${ucErrors.length} error(s))`)
      info(`  origin: ${ucErrors[0].origin_entity_id}, source: ${ucErrors[0].source}`)
    } else {
      warn('ErrorBubbler: no errors found on uc-validation (may not have propagated yet)')
    }
  } else {
    constraintPassCount++
    warn(`Expected task-schema-test to FAIL but got: ${r5.result}`)
  }

  // Step 1: Agent queries trace info for structured error context (per real-project-integration-guide.md)
  subsection('Agent queries: tw trace info --entity-id task-schema-test')
  const traceQuery = new TraceQueryEngine({
    spanManager,
    getAllEntities: () => handler.getAllEntities(),
    getEntity: (id: string) => handler.getEntityById(id),
  })
  const traceId = traceQuery.findTraceId('task-schema-test')
  if (traceId) {
    const traceInfo = traceQuery.buildTraceInfo(traceId)
    if (traceInfo) {
      ok(`trace_id: ${traceId}`)
      info(`  _ai_context.one_line: "${traceInfo._ai_context.one_line}"`)
      if (traceInfo._ai_context.next_actions.length > 0) {
        for (const action of traceInfo._ai_context.next_actions) {
          info(`  next_action: ${action}`)
        }
      }
      if (traceInfo._ai_context.error_refs.length > 0) {
        for (const ref of traceInfo._ai_context.error_refs) {
          info(`  error_ref: ${ref}`)
        }
      }
    }
  }

  // Step 2: Agent reads constraint span attributes for specific failure detail
  const constraintSpan = spanManager.getSpan(`constraint:task-schema-test`)
  if (constraintSpan) {
    const refName = constraintSpan.attributes['constraint.ref.0.name']
    const refResult = constraintSpan.attributes['constraint.ref.0.result']
    const refNote = constraintSpan.attributes['constraint.ref.0.note']
    ok(`Constraint span attributes:`)
    info(`  ref: ${refName} → ${refResult}`)
    info(`  note: "${refNote}"`)
    info(`  → Agent now knows exactly what to fix`)
  }

  // Step 3: Agent fixes the REAL code file based on structured error info
  subsection('Fix: task-schema-test — Agent modifies real test file')
  info('Agent reads constraint.ref.0.note → missing empty string edge case')
  info(`Agent writes fix to: ${TODO_PROJECT_ROOT}/src/schemas/todo.test.ts`)

  const testFilePath = join(TODO_PROJECT_ROOT, 'src/schemas/todo.test.ts')
  const originalContent = await readFile(testFilePath, 'utf8')

  // Agent adds the missing edge case test (replacing the BUG comment)
  const fixedContent = originalContent.replace(
    `  // BUG: missing edge case test for empty string title\n  // coding-rules.md requires: "Edge cases required: empty string"`,
    `  it('rejects empty title string', () => {\n    const result = validateCreateTodo({ title: '' })\n    expect(result.success).toBe(false)\n  })`
  )
  await writeFile(testFilePath, fixedContent, 'utf8')
  ok(`File written: src/schemas/todo.test.ts (${originalContent.length} → ${fixedContent.length} chars)`)

  // Step 4: Re-evaluate after fix
  const r5fix = await harness.run(taskSchemaTest, {})
  if (r5fix.result === 'pass') {
    constraintPassCount++
    ok(`task-schema-test constraint re-evaluation: PASS`)
  } else {
    constraintFailCount++
    fail(`task-schema-test constraint re-evaluation: ${r5fix.result}`)
  }
  await advanceTask('task-schema-test', ['review', 'completed'])
  ok('task-schema-test → completed (after fix)')
  await advanceTask('plan-schema', ['in_progress', 'review', 'completed'])
  ok('plan-schema → completed')

  subsection('plan-error-handling: normal completion')
  await advanceTask('task-error-middleware', ['in_progress', 'review', 'completed'])
  ok('task-error-middleware → completed')
  await advanceTask('task-error-test', ['in_progress', 'review', 'completed'])
  ok('task-error-test → completed')
  await advanceTask('plan-error-handling', ['in_progress', 'review', 'completed'])
  ok('plan-error-handling → completed')

  // Complete UC2
  await advanceTask('uc-validation', ['in_progress', 'review', 'completed'])
  ok('uc-validation → completed')
  await progressReport('uc-validation')

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 5: Execute UC3 — UseCase mutation (drain + replace)
  // ══════════════════════════════════════════════════════════════════════════
  section('Phase 5: Execute UC3 — UseCase Mutation (drain + replace)')

  subsection('plan-pagination: complete normally')
  await advanceTask('task-paginate-logic', ['in_progress', 'review', 'completed'])
  ok('task-paginate-logic → completed')
  await advanceTask('task-paginate-test', ['in_progress', 'review', 'completed'])
  ok('task-paginate-test → completed')
  await advanceTask('plan-pagination', ['in_progress', 'review', 'completed'])
  ok('plan-pagination → completed')
  await progressReport('uc-search')

  subsection('plan-search: start, then MUTATE')
  await handler.updateState({ id: 'plan-search', state: 'in_progress' })
  await handler.updateState({ id: 'task-search-impl', state: 'in_progress' })
  ok('task-search-impl → in_progress')
  info('Developer starts working on search implementation...')

  // MUTATION: requirements changed
  subsection('MUTATION: Requirements changed — add full-text search with Elasticsearch')
  info('usecaseMutate(uc-search, update, "Requirements changed: add full-text search with Elasticsearch")')

  const mutateResult = await handler.usecaseMutate({
    id: 'uc-search',
    mutation_type: 'update',
    context: 'Requirements changed: add full-text search with Elasticsearch',
  })
  await wait(100) // let UsecaseMutationHandler drain

  if (mutateResult.ok) {
    ok('usecaseMutate succeeded')
  } else {
    fail(`usecaseMutate failed: ${mutateResult.error?.message}`)
  }

  // Check if in_progress tasks were paused
  const searchImplAfterMutation = handler.getEntityById('task-search-impl')
  if (searchImplAfterMutation?.state === 'paused') {
    ok(`task-search-impl drained to paused state`)
  } else {
    info(`task-search-impl state after mutation: ${searchImplAfterMutation?.state ?? 'unknown'}`)
  }

  const searchTestAfterMutation = handler.getEntityById('task-search-test')
  info(`task-search-test state after mutation: ${searchTestAfterMutation?.state ?? 'unknown'}`)

  // REPLACE: supersede plan-search, register plan-fulltext-search
  subsection('REPLACE: Supersede old search, register new full-text search')

  const replaceResult = await handler.usecaseReplace({
    id: 'uc-search',
    supersede: ['plan-search', 'task-search-impl', 'task-search-test'],
    new_entities: [
      {
        id: 'plan-fulltext-search',
        entity_type: 'plan',
        parent_id: 'uc-search',
        depends_on: ['uc-search'],
        attributes: { title: 'Full-text Search with Elasticsearch' },
      } as RegisterParams,
      {
        id: 'task-elastic-setup',
        entity_type: 'task',
        parent_id: 'plan-fulltext-search',
        depends_on: ['plan-fulltext-search'],
        attributes: { title: 'Elasticsearch client setup' },
      } as RegisterParams,
      {
        id: 'task-fulltext-index',
        entity_type: 'task',
        parent_id: 'plan-fulltext-search',
        depends_on: ['plan-fulltext-search'],
        attributes: { title: 'Full-text indexing logic' },
      } as RegisterParams,
      {
        id: 'task-fulltext-search-api',
        entity_type: 'task',
        parent_id: 'plan-fulltext-search',
        depends_on: ['plan-fulltext-search'],
        attributes: { title: 'Full-text search API endpoint' },
        artifact_refs: [{ type: 'code', path: 'src/search/fulltext.ts' }],
      } as RegisterParams,
      {
        id: 'task-fulltext-test',
        entity_type: 'task',
        parent_id: 'plan-fulltext-search',
        depends_on: ['plan-fulltext-search'],
        attributes: { title: 'Full-text search tests' },
      } as RegisterParams,
    ],
  })

  await wait(80)

  if (replaceResult.ok) {
    ok(`usecaseReplace: superseded ${replaceResult.data?.superseded_count}, registered ${replaceResult.data?.registered_count}`)
  } else {
    fail(`usecaseReplace failed: ${replaceResult.error?.message}`)
  }

  // Verify superseded states
  for (const id of ['plan-search', 'task-search-impl', 'task-search-test']) {
    const entity = handler.getEntityById(id)
    info(`  ${id} → ${entity?.state ?? 'unknown'}`)
  }

  // Complete new plan-fulltext-search tasks
  subsection('Complete new full-text search tasks')
  await advanceTask('task-elastic-setup', ['in_progress', 'review', 'completed'])
  ok('task-elastic-setup → completed')
  await advanceTask('task-fulltext-index', ['in_progress', 'review', 'completed'])
  ok('task-fulltext-index → completed')
  await advanceTask('task-fulltext-search-api', ['in_progress', 'review', 'completed'])
  ok('task-fulltext-search-api → completed')
  await advanceTask('task-fulltext-test', ['in_progress', 'review', 'completed'])
  ok('task-fulltext-test → completed')
  await advanceTask('plan-fulltext-search', ['in_progress', 'review', 'completed'])
  ok('plan-fulltext-search → completed')

  // Complete UC3
  await advanceTask('uc-search', ['in_progress', 'review', 'completed'])
  ok('uc-search → completed')
  await progressReport('uc-search')

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 6: Verify
  // ══════════════════════════════════════════════════════════════════════════
  await wait(100) // let event bus drain

  section('Phase 6: Verify — Events, Spans, Progress, Constraints')

  // 6a: Event counts by type
  subsection('Event Counts')
  const eventCounts = new Map<string, number>()
  for (const ev of allEvents) {
    eventCounts.set(ev.type, (eventCounts.get(ev.type) ?? 0) + 1)
  }
  for (const [type, count] of Array.from(eventCounts.entries()).sort()) {
    info(`${type.padEnd(30)} ${count}`)
  }
  ok(`Total events: ${allEvents.length}`)

  // 6b: Span status summary
  subsection('Span Status')
  const allSpans = spanManager.getAllSpans()
  for (const span of allSpans) {
    const statusLabel = span.status === 'OK' ? `${C.green}OK${C.reset}` :
                        span.status === 'ERROR' ? `${C.red}ERROR${C.reset}` :
                        `${C.yellow}${span.status ?? 'ACTIVE'}${C.reset}`
    info(`${span.entity_id?.padEnd(35) ?? '???'} ${statusLabel}`)
  }
  ok(`Total spans: ${allSpans.length}`)

  // 6c: Progress for each UC
  subsection('UseCase Progress')
  for (const ucId of ['uc-crud', 'uc-validation', 'uc-search']) {
    const status = await handler.getStatus({ id: ucId })
    const state = status.entity.state
    const progress = status.entity.attributes?.progress as any
    const pct = progress?.percent ?? 'N/A'
    const stateColor = state === 'completed' ? C.green : C.yellow
    ok(`${ucId.padEnd(20)} state=${stateColor}${state}${C.reset}  progress=${pct}%`)
  }

  // 6d: Constraint evaluation summary
  subsection('Constraint Evaluation Summary')
  const constraintEvents = allEvents.filter(e => e.type === 'constraint.evaluated')
  ok(`Constraint evaluations: ${constraintEvents.length} total`)
  ok(`  Pass: ${constraintPassCount}  Fail: ${constraintFailCount}  Skip: ${constraintSkipCount}`)
  for (const ev of constraintEvents) {
    const attrs = ev.attributes as Record<string, unknown>
    info(`  entity_id=${ev.entity_id}  result=${attrs['result']}`)
  }

  // 6e: Mutation verification
  subsection('UseCase Mutation Verification')
  const mutatedEvents = allEvents.filter(e => e.type === 'usecase.mutated')
  ok(`usecase.mutated events: ${mutatedEvents.length}`)
  for (const ev of mutatedEvents) {
    const attrs = ev.attributes as Record<string, unknown>
    info(`  entity_id=${ev.entity_id}  mutation_type=${attrs['mutation_type']}  context="${attrs['context']}"`)
  }

  const supersededEntities = handler.getAllEntities().filter(e => e.state === 'superseded')
  ok(`Superseded entities: ${supersededEntities.length}`)
  for (const e of supersededEntities) {
    info(`  ${e.id} (${e.entity_type})`)
  }

  // 6f: Error bubbling verification
  subsection('Error Bubbling Verification')
  const errorEvents = allEvents.filter(e => e.type === 'error.captured')
  ok(`error.captured events: ${errorEvents.length}`)

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 7: Flush to Jaeger + Summary
  // ══════════════════════════════════════════════════════════════════════════
  section('Phase 7: Flush to Jaeger + Summary')

  info('Flushing spans to Jaeger...')
  eventBus.stop()
  await exporterRegistry.shutdown()
  ok('Spans exported to Jaeger')

  // Final summary table
  const totalTasks = handler.getAllEntities().filter(e => e.entity_type === 'task').length
  const completedTasks = handler.getAllEntities().filter(e => e.entity_type === 'task' && e.state === 'completed').length
  const supersededTasks = handler.getAllEntities().filter(e => e.entity_type === 'task' && e.state === 'superseded').length

  const ucSpan = spanManager.getSpan('uc-crud')
  const mainTraceId = ucSpan?.trace_id ?? 'unknown'

  console.log(`
${C.bold}${C.green}  Demo Complete!${C.reset}

  ${C.bold}Summary${C.reset}
  ┌──────────────────────────────────────────────────────────────┐
  │  UseCases registered:      3                                 │
  │  Plans registered:         ${String(handler.getAllEntities().filter(e => e.entity_type === 'plan').length).padEnd(37)}│
  │  Tasks registered:         ${String(totalTasks).padEnd(37)}│
  │  Tasks completed:          ${String(completedTasks).padEnd(37)}│
  │  Tasks superseded:         ${String(supersededTasks).padEnd(37)}│
  │  Total events:             ${String(allEvents.length).padEnd(37)}│
  │  Total spans:              ${String(allSpans.length).padEnd(37)}│
  │  Constraint pass:          ${String(constraintPassCount).padEnd(37)}│
  │  Constraint fail:          ${String(constraintFailCount).padEnd(37)}│
  │  UC mutations:             ${String(mutatedEvents.length).padEnd(37)}│
  │  Superseded entities:      ${String(supersededEntities.length).padEnd(37)}│
  │  Error bubble events:      ${String(errorEvents.length).padEnd(37)}│
  └──────────────────────────────────────────────────────────────┘

  ${C.bold}Jaeger${C.reset}
  ┌──────────────────────────────────────────────────────────────┐
  │  Service:    traceweaver-daemon                              │
  │  Project:    ${PROJECT_ID.padEnd(48)}│
  │  Trace ID:   ${mainTraceId.padEnd(48)}│
  │  Jaeger UI:  http://localhost:16686                          │
  └──────────────────────────────────────────────────────────────┘
`)

  await rm(storeDir, { recursive: true, force: true })

  // Restore todo-api-demo test file to original state (with BUG comment)
  const restoreTestPath = join(TODO_PROJECT_ROOT, 'src/schemas/todo.test.ts')
  try {
    const currentContent = await readFile(restoreTestPath, 'utf8')
    if (currentContent.includes('rejects empty title string')) {
      const restored = currentContent.replace(
        `  it('rejects empty title string', () => {\n    const result = validateCreateTodo({ title: '' })\n    expect(result.success).toBe(false)\n  })`,
        `  // BUG: missing edge case test for empty string title\n  // coding-rules.md requires: "Edge cases required: empty string"`
      )
      await writeFile(restoreTestPath, restored, 'utf8')
      info('Restored todo-api-demo test file to original state (re-runnable)')
    }
  } catch { /* ignore */ }
}

main().catch(err => {
  console.error(`\n${C.red}[Error]${C.reset}`, err.message)
  console.error(err)
  process.exit(1)
})
