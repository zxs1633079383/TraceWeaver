import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NotifyEngine } from './engine.js'
import { EventBus } from '../core/event-bus/event-bus.js'

describe('NotifyEngine', () => {
  let bus: EventBus

  beforeEach(() => {
    bus = new EventBus({ batchWindowMs: 10 })
    bus.start()
  })

  afterEach(() => bus.stop())

  it('routes rejected event to inbox', async () => {
    const inboxMock = { write: vi.fn().mockResolvedValue({ id: '1', acked: false }) }
    const engine = new NotifyEngine(bus, {
      inbox: inboxMock as any,
      rules: [{ event: 'entity.state_changed', state: 'rejected' }]
    })
    engine.start()

    bus.publish({ id: 'e1', type: 'entity.state_changed', state: 'rejected', entity_id: 'T-1', ts: '' })
    await new Promise(r => setTimeout(r, 50))
    expect(inboxMock.write).toHaveBeenCalledOnce()
    engine.stop()
  })

  it('does not route unsubscribed events', async () => {
    const inboxMock = { write: vi.fn().mockResolvedValue({}) }
    const engine = new NotifyEngine(bus, {
      inbox: inboxMock as any,
      rules: [{ event: 'entity.state_changed', state: 'completed' }]
    })
    engine.start()

    bus.publish({ id: 'e2', type: 'git.commit', ts: '' })
    await new Promise(r => setTimeout(r, 50))
    expect(inboxMock.write).not.toHaveBeenCalled()
    engine.stop()
  })

  it('stop() unsubscribes from bus', async () => {
    const inboxMock = { write: vi.fn().mockResolvedValue({}) }
    const engine = new NotifyEngine(bus, { inbox: inboxMock as any })
    engine.start()
    engine.stop()

    bus.publish({ id: 'e3', type: 'entity.registered', ts: '' })
    await new Promise(r => setTimeout(r, 50))
    expect(inboxMock.write).not.toHaveBeenCalled()
  })

  it('routes to webhook adapter when configured', async () => {
    const webhookMock = { dispatch: vi.fn().mockResolvedValue(undefined) }
    const engine = new NotifyEngine(bus, { webhook: webhookMock as any })
    engine.start()

    bus.publish({ id: 'e4', type: 'entity.state_changed', entity_id: 'T-1', ts: '' })
    await new Promise(r => setTimeout(r, 50))
    expect(webhookMock.dispatch).toHaveBeenCalledOnce()
    engine.stop()
  })
})
