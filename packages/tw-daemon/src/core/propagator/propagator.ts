import type { Entity, EntityState, PropagateResult } from '@traceweaver/types'

export class Propagator {
  private readonly byId: Map<string, Entity>
  private readonly byParent: Map<string, Entity[]>

  constructor(entities: Entity[]) {
    this.byId = new Map(entities.map(e => [e.id, e]))
    this.byParent = new Map()
    for (const e of entities) {
      if (e.parent_id) {
        const siblings = this.byParent.get(e.parent_id) ?? []
        siblings.push(e)
        this.byParent.set(e.parent_id, siblings)
      }
    }
  }

  bubbleUp(
    sourceId: string,
    newState: EntityState,
    previousState: EntityState
  ): PropagateResult {
    const result: PropagateResult = { updated: [], progress_updates: [] }
    const source = this.byId.get(sourceId)
    if (!source?.parent_id) return result

    const parent = this.byId.get(source.parent_id)
    if (!parent) return result

    const siblings = this.byParent.get(parent.id) ?? []
    // Apply the state change to source in our local view
    const states = siblings.map(s => s.id === sourceId ? newState : s.state)
    const done = states.filter(s => s === 'completed').length
    const total = states.length
    const allCompleted = done === total
    const hasRejected = states.some(s => s === 'rejected')

    if (allCompleted && parent.state !== 'completed') {
      result.updated.push({
        id: parent.id,
        entity_type: parent.entity_type,
        previous_state: parent.state,
        new_state: 'completed'
      })
      // Recursively bubble up from parent
      const parentResult = this.bubbleUp(parent.id, 'completed', parent.state)
      result.updated.push(...parentResult.updated)
      result.progress_updates.push(...parentResult.progress_updates)
    } else if (hasRejected && parent.state === 'completed') {
      // Rejected child demotes completed parent
      result.updated.push({
        id: parent.id,
        entity_type: parent.entity_type,
        previous_state: parent.state,
        new_state: 'in_progress'
      })
    } else {
      result.progress_updates.push({ id: parent.id, done, total })
    }

    return result
  }

  cascadeDown(sourceId: string, newState: EntityState): PropagateResult {
    const result: PropagateResult = { updated: [], progress_updates: [] }
    const children = this.byParent.get(sourceId) ?? []

    for (const child of children) {
      if (child.state !== newState) {
        result.updated.push({
          id: child.id,
          entity_type: child.entity_type,
          previous_state: child.state,
          new_state: newState
        })
      }
      // Recurse
      const childResult = this.cascadeDown(child.id, newState)
      result.updated.push(...childResult.updated)
    }

    return result
  }
}
