import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ErrorBubbler } from './error-bubbler.js'
import type { TwEvent, Entity } from '@traceweaver/types'

describe('ErrorBubbler', () => {
  const mockSpanManager = {
    addEvent: vi.fn(),
  }

  const entities: Record<string, Entity> = {
    'task-1': { id: 'task-1', entity_type: 'task', state: 'in_progress', parent_id: 'plan-1', created_at: '', updated_at: '' },
    'plan-1': { id: 'plan-1', entity_type: 'plan', state: 'in_progress', parent_id: 'uc-1', created_at: '', updated_at: '' },
    'uc-1':   { id: 'uc-1', entity_type: 'usecase', state: 'in_progress', created_at: '', updated_at: '' },
  }

  const mockGetEntity = (id: string) => entities[id]
  const mockUpdateAttributes = vi.fn()

  let bubbler: ErrorBubbler

  beforeEach(() => {
    vi.clearAllMocks()
    bubbler = new ErrorBubbler({
      spanManager: mockSpanManager as any,
      getEntity: mockGetEntity,
      updateAttributes: mockUpdateAttributes,
    })
  })

  it('bubbles error.captured to parent chain', () => {
    const event: TwEvent = {
      id: 'evt-1',
      type: 'error.captured',
      entity_id: 'task-1',
      ts: '2026-03-30T00:00:00Z',
      attributes: { source: 'build', message: 'tsc error TS2345' },
    }

    bubbler.handle(event)

    expect(mockSpanManager.addEvent).toHaveBeenCalledTimes(2)
    expect(mockSpanManager.addEvent).toHaveBeenCalledWith('plan-1', 'child_error', expect.objectContaining({
      origin_entity_id: 'task-1',
      source: 'build',
    }))
    expect(mockSpanManager.addEvent).toHaveBeenCalledWith('uc-1', 'child_error', expect.objectContaining({
      origin_entity_id: 'task-1',
      source: 'build',
    }))
  })

  it('updates parent attributes with errors array', () => {
    const event: TwEvent = {
      id: 'evt-1',
      type: 'error.captured',
      entity_id: 'task-1',
      ts: '2026-03-30T00:00:00Z',
      attributes: { source: 'build', message: 'tsc error TS2345' },
    }

    bubbler.handle(event)

    expect(mockUpdateAttributes).toHaveBeenCalledTimes(2)
    expect(mockUpdateAttributes).toHaveBeenCalledWith('plan-1', expect.objectContaining({
      errors: expect.arrayContaining([expect.objectContaining({ origin_entity_id: 'task-1' })]),
    }))
  })

  it('ignores non-error.captured events', () => {
    const event: TwEvent = {
      id: 'evt-1',
      type: 'entity.state_changed',
      entity_id: 'task-1',
      ts: '2026-03-30T00:00:00Z',
    }

    bubbler.handle(event)

    expect(mockSpanManager.addEvent).not.toHaveBeenCalled()
  })

  it('stops at root entity (no parent_id)', () => {
    const event: TwEvent = {
      id: 'evt-1',
      type: 'error.captured',
      entity_id: 'uc-1',
      ts: '2026-03-30T00:00:00Z',
      attributes: { source: 'tool', message: 'Edit failed' },
    }

    bubbler.handle(event)

    expect(mockSpanManager.addEvent).not.toHaveBeenCalled()
  })

  it('truncates message to 500 characters', () => {
    const event: TwEvent = {
      id: 'evt-1',
      type: 'error.captured',
      entity_id: 'task-1',
      ts: '2026-03-30T00:00:00Z',
      attributes: { source: 'build', message: 'x'.repeat(1000) },
    }

    bubbler.handle(event)

    const callArgs = mockSpanManager.addEvent.mock.calls[0][2]
    expect(callArgs.message.length).toBeLessThanOrEqual(500)
  })
})
