import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TraceVerifier } from './trace-verifier.js';

// Helper to build a Jaeger-style response
function jaegerResponse(spans: Array<{
  operationName: string;
  duration: number;  // microseconds
  error?: boolean;
}>) {
  return {
    data: [{
      traceID: 'abc123',
      spans: spans.map((s, i) => ({
        operationName: s.operationName,
        duration: s.duration,
        tags: s.error
          ? [{ key: 'error', type: 'bool', value: true }]
          : [],
        spanID: `span-${i}`,
        traceID: 'abc123',
        startTime: 1700000000000000,
        references: [],
        processID: 'p1',
        logs: [],
        warnings: null,
      })),
      processes: { p1: { serviceName: 'my-svc', tags: [] } },
    }],
    total: 1,
    limit: 20,
    offset: 0,
  };
}

describe('TraceVerifier', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  function createVerifier(jaegerUrl = 'http://jaeger:16686') {
    return new TraceVerifier({ jaegerUrl, fetchFn: fetchMock });
  }

  it('passes when all spans are healthy and match expectations', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => jaegerResponse([
        { operationName: 'HTTP GET /api/items', duration: 50_000 },
        { operationName: 'db.query', duration: 10_000 },
      ]),
    });

    const verifier = createVerifier();
    const result = await verifier.verify({
      service: 'my-svc',
      startTime: 1700000000000,
      endTime: 1700000060000,
      expectations: {
        noErrors: true,
        maxDuration: 100,
        expectedSpans: ['HTTP GET /api/items', 'db.query'],
      },
    });

    expect(result.pass).toBe(true);
    expect(result.spans).toHaveLength(2);
    expect(result.failures).toEqual([]);
    expect(result.queriedAt).toBeTruthy();
  });

  it('fails when an error span is present and noErrors is true', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => jaegerResponse([
        { operationName: 'HTTP GET /api/items', duration: 50_000, error: true },
      ]),
    });

    const verifier = createVerifier();
    const result = await verifier.verify({
      service: 'my-svc',
      startTime: 1700000000000,
      endTime: 1700000060000,
      expectations: { noErrors: true },
    });

    expect(result.pass).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures.some(f => f.includes('error'))).toBe(true);
  });

  it('fails when span duration exceeds maxDuration', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => jaegerResponse([
        { operationName: 'slow-op', duration: 200_000 }, // 200ms
      ]),
    });

    const verifier = createVerifier();
    const result = await verifier.verify({
      service: 'my-svc',
      startTime: 1700000000000,
      endTime: 1700000060000,
      expectations: { maxDuration: 100 },
    });

    expect(result.pass).toBe(false);
    expect(result.failures.some(f => f.includes('slow-op'))).toBe(true);
    expect(result.failures.some(f => f.includes('200'))).toBe(true);
  });

  it('fails when expected spans are missing', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => jaegerResponse([
        { operationName: 'HTTP GET /api/items', duration: 50_000 },
      ]),
    });

    const verifier = createVerifier();
    const result = await verifier.verify({
      service: 'my-svc',
      startTime: 1700000000000,
      endTime: 1700000060000,
      expectations: {
        expectedSpans: ['HTTP GET /api/items', 'db.query'],
      },
    });

    expect(result.pass).toBe(false);
    expect(result.failures.some(f => f.includes('db.query'))).toBe(true);
  });

  it('handles Jaeger unavailable gracefully', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const verifier = createVerifier();
    const result = await verifier.verify({
      service: 'my-svc',
      startTime: 1700000000000,
      endTime: 1700000060000,
      expectations: { noErrors: true },
    });

    expect(result.pass).toBe(false);
    expect(result.spans).toEqual([]);
    expect(result.failures.some(f => f.includes('ECONNREFUSED'))).toBe(true);
    expect(result.queriedAt).toBeTruthy();
  });

  it('passes query parameters correctly including microsecond conversion', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => jaegerResponse([]),
    });

    const verifier = createVerifier('http://jaeger:16686');
    await verifier.verify({
      service: 'my-svc',
      operation: 'GET /health',
      startTime: 1700000000000,
      endTime: 1700000060000,
      expectations: {},
    });

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('service=my-svc');
    expect(calledUrl).toContain('operation=GET+%2Fhealth');
    // Jaeger uses microseconds
    expect(calledUrl).toContain('start=1700000000000000');
    expect(calledUrl).toContain('end=1700000060000000');
    expect(calledUrl).toContain('limit=20');
  });

  it('handles non-ok HTTP response gracefully', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    });

    const verifier = createVerifier();
    const result = await verifier.verify({
      service: 'my-svc',
      startTime: 1700000000000,
      endTime: 1700000060000,
      expectations: { noErrors: true },
    });

    expect(result.pass).toBe(false);
    expect(result.failures.some(f => f.includes('503'))).toBe(true);
  });
});
