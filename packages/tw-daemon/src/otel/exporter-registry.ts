/**
 * ExporterRegistry — fan-out hub for multiple TraceExporter implementations.
 * Uses Promise.allSettled so one failing exporter never silences the others.
 */
import type { SpanMeta } from '@traceweaver/types'
import type { TraceExporter } from './exporter-types.js'

export class ExporterRegistry {
  private readonly exporters: TraceExporter[] = []

  register(exporter: TraceExporter): void {
    this.exporters.push(exporter)
  }

  async exportAll(spans: SpanMeta[]): Promise<void> {
    if (this.exporters.length === 0 || spans.length === 0) return

    const results = await Promise.allSettled(
      this.exporters.map(e => e.export(spans))
    )

    for (const result of results) {
      if (result.status === 'rejected') {
        // Intentional: log but do not re-throw — one exporter failure must not block others.
        console.error('[ExporterRegistry] export failed:', result.reason)
      }
    }
  }

  async shutdown(): Promise<void> {
    const shutdownables = this.exporters.filter(e => typeof e.shutdown === 'function')
    await Promise.allSettled(shutdownables.map(e => e.shutdown!()))
  }

  get size(): number {
    return this.exporters.length
  }
}
