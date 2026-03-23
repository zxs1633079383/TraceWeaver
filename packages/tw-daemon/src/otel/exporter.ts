/**
 * OTLP HTTP exporter for TraceWeaver deferred spans.
 * Implements OTLP/HTTP JSON protocol directly (no OTel SDK dependency).
 * In test/CI environments, export can be disabled or a custom fetch injected.
 */
import type { SpanMeta } from '@traceweaver/types'

export interface ExporterOptions {
  endpoint?: string   // default: http://localhost:4318/v1/traces
  enabled?: boolean   // default: true
  headers?: Record<string, string>
  /** Override fetch for testing */
  fetch?: typeof globalThis.fetch
}

export class OtlpExporter {
  private readonly endpoint: string
  private readonly enabled: boolean
  private readonly headers: Record<string, string>
  private readonly fetchFn: typeof fetch

  constructor(opts: ExporterOptions = {}) {
    this.endpoint = opts.endpoint ?? 'http://localhost:4318/v1/traces'
    this.enabled = opts.enabled ?? true
    this.headers = opts.headers ?? {}
    this.fetchFn = opts.fetch ?? globalThis.fetch
  }

  async export(spans: SpanMeta[]): Promise<void> {
    if (!this.enabled || spans.length === 0) return

    const body = this.buildOtlpPayload(spans)
    const response = await this.fetchFn(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })

    if (!response.ok) {
      throw new Error(`OTLP export failed: ${response.status} ${response.statusText}`)
    }
  }

  private buildOtlpPayload(spans: SpanMeta[]) {
    return {
      resourceSpans: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'traceweaver-daemon' } },
            { key: 'service.version', value: { stringValue: '0.2.0' } },
          ]
        },
        scopeSpans: [{
          scope: { name: 'traceweaver', version: '0.2.0' },
          spans: spans.map(s => this.toOtlpSpan(s))
        }]
      }]
    }
  }

  private toOtlpSpan(meta: SpanMeta) {
    const startNs = BigInt(new Date(meta.start_time).getTime()) * 1_000_000n
    const endNs = meta.end_time
      ? BigInt(new Date(meta.end_time).getTime()) * 1_000_000n
      : startNs

    return {
      traceId: meta.trace_id,
      spanId: meta.span_id,
      parentSpanId: meta.parent_span_id ?? '',
      name: `tw.${meta.entity_type}`,
      startTimeUnixNano: startNs.toString(),
      endTimeUnixNano: endNs.toString(),
      status: { code: meta.status === 'OK' ? 1 : meta.status === 'ERROR' ? 2 : 0 },
      attributes: Object.entries(meta.attributes).map(([k, v]) => ({
        key: k,
        value: { stringValue: String(v) }
      })),
      events: meta.events.map(e => ({
        name: e.name,
        timeUnixNano: (BigInt(new Date(e.ts).getTime()) * 1_000_000n).toString(),
        attributes: e.attributes
          ? Object.entries(e.attributes).map(([k, v]) => ({
              key: k, value: { stringValue: String(v) }
            }))
          : []
      }))
    }
  }
}
