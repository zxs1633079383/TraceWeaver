/**
 * OtlpHttpExporter — OTLP/HTTP JSON adapter.
 * Wraps the original OtlpExporter and exposes it under the TraceExporter interface.
 */
import type { SpanMeta } from '@traceweaver/types'
import type { TraceExporter } from './exporter-types.js'
import { OtlpExporter, type ExporterOptions } from './exporter.js'

export type { ExporterOptions as OtlpHttpExporterOptions }

export class OtlpHttpExporter implements TraceExporter {
  readonly name = 'otlp-http'
  private readonly inner: OtlpExporter

  constructor(opts: ExporterOptions = {}) {
    this.inner = new OtlpExporter(opts)
  }

  async export(spans: SpanMeta[]): Promise<void> {
    return this.inner.export(spans)
  }
}
