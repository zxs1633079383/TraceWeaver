/**
 * Common interface for all OTel span exporters.
 * Implementations: ConsoleExporter, OtlpHttpExporter, OtlpGrpcExporter.
 */
import type { SpanMeta } from '@traceweaver/types'

export interface TraceExporter {
  readonly name: string
  export(spans: SpanMeta[]): Promise<void>
  shutdown?(): Promise<void>
}
