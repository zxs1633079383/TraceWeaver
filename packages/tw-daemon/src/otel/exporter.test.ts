import { describe, it, expect } from 'vitest'
import { OtlpExporter } from './exporter.js'
import type { SpanMeta } from '@traceweaver/types'

const span: SpanMeta = {
  entity_id: 'T-1',
  entity_type: 'task',
  trace_id: 'abc123def456abc123def456abc12345',
  span_id: 'abc12345def67890',
  start_time: '2026-03-23T10:00:00.000Z',
  end_time: '2026-03-23T10:01:00.000Z',
  status: 'OK',
  attributes: { 'tw.entity.id': 'T-1' },
  events: [{ name: 'task_completed', ts: '2026-03-23T10:01:00.000Z' }]
}

describe('OtlpExporter', () => {
  it('skips export when disabled', async () => {
    const exporter = new OtlpExporter({ enabled: false })
    await expect(exporter.export([span])).resolves.toBeUndefined()
  })

  it('does nothing with empty spans array', async () => {
    const exporter = new OtlpExporter({ enabled: true })
    await expect(exporter.export([])).resolves.toBeUndefined()
  })

  it('uses custom fetch function when provided', async () => {
    const calls: unknown[] = []
    const mockFetch = async (url: string, opts: RequestInit) => {
      calls.push({ url, body: JSON.parse(opts.body as string) })
      return { ok: true, status: 200 } as Response
    }
    const exporter = new OtlpExporter({ enabled: true, fetch: mockFetch as any })
    await exporter.export([span])
    expect(calls).toHaveLength(1)
    const call = calls[0] as any
    expect(call.url).toBe('http://localhost:4318/v1/traces')
    expect(call.body.resourceSpans).toHaveLength(1)
    expect(call.body.resourceSpans[0].scopeSpans[0].spans[0].traceId).toBe('abc123def456abc123def456abc12345')
  })
})
