import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventBus } from './event-bus.js'
import type { TwEvent } from '@traceweaver/types'

describe('EventBus', () => {
  let bus: EventBus

  beforeEach(() => { bus = new EventBus({ bufferSize: 16, batchWindowMs: 10 }) })
  afterEach(() => bus.stop())

  it('delivers published event to subscriber', async () => {
    const received: TwEvent[] = []
    bus.subscribe(ev => received.push(ev))
    bus.start()

    bus.publish({ id: 'e1', type: 'entity.registered', ts: new Date().toISOString() })
    await new Promise(r => setTimeout(r, 50))
    expect(received).toHaveLength(1)
    expect(received[0].id).toBe('e1')
  })

  it('batches multiple events via subscribeBatch', async () => {
    const batches: TwEvent[][] = []
    bus.subscribeBatch(batch => batches.push(batch))
    bus.start()

    bus.publish({ id: 'e1', type: 'entity.registered', ts: '' })
    bus.publish({ id: 'e2', type: 'entity.state_changed', ts: '' })
    await new Promise(r => setTimeout(r, 50))
    const allIds = batches.flat().map(e => e.id)
    expect(allIds).toContain('e1')
    expect(allIds).toContain('e2')
  })

  it('getHistory returns emitted events in order', async () => {
    bus.start()
    bus.publish({ id: 'h1', type: 'git.commit', ts: '' })
    bus.publish({ id: 'h2', type: 'file.changed', ts: '' })
    await new Promise(r => setTimeout(r, 30))
    const hist = bus.getHistory()
    expect(hist.map(e => e.id)).toEqual(['h1', 'h2'])
  })

  it('stop() prevents further event delivery', async () => {
    const received: TwEvent[] = []
    bus.subscribe(ev => received.push(ev))
    bus.start()
    bus.stop()
    bus.publish({ id: 'after-stop', type: 'git.commit', ts: '' })
    await new Promise(r => setTimeout(r, 50))
    expect(received).toHaveLength(0)
  })

  it('unsubscribe removes subscriber', async () => {
    const received: TwEvent[] = []
    const unsub = bus.subscribe(ev => received.push(ev))
    bus.start()
    unsub()
    bus.publish({ id: 'e3', type: 'entity.registered', ts: '' })
    await new Promise(r => setTimeout(r, 30))
    expect(received).toHaveLength(0)
  })
})
