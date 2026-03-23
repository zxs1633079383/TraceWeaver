/**
 * Example 10 — Edge Case: WAL-Based State Recovery
 *
 * Demonstrates that CommandHandler can recover in-memory state after a
 * simulated "crash" by replaying the Write-Ahead Log (WAL):
 *
 *   Phase 1 — First run:
 *     Register entities, update states, then drop the handler reference
 *     without cleaning up the store directory (simulating a crash).
 *
 *   Phase 2 — Recovery run:
 *     Create a new CommandHandler pointing at the SAME store directory.
 *     Call init() — it replays the WAL and restores state.
 *     Verify the in-progress task is still in_progress, then complete it.
 *
 *   Phase 3 — Cleanup:
 *     Remove the tmp directory.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandHandler } from '../../packages/tw-daemon/src/core/command-handler.js'

async function main(): Promise<void> {
  console.log('\n── WAL-Based State Recovery ──')

  // Create the tmp dir once — shared across both phases
  const storeDir = await mkdtemp(join(tmpdir(), 'tw-example-10-'))
  console.log(`  storeDir: ${storeDir}`)

  // ── Phase 1: First run ────────────────────────────────────────────────────
  console.log('\n── Phase 1: First run — register entities + update state ──')
  {
    const handler1 = new CommandHandler({ storeDir })
    await handler1.init()
    console.log('  handler1 initialised (fresh WAL)')

    const usecase = await handler1.register({
      id: 'exp-persist-001',
      entity_type: 'usecase',
      attributes: { title: 'Persistent ML Experiment' },
    })
    console.log(`  Registered usecase: ${usecase.id}  state=${usecase.state}`)

    const task = await handler1.register({
      id: 'task-persist-001',
      entity_type: 'task',
      parent_id: 'exp-persist-001',
      attributes: { title: 'Run baseline evaluation' },
    })
    console.log(`  Registered task:    ${task.id}  state=${task.state}`)

    const inProgress = await handler1.updateState({
      id: 'task-persist-001',
      state: 'in_progress',
      reason: 'Evaluation started',
    })
    console.log(`  task-persist-001 → ${inProgress.state}`)

    const status1 = await handler1.getStatus({})
    console.log(`\n  handler1 status:  total=${status1.total}  done=${status1.done}`)

    // Simulate crash — let handler1 go out of scope without any cleanup.
    // The WAL file on disk persists.
    console.log('\n  Simulating crash... process would restart here')
    // handler1 is dropped here (end of block)
  }

  // ── Phase 2: Recovery run ─────────────────────────────────────────────────
  console.log('\n── Phase 2: Recovery run — new handler, same storeDir ──')
  try {
    const handler2 = new CommandHandler({ storeDir })
    // init() replays the WAL → restores both entities and the in_progress state
    await handler2.init()
    console.log('  handler2 initialised — replaying WAL...')

    const status2 = await handler2.getStatus({})
    console.log(`  Entities restored:  total=${status2.total}  done=${status2.done}`)

    // Verify task is still in_progress
    const taskDetail = await handler2.getStatus({ id: 'task-persist-001' })
    const restoredState = taskDetail.entity.state
    console.log(`  task-persist-001 restored state: ${restoredState}`)
    console.log(`  State matches in_progress: ${restoredState === 'in_progress'}`)

    if (restoredState !== 'in_progress') {
      throw new Error(`Recovery failed — expected in_progress but got ${restoredState}`)
    }

    // Continue work: advance the task to completed
    console.log('\n  Continuing work — advancing task to review then completed...')
    await handler2.updateState({ id: 'task-persist-001', state: 'review', reason: 'Ready for review' })
    const completed = await handler2.updateState({ id: 'task-persist-001', state: 'completed', reason: 'Evaluation passed' })
    console.log(`  task-persist-001 → ${completed.state}`)

    const finalStatus = await handler2.getStatus({})
    console.log(`\n  Recovery successful — ${finalStatus.total} entities restored from WAL`)
    console.log(`  Final progress: ${finalStatus.done}/${finalStatus.total} done (${finalStatus.percent}%)`)

    // Also verify usecase was restored
    const ucDetail = await handler2.getStatus({ id: 'exp-persist-001' })
    console.log(`  exp-persist-001 state: ${ucDetail.entity.state}`)

  } finally {
    // ── Phase 3: Cleanup ────────────────────────────────────────────────────
    await rm(storeDir, { recursive: true, force: true })
    console.log(`\n  Cleaned up storeDir: ${storeDir}`)
  }

  console.log('\n✓ Example complete\n')
}

main().catch(console.error)
