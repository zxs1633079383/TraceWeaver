import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProgressTracker } from './progress-tracker.js'
import type { TwEvent, Entity } from '@traceweaver/types'

describe('ProgressTracker', () => {
  const makeEntity = (id: string, type: string, state: string, parent?: string): Entity => ({
    id, entity_type: type as any, state: state as any, parent_id: parent, created_at: '', updated_at: '',
  })

  let entities: Record<string, Entity>
  const mockUpdateAttributes = vi.fn()

  let tracker: ProgressTracker

  beforeEach(() => {
    vi.clearAllMocks()
    entities = {
      'uc-1':   makeEntity('uc-1', 'usecase', 'in_progress'),
      'plan-1': makeEntity('plan-1', 'plan', 'in_progress', 'uc-1'),
      'task-1': makeEntity('task-1', 'task', 'completed', 'plan-1'),
      'task-2': makeEntity('task-2', 'task', 'in_progress', 'plan-1'),
      'task-3': makeEntity('task-3', 'task', 'pending', 'plan-1'),
    }
    tracker = new ProgressTracker({
      getEntity: (id: string) => entities[id],
      getChildrenOf: (id: string) => Object.values(entities).filter(e => e.parent_id === id),
      updateAttributes: mockUpdateAttributes,
    })
  })

  it('computes progress on state_changed', () => {
    const event: TwEvent = {
      id: 'evt-1', type: 'entity.state_changed', entity_id: 'task-1', ts: '',
    }

    tracker.handle(event)

    expect(mockUpdateAttributes).toHaveBeenCalledWith('plan-1', {
      progress: {
        done: 1, total: 3, percent: 33,
        in_progress: 1, paused: 0, rejected: 0,
        blocked_by: [],
      },
    })
  })

  it('recursively updates UseCase progress from Plan', () => {
    const event: TwEvent = {
      id: 'evt-1', type: 'entity.state_changed', entity_id: 'task-1', ts: '',
    }

    tracker.handle(event)

    // plan-1 is the only child of uc-1, and plan-1 is in_progress
    expect(mockUpdateAttributes).toHaveBeenCalledWith('uc-1', {
      progress: {
        done: 0, total: 1, percent: 0,
        in_progress: 1, paused: 0, rejected: 0,
        blocked_by: [],
      },
    })
  })

  it('updates on entity.registered', () => {
    const event: TwEvent = {
      id: 'evt-1', type: 'entity.registered', entity_id: 'task-3', ts: '',
      entity_type: 'task',
    }

    tracker.handle(event)

    expect(mockUpdateAttributes).toHaveBeenCalledWith('plan-1', expect.objectContaining({
      progress: expect.objectContaining({ total: 3 }),
    }))
  })

  it('ignores entities without parent_id', () => {
    const event: TwEvent = {
      id: 'evt-1', type: 'entity.state_changed', entity_id: 'uc-1', ts: '',
    }

    tracker.handle(event)

    // uc-1 has no parent, no update needed
    expect(mockUpdateAttributes).not.toHaveBeenCalled()
  })

  it('counts paused entities in progress', () => {
    entities['task-2'] = makeEntity('task-2', 'task', 'paused', 'plan-1')

    const event: TwEvent = {
      id: 'evt-1', type: 'entity.state_changed', entity_id: 'task-2', ts: '',
    }

    tracker.handle(event)

    expect(mockUpdateAttributes).toHaveBeenCalledWith('plan-1', {
      progress: expect.objectContaining({ paused: 1 }),
    })
  })

  it('handles entity.removed using cached parent', () => {
    // Cache parent before removal
    tracker.cacheParent('task-3', 'plan-1')
    delete entities['task-3']

    const event: TwEvent = {
      id: 'evt-1', type: 'entity.removed', entity_id: 'task-3', ts: '',
    }

    tracker.handle(event)

    expect(mockUpdateAttributes).toHaveBeenCalledWith('plan-1', expect.objectContaining({
      progress: expect.objectContaining({ total: 2 }),
    }))
  })
})
