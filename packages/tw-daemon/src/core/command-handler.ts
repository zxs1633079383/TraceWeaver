// packages/tw-daemon/src/core/command-handler.ts
import { join } from 'node:path'
import { EntityRegistry } from './engine/entity-registry.js'
import { Dag } from './engine/dag.js'
import { Wal } from './fs-store/wal.js'
import { FsStore } from './fs-store/store.js'
import { EntityCache } from './fs-store/cache.js'
import type {
  Entity, EntityType, RegisterParams, UpdateStateParams,
  UpdateAttributesParams, GetStatusParams
} from '@traceweaver/types'

export class CommandHandler {
  private readonly registry = new EntityRegistry()
  private readonly dag = new Dag()
  private readonly wal: Wal
  private readonly store: FsStore
  private readonly cache = new EntityCache()

  constructor(private readonly root: string) {
    this.wal   = new Wal(join(root, '.wal'))
    this.store = new FsStore(root)
  }

  async init(): Promise<void> {
    // Replay WAL to restore in-memory state
    const entries = await this.wal.replay()
    for (const entry of entries) {
      try {
        if (entry.op === 'upsert_entity') {
          const p = entry.payload as RegisterParams
          const entity = this.registry.register(p)
          if (p.depends_on?.length) {
            this.dag.addNode(p.id)
            for (const dep of p.depends_on) {
              this.dag.addNode(dep)
              this.dag.addEdge(p.id, dep)
            }
          }
          this.cache.set(entity)
        } else if (entry.op === 'update_state') {
          const p = entry.payload as UpdateStateParams
          const entity = this.registry.updateState(p.id, p.state, p.reason)
          this.cache.set(entity)
        } else if (entry.op === 'update_attributes') {
          const p = entry.payload as UpdateAttributesParams
          const entity = this.registry.updateAttributes(p.id, p.attributes)
          this.cache.set(entity)
        } else if (entry.op === 'remove_entity') {
          const { id } = entry.payload as { id: string; entity_type: EntityType }
          this.registry.remove(id)
          this.dag.removeNode(id)
          this.cache.invalidate(id)
        }
      } catch {
        // Skip replay errors (e.g. duplicate registration)
      }
    }
  }

  async register(params: RegisterParams): Promise<Entity> {
    const entity = this.registry.register(params)
    if (params.depends_on?.length) {
      this.dag.addNode(params.id)
      for (const dep of params.depends_on) {
        this.dag.addNode(dep)
        this.dag.addEdge(params.id, dep)
      }
    }
    this.cache.set(entity)
    await this.wal.append({
      op: 'upsert_entity',
      idempotency_key: `register-${params.id}`,
      payload: params as unknown as Record<string, unknown>,
    })
    await this.store.writeEntity(entity)
    return entity
  }

  async updateState(params: UpdateStateParams): Promise<Entity> {
    const entity = this.registry.updateState(params.id, params.state, params.reason)
    this.cache.set(entity)
    await this.wal.append({
      op: 'update_state',
      idempotency_key: `update_state-${params.id}-${Date.now()}`,
      payload: params as unknown as Record<string, unknown>,
    })
    await this.store.writeEntity(entity)
    return entity
  }

  async updateAttributes(params: UpdateAttributesParams): Promise<Entity> {
    const entity = this.registry.updateAttributes(params.id, params.attributes)
    this.cache.set(entity)
    await this.wal.append({
      op: 'update_attributes',
      idempotency_key: `update_attrs-${params.id}-${Date.now()}`,
      payload: params as unknown as Record<string, unknown>,
    })
    await this.store.writeEntity(entity)
    return entity
  }

  async remove(id: string): Promise<void> {
    const entity = this.registry.get(id)
    if (!entity) return
    this.registry.remove(id)
    this.dag.removeNode(id)
    this.cache.invalidate(id)
    await this.wal.append({
      op: 'remove_entity',
      idempotency_key: `remove-${id}-${Date.now()}`,
      payload: { id, entity_type: entity.entity_type },
    })
  }

  async getStatus(params: GetStatusParams): Promise<any> {
    if (params.id) {
      const entity = this.cache.get(params.id) ?? this.registry.get(params.id)
      if (!entity) throw Object.assign(new Error(`Entity ${params.id} not found`), { code: 'ENTITY_NOT_FOUND' })
      const children = this.registry.getChildrenOf(params.id)
      return { entity, children }
    }
    const all = this.registry.getAll()
    const done = all.filter(e => e.state === 'completed').length
    return { total: all.length, done, percent: all.length ? Math.round(done / all.length * 100) : 0 }
  }
}
