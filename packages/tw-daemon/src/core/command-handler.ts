// packages/tw-daemon/src/core/command-handler.ts
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EntityRegistry } from './engine/entity-registry.js'
import { Dag } from './engine/dag.js'
import { Wal } from './fs-store/wal.js'
import { FsStore } from './fs-store/store.js'
import { EntityCache } from './fs-store/cache.js'
import { EventBus } from './event-bus/event-bus.js'
import { ImpactResolver } from '../impact/impact-resolver.js'
import type { ImpactResult } from '../impact/impact-resolver.js'
import { SpanManager } from '../otel/span-manager.js'
import type { EventLog } from '../log/event-log.js'
import type {
  Entity, EntityType, RegisterParams, UpdateStateParams,
  UpdateAttributesParams, GetStatusParams, ArtifactRef, TwEvent, TwEventType,
} from '@traceweaver/types'

export interface CommandHandlerOptions {
  storeDir: string
  eventBus?: EventBus
  spanManager?: SpanManager
  eventLog?: EventLog
}

export class CommandHandler {
  private readonly registry = new EntityRegistry()
  private readonly dag = new Dag()
  private readonly wal: Wal
  private readonly store: FsStore
  private readonly cache = new EntityCache()
  private readonly impactResolver = new ImpactResolver()
  private readonly opts: CommandHandlerOptions

  constructor(rootOrOptions: string | CommandHandlerOptions) {
    if (typeof rootOrOptions === 'string') {
      this.opts = { storeDir: rootOrOptions }
    } else {
      this.opts = rootOrOptions
    }
    const root = this.opts.storeDir
    this.wal   = new Wal(join(root, '.wal'))
    this.store = new FsStore(root)
  }

  private emit(event: TwEvent): void {
    this.opts.eventBus?.publish(event)
    this.opts.eventLog?.append(event)
  }

  async init(): Promise<void> {
    // Replay WAL to restore in-memory state
    const entries = await this.wal.replay()
    for (const entry of entries) {
      try {
        if (entry.op === 'upsert_entity') {
          const p = entry.payload as unknown as RegisterParams
          const entity = this.registry.register(p)
          this.dag.addNode(p.id)
          if (p.depends_on?.length) {
            for (const dep of p.depends_on) {
              this.dag.addNode(dep)
              this.dag.addEdge(p.id, dep)
            }
          }
          this.cache.set(entity)
        } else if (entry.op === 'update_state') {
          const p = entry.payload as unknown as UpdateStateParams
          const entity = this.registry.updateState(p.id, p.state, p.reason)
          this.cache.set(entity)
        } else if (entry.op === 'update_attributes') {
          const p = entry.payload as unknown as UpdateAttributesParams
          const entity = this.registry.updateAttributes(p.id, p.attributes)
          this.cache.set(entity)
        } else if (entry.op === 'remove_entity') {
          const { id } = entry.payload as { id: string; entity_type: EntityType }
          this.registry.remove(id)
          this.dag.removeNode(id)
          this.cache.invalidate(id)
        }
      } catch (err: unknown) {
        // Skip expected replay errors (DUPLICATE_ID from re-registering already-known entities).
        // Unexpected errors are re-thrown so they surface rather than being silently swallowed.
        const code = (err as { code?: string }).code
        if (code !== 'DUPLICATE_ID') throw err
      }
    }
    this.impactResolver.index(this.registry.getAll())
  }

  async register(params: RegisterParams): Promise<Entity> {
    const entity = this.registry.register(params)
    this.dag.addNode(params.id)
    if (params.depends_on?.length) {
      for (const dep of params.depends_on) {
        this.dag.addNode(dep)
        this.dag.addEdge(params.id, dep)
      }
    }
    this.cache.set(entity)
    this.impactResolver.upsert(entity)
    await this.wal.append({
      op: 'upsert_entity',
      idempotency_key: `register-${params.id}`,
      payload: params as unknown as Record<string, unknown>,
    })
    await this.store.writeEntity(entity)

    // Publish event
    this.emit({
      id: randomUUID(),
      type: 'entity.registered',
      entity_id: params.id,
      entity_type: params.entity_type,
      ts: new Date().toISOString(),
    })
    // Create OTel span
    const parentSpan = params.parent_id ? this.opts.spanManager?.getSpan(params.parent_id) : undefined
    this.opts.spanManager?.createSpan({
      entity_id: params.id,
      entity_type: params.entity_type,
      parent_span_id: parentSpan?.span_id,
    })

    return entity
  }

  async updateState(params: UpdateStateParams): Promise<Entity> {
    // Capture previous state before update
    const before = this.registry.get(params.id)
    const previousState = before?.state

    const entity = this.registry.updateState(params.id, params.state, params.reason)
    this.cache.set(entity)
    await this.wal.append({
      op: 'update_state',
      idempotency_key: `update_state-${params.id}-${randomUUID()}`,
      payload: params as unknown as Record<string, unknown>,
    })
    await this.store.writeEntity(entity)

    // Publish event
    this.emit({
      id: randomUUID(),
      type: 'entity.state_changed',
      entity_id: params.id,
      entity_type: entity.entity_type,
      state: params.state,
      previous_state: previousState,
      ts: new Date().toISOString(),
    })
    // Add OTel event
    this.opts.spanManager?.addEvent(params.id, `state_changed_to_${params.state}`, {
      from: previousState,
      reason: params.reason,
    })
    // End span on terminal states
    if (params.state === 'completed' || params.state === 'rejected' || params.state === 'superseded') {
      const status = SpanManager.stateToStatus(params.state)
      this.opts.spanManager?.endSpan(params.id, status)
    }

    return entity
  }

  async updateAttributes(params: UpdateAttributesParams): Promise<Entity> {
    const entity = this.registry.updateAttributes(params.id, params.attributes)
    this.cache.set(entity)
    this.impactResolver.upsert(entity)
    await this.wal.append({
      op: 'update_attributes',
      idempotency_key: `update_attrs-${params.id}-${randomUUID()}`,
      payload: params as unknown as Record<string, unknown>,
    })
    await this.store.writeEntity(entity)

    // Publish event
    this.emit({
      id: randomUUID(),
      type: 'entity.updated',
      entity_id: params.id,
      ts: new Date().toISOString(),
    })

    return entity
  }

  async remove(id: string): Promise<void> {
    const entity = this.registry.get(id)
    if (!entity) return
    this.registry.remove(id)
    this.dag.removeNode(id)
    this.cache.invalidate(id)
    this.impactResolver.index(this.registry.getAll())
    await this.store.deleteEntity(id, entity.entity_type)
    await this.wal.append({
      op: 'remove_entity',
      idempotency_key: `remove-${id}-${randomUUID()}`,
      payload: { id, entity_type: entity.entity_type },
    })

    // Publish event
    this.emit({
      id: randomUUID(),
      type: 'entity.removed',
      entity_id: id,
      ts: new Date().toISOString(),
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

  // ─── New API methods (Phase 2) ────────────────────────────────────────────

  async get(params: { id: string }): Promise<any> {
    const entity = this.registry.get(params.id)
    if (!entity) {
      return { ok: false, error: { code: 'ENTITY_NOT_FOUND', message: `Entity ${params.id} not found` } }
    }
    return { ok: true, data: entity }
  }

  getDagSnapshot(): { nodes: Array<{ id: string; entity_type: string }>; edges: Array<{ from: string; to: string }> } {
    const entities = this.registry.getAll()
    const nodes = entities.map(e => ({ id: e.id, entity_type: e.entity_type }))
    const edges: Array<{ from: string; to: string }> = []
    for (const e of entities) {
      for (const dep of e.depends_on ?? []) {
        edges.push({ from: e.id, to: dep })
      }
    }
    return { nodes, edges }
  }

  async linkArtifact(params: { entity_id: string; artifact: ArtifactRef }): Promise<any> {
    const entity = this.registry.get(params.entity_id)
    if (!entity) {
      return { ok: false, error: { code: 'ENTITY_NOT_FOUND', message: `Entity ${params.entity_id} not found` } }
    }
    const newRefs = [...(entity.artifact_refs ?? []), params.artifact]
    await this.updateAttributes({ id: params.entity_id, attributes: { artifact_refs: newRefs } })
    this.emit({
      id: randomUUID(),
      type: 'artifact.linked',
      entity_id: params.entity_id,
      ts: new Date().toISOString(),
      attributes: { artifact: params.artifact as unknown as Record<string, unknown> },
    })
    return { ok: true, data: { entity_id: params.entity_id, artifact_ref: `${params.artifact.type}:${params.artifact.path}` } }
  }

  async emitEvent(params: { entity_id: string; event: string; attributes?: Record<string, unknown> }): Promise<any> {
    this.opts.spanManager?.addEvent(params.entity_id, params.event, params.attributes)
    this.emit({
      id: randomUUID(),
      type: 'hook.received',
      entity_id: params.entity_id,
      ts: new Date().toISOString(),
      attributes: { event: params.event, ...params.attributes },
    })
    return { ok: true, data: { event_id: randomUUID(), timestamp: new Date().toISOString() } }
  }

  async queryEvents(params: { entity_id?: string; event_type?: string; since?: string; limit?: number }): Promise<any> {
    const history = this.opts.eventLog
      ? this.opts.eventLog.query({ entity_id: params.entity_id, event_type: params.event_type as TwEventType | undefined, since: params.since, limit: params.limit })
      : (this.opts.eventBus?.getHistory(params.since) ?? [])
    let filtered = Array.isArray(history) ? history : []
    if (params.entity_id && !this.opts.eventLog) filtered = filtered.filter((e: any) => e.entity_id === params.entity_id)
    if (params.event_type && !this.opts.eventLog) filtered = filtered.filter((e: any) => e.type === params.event_type)
    const limited = params.limit ? filtered.slice(-params.limit) : filtered
    return { ok: true, data: limited }
  }

  async cascadeUpdate(params: {
    id: string
    attributes: Record<string, unknown>
    cascade: boolean
  }): Promise<{ ok: boolean; data?: { id: string; updated_count: number }; error?: { code: string; message: string } }> {
    const entity = this.registry.get(params.id)
    if (!entity) {
      return { ok: false, error: { code: 'ENTITY_NOT_FOUND', message: `Entity ${params.id} not found` } }
    }

    await this.updateAttributes({ id: params.id, attributes: params.attributes })
    let updatedCount = 1

    if (params.cascade) {
      const descendants = this.dag.getTransitiveDependents(params.id)
      for (const descendantId of descendants) {
        const desc = this.registry.get(descendantId)
        if (!desc) continue
        this.opts.spanManager?.addEvent(descendantId, 'upstream_updated', {
          source: params.id,
          changed: Object.keys(params.attributes),
        })
        this.emit({
          id: randomUUID(),
          type: 'entity.upstream_changed',
          entity_id: descendantId,
          ts: new Date().toISOString(),
          attributes: { source: params.id, changed: Object.keys(params.attributes) },
        })
        updatedCount++
      }
    }

    return { ok: true, data: { id: params.id, updated_count: updatedCount } }
  }

  async remediationNext(queueDir: string): Promise<Record<string, unknown> | null> {
    const { readdir, readFile, rename, mkdir } = await import('node:fs/promises')
    const pendingDir = join(queueDir, 'pending')
    const inProgressDir = join(queueDir, 'in-progress')
    await mkdir(pendingDir, { recursive: true })
    await mkdir(inProgressDir, { recursive: true })
    let files: string[]
    try { files = await readdir(pendingDir) } catch { return null /* ENOENT: queue not yet created */ }
    const jsonFiles = files.filter(f => f.endsWith('.json')).sort()
    if (jsonFiles.length === 0) return null
    const file = jsonFiles[0]
    const src = join(pendingDir, file)
    const dst = join(inProgressDir, file)
    const raw = await readFile(src, 'utf8')
    const item = JSON.parse(raw) as Record<string, unknown>
    await rename(src, dst)
    return item
  }

  async remediationDone(params: { remId: string; queueDir: string }): Promise<{ ok: boolean }> {
    const { readdir, rename, mkdir } = await import('node:fs/promises')
    const inProgressDir = join(params.queueDir, 'in-progress')
    const doneDir = join(params.queueDir, 'done')
    await mkdir(doneDir, { recursive: true })
    let files: string[]
    try { files = await readdir(inProgressDir) } catch { return { ok: false } /* ENOENT: in-progress dir not yet created */ }
    const target = files.find(f => f.includes(params.remId))
    if (!target) return { ok: false }
    await rename(join(inProgressDir, target), join(doneDir, target))
    return { ok: true }
  }

  async usecaseMutate(params: {
    id: string
    mutation_type: 'insert' | 'update'
    context?: string
    entities?: RegisterParams[]
  }): Promise<{ ok: boolean; data?: { registered_count?: number }; error?: { code: string; message: string } }> {
    const entity = this.registry.get(params.id)
    if (!entity) {
      return { ok: false, error: { code: 'ENTITY_NOT_FOUND', message: `Entity ${params.id} not found` } }
    }

    if (params.mutation_type === 'insert' && params.entities?.length) {
      let count = 0
      for (const e of params.entities) {
        await this.register(e)
        count++
      }
      return { ok: true, data: { registered_count: count } }
    }

    if (params.mutation_type === 'update') {
      await this.updateAttributes({
        id: params.id,
        attributes: {
          mutation_context: params.context,
          mutation_ts: new Date().toISOString(),
          mutation_type: 'update',
        },
      })

      this.emit({
        id: randomUUID(),
        type: 'usecase.mutated',
        entity_id: params.id,
        entity_type: entity.entity_type,
        ts: new Date().toISOString(),
        attributes: { mutation_type: 'update', context: params.context },
      })

      return { ok: true, data: {} }
    }

    return { ok: true, data: {} }
  }

  async usecaseReplace(params: {
    id: string
    supersede: string[]
    new_entities?: RegisterParams[]
  }): Promise<{ ok: boolean; data?: { superseded_count: number; registered_count: number }; error?: { code: string; message: string } }> {
    const entity = this.registry.get(params.id)
    if (!entity) {
      return { ok: false, error: { code: 'ENTITY_NOT_FOUND', message: `Entity ${params.id} not found` } }
    }

    let supersededCount = 0
    for (const targetId of params.supersede) {
      const target = this.registry.get(targetId)
      if (!target) continue
      await this.updateState({ id: targetId, state: 'superseded', reason: 'replaced_by_new_chain' })
      supersededCount++
    }

    let registeredCount = 0
    if (params.new_entities?.length) {
      for (const e of params.new_entities) {
        await this.register(e)
        registeredCount++
      }
    }

    return { ok: true, data: { superseded_count: supersededCount, registered_count: registeredCount } }
  }

  async sessionRebind(params: {
    old_entity_id: string
    new_entity_id: string
  }): Promise<{ ok: boolean; error?: { code: string; message: string } }> {
    const oldEntity = this.registry.get(params.old_entity_id)
    const newEntity = this.registry.get(params.new_entity_id)
    if (!oldEntity) return { ok: false, error: { code: 'ENTITY_NOT_FOUND', message: `Old entity ${params.old_entity_id} not found` } }
    if (!newEntity) return { ok: false, error: { code: 'ENTITY_NOT_FOUND', message: `New entity ${params.new_entity_id} not found` } }

    this.opts.spanManager?.rebindEvents(params.old_entity_id, params.new_entity_id)

    this.emit({
      id: randomUUID(),
      type: 'session.rebound',
      entity_id: params.new_entity_id,
      ts: new Date().toISOString(),
      attributes: { old_entity_id: params.old_entity_id },
    })

    // Supersede the anonymous session entity
    if (oldEntity.state !== 'completed' && oldEntity.state !== 'rejected' && oldEntity.state !== 'superseded') {
      if (oldEntity.state === 'pending') {
        await this.updateState({ id: params.old_entity_id, state: 'superseded', reason: 'session_rebound' })
      } else {
        // in_progress → paused → superseded
        await this.updateState({ id: params.old_entity_id, state: 'paused', reason: 'session_rebound' })
        await this.updateState({ id: params.old_entity_id, state: 'superseded', reason: 'session_rebound' })
      }
    }

    return { ok: true }
  }

  getAllEntities(): Entity[] {
    return this.registry.getAll()
  }

  getEntityById(id: string): Entity | undefined {
    return this.registry.get(id)
  }

  resolveImpact(filePath: string, section?: string): ImpactResult {
    return this.impactResolver.resolve(filePath, section)
  }
}
