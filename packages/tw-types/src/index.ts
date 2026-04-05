// packages/tw-types/src/index.ts

// ─── Entity ────────────────────────────────────────────────────────────────

export type EntityType = 'usecase' | 'plan' | 'task'

export type EntityState =
  | 'pending'
  | 'in_progress'
  | 'review'
  | 'completed'
  | 'rejected'
  | 'paused'
  | 'superseded'

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

export interface UsecaseMutateParams {
  id: string
  mutation_type: 'insert' | 'update'
  context?: string
  entities?: RegisterParams[]
}

export interface UsecaseReplaceParams {
  id: string
  supersede: string[]
  new_entities?: RegisterParams[]
}

export interface SessionRebindParams {
  old_entity_id: string
  new_entity_id: string
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
  | 'entity.paused'
  | 'entity.superseded'
  | 'artifact.created'
  | 'artifact.modified'
  | 'artifact.linked'
  | 'hook.received'
  | 'webhook.inbound'
  | 'git.commit'
  | 'file.changed'
  | 'entity.upstream_changed'
  | 'report.generated'
  | 'error.captured'
  | 'usecase.mutated'
  | 'tool.invoked'
  | 'tool.completed'
  | 'session.started'
  | 'session.ended'
  | 'session.rebound'
  | 'constraint.evaluated'

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

// ─── Trace Query ──────────────────────────────────────────────────────────────

export interface SpanTreeNode {
  entity_id: string
  entity_type: EntityType
  state: EntityState                // from EntityRegistry (authoritative), NOT SpanMeta.status
  span_id: string                   // after daemon restart = entity_id (reconstructed mode)
  trace_id: string
  parent_span_id?: string
  start_time: string
  end_time?: string
  duration_ms?: number              // undefined in reconstructed mode
  status: 'OK' | 'ERROR' | 'UNSET'
  source: 'live' | 'reconstructed' // SpanManager vs EntityRegistry fallback
  events: SpanEvent[]              // in reconstructed mode, rebuilt from EventLog (can be empty array)
  children: SpanTreeNode[]
}

export interface TraceInfo {
  trace_id: string
  root: SpanTreeNode
  summary: {
    total: number
    completed: number
    in_progress: number
    pending: number
    rejected: number
    blocked: string[]
  }
  _ai_context: {
    one_line: string       // deterministic template, no LLM call
    next_actions: string[]
    error_refs: string[]
  }
}

// ─── Report ───────────────────────────────────────────────────────────────────

export interface ReportMeta {
  date: string          // YYYY-MM-DD
  trace_id: string
  path: string
  generated_at: string  // ISO8601
}

// ─── Constraints ──────────────────────────────────────────────────────────────

export interface ConstraintValidationResult {
  result: 'pass' | 'fail' | 'skipped'
  checked_at: string
  refs_checked: Array<{ ref: string; result: string; note?: string }>
}

export interface ConstraintHarnessResult {
  entity_id: string
  result: 'pass' | 'fail' | 'skipped'
  checked_at: string
  duration_ms: number
  span_id?: string
  refs_checked: Array<{ ref: string; result: string; note?: string }>
  error?: string
}

// ─── Trace Verification ──────────────────────────────────────────────────────

export interface TraceVerifyInput {
  service: string
  operation?: string
  startTime: number  // epoch ms
  endTime: number    // epoch ms
  expectations: {
    noErrors?: boolean
    maxDuration?: number  // ms
    expectedSpans?: string[]  // span operation names that must appear
  }
}

export interface TraceVerifyResult {
  pass: boolean
  spans: Array<{ operationName: string; duration: number; error: boolean }>
  failures: string[]  // human-readable failure reasons
  queriedAt: string   // ISO8601
}
