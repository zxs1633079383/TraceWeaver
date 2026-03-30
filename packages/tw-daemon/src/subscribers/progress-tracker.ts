import type { TwEvent, Entity } from '@traceweaver/types'

export interface ProgressTrackerDeps {
  getEntity: (id: string) => Entity | undefined
  getChildrenOf: (parentId: string) => Entity[]
  updateAttributes: (id: string, attrs: Record<string, unknown>) => void
}

interface Progress {
  done: number
  total: number
  percent: number
  in_progress: number
  paused: number
  rejected: number
  blocked_by: string[]
}

const TRIGGER_EVENTS = new Set([
  'entity.state_changed',
  'entity.registered',
  'entity.removed',
])

export class ProgressTracker {
  private readonly parentCache = new Map<string, string>()

  constructor(private readonly deps: ProgressTrackerDeps) {}

  cacheParent(entityId: string, parentId: string): void {
    this.parentCache.set(entityId, parentId)
  }

  handle(event: TwEvent): void {
    if (!TRIGGER_EVENTS.has(event.type)) return
    if (!event.entity_id) return

    let parentId: string | undefined

    if (event.type === 'entity.removed') {
      parentId = this.parentCache.get(event.entity_id)
      this.parentCache.delete(event.entity_id)
    } else {
      const entity = this.deps.getEntity(event.entity_id)
      if (!entity?.parent_id) return
      parentId = entity.parent_id
      this.parentCache.set(event.entity_id, parentId)
    }

    if (!parentId) return
    this.updateProgress(parentId)
  }

  private updateProgress(parentId: string): void {
    const parent = this.deps.getEntity(parentId)
    if (!parent) return

    const children = this.deps.getChildrenOf(parentId)
    if (children.length === 0) return

    const progress: Progress = {
      done: 0,
      total: children.length,
      percent: 0,
      in_progress: 0,
      paused: 0,
      rejected: 0,
      blocked_by: [],
    }

    for (const child of children) {
      if (child.state === 'completed') progress.done++
      else if (child.state === 'in_progress') progress.in_progress++
      else if (child.state === 'paused') progress.paused++
      else if (child.state === 'rejected') progress.rejected++

      if (child.depends_on?.length) {
        const unmet = child.depends_on.filter(depId => {
          const dep = this.deps.getEntity(depId)
          return dep && dep.state !== 'completed'
        })
        if (unmet.length > 0) progress.blocked_by.push(child.id)
      }
    }

    progress.percent = progress.total > 0
      ? Math.round(progress.done / progress.total * 100)
      : 0

    this.deps.updateAttributes(parentId, { progress })

    if (parent.parent_id) {
      this.updateProgress(parent.parent_id)
    }
  }
}
