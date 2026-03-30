import { describe, it, expect } from 'vitest'
import { canTransition, assertTransition, ALLOWED_TRANSITIONS } from './state-machine.js'
import { TransitionError } from '@traceweaver/types'

describe('canTransition', () => {
  it('allows pending → in_progress', () => {
    expect(canTransition('pending', 'in_progress')).toBe(true)
  })
  it('allows in_progress → review', () => {
    expect(canTransition('in_progress', 'review')).toBe(true)
  })
  it('allows in_progress → rejected', () => {
    expect(canTransition('in_progress', 'rejected')).toBe(true)
  })
  it('allows review → completed', () => {
    expect(canTransition('review', 'completed')).toBe(true)
  })
  it('allows review → rejected', () => {
    expect(canTransition('review', 'rejected')).toBe(true)
  })
  it('allows rejected → in_progress', () => {
    expect(canTransition('rejected', 'in_progress')).toBe(true)
  })
  it('allows completed → rejected (post-hoc review)', () => {
    expect(canTransition('completed', 'rejected')).toBe(true)
  })
  it('rejects pending → completed', () => {
    expect(canTransition('pending', 'completed')).toBe(false)
  })
  it('rejects pending → rejected', () => {
    expect(canTransition('pending', 'rejected')).toBe(false)
  })
  it('rejects completed → pending', () => {
    expect(canTransition('completed', 'pending')).toBe(false)
  })
  it('rejects same-state transition', () => {
    expect(canTransition('in_progress', 'in_progress')).toBe(false)
  })
  it('returns false for unknown state', () => {
    expect(canTransition('unknown' as EntityState, 'in_progress')).toBe(false)
  })
})

describe('assertTransition', () => {
  it('returns target state on valid transition', () => {
    expect(assertTransition('pending', 'in_progress')).toBe('in_progress')
  })
  it('throws TransitionError on invalid transition', () => {
    expect(() => assertTransition('pending', 'completed')).toThrow(TransitionError)
  })
  it('thrown error has code INVALID_TRANSITION', () => {
    expect.assertions(1)
    try {
      assertTransition('pending', 'completed')
    } catch (e) {
      expect((e as TransitionError).code).toBe('INVALID_TRANSITION')
    }
  })
})

describe('paused state transitions', () => {
  it('allows in_progress → paused', () => {
    expect(canTransition('in_progress', 'paused')).toBe(true)
  })

  it('allows review → paused', () => {
    expect(canTransition('review', 'paused')).toBe(true)
  })

  it('allows paused → in_progress (resume)', () => {
    expect(canTransition('paused', 'in_progress')).toBe(true)
  })

  it('allows paused → superseded (replace)', () => {
    expect(canTransition('paused', 'superseded')).toBe(true)
  })

  it('allows paused → rejected', () => {
    expect(canTransition('paused', 'rejected')).toBe(true)
  })

  it('rejects paused → completed', () => {
    expect(canTransition('paused', 'completed')).toBe(false)
  })
})

describe('superseded state transitions', () => {
  it('allows pending → superseded', () => {
    expect(canTransition('pending', 'superseded')).toBe(true)
  })

  it('rejects superseded → any (terminal)', () => {
    expect(canTransition('superseded', 'pending')).toBe(false)
    expect(canTransition('superseded', 'in_progress')).toBe(false)
    expect(canTransition('superseded', 'paused')).toBe(false)
  })
})
