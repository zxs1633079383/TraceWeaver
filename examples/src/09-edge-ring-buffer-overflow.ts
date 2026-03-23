/**
 * Example 09 — Edge Case: RingBuffer Circular Overflow
 *
 * Demonstrates RingBuffer fixed-capacity circular behavior:
 *   1. Fill a capacity-5 buffer (0–4) — isFull, no drops
 *   2. Push items 5–8 — each push drops the oldest item
 *   3. drainAll() returns only the last 5 items
 *   4. Second buffer: drain mid-way, push more, drain again (empty)
 *   5. EventBus with tiny buffer (size 3) dropping events under load
 */

import { RingBuffer } from '../../packages/tw-daemon/src/core/event-bus/ring-buffer.js'
import { EventBus } from '../../packages/tw-daemon/src/core/event-bus/event-bus.js'
import { randomUUID } from 'node:crypto'
import type { TwEvent } from '@traceweaver/types'

async function main(): Promise<void> {
  console.log('\n── RingBuffer Circular Overflow ──')

  // ── Part 1: Basic overflow ───────────────────────────────────────────────
  console.log('\n── Part 1: Fill a capacity-5 buffer with items 0–4 ──')
  const buf = new RingBuffer<number>(5)

  for (let i = 0; i < 5; i++) {
    const dropped = buf.push(i)
    console.log(`  push(${i})  dropped=${dropped ?? 'null'}`)
  }
  console.log(`  size=${buf.size()}  isFull=${buf.isFull()}  isEmpty=${buf.isEmpty()}`)

  // ── Part 2: Push beyond capacity — oldest items get dropped ─────────────
  console.log('\n── Part 2: Push items 5–8 (overflow) ──')
  for (let i = 5; i <= 8; i++) {
    const dropped = buf.push(i)
    console.log(`  push(${i})  dropped=${dropped ?? 'null'}  (oldest evicted)`)
  }

  // After pushing 0,1,2,3,4,5,6,7,8 into capacity-5:
  // After push(5): [1,2,3,4,5]  dropped=0
  // After push(6): [2,3,4,5,6]  dropped=1
  // After push(7): [3,4,5,6,7]  dropped=2
  // After push(8): [4,5,6,7,8]  dropped=3
  console.log(`\n  size=${buf.size()}  isFull=${buf.isFull()}`)

  // ── Part 3: drainAll ─────────────────────────────────────────────────────
  console.log('\n── Part 3: drainAll() — returns last 5 items ──')
  const drained = buf.drainAll()
  console.log(`  drainAll() → [${drained.join(', ')}]`)
  console.log(`  Expected:    [4, 5, 6, 7, 8]  (oldest 4 items were dropped by overflow)`)
  console.log(`  size after drain: ${buf.size()}  isEmpty: ${buf.isEmpty()}`)

  // ── Part 4: Second buffer — partial drain then push more ─────────────────
  console.log('\n── Part 4: Drain mid-way, then push more ──')
  const buf2 = new RingBuffer<number>(5)
  buf2.push(10)
  buf2.push(20)
  buf2.push(30)
  console.log(`  Pushed [10, 20, 30]  size=${buf2.size()}`)

  const mid = buf2.drainAll()
  console.log(`  drainAll() → [${mid.join(', ')}]  size=${buf2.size()}`)

  buf2.push(40)
  buf2.push(50)
  console.log(`  Pushed [40, 50]  size=${buf2.size()}`)

  const second = buf2.drainAll()
  console.log(`  drainAll() → [${second.join(', ')}]  isEmpty=${buf2.isEmpty()}`)

  // ── Part 5: EventBus with tiny buffer under load ─────────────────────────
  console.log('\n── Part 5: EventBus with bufferSize=3 dropping events under load ──')
  console.log('  (Demonstrates ring-buffer behaviour in practice)')

  const tinyBus = new EventBus({ bufferSize: 3, batchWindowMs: 500 })
  // Do NOT start the bus — we publish directly to fill the buffer without draining,
  // then start and drain to see what survived.
  // Actually EventBus only publishes if running — so start it first,
  // then publish 10 events synchronously (faster than batchWindowMs=500ms drain).
  tinyBus.start()

  const received: TwEvent[] = []
  tinyBus.subscribe(ev => received.push(ev))

  // Publish 10 events synchronously — bus won't drain until 500ms later
  for (let i = 0; i < 10; i++) {
    tinyBus.publish({
      id: randomUUID(),
      type: 'entity.updated',
      entity_id: `entity-${i}`,
      ts: new Date().toISOString(),
    })
  }
  console.log('  Published 10 events synchronously to a bufferSize=3 bus')
  console.log('  (buffer holds at most 3 at a time; oldest are overwritten)')

  // Wait for the batch window to drain
  await new Promise(resolve => setTimeout(resolve, 600))

  console.log(`  Events received by subscriber: ${received.length}`)
  console.log('  (with bufferSize=3 and synchronous publishing, only the latest 3 survive)')
  for (const ev of received) {
    console.log(`    entity_id=${ev.entity_id}`)
  }

  tinyBus.stop()

  console.log('\n✓ Example complete\n')
}

main().catch(console.error)
