// packages/tw-types/src/index.ts

// ─── Entity ────────────────────────────────────────────────────────────────

export type EntityType = 'usecase' | 'plan' | 'task'

export type EntityState =
  | 'pending'
  | 'in_progress'
  | 'review'
  | 'completed'
  | 'rejected'

// TODO: Used in Phase 2 (OTel + Event System) for UseCase mutation tracking
export type UsecaseMutation = 'new' | 'replace' | 'modify' | 'append'

export type ArtifactType = 'prd' | 'design' | 'code' | 'test' | string  // string allows custom types

export interface ArtifactRef {
  type: ArtifactType
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

export interface RemoveEntityParams {
  id: string
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

// ─── Events ────────────────────────────────────────────────────────────────

export type TwEventType =
  | 'entity.registered'
  | 'entity.updated'
  | 'entity.state_changed'
  | 'entity.removed'
  | 'artifact.created'
  | 'artifact.modified'
  | 'artifact.linked'
  | 'hook.received'
  | 'webhook.inbound'
  | 'git.commit'
  | 'file.changed'

export interface TwEvent {
  id: string            // uuid
  type: TwEventType
  entity_id?: string
  entity_type?: EntityType
  state?: EntityState
  previous_state?: EntityState
  attributes?: Record<string, unknown>
  ts: string            // ISO8601
}

export interface EventRecord extends TwEvent {
  seq: number           // monotonically increasing within session
}

// ─── Trigger Rules ─────────────────────────────────────────────────────────

export interface TriggerOn {
  event: TwEventType | '*'
  entity_type?: EntityType
  state?: EntityState
}

export type ActionType =
  | 'propagate'
  | 'validate'
  | 'notify'
  | 'otel'
  | 'resolve_refs'
  | 'webhook'
  | 'exec'

export interface TriggerAction {
  type: ActionType
  params?: Record<string, unknown>
}

export interface TriggerRule {
  id: string
  on: TriggerOn
  actions: TriggerAction[]
}

// ─── Propagation ────────────────────────────────────────────────────────────

export type PropagateDirection = 'bubble_up' | 'cascade_down'

export interface PropagateInput {
  direction: PropagateDirection
  source_id: string
  source_state: EntityState
  previous_state: EntityState
}

export interface PropagateResult {
  updated: Array<{
    id: string
    entity_type: EntityType
    previous_state: EntityState
    new_state: EntityState
  }>
  progress_updates: Array<{
    id: string
    done: number
    total: number
  }>
}

// ─── OTel ────────────────────────────────────────────────────────────────────

export interface SpanMeta {
  entity_id: string
  entity_type: EntityType
  trace_id: string
  span_id: string
  parent_span_id?: string
  start_time: string      // ISO8601
  end_time?: string
  status: 'UNSET' | 'OK' | 'ERROR'
  attributes: Record<string, unknown>
  events: SpanEvent[]
}

export interface SpanEvent {
  name: string
  ts: string
  attributes?: Record<string, unknown>
}

// ─── Notify ────────────────────────────────────────────────────────────────

export interface InboxItem {
  id: string
  ts: string
  event_type: TwEventType
  entity_id?: string
  message: string
  acked: boolean
}

export interface WebhookEndpoint {
  name: string
  url: string
  headers?: Record<string, string>
  events: Array<{ event: TwEventType | '*'; entity_type?: EntityType; state?: EntityState }>
}

export interface NotifyDeliveryConfig {
  retry_count: number
  retry_backoff_ms: number
  timeout_ms: number
  dead_letter: 'inbox' | 'discard'
}

export type ConstraintCheckStatus = 'pass' | 'fail' | 'skipped'

export interface ConstraintCheckResult {
  ref: string
  result: ConstraintCheckStatus
  note: string
}

export interface ConstraintValidationResult {
  result: ConstraintCheckStatus
  checked_at: string
  refs_checked: ConstraintCheckResult[]
}
