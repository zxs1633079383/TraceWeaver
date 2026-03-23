// packages/tw-daemon/src/core/fs-store/cache.ts
import type { Entity } from '@traceweaver/types'

export class EntityCache {
  private readonly store = new Map<string, Entity>()

  set(entity: Entity): void {
    this.store.set(entity.id, { ...entity })
  }

  get(id: string): Entity | undefined {
    const e = this.store.get(id)
    return e ? { ...e } : undefined
  }

  getAll(): Entity[] {
    return Array.from(this.store.values()).map(e => ({ ...e }))
  }

  invalidate(id: string): void {
    this.store.delete(id)
  }

  clear(): void {
    this.store.clear()
  }
}
