import type { TwEvent, Entity } from '@traceweaver/types'

export interface UsecaseMutationHandlerDeps {
  getEntity: (id: string) => Entity | undefined
  getDescendants: (id: string) => Entity[]
  updateState: (id: string, state: string, reason: string) => void
  spanAddEvent: (entityId: string, name: string, attrs: Record<string, unknown>) => void
}

const PAUSABLE_STATES = new Set(['in_progress', 'review'])

export class UsecaseMutationHandler {
  constructor(private readonly deps: UsecaseMutationHandlerDeps) {}

  handle(event: TwEvent): { paused_count: number } | undefined {
    if (event.type !== 'usecase.mutated') return undefined
    if (!event.entity_id) return undefined
    if (event.attributes?.mutation_type !== 'update') return undefined

    const descendants = this.deps.getDescendants(event.entity_id)
    let pausedCount = 0

    for (const entity of descendants) {
      if (!PAUSABLE_STATES.has(entity.state)) continue

      this.deps.updateState(entity.id, 'paused', 'upstream_updated')
      this.deps.spanAddEvent(entity.id, 'drain.paused', {
        reason: 'upstream_updated',
        source_usecase: event.entity_id,
        was_reviewing: entity.state === 'review',
      })
      pausedCount++
    }

    return { paused_count: pausedCount }
  }
}
