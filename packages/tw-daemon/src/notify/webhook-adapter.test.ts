import { describe, it, expect, vi } from 'vitest'
import { WebhookAdapter } from './webhook-adapter.js'
import type { TwEvent, WebhookEndpoint } from '@traceweaver/types'

const endpoint: WebhookEndpoint = {
  name: 'test',
  url: 'https://example.com/webhook',
  events: [{ event: '*' }]
}

describe('WebhookAdapter', () => {
  it('sends POST with correct payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    const adapter = new WebhookAdapter([endpoint], {
      retryCount: 0,
      timeoutMs: 1000,
      fetch: fetchMock as any
    })
    const event: TwEvent = { id: 'e1', type: 'entity.state_changed', ts: '' }
    await adapter.dispatch(event, 'Task T-1 completed')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://example.com/webhook')
    expect(JSON.parse(opts.body).event_id).toBe('e1')
  })

  it('retries on failure then falls back to dead letter', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' })
    const inboxMock = { write: vi.fn().mockResolvedValue({}) }
    const adapter = new WebhookAdapter([endpoint], {
      retryCount: 1,
      retryBackoffMs: 10,
      timeoutMs: 100,
      fetch: fetchMock as any,
      deadLetterInbox: inboxMock as any
    })
    const event: TwEvent = { id: 'e2', type: 'git.commit', ts: '' }
    await adapter.dispatch(event, 'git commit abc')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(inboxMock.write).toHaveBeenCalledOnce()
  })

  it('filters events by endpoint subscription', async () => {
    const restrictedEndpoint: WebhookEndpoint = {
      name: 'restricted',
      url: 'https://ci/trigger',
      events: [{ event: 'entity.state_changed', entity_type: 'task', state: 'completed' }]
    }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    const adapter = new WebhookAdapter([restrictedEndpoint], { retryCount: 0, timeoutMs: 100, fetch: fetchMock as any })

    await adapter.dispatch({ id: 'e3', type: 'entity.state_changed', entity_type: 'task', state: 'rejected', ts: '' }, '')
    expect(fetchMock).not.toHaveBeenCalled()

    await adapter.dispatch({ id: 'e4', type: 'entity.state_changed', entity_type: 'task', state: 'completed', ts: '' }, '')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('does nothing with empty endpoints', async () => {
    const fetchMock = vi.fn()
    const adapter = new WebhookAdapter([], { retryCount: 0, fetch: fetchMock as any })
    await adapter.dispatch({ id: 'e5', type: 'git.commit', ts: '' }, 'test')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
