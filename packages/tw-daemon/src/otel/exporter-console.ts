/**
 * ConsoleExporter — development/debug adapter.
 * Writes a one-line summary per span to stdout; never throws.
 */
import type { SpanMeta } from '@traceweaver/types'
import type { TraceExporter } from './exporter-types.js'

export class ConsoleExporter implements TraceExporter {
  readonly name = 'console'

  async export(spans: SpanMeta[]): Promise<void> {
    for (const s of spans) {
      console.log(
        `[OTel] ${s.entity_type} ${s.entity_id}` +
        ` status=${s.status}` +
        ` events=${s.events.length}`
      )
    }
  }
}
