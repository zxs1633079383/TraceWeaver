import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import type { SpanMeta } from '@traceweaver/types'
import type { TraceExporter } from './exporter-types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROTO_ROOT = path.resolve(__dirname, 'proto')
const PROTO_PATH = path.join(
  PROTO_ROOT,
  'opentelemetry/proto/collector/trace/v1/trace_service.proto',
)

export interface OtlpGrpcExporterOptions {
  /** Host:port without protocol, e.g. "localhost:4317" or accept "http://host:4317" */
  endpoint: string
  /** When false, export() is a no-op. Defaults to true. */
  enabled?: boolean
  /** Extra gRPC metadata forwarded with each request (e.g. auth tokens). */
  headers?: Record<string, string>
}

export class OtlpGrpcExporter implements TraceExporter {
  readonly name = 'otlp-grpc'
  private client: any = null
  private readonly endpoint: string
  private readonly enabled: boolean
  private readonly headers: Record<string, string>

  constructor(opts: OtlpGrpcExporterOptions) {
    this.endpoint = opts.endpoint.replace(/^https?:\/\//, '')
    this.enabled = opts.enabled ?? true
    this.headers = opts.headers ?? {}
  }

  private getClient(): any {
    if (this.client) return this.client

    const pkg = protoLoader.loadSync(PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [PROTO_ROOT],
    })
    const proto = grpc.loadPackageDefinition(pkg) as any
    const TraceService =
      proto?.opentelemetry?.proto?.collector?.trace?.v1?.TraceService

    this.client = new TraceService(
      this.endpoint,
      grpc.credentials.createInsecure(),
    )
    return this.client
  }

  async export(spans: SpanMeta[]): Promise<void> {
    if (!this.enabled || spans.length === 0) return

    const request = this._buildOtlpRequest(spans)
    const metadata = new grpc.Metadata()
    for (const [k, v] of Object.entries(this.headers)) {
      metadata.set(k, v)
    }

    return new Promise((resolve, reject) => {
      this.getClient().Export(request, metadata, (err: Error | null) => {
        if (err) {
          reject(new Error(`[OtlpGrpcExporter] export failed: ${err.message}`))
        } else {
          resolve()
        }
      })
    })
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      this.client.close()
      this.client = null
    }
  }

  private _buildOtlpRequest(spans: SpanMeta[]) {
    return {
      resource_spans: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { string_value: 'traceweaver-daemon' } },
            { key: 'service.version', value: { string_value: '0.2.0' } },
          ],
        },
        scope_spans: [{
          scope: { name: 'traceweaver', version: '0.2.0' },
          spans: spans.map(s => this._toOtlpSpan(s)),
        }],
      }],
    }
  }

  private _toOtlpSpan(meta: SpanMeta) {
    const startNs = BigInt(new Date(meta.start_time).getTime()) * 1_000_000n
    const endNs = meta.end_time
      ? BigInt(new Date(meta.end_time).getTime()) * 1_000_000n
      : startNs

    return {
      trace_id: Buffer.from(meta.trace_id.replace(/-/g, ''), 'hex'),
      span_id: Buffer.from(meta.span_id, 'hex'),
      parent_span_id: meta.parent_span_id
        ? Buffer.from(meta.parent_span_id, 'hex')
        : Buffer.alloc(0),
      name: `${meta.entity_type}/${meta.entity_id}`,
      kind: 1, // SPAN_KIND_INTERNAL
      start_time_unix_nano: startNs.toString(),
      end_time_unix_nano: endNs.toString(),
      status: {
        code: meta.status === 'OK' ? 1 : meta.status === 'ERROR' ? 2 : 0,
        message: '',
      },
      attributes: Object.entries(meta.attributes).map(([k, v]) => ({
        key: k,
        value: { string_value: String(v) },
      })),
      events: meta.events.map(e => ({
        name: e.name,
        time_unix_nano: (BigInt(new Date(e.ts).getTime()) * 1_000_000n).toString(),
        attributes: e.attributes
          ? Object.entries(e.attributes).map(([k, v]) => ({
              key: k,
              value: { string_value: String(v) },
            }))
          : [],
      })),
    }
  }
}
