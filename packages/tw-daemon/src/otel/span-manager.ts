import { randomUUID } from 'node:crypto'
import type { Entity, EntityType, SpanMeta, SpanEvent } from '@traceweaver/types'
import type { ExporterRegistry } from './exporter-registry.js'

export interface SpanManagerOptions {
  export?: boolean
  otlpEndpoint?: string
  projectId?: string
  /** Optional registry of exporters. When provided, endSpan() calls registry.exportAll(). */
  exporterRegistry?: ExporterRegistry
}

export interface CreateSpanInput {
  entity_id: string
  entity_type: EntityType
  parent_span_id?: string
}

export class SpanManager {
  private readonly spans = new Map<string, SpanMeta>()
  private readonly exporterRegistry?: ExporterRegistry

  constructor(private readonly opts: SpanManagerOptions = {}) {
    this.exporterRegistry = opts.exporterRegistry
  }

  private deriveTraceId(parentSpanId?: string): string {
    if (parentSpanId) {
      for (const span of this.spans.values()) {
        if (span.span_id === parentSpanId) return span.trace_id
      }
    }
    return randomUUID().replace(/-/g, '')
  }

  createSpan(input: CreateSpanInput): SpanMeta {
    if (this.spans.has(input.entity_id)) {
      return this.spans.get(input.entity_id)!
    }
    const meta: SpanMeta = {
      entity_id: input.entity_id,
      entity_type: input.entity_type,
      trace_id: this.deriveTraceId(input.parent_span_id),
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
    if (this.exporterRegistry) {
      // Fire-and-forget: export errors are handled inside ExporterRegistry.exportAll
      void this.exporterRegistry.exportAll([meta])
    }
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

  getAllSpans(entityType?: EntityType): SpanMeta[] {
    const all = [...this.spans.values()]
    if (!entityType) return all
    return all.filter(s => s.entity_type === entityType)
  }

  static stateToStatus(state: Entity['state']): SpanMeta['status'] {
    if (state === 'completed') return 'OK'
    if (state === 'rejected') return 'ERROR'
    return 'UNSET'
  }
}
