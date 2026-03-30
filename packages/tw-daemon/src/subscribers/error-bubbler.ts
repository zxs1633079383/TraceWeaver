import type { TwEvent, Entity, EntityType } from '@traceweaver/types'
import type { SpanManager } from '../otel/span-manager.js'

export interface ErrorBubblerDeps {
  spanManager: SpanManager
  getEntity: (id: string) => Entity | undefined
  updateAttributes: (id: string, attrs: Record<string, unknown>) => void
}

interface BubbledError {
  origin_entity_id: string
  origin_entity_type: EntityType
  source: string
  message: string
  ts: string
}

const MAX_MESSAGE_LENGTH = 500

export class ErrorBubbler {
  constructor(private readonly deps: ErrorBubblerDeps) {}

  handle(event: TwEvent): void {
    if (event.type !== 'error.captured') return
    if (!event.entity_id) return

    const entity = this.deps.getEntity(event.entity_id)
    if (!entity?.parent_id) return

    const rawMessage = String(event.attributes?.message ?? '')
    const bubbledError: BubbledError = {
      origin_entity_id: event.entity_id,
      origin_entity_type: entity.entity_type,
      source: String(event.attributes?.source ?? 'unknown'),
      message: rawMessage.slice(0, MAX_MESSAGE_LENGTH),
      ts: event.ts,
    }

    let currentId: string | undefined = entity.parent_id
    while (currentId) {
      const parent = this.deps.getEntity(currentId)
      if (!parent) break

      this.deps.spanManager.addEvent(currentId, 'child_error', { ...bubbledError })

      const existing = (parent.attributes?.errors as BubbledError[] | undefined) ?? []
      this.deps.updateAttributes(currentId, {
        errors: [...existing, bubbledError],
      })

      currentId = parent.parent_id
    }
  }
}
