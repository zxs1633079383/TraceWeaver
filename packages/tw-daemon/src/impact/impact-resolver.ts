// packages/tw-daemon/src/impact/impact-resolver.ts
import type { Entity } from '@traceweaver/types'

export interface ImpactResult {
  directly_affected: Entity[]
  transitively_affected: Entity[]
}

export class ImpactResolver {
  private readonly fileIndex = new Map<string, Set<string>>()
  private readonly dependentIndex = new Map<string, Set<string>>()
  private readonly byId = new Map<string, Entity>()

  index(entities: Entity[]): void {
    this.fileIndex.clear()
    this.dependentIndex.clear()
    this.byId.clear()
    for (const entity of entities) {
      this.byId.set(entity.id, entity)
      for (const ref of entity.artifact_refs ?? []) {
        const set = this.fileIndex.get(ref.path) ?? new Set()
        set.add(entity.id)
        this.fileIndex.set(ref.path, set)
      }
      for (const dep of entity.depends_on ?? []) {
        const set = this.dependentIndex.get(dep) ?? new Set()
        set.add(entity.id)
        this.dependentIndex.set(dep, set)
      }
    }
  }

  upsert(entity: Entity): void {
    this.byId.set(entity.id, entity)
    this.index([...this.byId.values()])
  }

  resolve(filePath: string, _section?: string): ImpactResult {
    const directIds = new Set(this.fileIndex.get(filePath) ?? [])
    const directly_affected = [...directIds].map(id => this.byId.get(id)!).filter(Boolean)
    const visited = new Set<string>(directIds)
    const queue = [...directIds]
    const transitiveIds = new Set<string>()
    while (queue.length > 0) {
      const id = queue.shift()!
      for (const dependent of this.dependentIndex.get(id) ?? []) {
        if (!visited.has(dependent)) {
          visited.add(dependent)
          transitiveIds.add(dependent)
          queue.push(dependent)
        }
      }
    }
    const transitively_affected = [...transitiveIds].map(id => this.byId.get(id)!).filter(Boolean)
    return { directly_affected, transitively_affected }
  }
}
