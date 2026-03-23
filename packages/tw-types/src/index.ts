// packages/tw-types/src/index.ts

// ─── Entity ────────────────────────────────────────────────────────────────

export type EntityType = 'usecase' | 'plan' | 'task'

export type EntityState =
  | 'pending'
  | 'in_progress'
  | 'review'
  | 'completed'
  | 'rejected'

export type UsecaseMutation = 'new' | 'replace' | 'modify' | 'append'

export interface ArtifactRef {
  type: string   // prd | design | code | test
  path: string
  section?: string
}

export interface Entity {
  id: string
  entity_type: EntityType
  state: EntityState
  parent_id?: string
  domain?: string           // plan only
  depends_on?: string[]
  artifact_refs?: ArtifactRef[]
  constraint_refs?: string[]
  attributes?: Record<string, unknown>
  created_at: string        // ISO8601
  updated_at: string        // ISO8601
}

// ─── State machine ────────────────────────────────────────────────────────

export class TransitionError extends Error {
  readonly code = 'INVALID_TRANSITION'
  constructor(from: EntityState, to: EntityState) {
    super(`Cannot transition from ${from} to ${to}`)
    this.name = 'TransitionError'
  }
}

// ─── IPC protocol ─────────────────────────────────────────────────────────

export interface TwRequest {
  request_id: string
  method: string
  params: Record<string, unknown>
}

export type TwResponse<T = unknown> =
  | { request_id: string; ok: true;  data: T }
  | { request_id: string; ok: false; error: { code: string; message: string } }

// ─── Commands ─────────────────────────────────────────────────────────────

export interface RegisterParams {
  entity_type: EntityType
  id: string
  parent_id?: string
  domain?: string
  depends_on?: string[]
  artifact_refs?: ArtifactRef[]
  constraint_refs?: string[]
  attributes?: Record<string, unknown>
}

export interface UpdateStateParams {
  id: string
  state: EntityState
  reason?: string
}

export interface UpdateAttributesParams {
  id: string
  attributes: Record<string, unknown>
}

export interface GetStatusParams {
  id?: string
  format?: 'summary' | 'tree'
}

// ─── WAL ──────────────────────────────────────────────────────────────────

export interface WalEntry {
  seq: number
  op: 'upsert_entity' | 'update_state' | 'update_attributes' | 'remove_entity'
  idempotency_key: string
  payload: Record<string, unknown>
  ts: string  // ISO8601
}

// ─── Project state ────────────────────────────────────────────────────────

export interface ProjectMeta {
  id: string
  name: string
  created_at: string
}

export interface Progress {
  done: number
  total: number
  percent: number
}
