import { describe, it, expect, vi, beforeEach } from 'vitest'
import { UsecaseMutationHandler } from './usecase-mutation-handler.js'
import type { TwEvent, Entity } from '@traceweaver/types'

describe('UsecaseMutationHandler', () => {
  const makeEntity = (id: string, type: string, state: string, parent?: string): Entity => ({
    id, entity_type: type as any, state: state as any, parent_id: parent, created_at: '', updated_at: '',
  })

  let entities: Record<string, Entity>
  const mockUpdateState = vi.fn()
  const mockAddEvent = vi.fn()

  let handler: UsecaseMutationHandler

  beforeEach(() => {
    vi.clearAllMocks()
    entities = {
      'uc-1':   makeEntity('uc-1', 'usecase', 'in_progress'),
      'plan-1': makeEntity('plan-1', 'plan', 'in_progress', 'uc-1'),
      'task-1': makeEntity('task-1', 'task', 'in_progress', 'plan-1'),
      'task-2': makeEntity('task-2', 'task', 'review', 'plan-1'),
      'task-3': makeEntity('task-3', 'task', 'pending', 'plan-1'),
      'task-4': makeEntity('task-4', 'task', 'completed', 'plan-1'),
    }
    handler = new UsecaseMutationHandler({
      getEntity: (id: string) => entities[id],
      getDescendants: (id: string) => {
        const result: Entity[] = []
        const children = Object.values(entities).filter(e => e.parent_id === id)
        for (const child of children) {
          result.push(child)
          result.push(...Object.values(entities).filter(e => e.parent_id === child.id))
        }
        return result
      },
      updateState: mockUpdateState,
      spanAddEvent: mockAddEvent,
    })
  })

  it('pauses in_progress and review entities on usecase.mutated', () => {
    const event: TwEvent = {
      id: 'evt-1', type: 'usecase.mutated', entity_id: 'uc-1', ts: '',
      attributes: { mutation_type: 'update' },
    }

    handler.handle(event)

    expect(mockUpdateState).toHaveBeenCalledWith('task-1', 'paused', 'upstream_updated')
    expect(mockUpdateState).toHaveBeenCalledWith('task-2', 'paused', 'upstream_updated')
    expect(mockUpdateState).toHaveBeenCalledWith('plan-1', 'paused', 'upstream_updated')
    expect(mockUpdateState).not.toHaveBeenCalledWith('task-3', 'paused', expect.anything())
    expect(mockUpdateState).not.toHaveBeenCalledWith('task-4', 'paused', expect.anything())
  })

  it('adds drain.paused span events', () => {
    const event: TwEvent = {
      id: 'evt-1', type: 'usecase.mutated', entity_id: 'uc-1', ts: '',
      attributes: { mutation_type: 'update' },
    }

    handler.handle(event)

    expect(mockAddEvent).toHaveBeenCalledWith('task-1', 'drain.paused', expect.objectContaining({
      reason: 'upstream_updated',
    }))
  })

  it('returns count of paused entities', () => {
    const event: TwEvent = {
      id: 'evt-1', type: 'usecase.mutated', entity_id: 'uc-1', ts: '',
      attributes: { mutation_type: 'update' },
    }

    const result = handler.handle(event)

    expect(result).toEqual({ paused_count: 3 })
  })

  it('ignores insert mutation type', () => {
    const event: TwEvent = {
      id: 'evt-1', type: 'usecase.mutated', entity_id: 'uc-1', ts: '',
      attributes: { mutation_type: 'insert' },
    }

    handler.handle(event)

    expect(mockUpdateState).not.toHaveBeenCalled()
  })

  it('ignores non-usecase.mutated events', () => {
    const event: TwEvent = {
      id: 'evt-1', type: 'entity.state_changed', entity_id: 'uc-1', ts: '',
    }

    handler.handle(event)

    expect(mockUpdateState).not.toHaveBeenCalled()
  })
})
