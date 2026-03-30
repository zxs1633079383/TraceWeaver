import type { Entity, ConstraintHarnessResult } from '@traceweaver/types';
import type { ConstraintEvaluator } from './evaluator.js';
import type { SpanManager } from '../otel/span-manager.js';
import type { EventBus } from '../core/event-bus/event-bus.js';

export interface ConstraintHarnessOptions {
  evaluator: ConstraintEvaluator;
  spanManager: SpanManager;
  eventBus: EventBus;
  timeoutMs?: number;
}

export interface RunOptions {
  constraintContents?: Record<string, string>;
}

export class ConstraintHarness {
  private readonly evaluator: ConstraintEvaluator;
  private readonly spanManager: SpanManager;
  private readonly eventBus: EventBus;
  private readonly timeoutMs: number;

  constructor(opts: ConstraintHarnessOptions) {
    this.evaluator = opts.evaluator;
    this.spanManager = opts.spanManager;
    this.eventBus = opts.eventBus;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async run(entity: Entity, runOpts?: RunOptions): Promise<ConstraintHarnessResult> {
    const start = Date.now();
    const checkedAt = new Date().toISOString();

    const constraintRefs: string[] =
      (entity as any).constraint_refs ?? [];

    if (constraintRefs.length === 0) {
      return {
        entity_id: entity.id,
        result: 'skipped',
        checked_at: checkedAt,
        duration_ms: Date.now() - start,
        refs_checked: [],
      };
    }

    // 1. Create span (as child of entity's span for same trace_id)
    let spanId: string | undefined;
    try {
      const parentSpan = this.spanManager.getSpan(entity.id);
      const spanMeta = this.spanManager.createSpan({
        entity_id: `constraint:${entity.id}`,
        entity_type: 'task',
        parent_span_id: parentSpan?.span_id,
      });
      spanId = spanMeta.span_id;
    } catch {
      // Span creation failure is non-fatal
    }

    // 2. Evaluate with timeout
    let evalResult: ConstraintHarnessResult;
    try {
      const evalPromise = this.evaluator.evaluate({
        entity_id: entity.id,
        constraint_refs: constraintRefs,
        artifact_refs: entity.artifact_refs ?? [],
        constraintContents: runOpts?.constraintContents,
      });

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('evaluation timed out')), this.timeoutMs)
      );

      const validation = await Promise.race([evalPromise, timeoutPromise]);

      // Collect any LLM error notes from skipped refs
      const errorNotes = validation.refs_checked
        .filter((r: any) => r.result === 'skipped' && r.note)
        .map((r: any) => r.note as string);
      const errorMsg = errorNotes.length > 0 ? errorNotes.join('; ') : undefined;

      evalResult = {
        entity_id: entity.id,
        result: validation.result as 'pass' | 'fail' | 'skipped',
        checked_at: validation.checked_at,
        duration_ms: Date.now() - start,
        span_id: spanId,
        refs_checked: validation.refs_checked,
        ...(errorMsg ? { error: errorMsg } : {}),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      evalResult = {
        entity_id: entity.id,
        result: 'skipped',
        checked_at: checkedAt,
        duration_ms: Date.now() - start,
        span_id: spanId,
        refs_checked: [],
        error: message,
      };
    }

    // 3. Update span
    if (spanId) {
      try {
        this.spanManager.updateAttributes(`constraint:${entity.id}`, {
          'constraint.result': evalResult.result,
          'constraint.duration_ms': evalResult.duration_ms,
          'constraint.refs_count': evalResult.refs_checked.length,
        });
        const spanStatus =
          evalResult.result === 'fail' ? 'ERROR' :
          evalResult.result === 'pass' ? 'OK' : 'UNSET';
        this.spanManager.endSpan(`constraint:${entity.id}`, spanStatus as any);
      } catch {
        // Span update failure is non-fatal
      }
    }

    // 4. Publish event
    try {
      this.eventBus.publish({
        id: crypto.randomUUID(),
        type: 'constraint.evaluated',
        entity_id: entity.id,
        entity_type: entity.entity_type,
        attributes: {
          result: evalResult.result,
          span_id: spanId,
          refs_checked: evalResult.refs_checked,
          duration_ms: evalResult.duration_ms,
          ...(evalResult.error ? { error: evalResult.error } : {}),
        },
        ts: evalResult.checked_at,
      });
    } catch {
      // Event publish failure is non-fatal
    }

    return evalResult;
  }
}
