import type { EntityState } from '@traceweaver/types'
import { TransitionError } from '@traceweaver/types'

export const ALLOWED_TRANSITIONS: Readonly<Record<EntityState, readonly EntityState[]>> = {
  pending:     ['in_progress', 'superseded'],
  in_progress: ['review', 'rejected', 'paused'],
  review:      ['completed', 'rejected', 'paused'],
  completed:   ['rejected'],
  rejected:    ['in_progress'],
  paused:      ['in_progress', 'superseded', 'rejected'],
  superseded:  [],
}

export function canTransition(from: EntityState, to: EntityState): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false
}

export function assertTransition(from: EntityState, to: EntityState): EntityState {
  if (!canTransition(from, to)) throw new TransitionError(from, to)
  return to
}
