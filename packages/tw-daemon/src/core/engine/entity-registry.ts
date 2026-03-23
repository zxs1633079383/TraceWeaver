// packages/tw-daemon/src/core/engine/entity-registry.ts
import type { Entity, EntityState, RegisterParams } from '@traceweaver/types'
import { assertTransition } from './state-machine.js'

class RegistryError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'RegistryError'
  }
}

export class EntityRegistry {
  private readonly entities = new Map<string, Entity>()

  register(params: RegisterParams): Entity {
    if (this.entities.has(params.id)) {
      throw new RegistryError('DUPLICATE_ID', `Entity ${params.id} already exists`)
    }
    if (params.parent_id && !this.entities.has(params.parent_id)) {
      throw new RegistryError('PARENT_NOT_FOUND', `Parent ${params.parent_id} not found`)
    }
    const now = new Date().toISOString()
    const entity: Entity = {
      ...params,
      state: 'pending',
      created_at: now,
      updated_at: now,
    }
    this.entities.set(entity.id, entity)
    return { ...entity }
  }

  updateState(id: string, to: EntityState, _reason?: string): Entity {
    const entity = this.entities.get(id)
    if (!entity) throw new RegistryError('ENTITY_NOT_FOUND', `Entity ${id} not found`)
    const newState = assertTransition(entity.state, to)
    const updated = { ...entity, state: newState, updated_at: new Date().toISOString() }
    this.entities.set(id, updated)
    return { ...updated }
  }

  updateAttributes(id: string, attrs: Record<string, unknown>): Entity {
    const entity = this.entities.get(id)
    if (!entity) throw new RegistryError('ENTITY_NOT_FOUND', `Entity ${id} not found`)
    const updated = {
      ...entity,
      attributes: { ...entity.attributes, ...attrs },
      updated_at: new Date().toISOString(),
    }
    this.entities.set(id, updated)
    return { ...updated }
  }

  remove(id: string): void {
    this.entities.delete(id)
  }

  get(id: string): Entity | undefined {
    const e = this.entities.get(id)
    return e ? { ...e } : undefined
  }

  getAll(): Entity[] {
    return Array.from(this.entities.values()).map(e => ({ ...e }))
  }

  getChildrenOf(parentId: string): Entity[] {
    return this.getAll().filter(e => e.parent_id === parentId)
  }
}
