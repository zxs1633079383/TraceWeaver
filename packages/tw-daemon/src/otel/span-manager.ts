import { randomUUID } from 'node:crypto'
import type { Entity, EntityType, SpanMeta, SpanEvent } from '@traceweaver/types'

export interface SpanManagerOptions {
  export?: boolean
  otlpEndpoint?: string
  projectId?: string
}

export interface CreateSpanInput {
  entity_id: string
  entity_type: EntityType
  parent_span_id?: string
}

export class SpanManager {
  private readonly spans = new Map<string, SpanMeta>()
  private readonly projectTraceId: string

  constructor(private readonly opts: SpanManagerOptions = {}) {
    this.projectTraceId = randomUUID().replace(/-/g, '')
  }

  createSpan(input: CreateSpanInput): SpanMeta {
    if (this.spans.has(input.entity_id)) {
      return this.spans.get(input.entity_id)!
    }
    const meta: SpanMeta = {
      entity_id: input.entity_id,
      entity_type: input.entity_type,
      trace_id: this.projectTraceId,
      span_id: randomUUID().replace(/-/g, '').slice(0, 16),
      parent_span_id: input.parent_span_id,
      start_time: new Date().toISOString(),
      status: 'UNSET',
      attributes: {
        'tw.entity.id': input.entity_id,
        'tw.entity.type': input.entity_type,
        'tw.project.id': this.opts.projectId ?? 'default',
      },
      events: [],
    }
    this.spans.set(input.entity_id, meta)
    return meta
  }

  addEvent(entityId: string, name: string, attributes?: Record<string, unknown>): void {
    const meta = this.spans.get(entityId)
    if (!meta) return
    const event: SpanEvent = { name, ts: new Date().toISOString(), attributes }
    meta.events.push(event)
  }

  updateAttributes(entityId: string, attrs: Record<string, unknown>): void {
    const meta = this.spans.get(entityId)
    if (!meta) return
    Object.assign(meta.attributes, attrs)
  }

  endSpan(entityId: string, status: SpanMeta['status']): SpanMeta | null {
    const meta = this.spans.get(entityId)
    if (!meta || meta.end_time) return null
    meta.status = status
    meta.end_time = new Date().toISOString()
    return meta
  }

  getSpan(entityId: string): SpanMeta | undefined {
    return this.spans.get(entityId)
  }

  getActiveSpans(): SpanMeta[] {
    return [...this.spans.values()].filter(s => !s.end_time)
  }

  hasActiveSpans(): boolean {
    return this.getActiveSpans().length > 0
  }

  static stateToStatus(state: Entity['state']): SpanMeta['status'] {
    if (state === 'completed') return 'OK'
    if (state === 'rejected') return 'ERROR'
    return 'UNSET'
  }
}
