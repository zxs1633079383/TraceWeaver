import type { TwEvent, WebhookEndpoint } from '@traceweaver/types'
import type { InboxAdapter } from './inbox.js'

export interface WebhookAdapterOptions {
  retryCount?: number
  retryBackoffMs?: number
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
  deadLetterInbox?: Pick<InboxAdapter, 'write'>
}

export class WebhookAdapter {
  private readonly retryCount: number
  private readonly retryBackoffMs: number
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch
  private readonly deadLetter?: Pick<InboxAdapter, 'write'>

  constructor(
    private readonly endpoints: WebhookEndpoint[],
    opts: WebhookAdapterOptions = {}
  ) {
    this.retryCount = opts.retryCount ?? 3
    this.retryBackoffMs = opts.retryBackoffMs ?? 1000
    this.timeoutMs = opts.timeoutMs ?? 5000
    this.fetchFn = opts.fetch ?? globalThis.fetch
    this.deadLetter = opts.deadLetterInbox
  }

  async dispatch(event: TwEvent, message: string): Promise<void> {
    for (const endpoint of this.endpoints) {
      if (!this.matches(endpoint, event)) continue
      await this.sendWithRetry(endpoint, event, message)
    }
  }

  private matches(endpoint: WebhookEndpoint, event: TwEvent): boolean {
    return endpoint.events.some(sub => {
      if (sub.event !== '*' && sub.event !== event.type) return false
      if (sub.entity_type && sub.entity_type !== event.entity_type) return false
      if (sub.state && sub.state !== event.state) return false
      return true
    })
  }

  private async sendWithRetry(endpoint: WebhookEndpoint, event: TwEvent, message: string): Promise<void> {
    const payload = { event_id: event.id, event_type: event.type, entity_id: event.entity_id, message, ts: event.ts }
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= this.retryCount; attempt++) {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, this.retryBackoffMs * Math.pow(2, attempt - 1)))
      }
      try {
        const res = await this.fetchFn(endpoint.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(endpoint.headers ?? {}) },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
        if (res.ok) return
        lastError = new Error(`HTTP ${res.status} ${res.statusText}`)
      } catch (err) {
        lastError = err as Error
      }
    }

    if (this.deadLetter && lastError) {
      await this.deadLetter.write({
        event_type: event.type,
        entity_id: event.entity_id,
        message: `Webhook delivery failed: ${endpoint.name} — ${lastError.message}`,
      })
    }
  }
}
