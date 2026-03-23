/**
 * Example 02 — Basic EventBus Subscribe / Publish
 *
 * Demonstrates how to:
 *   1. Create and start an EventBus
 *   2. Subscribe to all events and log each one as it arrives
 *   3. Wire EventBus into CommandHandler so operations emit events automatically
 *   4. Wait for the batch drain window to flush buffered events
 *   5. Inspect the full event history via bus.getHistory()
 *   6. Stop the bus and clean up
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus } from '../../packages/tw-daemon/src/core/event-bus/event-bus.js'
import { CommandHandler } from '../../packages/tw-daemon/src/core/command-handler.js'
import type { TwEvent } from '@traceweaver/types'

async function main(): Promise<void> {
  console.log('\n── EventBus Demo ──')

  // ── Step 1: Create temp store ────────────────────────────────────────────
  const storeDir = await mkdtemp(join(tmpdir(), 'tw-example-02-'))
  console.log(`\n  storeDir: ${storeDir}`)

  // ── Step 2: Create and start EventBus ───────────────────────────────────
  console.log('\n── Step 2: Create & start EventBus ──')
  // batchWindowMs=50 means events are flushed to subscribers every 50 ms
  const bus = new EventBus({ bufferSize: 512, batchWindowMs: 50 })
  bus.start()
  console.log('  EventBus started (batchWindowMs=50)')

  // ── Step 3: Subscribe — log each event as it is delivered ───────────────
  console.log('\n── Step 3: Subscribe to events ──')
  const received: TwEvent[] = []
  const unsubscribe = bus.subscribe((event: TwEvent) => {
    received.push(event)
    console.log(`  [event] type=${event.type}  entity_id=${event.entity_id ?? '—'}`)
  })
  console.log('  Subscriber registered')

  // ── Step 4: Create CommandHandler with EventBus ──────────────────────────
  console.log('\n── Step 4: Create CommandHandler with EventBus ──')
  const handler = new CommandHandler({ storeDir, eventBus: bus })
  await handler.init()
  console.log('  Handler ready')

  try {
    // ── Step 5: Register entity — triggers entity.registered event ──────
    console.log('\n── Step 5: Register entity → expect entity.registered ──')
    await handler.register({
      id: 'uc-events-1',
      entity_type: 'usecase',
      attributes: { title: 'EventBus walkthrough' },
    })

    // ── Step 6: Update state — triggers entity.state_changed event ───────
    console.log('\n── Step 6: Update state → expect entity.state_changed ──')
    await handler.updateState({
      id: 'uc-events-1',
      state: 'in_progress',
      reason: 'Kicked off by EventBus example',
    })

    // ── Step 7: Wait for batch drain window ──────────────────────────────
    console.log('\n── Step 7: Waiting 100 ms for batch drain… ──')
    await new Promise<void>(r => setTimeout(r, 100))

    // ── Step 8: Inspect history via bus.getHistory() ─────────────────────
    console.log('\n── Step 8: Query event history ──')
    const history = bus.getHistory()
    console.log(`  Events in history: ${history.length}`)
    const types = history.map(e => e.type)
    console.log(`  Event types: ${types.join(', ')}`)

    // Confirm both expected events are present
    const hasRegistered = types.includes('entity.registered')
    const hasStateChanged = types.includes('entity.state_changed')
    console.log(`  entity.registered    present: ${hasRegistered}`)
    console.log(`  entity.state_changed present: ${hasStateChanged}`)

  } finally {
    // ── Cleanup ───────────────────────────────────────────────────────────
    unsubscribe()
    bus.stop()
    console.log('\n  EventBus stopped, subscriber removed')
    await rm(storeDir, { recursive: true, force: true })
    console.log(`  Cleaned up storeDir: ${storeDir}`)
  }

  console.log('\n✓ Example complete\n')
}

main().catch(console.error)
