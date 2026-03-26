import type { Entity, EntityState, EntityType, SpanMeta, SpanTreeNode, TraceInfo } from '@traceweaver/types'
import type { SpanManager } from './span-manager.js'

export interface TraceQueryEngineOptions {
  spanManager: SpanManager
  getAllEntities: () => Entity[]
  getEntity: (id: string) => Entity | undefined
}

export class TraceQueryEngine {
  private readonly spanManager: SpanManager
  private readonly getAllEntities: () => Entity[]
  private readonly getEntity: (id: string) => Entity | undefined

  constructor(opts: TraceQueryEngineOptions) {
    this.spanManager = opts.spanManager
    this.getAllEntities = opts.getAllEntities
    this.getEntity = opts.getEntity
  }

  /** Find trace_id for an entity. Uses SpanManager first, then walks parent chain via EntityRegistry. */
  findTraceId(entityId: string): string | undefined {
    // Try live span first
    const span = this.spanManager.getSpan(entityId)
    if (span) return span.trace_id

    // Walk parent chain via EntityRegistry
    const entity = this.getEntity(entityId)
    if (!entity) return undefined
    if (entity.parent_id) return this.findTraceId(entity.parent_id)
    return undefined
  }

  /** Get all unique trace_ids from live SpanManager */
  getAllTraceIds(): string[] {
    const ids = new Set<string>()
    for (const span of this.spanManager.getAllSpans()) {
      ids.add(span.trace_id)
    }
    return [...ids]
  }

  /** Build SpanTree for a given trace_id. Returns null if not found. */
  buildSpanTree(traceId: string): SpanTreeNode | null {
    // O(n) linear scan — acceptable for < 200 entities per trace
    const allSpans = this.spanManager.getAllSpans()
    const traceSpans = allSpans.filter(s => s.trace_id === traceId)
    if (traceSpans.length === 0) return null

    const toNode = (span: SpanMeta): SpanTreeNode => {
      const entity = this.getEntity(span.entity_id)
      const state: EntityState = entity?.state ?? 'pending'

      // Find children: spans whose parent_span_id == this span's span_id
      const childSpans = traceSpans.filter(s => s.parent_span_id === span.span_id)

      const node: SpanTreeNode = {
        entity_id: span.entity_id,
        entity_type: (entity?.entity_type ?? span.entity_type) as EntityType,
        state,
        span_id: span.span_id,
        trace_id: span.trace_id,
        parent_span_id: span.parent_span_id,
        start_time: span.start_time,
        end_time: span.end_time,
        duration_ms: undefined,
        status: span.status as 'OK' | 'ERROR' | 'UNSET',
        source: 'live',
        events: span.events ?? [],
        children: childSpans.map(toNode),
      }
      return node
    }

    // Find root span (no parent_span_id, or parent_span_id not in this trace)
    const traceSpanIds = new Set(traceSpans.map(s => s.span_id))
    const rootSpans = traceSpans.filter(s => !s.parent_span_id || !traceSpanIds.has(s.parent_span_id))
    if (rootSpans.length === 0) return null

    // If multiple roots, prefer the one with no parent_span_id
    const rootSpan = rootSpans.find(s => !s.parent_span_id) ?? rootSpans[0]
    return toNode(rootSpan)
  }

  /** Build full TraceInfo including summary and _ai_context. Returns null if trace not found. */
  buildTraceInfo(traceId: string): TraceInfo | null {
    const root = this.buildSpanTree(traceId)
    if (!root) return null

    const allEntities = this.getAllEntities()
    const entityById = new Map<string, Entity>()
    for (const e of allEntities) entityById.set(e.id, e)

    let total = 0
    let completed = 0
    let in_progress = 0
    let pending = 0
    let rejected = 0
    const blocked: string[] = []

    const walk = (n: SpanTreeNode): void => {
      total++
      if (n.state === 'completed') completed++
      else if (n.state === 'in_progress') in_progress++
      else if (n.state === 'pending') pending++
      else if (n.state === 'rejected') rejected++

      // Check if blocked: has depends_on pointing to non-completed entities
      const entity = entityById.get(n.entity_id)
      if (entity?.depends_on && entity.depends_on.length > 0) {
        const isBlocked = entity.depends_on.some(depId => {
          const dep = entityById.get(depId)
          return dep !== undefined && dep.state !== 'completed'
        })
        if (isBlocked && !blocked.includes(n.entity_id)) {
          blocked.push(n.entity_id)
        }
      }

      for (const child of n.children) walk(child)
    }
    walk(root)

    // Collect rejected entity ids for the one_line summary
    const rejectedIds: string[] = []
    const collectRejected = (n: SpanTreeNode): void => {
      if (n.state === 'rejected') rejectedIds.push(n.entity_id)
      for (const child of n.children) collectRejected(child)
    }
    collectRejected(root)

    const one_line =
      `${total} 实体中 ${completed} 完成` +
      (rejectedIds.length > 0 ? `，${rejectedIds.join('/')} 被拒绝` : '') +
      (blocked.length > 0 ? `，${blocked.join('/')} 等待解锁` : '')

    const next_actions = [
      ...rejectedIds.map(id => `${id}: 已拒绝 → 检查原因后修复`),
      ...blocked.map(id => `${id}: 等待上游完成后继续`),
    ]

    const error_refs = rejectedIds.map(
      id => `events.ndjson → entity_id=${id}, type=entity.state_changed, state=rejected`
    )

    return {
      trace_id: traceId,
      root,
      summary: { total, completed, in_progress, pending, rejected, blocked },
      _ai_context: { one_line, next_actions, error_refs },
    }
  }
}
