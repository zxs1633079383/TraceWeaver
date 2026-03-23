import type { EntityState } from '@traceweaver/types'
import { TransitionError } from '@traceweaver/types'

export const ALLOWED_TRANSITIONS: Readonly<Record<EntityState, EntityState[]>> = {
  pending:     ['in_progress'],
  in_progress: ['review', 'rejected'],
  review:      ['completed', 'rejected'],
  completed:   ['rejected'],
  rejected:    ['in_progress'],
}

export function canTransition(from: EntityState, to: EntityState): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false
}

export function assertTransition(from: EntityState, to: EntityState): EntityState {
  if (!canTransition(from, to)) throw new TransitionError(from, to)
  return to
}
