import { describe, it, expect, vi } from 'vitest';
import { ConstraintHarness } from './harness.js';
import { ConstraintEvaluator } from './evaluator.js';
import type { Entity, TwEvent } from '@traceweaver/types';

function makeEntity(overrides: Partial<Entity> & { constraint_refs?: string[] } = {}): Entity {
  return {
    id: 'T-1',
    entity_type: 'task',
    state: 'in_progress',
    depends_on: [],
    artifact_refs: [{ type: 'code', path: 'src/main.ts' }],
    attributes: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    constraint_refs: ['rules.md'],
    ...overrides,
  } as Entity;
}

function makeSpanManager() {
  return {
    createSpan: vi.fn().mockReturnValue({
      span_id: 'span-123',
      trace_id: 'trace-456',
    }),
    addEvent: vi.fn(),
    updateAttributes: vi.fn(),
    endSpan: vi.fn(),
    getSpan: vi.fn(),
  };
}

function makeEventBus() {
  const events: TwEvent[] = [];
  return {
    publish: vi.fn((event: TwEvent) => { events.push(event); }),
    events,
  };
}

describe('ConstraintHarness', () => {
  it('returns pass result and creates span', async () => {
    const evaluator = new ConstraintEvaluator({
      enabled: true,
      llmFn: async () => 'RESULT: pass\nAll good.',
    });
    const spanManager = makeSpanManager();
    const eventBus = makeEventBus();

    const harness = new ConstraintHarness({
      evaluator,
      spanManager: spanManager as any,
      eventBus: eventBus as any,
    });

    const entity = makeEntity({ constraint_refs: ['rules.md'] });

    const result = await harness.run(entity, {
      constraintContents: { 'rules.md': 'Functions under 50 lines.' },
    });

    expect(result.entity_id).toBe('T-1');
    expect(result.result).toBe('pass');
    expect(result.span_id).toBe('span-123');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
    expect(spanManager.createSpan).toHaveBeenCalledOnce();
    expect(eventBus.publish).toHaveBeenCalledOnce();
  });

  it('returns skipped when evaluator throws', async () => {
    const evaluator = new ConstraintEvaluator({
      enabled: true,
      llmFn: async () => { throw new Error('LLM down'); },
    });
    const spanManager = makeSpanManager();
    const eventBus = makeEventBus();

    const harness = new ConstraintHarness({
      evaluator,
      spanManager: spanManager as any,
      eventBus: eventBus as any,
    });

    const entity = makeEntity();
    const result = await harness.run(entity, {
      constraintContents: { 'rules.md': 'Some rule.' },
    });

    expect(result.result).toBe('skipped');
    expect(result.error).toContain('LLM down');
    expect(spanManager.endSpan).toHaveBeenCalled();
    expect(eventBus.publish).toHaveBeenCalledOnce();
  });

  it('returns skipped on timeout', async () => {
    const evaluator = new ConstraintEvaluator({
      enabled: true,
      llmFn: async () => {
        await new Promise(r => setTimeout(r, 5000));
        return 'RESULT: pass\nOK';
      },
    });
    const spanManager = makeSpanManager();
    const eventBus = makeEventBus();

    const harness = new ConstraintHarness({
      evaluator,
      spanManager: spanManager as any,
      eventBus: eventBus as any,
      timeoutMs: 100,
    });

    const entity = makeEntity();
    const result = await harness.run(entity, {
      constraintContents: { 'rules.md': 'Some rule.' },
    });

    expect(result.result).toBe('skipped');
    expect(result.error).toBe('evaluation timed out');
    expect(result.duration_ms).toBeLessThan(1000);
  }, 10_000);

  it('returns skipped without calling evaluator when no constraint_refs', async () => {
    const llmFn = vi.fn();
    const evaluator = new ConstraintEvaluator({ enabled: true, llmFn });
    const spanManager = makeSpanManager();
    const eventBus = makeEventBus();

    const harness = new ConstraintHarness({
      evaluator,
      spanManager: spanManager as any,
      eventBus: eventBus as any,
    });

    const entity = makeEntity({ constraint_refs: [] });
    const result = await harness.run(entity);

    expect(result.result).toBe('skipped');
    expect(llmFn).not.toHaveBeenCalled();
    expect(spanManager.createSpan).not.toHaveBeenCalled();
    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('publishes constraint.evaluated event with correct payload', async () => {
    const evaluator = new ConstraintEvaluator({
      enabled: true,
      llmFn: async () => 'RESULT: fail\nToo long.',
    });
    const spanManager = makeSpanManager();
    const eventBus = makeEventBus();

    const harness = new ConstraintHarness({
      evaluator,
      spanManager: spanManager as any,
      eventBus: eventBus as any,
    });

    const entity = makeEntity();
    await harness.run(entity, {
      constraintContents: { 'rules.md': 'Max 50 lines.' },
    });

    expect(eventBus.events).toHaveLength(1);
    const event = eventBus.events[0];
    expect(event.type).toBe('constraint.evaluated');
    expect(event.entity_id).toBe('T-1');
    expect(event.attributes.result).toBe('fail');
    expect(event.attributes.span_id).toBe('span-123');
    expect(event.attributes.refs_checked).toHaveLength(1);
  });
});
