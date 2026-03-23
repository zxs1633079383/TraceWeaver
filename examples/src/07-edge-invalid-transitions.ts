/**
 * Example 07 — Edge Case: Invalid State Machine Transitions
 *
 * Demonstrates TransitionError and the enforced state machine:
 *
 *   pending → in_progress → review → completed
 *                         → rejected
 *          → rejected
 *   completed → rejected  (only terminal demotion allowed)
 *   rejected  → in_progress (re-open)
 *
 * Invalid attempts (caught as TransitionError):
 *   - pending → completed   (skipping in_progress)
 *   - completed → in_progress (going backwards past review)
 *   - review → pending (going backwards)
 *
 * Valid transitions are also shown for contrast.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandHandler } from '../../packages/tw-daemon/src/core/command-handler.js'
import { TransitionError } from '@traceweaver/types'

async function main(): Promise<void> {
  console.log('\n── Invalid Transition Edge Cases ──')

  const storeDir = await mkdtemp(join(tmpdir(), 'tw-example-07-'))
  console.log(`  storeDir: ${storeDir}`)

  const handler = new CommandHandler({ storeDir })

  try {
    await handler.init()

    // ── Show valid state machine ─────────────────────────────────────────
    console.log('\n── Valid state machine ──')
    console.log('  pending     → in_progress')
    console.log('  in_progress → review')
    console.log('  in_progress → rejected')
    console.log('  review      → completed')
    console.log('  review      → rejected')
    console.log('  completed   → rejected  (terminal demotion)')
    console.log('  rejected    → in_progress  (re-open)')

    // ── Register a task for transition testing ───────────────────────────
    await handler.register({ id: 'task-edge-001', entity_type: 'task' })
    console.log('\n  Registered task-edge-001  state=pending')

    let invalidCount = 0

    // ── Attempt 1: pending → completed (skip in_progress) ───────────────
    console.log('\n── Attempt 1: pending → completed (INVALID — skips in_progress) ──')
    try {
      await handler.updateState({ id: 'task-edge-001', state: 'completed' })
      console.log('  ERROR: expected TransitionError but none was thrown')
    } catch (err) {
      if (err instanceof TransitionError) {
        invalidCount++
        console.log(`  Caught TransitionError: ${err.message}`)
        console.log(`  error.code === 'INVALID_TRANSITION': ${err.code === 'INVALID_TRANSITION'}`)
        console.log(`  message includes 'pending':   ${err.message.includes('pending')}`)
        console.log(`  message includes 'completed': ${err.message.includes('completed')}`)
      } else {
        throw err
      }
    }

    // ── Attempt 2: complete a different task, then try to go backwards ───
    // First create and fully complete a separate task
    await handler.register({ id: 'task-edge-002', entity_type: 'task' })
    await handler.updateState({ id: 'task-edge-002', state: 'in_progress' })
    await handler.updateState({ id: 'task-edge-002', state: 'review' })
    await handler.updateState({ id: 'task-edge-002', state: 'completed' })
    console.log('\n  task-edge-002 brought to completed state for backwards test')

    console.log('\n── Attempt 2: completed → in_progress (INVALID — going backwards) ──')
    try {
      await handler.updateState({ id: 'task-edge-002', state: 'in_progress' })
      console.log('  ERROR: expected TransitionError but none was thrown')
    } catch (err) {
      if (err instanceof TransitionError) {
        invalidCount++
        console.log(`  Caught TransitionError: ${err.message}`)
        console.log(`  error.code === 'INVALID_TRANSITION': ${err.code === 'INVALID_TRANSITION'}`)
        console.log(`  message includes 'completed':   ${err.message.includes('completed')}`)
        console.log(`  message includes 'in_progress': ${err.message.includes('in_progress')}`)
      } else {
        throw err
      }
    }

    // ── Attempt 3: review → pending (going backwards) ───────────────────
    // Advance task-edge-001 to review first
    await handler.updateState({ id: 'task-edge-001', state: 'in_progress' })
    await handler.updateState({ id: 'task-edge-001', state: 'review' })
    console.log('\n  task-edge-001 brought to review state for backwards test')

    console.log('\n── Attempt 3: review → pending (INVALID — going backwards) ──')
    try {
      await handler.updateState({ id: 'task-edge-001', state: 'pending' })
      console.log('  ERROR: expected TransitionError but none was thrown')
    } catch (err) {
      if (err instanceof TransitionError) {
        invalidCount++
        console.log(`  Caught TransitionError: ${err.message}`)
        console.log(`  error.code === 'INVALID_TRANSITION': ${err.code === 'INVALID_TRANSITION'}`)
        console.log(`  message includes 'review':  ${err.message.includes('review')}`)
        console.log(`  message includes 'pending': ${err.message.includes('pending')}`)
      } else {
        throw err
      }
    }

    // ── Valid transitions for contrast ───────────────────────────────────
    console.log('\n── Valid transitions (for contrast) ──')

    // task-edge-001 is in review; complete it validly
    const completed = await handler.updateState({ id: 'task-edge-001', state: 'completed' })
    console.log(`  task-edge-001: review → ${completed.state}  (valid)`)

    // completed → rejected is allowed (terminal demotion)
    const rejected = await handler.updateState({ id: 'task-edge-001', state: 'rejected', reason: 'Post-deploy issue found' })
    console.log(`  task-edge-001: completed → ${rejected.state}  (valid — terminal demotion)`)

    // rejected → in_progress is allowed (re-open)
    const reopened = await handler.updateState({ id: 'task-edge-001', state: 'in_progress', reason: 'Re-opened for fix' })
    console.log(`  task-edge-001: rejected → ${reopened.state}  (valid — re-open)`)

    // ── Final count ──────────────────────────────────────────────────────
    console.log(`\n  TransitionError correctly prevented ${invalidCount} invalid transition(s)`)

  } finally {
    await rm(storeDir, { recursive: true, force: true })
    console.log(`\n  Cleaned up storeDir: ${storeDir}`)
  }

  console.log('\n✓ Example complete\n')
}

main().catch(console.error)
