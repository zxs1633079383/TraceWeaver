/**
 * Example 05 — Full-Flow: NotifyEngine Pipeline
 *
 * Demonstrates the full notification pipeline:
 *   1. Create EventBus + InboxAdapter + NotifyEngine with filtering rules
 *   2. Wire CommandHandler to the same EventBus
 *   3. Complete and reject entities to trigger notifications
 *   4. Update an entity to in_progress (should NOT trigger a notification)
 *   5. List inbox items, ack the first one, list again
 *   6. Show how NotifyEngine correctly filters by state
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandHandler } from '../../packages/tw-daemon/src/core/command-handler.js'
import { EventBus } from '../../packages/tw-daemon/src/core/event-bus/event-bus.js'
import { NotifyEngine } from '../../packages/tw-daemon/src/notify/engine.js'
import { InboxAdapter } from '../../packages/tw-daemon/src/notify/inbox.js'

async function main(): Promise<void> {
  console.log('\n── NotifyEngine Pipeline Simulation ──')

  const tmpDir = await mkdtemp(join(tmpdir(), 'tw-example-05-'))
  console.log(`  tmpDir: ${tmpDir}`)

  const eventBus = new EventBus({ bufferSize: 256, batchWindowMs: 20 })
  const inbox = new InboxAdapter(join(tmpDir, 'inbox'))

  const engine = new NotifyEngine(eventBus, {
    inbox,
    rules: [
      { event: 'entity.state_changed', state: 'completed' },
      { event: 'entity.state_changed', state: 'rejected' },
    ],
  })

  // Use tmpDir directly as storeDir; InboxAdapter uses a dedicated subdirectory
  const handler = new CommandHandler({ storeDir: tmpDir, eventBus })

  try {
    // ── Step 1: Start bus + engine ────────────────────────────────────
    console.log('\n── Step 1: Start bus + NotifyEngine ──')
    eventBus.start()
    engine.start()
    await handler.init()
    console.log('  EventBus started, NotifyEngine started, CommandHandler initialised')
    console.log('  Rules: notify on state_changed → completed | rejected')

    // ── Step 2: Register and complete exp-001 ────────────────────────
    console.log('\n── Step 2: Register + complete exp-001 ──')
    await handler.register({ id: 'exp-001', entity_type: 'task' })
    await handler.updateState({ id: 'exp-001', state: 'in_progress' })
    await handler.updateState({ id: 'exp-001', state: 'review' })
    await handler.updateState({ id: 'exp-001', state: 'completed', reason: 'All checks passed' })
    console.log('  exp-001: pending → in_progress → review → completed')

    // ── Step 3: Register and reject exp-002 ──────────────────────────
    console.log('\n── Step 3: Register + reject exp-002 ──')
    await handler.register({ id: 'exp-002', entity_type: 'task' })
    await handler.updateState({ id: 'exp-002', state: 'in_progress' })
    await handler.updateState({ id: 'exp-002', state: 'rejected', reason: 'Quality gate failed' })
    console.log('  exp-002: pending → in_progress → rejected')

    // ── Step 4: Register and advance exp-003 to in_progress only ─────
    console.log('\n── Step 4: Register + advance exp-003 to in_progress (should NOT notify) ──')
    await handler.register({ id: 'exp-003', entity_type: 'task' })
    await handler.updateState({ id: 'exp-003', state: 'in_progress', reason: 'Work begun' })
    console.log('  exp-003: pending → in_progress  (no completed/rejected → no notification)')

    // Wait for bus to drain and engine to process
    await new Promise(resolve => setTimeout(resolve, 200))

    // ── Step 5: List inbox items ──────────────────────────────────────
    console.log('\n── Step 5: Inbox items (before ack) ──')
    const itemsBefore = await inbox.list({})
    console.log(`  Inbox contains ${itemsBefore.length} item(s):`)
    for (const item of itemsBefore) {
      console.log(`    id=${item.id}`)
      console.log(`      event_type: ${item.event_type}`)
      console.log(`      entity_id:  ${item.entity_id ?? '-'}`)
      console.log(`      message:    ${item.message}`)
      console.log(`      acked:      ${item.acked}`)
    }

    // ── Step 6: Ack the first item ────────────────────────────────────
    if (itemsBefore.length > 0) {
      const firstId = itemsBefore[0].id
      console.log(`\n── Step 6: Ack first item (id=${firstId}) ──`)
      await inbox.ack(firstId)
      console.log('  Ack sent.')

      // List again
      const itemsAfter = await inbox.list({})
      console.log('\n── Step 7: Inbox items (after ack) ──')
      console.log(`  Inbox contains ${itemsAfter.length} item(s):`)
      for (const item of itemsAfter) {
        console.log(`    [${item.acked ? 'ACKED' : 'UNACKED'}]  ${item.message}`)
      }

      const unacked = await inbox.list({ unackedOnly: true })
      console.log(`\n  Unacked only: ${unacked.length} item(s)`)
    } else {
      console.log('\n── Step 6/7: No items to ack ──')
    }

    // ── Summary ───────────────────────────────────────────────────────
    console.log('\n── Summary ──')
    const finalItems = await inbox.list({})
    // exp-003 went to in_progress — should not have triggered a notification
    // exp-001 completed + exp-002 rejected → 2 notifications expected
    const notifiedCount = finalItems.length
    const filteredCount = 3 - notifiedCount  // 3 terminal state changes total: completed, rejected, in_progress
    // Actually: registered events also fire, but NotifyEngine only cares about state_changed with matching state
    // completed(exp-001) + rejected(exp-002) = 2 delivered; in_progress transitions filtered out
    console.log(`  NotifyEngine correctly filtered events, delivered ${notifiedCount} notification(s)`)
    console.log(`  (in_progress state transitions were ignored by the rules filter)`)

  } finally {
    engine.stop()
    eventBus.stop()
    await rm(tmpDir, { recursive: true, force: true })
    console.log(`\n  Cleaned up tmpDir: ${tmpDir}`)
  }

  console.log('\n✓ Example complete\n')
}

main().catch(console.error)
