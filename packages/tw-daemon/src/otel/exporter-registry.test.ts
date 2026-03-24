import { describe, it, expect, vi } from 'vitest'
import { ExporterRegistry } from './exporter-registry.js'
import type { TraceExporter } from './exporter-types.js'
import type { SpanMeta } from '@traceweaver/types'

const makeSpan = (id: string): SpanMeta => ({
  entity_id: id,
  entity_type: 'task',
  trace_id: 'trace001',
  span_id: 'span001',
  start_time: '2026-03-24T00:00:00.000Z',
  end_time: '2026-03-24T00:01:00.000Z',
  status: 'OK',
  attributes: {},
  events: [],
})

const makeExporter = (name: string, fail = false): TraceExporter & { calls: SpanMeta[][] } => {
  const calls: SpanMeta[][] = []
  return {
    name,
    calls,
    async export(spans) {
      calls.push(spans)
      if (fail) throw new Error(`${name} intentional failure`)
    },
  }
}

describe('ExporterRegistry', () => {
  it('starts empty', () => {
    const reg = new ExporterRegistry()
    expect(reg.size).toBe(0)
  })

  it('register increments size', () => {
    const reg = new ExporterRegistry()
    reg.register(makeExporter('a'))
    reg.register(makeExporter('b'))
    expect(reg.size).toBe(2)
  })

  it('exportAll fans out to all exporters', async () => {
    const reg = new ExporterRegistry()
    const a = makeExporter('a')
    const b = makeExporter('b')
    reg.register(a)
    reg.register(b)
    const spans = [makeSpan('T-1')]
    await reg.exportAll(spans)
    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(1)
    expect(a.calls[0]).toEqual(spans)
  })

  it('exportAll does nothing when no exporters registered', async () => {
    const reg = new ExporterRegistry()
    // Should resolve without error
    await expect(reg.exportAll([makeSpan('T-1')])).resolves.toBeUndefined()
  })

  it('exportAll does nothing when spans array is empty', async () => {
    const reg = new ExporterRegistry()
    reg.register(makeExporter('a'))
    await expect(reg.exportAll([])).resolves.toBeUndefined()
  })

  it('exportAll — one exporter failing does not prevent others from running (allSettled)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reg = new ExporterRegistry()
    const failing = makeExporter('failing', true)
    const healthy = makeExporter('healthy')
    reg.register(failing)
    reg.register(healthy)
    const spans = [makeSpan('T-2')]

    await expect(reg.exportAll(spans)).resolves.toBeUndefined()

    expect(failing.calls).toHaveLength(1)  // was invoked
    expect(healthy.calls).toHaveLength(1)  // still ran despite peer failure
    expect(consoleSpy).toHaveBeenCalledWith(
      '[ExporterRegistry] export failed:',
      expect.any(Error)
    )
    consoleSpy.mockRestore()
  })

  it('exportAll — multiple failing exporters all get logged', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reg = new ExporterRegistry()
    reg.register(makeExporter('fail-1', true))
    reg.register(makeExporter('fail-2', true))
    await reg.exportAll([makeSpan('T-3')])
    expect(consoleSpy).toHaveBeenCalledTimes(2)
    consoleSpy.mockRestore()
  })

  it('shutdown calls shutdown() on exporters that have it', async () => {
    const reg = new ExporterRegistry()
    let shutdownCalled = false
    const withShutdown: TraceExporter = {
      name: 'with-shutdown',
      async export() {},
      async shutdown() { shutdownCalled = true },
    }
    const withoutShutdown: TraceExporter = {
      name: 'no-shutdown',
      async export() {},
    }
    reg.register(withShutdown)
    reg.register(withoutShutdown)
    await reg.shutdown()
    expect(shutdownCalled).toBe(true)
  })

  it('shutdown does not throw if a shutdown() rejects', async () => {
    const reg = new ExporterRegistry()
    const bad: TraceExporter = {
      name: 'bad-shutdown',
      async export() {},
      async shutdown() { throw new Error('shutdown error') },
    }
    reg.register(bad)
    await expect(reg.shutdown()).resolves.toBeUndefined()
  })
})
