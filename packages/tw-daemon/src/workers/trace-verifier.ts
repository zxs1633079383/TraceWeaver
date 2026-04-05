import type { TraceVerifyInput, TraceVerifyResult } from '@traceweaver/types';

interface JaegerSpan {
  operationName: string;
  duration: number;  // microseconds
  tags: Array<{ key: string; type?: string; value: unknown }>;
}

interface JaegerTrace {
  traceID: string;
  spans: JaegerSpan[];
}

interface JaegerResponse {
  data: JaegerTrace[];
}

type FetchFn = (url: string) => Promise<{ ok: boolean; status?: number; statusText?: string; json: () => Promise<unknown> }>;

export interface TraceVerifierConfig {
  jaegerUrl: string;
  fetchFn?: FetchFn;
}

export class TraceVerifier {
  private readonly jaegerUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(config: TraceVerifierConfig) {
    this.jaegerUrl = config.jaegerUrl.replace(/\/$/, '');
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
  }

  async verify(input: TraceVerifyInput): Promise<TraceVerifyResult> {
    const queriedAt = new Date().toISOString();

    let jaegerData: JaegerResponse;
    try {
      jaegerData = await this.queryJaeger(input);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        pass: false,
        spans: [],
        failures: [`Jaeger query failed: ${message}`],
        queriedAt,
      };
    }

    const parsedSpans = this.parseSpans(jaegerData);
    const failures = this.checkExpectations(parsedSpans, input.expectations);

    return {
      pass: failures.length === 0,
      spans: parsedSpans,
      failures,
      queriedAt,
    };
  }

  private async queryJaeger(input: TraceVerifyInput): Promise<JaegerResponse> {
    const params = new URLSearchParams();
    params.set('service', input.service);
    if (input.operation) {
      params.set('operation', input.operation);
    }
    // Jaeger API uses microseconds, input uses milliseconds
    params.set('start', String(input.startTime * 1000));
    params.set('end', String(input.endTime * 1000));
    params.set('limit', '20');

    const url = `${this.jaegerUrl}/api/traces?${params.toString()}`;
    const response = await this.fetchFn(url);

    if (!response.ok) {
      throw new Error(
        `Jaeger returned HTTP ${response.status ?? 'unknown'}: ${response.statusText ?? 'unknown'}`
      );
    }

    return (await response.json()) as JaegerResponse;
  }

  private parseSpans(
    data: JaegerResponse
  ): Array<{ operationName: string; duration: number; error: boolean }> {
    const result: Array<{ operationName: string; duration: number; error: boolean }> = [];

    for (const trace of data.data) {
      for (const span of trace.spans) {
        const hasError = span.tags.some(
          tag => tag.key === 'error' && (tag.value === true || tag.value === 'true')
        );
        result.push({
          operationName: span.operationName,
          duration: span.duration / 1000, // microseconds → milliseconds
          error: hasError,
        });
      }
    }

    return result;
  }

  private checkExpectations(
    spans: Array<{ operationName: string; duration: number; error: boolean }>,
    expectations: TraceVerifyInput['expectations']
  ): string[] {
    const failures: string[] = [];

    if (expectations.noErrors) {
      const errorSpans = spans.filter(s => s.error);
      for (const s of errorSpans) {
        failures.push(
          `Span "${s.operationName}" has error tag (expected no errors)`
        );
      }
    }

    if (expectations.maxDuration !== undefined) {
      for (const s of spans) {
        if (s.duration > expectations.maxDuration) {
          failures.push(
            `Span "${s.operationName}" duration ${s.duration}ms exceeds max ${expectations.maxDuration}ms`
          );
        }
      }
    }

    if (expectations.expectedSpans && expectations.expectedSpans.length > 0) {
      const foundNames = new Set(spans.map(s => s.operationName));
      for (const expected of expectations.expectedSpans) {
        if (!foundNames.has(expected)) {
          failures.push(`Expected span "${expected}" not found in traces`);
        }
      }
    }

    return failures;
  }
}
