import type { EventBus } from '../core/event-bus/event-bus.js'
import type { TwEvent, TwEventType, EntityState, EntityType } from '@traceweaver/types'
import type { InboxAdapter } from './inbox.js'
import type { WebhookAdapter } from './webhook-adapter.js'

export interface NotifyRule {
  event: TwEventType | '*'
  entity_type?: EntityType
  state?: EntityState
}

export interface NotifyEngineOptions {
  inbox?: Pick<InboxAdapter, 'write'>
  webhook?: Pick<WebhookAdapter, 'dispatch'>
  rules?: NotifyRule[]
}

export class NotifyEngine {
  private unsub: (() => void) | null = null

  constructor(
    private readonly bus: EventBus,
    private readonly opts: NotifyEngineOptions
  ) {}

  start(): void {
    this.unsub = this.bus.subscribe(event => void this.handle(event).catch(() => {}))
  }

  stop(): void {
    this.unsub?.()
    this.unsub = null
  }

  private async handle(event: TwEvent): Promise<void> {
    if (!this.shouldHandle(event)) return
    const message = this.buildMessage(event)
    if (this.opts.inbox) {
      await this.opts.inbox.write({ event_type: event.type, entity_id: event.entity_id, message })
    }
    if (this.opts.webhook) {
      await this.opts.webhook.dispatch(event, message)
    }
  }

  private shouldHandle(event: TwEvent): boolean {
    const rules = this.opts.rules
    if (!rules || rules.length === 0) return true
    return rules.some(rule => {
      if (rule.event !== '*' && rule.event !== event.type) return false
      if (rule.entity_type && rule.entity_type !== event.entity_type) return false
      if (rule.state && rule.state !== event.state) return false
      return true
    })
  }

  private buildMessage(event: TwEvent): string {
    const id = event.entity_id ? ` [${event.entity_id}]` : ''
    const state = event.state ? ` → ${event.state}` : ''
    return `${event.type}${id}${state}`
  }
}
