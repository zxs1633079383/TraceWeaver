/**
 * Example 04 — Full-Flow: Research Project Lifecycle
 *
 * Demonstrates a complete R&D project simulation:
 *   1. Wire EventBus + SpanManager + CommandHandler together
 *   2. Build a usecase → plan → task hierarchy (1 usecase, 2 plans, 4 tasks)
 *   3. Advance every task through pending → in_progress → review → completed
 *   4. Collect events via subscription
 *   5. Print a summary: entity counts, state breakdown, events, OTel spans
 *   6. Show getDagSnapshot()
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandHandler } from '../../packages/tw-daemon/src/core/command-handler.js'
import { EventBus } from '../../packages/tw-daemon/src/core/event-bus/event-bus.js'
import { SpanManager } from '../../packages/tw-daemon/src/otel/span-manager.js'
import type { TwEvent } from '@traceweaver/types'

async function main(): Promise<void> {
  console.log('\n── Research Project Simulation ──')

  const storeDir = await mkdtemp(join(tmpdir(), 'tw-example-04-'))
  console.log(`  storeDir: ${storeDir}`)

  const eventBus = new EventBus({ bufferSize: 256, batchWindowMs: 20 })
  const spanManager = new SpanManager({ projectId: 'ml-experiment-001' })

  const handler = new CommandHandler({ storeDir, eventBus, spanManager })

  const collectedEvents: TwEvent[] = []
  eventBus.subscribe(ev => collectedEvents.push(ev))

  try {
    // ── Step 1: Start event bus and init handler ────────────────────────
    console.log('\n── Step 1: Start bus + init handler ──')
    eventBus.start()
    await handler.init()
    console.log('  EventBus started, CommandHandler initialised')

    // ── Step 2: Register hierarchy ────────────────────────────────────
    console.log('\n── Step 2: Register entity hierarchy ──')

    const usecase = await handler.register({
      id: 'ml-experiment-001',
      entity_type: 'usecase',
      attributes: { title: 'ML Experiment: Image Classifier v1' },
    })
    console.log(`  usecase: ${usecase.id}  state=${usecase.state}`)

    const dataPlan = await handler.register({
      id: 'data-prep-plan',
      entity_type: 'plan',
      parent_id: 'ml-experiment-001',
      domain: 'data',
      attributes: { title: 'Data Preparation' },
    })
    console.log(`  plan:    ${dataPlan.id}  state=${dataPlan.state}`)

    const trainPlan = await handler.register({
      id: 'model-train-plan',
      entity_type: 'plan',
      parent_id: 'ml-experiment-001',
      domain: 'ml',
      attributes: { title: 'Model Training' },
    })
    console.log(`  plan:    ${trainPlan.id}  state=${trainPlan.state}`)

    const dataTask1 = await handler.register({
      id: 'data-task-001',
      entity_type: 'task',
      parent_id: 'data-prep-plan',
      attributes: { title: 'Download & validate raw dataset' },
    })
    console.log(`  task:    ${dataTask1.id}  state=${dataTask1.state}`)

    const dataTask2 = await handler.register({
      id: 'data-task-002',
      entity_type: 'task',
      parent_id: 'data-prep-plan',
      attributes: { title: 'Normalise and split train/val/test' },
    })
    console.log(`  task:    ${dataTask2.id}  state=${dataTask2.state}`)

    const trainTask1 = await handler.register({
      id: 'train-task-001',
      entity_type: 'task',
      parent_id: 'model-train-plan',
      attributes: { title: 'Baseline CNN training run' },
    })
    console.log(`  task:    ${trainTask1.id}  state=${trainTask1.state}`)

    const trainTask2 = await handler.register({
      id: 'train-task-002',
      entity_type: 'task',
      parent_id: 'model-train-plan',
      attributes: { title: 'Hyperparameter sweep & eval' },
    })
    console.log(`  task:    ${trainTask2.id}  state=${trainTask2.state}`)

    // ── Step 3: Advance all tasks through states ──────────────────────
    console.log('\n── Step 3: Advance tasks (pending → in_progress → review → completed) ──')

    const taskIds = ['data-task-001', 'data-task-002', 'train-task-001', 'train-task-002']

    for (const id of taskIds) {
      await handler.updateState({ id, state: 'in_progress', reason: 'Work started' })
    }
    console.log('  All tasks → in_progress')

    for (const id of taskIds) {
      await handler.updateState({ id, state: 'review', reason: 'Ready for review' })
    }
    console.log('  All tasks → review')

    for (const id of taskIds) {
      await handler.updateState({ id, state: 'completed', reason: 'Review passed' })
    }
    console.log('  All tasks → completed')

    // Wait for event bus to drain
    await new Promise(resolve => setTimeout(resolve, 200))

    // ── Step 4: Print summary ─────────────────────────────────────────
    console.log('\n── Step 4: Summary ──')

    const status = await handler.getStatus({})
    console.log(`  Total entities:   ${status.total}`)
    console.log(`  Completed:        ${status.done}`)
    console.log(`  Progress:         ${status.percent}%`)

    // State breakdown
    const allEntityIds = [
      'ml-experiment-001', 'data-prep-plan', 'model-train-plan', ...taskIds,
    ]
    const stateCounts: Record<string, number> = {}
    for (const id of allEntityIds) {
      const detail = await handler.getStatus({ id })
      const s = detail.entity.state as string
      stateCounts[s] = (stateCounts[s] ?? 0) + 1
    }
    console.log('  State breakdown:')
    for (const [state, count] of Object.entries(stateCounts)) {
      console.log(`    ${state}: ${count}`)
    }

    // Collected events
    console.log(`\n  Collected events (${collectedEvents.length} total):`)
    for (const ev of collectedEvents) {
      console.log(`    [${ev.type}]  entity=${ev.entity_id ?? '-'}  state=${ev.state ?? '-'}`)
    }

    // OTel active spans
    const activeSpans = spanManager.getActiveSpans()
    console.log(`\n  Active OTel spans: ${activeSpans.length}`)
    if (activeSpans.length > 0) {
      for (const span of activeSpans) {
        console.log(`    ${span.entity_id}  status=${span.status}`)
      }
    }

    // ── Step 5: DAG snapshot ──────────────────────────────────────────
    console.log('\n── Step 5: DAG snapshot ──')
    const dag = handler.getDagSnapshot()
    console.log(`  Nodes (${dag.nodes.length}):`)
    for (const node of dag.nodes) {
      console.log(`    ${node.id}  [${node.entity_type}]`)
    }
    console.log(`  Edges (${dag.edges.length}):`)
    if (dag.edges.length === 0) {
      console.log('    (no dependency edges — hierarchy uses parent_id, not depends_on)')
    } else {
      for (const edge of dag.edges) {
        console.log(`    ${edge.from} → ${edge.to}`)
      }
    }

  } finally {
    eventBus.stop()
    await rm(storeDir, { recursive: true, force: true })
    console.log(`\n  Cleaned up storeDir: ${storeDir}`)
  }

  console.log('\n✓ Example complete\n')
}

main().catch(console.error)
