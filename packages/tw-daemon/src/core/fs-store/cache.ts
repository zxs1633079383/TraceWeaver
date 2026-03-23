// packages/tw-daemon/src/core/fs-store/cache.ts
import type { Entity } from '@traceweaver/types'

export class EntityCache {
  private readonly store = new Map<string, Entity>()

  private clone(entity: Entity): Entity {
    return {
      ...entity,
      depends_on: entity.depends_on ? [...entity.depends_on] : undefined,
      artifact_refs: entity.artifact_refs ? entity.artifact_refs.map(r => ({ ...r })) : undefined,
      constraint_refs: entity.constraint_refs ? [...entity.constraint_refs] : undefined,
      attributes: entity.attributes ? { ...entity.attributes } : undefined,
    }
  }

  set(entity: Entity): void {
    this.store.set(entity.id, this.clone(entity))
  }

  get(id: string): Entity | undefined {
    const e = this.store.get(id)
    return e ? this.clone(e) : undefined
  }

  getAll(): Entity[] {
    return Array.from(this.store.values()).map(e => this.clone(e))
  }

  invalidate(id: string): void {
    this.store.delete(id)
  }

  clear(): void {
    this.store.clear()
  }
}
