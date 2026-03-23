/**
 * Example 01 — Basic Entity Lifecycle
 *
 * Demonstrates how to:
 *   1. Instantiate CommandHandler with a temp store directory
 *   2. Register an entity
 *   3. Transition it through states: pending → in_progress → review → completed
 *   4. Query overall status with getStatus()
 *   5. Clean up the temp directory on exit
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandHandler } from '../../packages/tw-daemon/src/core/command-handler.js'
import type { Entity } from '@traceweaver/types'

async function main(): Promise<void> {
  // ── Step 1: Create a temporary store directory ──────────────────────────
  console.log('\n── Step 1: Create temp store ──')
  const storeDir = await mkdtemp(join(tmpdir(), 'tw-example-01-'))
  console.log(`  storeDir: ${storeDir}`)

  const handler = new CommandHandler({ storeDir })

  try {
    // ── Step 2: Initialise (replays WAL — empty on first run) ────────────
    console.log('\n── Step 2: Init CommandHandler ──')
    await handler.init()
    console.log('  Handler initialised — WAL replayed (0 entries on fresh dir)')

    // ── Step 3: Register a usecase entity ───────────────────────────────
    console.log('\n── Step 3: Register usecase entity ──')
    const entity: Entity = await handler.register({
      id: 'usecase-1',
      entity_type: 'usecase',
      attributes: {
        title: 'User Authentication',
        description: 'Implement login, logout, and session management',
      },
    })
    console.log('  Registered entity:')
    console.log(`    id:          ${entity.id}`)
    console.log(`    type:        ${entity.entity_type}`)
    console.log(`    state:       ${entity.state}`)
    console.log(`    created_at:  ${entity.created_at}`)

    // ── Step 4: Transition to in_progress ────────────────────────────────
    console.log('\n── Step 4: Update state → in_progress ──')
    const inProgress: Entity = await handler.updateState({
      id: 'usecase-1',
      state: 'in_progress',
      reason: 'Development started',
    })
    console.log(`  state: ${inProgress.state}  (was: pending)`)
    console.log(`  updated_at: ${inProgress.updated_at}`)

    // ── Step 5: Transition to review ─────────────────────────────────────
    console.log('\n── Step 5: Update state → review ──')
    const review: Entity = await handler.updateState({
      id: 'usecase-1',
      state: 'review',
      reason: 'Ready for review',
    })
    console.log(`  state: ${review.state}  (was: in_progress)`)
    console.log(`  updated_at: ${review.updated_at}`)

    // ── Step 6: Transition to completed ──────────────────────────────────
    console.log('\n── Step 6: Update state → completed ──')
    const completed: Entity = await handler.updateState({
      id: 'usecase-1',
      state: 'completed',
      reason: 'All tasks done and reviewed',
    })
    console.log(`  state: ${completed.state}  (was: review)`)
    console.log(`  updated_at: ${completed.updated_at}`)

    // ── Step 7: Query overall status ─────────────────────────────────────
    console.log('\n── Step 7: getStatus() summary ──')
    const summary = await handler.getStatus({})
    console.log(`  total:   ${summary.total}`)
    console.log(`  done:    ${summary.done}`)
    console.log(`  percent: ${summary.percent}%`)

    // ── Step 8: Query status for specific entity ──────────────────────────
    console.log('\n── Step 8: getStatus({ id }) for usecase-1 ──')
    const detail = await handler.getStatus({ id: 'usecase-1' })
    console.log(`  entity.id:    ${detail.entity.id}`)
    console.log(`  entity.state: ${detail.entity.state}`)
    console.log(`  children:     ${detail.children.length}`)

  } finally {
    // ── Cleanup ───────────────────────────────────────────────────────────
    await rm(storeDir, { recursive: true, force: true })
    console.log(`\n  Cleaned up storeDir: ${storeDir}`)
  }

  console.log('\n✓ Example complete\n')
}

main().catch(console.error)
