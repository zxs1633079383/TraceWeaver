/**
 * OtlpGrpcExporter — unit tests
 *
 * Strategy: mock @grpc/grpc-js and @grpc/proto-loader entirely so no real
 * network connection is needed, then exercise the exported class behaviour.
 *
 * vi.hoisted() is required because vi.mock factories are hoisted to the top
 * of the file before any variable initialisations. hoisted() lets us create
 * shared mock handles that are available in both the factory and the tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── hoisted mock handles ──────────────────────────────────────────────────────
const { mockExportFn, mockCloseFn, mockMetadataSet, MockMetadata, MockTraceService } =
  vi.hoisted(() => {
    const mockExportFn = vi.fn()
    const mockCloseFn = vi.fn()
    const mockMetadataSet = vi.fn()
    const MockMetadata = vi.fn(() => ({ set: mockMetadataSet }))
    const MockTraceService = vi.fn(() => ({
      Export: mockExportFn,
      close: mockCloseFn,
    }))
    return { mockExportFn, mockCloseFn, mockMetadataSet, MockMetadata, MockTraceService }
  })

// ── module mocks ──────────────────────────────────────────────────────────────

vi.mock('@grpc/grpc-js', () => ({
  loadPackageDefinition: vi.fn(() => ({
    opentelemetry: {
      proto: {
        collector: {
          trace: {
            v1: { TraceService: MockTraceService },
          },
        },
      },
    },
  })),
  credentials: { createInsecure: vi.fn(() => ({})) },
  Metadata: MockMetadata,
}))

vi.mock('@grpc/proto-loader', () => ({
  loadSync: vi.fn(() => ({})),
}))

// ── import after mocks ────────────────────────────────────────────────────────
import { OtlpGrpcExporter } from './exporter-grpc.js'
import type { SpanMeta } from '@traceweaver/types'

// ── helpers ───────────────────────────────────────────────────────────────────

function makeSpan(overrides: Partial<SpanMeta> = {}): SpanMeta {
  return {
    span_id: 'aabbccdd11223344',
    trace_id: '00112233-4455-6677-8899-aabbccddeeff',
    parent_span_id: null,
    entity_id: 'task-1',
    entity_type: 'task',
    name: 'test span',
    start_time: '2024-01-01T00:00:00.000Z',
    end_time: '2024-01-01T00:00:01.000Z',
    status: 'OK',
    attributes: { env: 'test' },
    events: [],
    ...overrides,
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('OtlpGrpcExporter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── 1. no-op when disabled ─────────────────────────────────────────────────

  it('export() is a no-op when enabled=false', async () => {
    const exporter = new OtlpGrpcExporter({
      endpoint: 'localhost:4317',
      enabled: false,
    })
    await exporter.export([makeSpan()])
    expect(MockTraceService).not.toHaveBeenCalled()
    expect(mockExportFn).not.toHaveBeenCalled()
  })

  // ── 2. no-op when spans array is empty ────────────────────────────────────

  it('export() is a no-op when spans array is empty', async () => {
    const exporter = new OtlpGrpcExporter({ endpoint: 'localhost:4317' })
    await exporter.export([])
    expect(MockTraceService).not.toHaveBeenCalled()
    expect(mockExportFn).not.toHaveBeenCalled()
  })

  // ── 3. calls gRPC client.Export with correct payload ──────────────────────

  it('export() calls client.Export with a well-formed proto payload', async () => {
    // Arrange: Export callback resolves immediately (success)
    mockExportFn.mockImplementation(
      (_payload: unknown, _meta: unknown, cb: (err: null) => void) => { cb(null) }
    )

    const exporter = new OtlpGrpcExporter({
      endpoint: 'http://localhost:4317',
      headers: { 'x-trace-token': 'secret' },
    })
    const span = makeSpan({
      trace_id: 'aabbccdd-eeff-0011-2233-445566778899',
      span_id: '0102030405060708',
      parent_span_id: 'ffffffff00000001',
      status: 'ERROR',
      attributes: { component: 'grpc' },
      events: [{ name: 'error', ts: '2024-01-01T00:00:00.500Z', attributes: { msg: 'oops' } }],
    })

    await exporter.export([span])

    // The gRPC client constructor must have been called with stripped endpoint
    expect(MockTraceService).toHaveBeenCalledOnce()
    expect(MockTraceService).toHaveBeenCalledWith('localhost:4317', expect.anything())

    // Export RPC must have been called once
    expect(mockExportFn).toHaveBeenCalledOnce()

    const [payload, metadata] = mockExportFn.mock.calls[0] as [
      {
        resource_spans: Array<{
          resource: { attributes: Array<{ key: string; value: { string_value: string } }> }
          scope_spans: Array<{
            scope: { name: string; version: string }
            spans: Array<{
              trace_id: Buffer
              span_id: Buffer
              parent_span_id: Buffer
              name: string
              kind: number
              start_time_unix_nano: string
              end_time_unix_nano: string
              status: { code: number; message: string }
              attributes: Array<{ key: string; value: { string_value: string } }>
              events: Array<{
                name: string
                time_unix_nano: string
                attributes: Array<{ key: string; value: { string_value: string } }>
              }>
            }>
          }>
        }>
      },
      { set: typeof mockMetadataSet }
    ]

    expect(payload.resource_spans).toHaveLength(1)
    const rs = payload.resource_spans[0]
    expect(rs.resource.attributes[0]).toMatchObject({ key: 'service.name' })

    expect(rs.scope_spans).toHaveLength(1)
    const ss = rs.scope_spans[0]
    expect(ss.scope.name).toBe('traceweaver')

    const protoSpan = ss.spans[0]
    expect(Buffer.isBuffer(protoSpan.trace_id)).toBe(true)
    expect(protoSpan.trace_id).toHaveLength(16) // 128-bit trace id → 16 bytes
    expect(Buffer.isBuffer(protoSpan.span_id)).toBe(true)
    expect(protoSpan.span_id).toHaveLength(8)   // 64-bit span id → 8 bytes
    expect(Buffer.isBuffer(protoSpan.parent_span_id)).toBe(true)
    expect(protoSpan.parent_span_id.length).toBeGreaterThan(0)
    expect(protoSpan.name).toBe('tw.task')
    expect(protoSpan.kind).toBe(1)
    expect(typeof protoSpan.start_time_unix_nano).toBe('string')
    expect(typeof protoSpan.end_time_unix_nano).toBe('string')
    expect(protoSpan.status.code).toBe(2) // ERROR
    expect(protoSpan.attributes).toContainEqual({
      key: 'component',
      value: { string_value: 'grpc' },
    })
    expect(protoSpan.events).toHaveLength(1)
    expect(protoSpan.events[0].name).toBe('error')
    expect(protoSpan.events[0].attributes).toContainEqual({
      key: 'msg',
      value: { string_value: 'oops' },
    })

    // Metadata must carry custom headers via set()
    expect(mockMetadataSet).toHaveBeenCalledWith('x-trace-token', 'secret')
    void metadata
  })

  // ── 4. propagates gRPC errors ─────────────────────────────────────────────

  it('export() rejects when the gRPC client calls back with an error', async () => {
    const grpcError = new Error('UNAVAILABLE: endpoint unreachable')
    mockExportFn.mockImplementation(
      (_payload: unknown, _meta: unknown, cb: (err: Error) => void) => { cb(grpcError) }
    )

    const exporter = new OtlpGrpcExporter({ endpoint: 'localhost:4317' })
    await expect(exporter.export([makeSpan()])).rejects.toThrow('UNAVAILABLE: endpoint unreachable')
  })

  // ── 5. shutdown closes the gRPC channel ──────────────────────────────────

  it('shutdown() closes the gRPC channel after a successful export', async () => {
    mockExportFn.mockImplementation(
      (_payload: unknown, _meta: unknown, cb: (err: null) => void) => { cb(null) }
    )

    const exporter = new OtlpGrpcExporter({ endpoint: 'localhost:4317' })
    // Trigger lazy client creation
    await exporter.export([makeSpan()])
    expect(mockCloseFn).not.toHaveBeenCalled()

    await exporter.shutdown()
    expect(mockCloseFn).toHaveBeenCalledOnce()
  })

  it('shutdown() is a no-op when export() was never called (no client)', async () => {
    const exporter = new OtlpGrpcExporter({ endpoint: 'localhost:4317' })
    // Should not throw even though no client was created
    await expect(exporter.shutdown()).resolves.toBeUndefined()
    expect(mockCloseFn).not.toHaveBeenCalled()
  })

  // ── 6. http:// and https:// prefix stripping ──────────────────────────────

  it('strips http:// prefix from the endpoint passed to the gRPC client', async () => {
    mockExportFn.mockImplementation(
      (_payload: unknown, _meta: unknown, cb: (err: null) => void) => { cb(null) }
    )

    const exporter = new OtlpGrpcExporter({ endpoint: 'http://collector.internal:4317' })
    await exporter.export([makeSpan()])
    expect(MockTraceService).toHaveBeenCalledWith('collector.internal:4317', expect.anything())
  })

  it('strips https:// prefix from the endpoint', async () => {
    mockExportFn.mockImplementation(
      (_payload: unknown, _meta: unknown, cb: (err: null) => void) => { cb(null) }
    )

    const exporter = new OtlpGrpcExporter({ endpoint: 'https://secure-collector:4317' })
    await exporter.export([makeSpan()])
    expect(MockTraceService).toHaveBeenCalledWith('secure-collector:4317', expect.anything())
  })

  // ── 7. status code mapping ────────────────────────────────────────────────

  it('maps OK status to proto code 1', async () => {
    mockExportFn.mockImplementation(
      (_: unknown, __: unknown, cb: (err: null) => void) => { cb(null) }
    )
    const exporter = new OtlpGrpcExporter({ endpoint: 'localhost:4317' })
    await exporter.export([makeSpan({ status: 'OK' })])

    const [payload] = mockExportFn.mock.calls[0] as [
      { resource_spans: Array<{ scope_spans: Array<{ spans: Array<{ status: { code: number } }> }> }> }
    ]
    expect(payload.resource_spans[0].scope_spans[0].spans[0].status.code).toBe(1)
  })

  it('maps UNSET status to proto code 0', async () => {
    mockExportFn.mockImplementation(
      (_: unknown, __: unknown, cb: (err: null) => void) => { cb(null) }
    )
    const exporter = new OtlpGrpcExporter({ endpoint: 'localhost:4317' })
    await exporter.export([makeSpan({ status: 'UNSET' })])

    const [payload] = mockExportFn.mock.calls[0] as [
      { resource_spans: Array<{ scope_spans: Array<{ spans: Array<{ status: { code: number } }> }> }> }
    ]
    expect(payload.resource_spans[0].scope_spans[0].spans[0].status.code).toBe(0)
  })

  // ── 8. null parent_span_id yields empty Buffer ────────────────────────────

  it('uses empty Buffer for null parent_span_id', async () => {
    mockExportFn.mockImplementation(
      (_: unknown, __: unknown, cb: (err: null) => void) => { cb(null) }
    )
    const exporter = new OtlpGrpcExporter({ endpoint: 'localhost:4317' })
    await exporter.export([makeSpan({ parent_span_id: null })])

    const [payload] = mockExportFn.mock.calls[0] as [
      { resource_spans: Array<{ scope_spans: Array<{ spans: Array<{ parent_span_id: Buffer }> }> }> }
    ]
    const parentBuf = payload.resource_spans[0].scope_spans[0].spans[0].parent_span_id
    expect(Buffer.isBuffer(parentBuf)).toBe(true)
    expect(parentBuf).toHaveLength(0)
  })

  // ── 9. events without attributes ─────────────────────────────────────────

  it('handles events that have no attributes field', async () => {
    mockExportFn.mockImplementation(
      (_: unknown, __: unknown, cb: (err: null) => void) => { cb(null) }
    )
    const exporter = new OtlpGrpcExporter({ endpoint: 'localhost:4317' })
    const span = makeSpan({
      events: [{ name: 'checkpoint', ts: '2024-01-01T00:00:00.200Z' }],
    })
    await exporter.export([span])

    const [payload] = mockExportFn.mock.calls[0] as [
      { resource_spans: Array<{ scope_spans: Array<{ spans: Array<{ events: Array<{ name: string; attributes: unknown[] }> }> }> }> }
    ]
    const event = payload.resource_spans[0].scope_spans[0].spans[0].events[0]
    expect(event.name).toBe('checkpoint')
    expect(event.attributes).toEqual([])
  })

  // ── 10. lazy client — no calls before export() ───────────────────────────

  it('does not create the gRPC client before export() is called', () => {
    new OtlpGrpcExporter({ endpoint: 'localhost:4317' })
    expect(MockTraceService).not.toHaveBeenCalled()
  })

  // ── 11. client is reused across multiple export() calls ──────────────────

  it('reuses the same gRPC client across multiple export() calls', async () => {
    mockExportFn.mockImplementation(
      (_: unknown, __: unknown, cb: (err: null) => void) => { cb(null) }
    )
    const exporter = new OtlpGrpcExporter({ endpoint: 'localhost:4317' })
    await exporter.export([makeSpan()])
    await exporter.export([makeSpan()])
    // Client constructor called only once despite two exports
    expect(MockTraceService).toHaveBeenCalledOnce()
  })
})
