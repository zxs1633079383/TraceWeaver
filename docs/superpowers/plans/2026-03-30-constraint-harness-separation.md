# ConstraintEvaluator 职责分离 Implementation Plan

> **状态:** ✅ COMPLETED (2026-03-30) — 所有 8 个 Task 已完成，292 测试通过
> **稳定版文档:** [../../CONSTRAINT-HARNESS-STABLE.md](../../CONSTRAINT-HARNESS-STABLE.md)
> **注意:** 实现过程中发现并修复了 7 个额外问题（见稳定版文档"修复记录"）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split ConstraintEvaluator into two layers — ConstraintHarness (runtime: span/event/IPC) and ConstraintEvaluator (eval: pure LLM assessment) — so evaluation failures never block the main runtime.

**Architecture:** ConstraintHarness orchestrates the flow: creates spans, calls ConstraintEvaluator, publishes events, returns structured results via IPC. ConstraintEvaluator is a pure function that reads constraint files and calls `claude --print` for assessment. The harness wraps all evaluator calls in try/catch + 30s timeout so failures degrade to `skipped`.

**Tech Stack:** TypeScript, vitest, node:child_process (execFile), commander (CLI)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/tw-types/src/index.ts` | Modify | Add `ConstraintHarnessResult` type |
| `packages/tw-daemon/src/constraint/evaluator.ts` | Create | Pure eval: read constraints, call LLM, return pass/fail |
| `packages/tw-daemon/src/constraint/evaluator.test.ts` | Create | Unit tests for evaluator |
| `packages/tw-daemon/src/constraint/harness.ts` | Create | Runtime: span, event, timeout, orchestration |
| `packages/tw-daemon/src/constraint/harness.test.ts` | Create | Unit tests for harness |
| `packages/tw-daemon/src/ipc-server.ts` | Modify | Add `constraint.evaluate` and `constraint.history` dispatch |
| `packages/tw-daemon/src/index.ts` | Modify | Wire ConstraintEvaluator + ConstraintHarness into daemon |
| `packages/tw-cli/src/commands/constraint.ts` | Create | CLI: `tw constraint evaluate/history/show` |
| `packages/tw-cli/src/index.ts` | Modify | Register constraint command |

---

### Task 1: Add ConstraintHarnessResult type to tw-types

**Files:**
- Modify: `packages/tw-types/src/index.ts`

- [ ] **Step 1: Read existing types to find insertion point**

Open `packages/tw-types/src/index.ts` and locate the existing `ConstraintValidationResult` type. The new type goes right after it.

- [ ] **Step 2: Add ConstraintHarnessResult type**

Add after the existing `ConstraintValidationResult` interface:

```typescript
export interface ConstraintHarnessResult {
  entity_id: string;
  result: 'pass' | 'fail' | 'skipped';
  checked_at: string;
  duration_ms: number;
  span_id?: string;
  refs_checked: Array<{ ref: string; result: string; note?: string }>;
  error?: string;
}
```

- [ ] **Step 3: Verify typecheck passes**

Run: `cd packages/tw-types && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add packages/tw-types/src/index.ts
git commit -m "feat(types): add ConstraintHarnessResult interface"
```

---

### Task 2: Rebuild ConstraintEvaluator (Eval layer)

**Files:**
- Create: `packages/tw-daemon/src/constraint/evaluator.ts`
- Create: `packages/tw-daemon/src/constraint/evaluator.test.ts`

- [ ] **Step 1: Write the failing test for skipped-when-disabled**

```typescript
// packages/tw-daemon/src/constraint/evaluator.test.ts
import { describe, it, expect } from 'vitest';
import { ConstraintEvaluator } from './evaluator.js';

describe('ConstraintEvaluator', () => {
  it('returns skipped when disabled', async () => {
    const evaluator = new ConstraintEvaluator({ enabled: false });
    const result = await evaluator.evaluate({
      entity_id: 'T-1',
      constraint_refs: ['constraints.md'],
      artifact_refs: [],
    });
    expect(result.result).toBe('skipped');
    expect(result.refs_checked).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tw-daemon && npx vitest run src/constraint/evaluator.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the ConstraintEvaluator class (minimal — skipped path)**

```typescript
// packages/tw-daemon/src/constraint/evaluator.ts
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ArtifactRef, ConstraintValidationResult } from '@traceweaver/types';

const execFileAsync = promisify(execFile);

export interface EvaluateInput {
  entity_id: string;
  constraint_refs: string[];
  artifact_refs: ArtifactRef[];
  constraintContents?: Record<string, string>;
}

export interface ConstraintEvaluatorOptions {
  enabled: boolean;
  projectRoot?: string;
  llmFn?: (prompt: string) => Promise<string>;
  model?: string;
}

export class ConstraintEvaluator {
  private readonly opts: ConstraintEvaluatorOptions;

  constructor(opts: ConstraintEvaluatorOptions) {
    this.opts = opts;
  }

  async evaluate(input: EvaluateInput): Promise<ConstraintValidationResult> {
    const now = new Date().toISOString();
    if (!this.opts.enabled || input.constraint_refs.length === 0) {
      return { result: 'skipped', checked_at: now, refs_checked: [] };
    }

    const refsChecked = await Promise.all(
      input.constraint_refs.map(ref => this.checkRef(ref, input))
    );

    const overallFail = refsChecked.some(r => r.result === 'fail');
    const allSkipped = refsChecked.every(r => r.result === 'skipped');
    const result = overallFail ? 'fail' : allSkipped ? 'skipped' : 'pass';

    return { result, checked_at: now, refs_checked: refsChecked };
  }

  private async checkRef(
    ref: string,
    input: EvaluateInput
  ): Promise<{ ref: string; result: string; note?: string }> {
    let content: string;
    if (input.constraintContents?.[ref]) {
      content = input.constraintContents[ref];
    } else {
      const filePath = this.opts.projectRoot
        ? `${this.opts.projectRoot}/${ref}`
        : ref;
      try {
        content = await readFile(filePath, 'utf8');
      } catch {
        return { ref, result: 'skipped', note: 'Constraint file not found' };
      }
    }

    const artifactSummary =
      input.artifact_refs.length > 0
        ? input.artifact_refs.map(a => `${a.type}: ${a.path}`).join('\n')
        : '(no artifacts)';

    const prompt = `You are a code review assistant enforcing project constraints.

CONSTRAINT FILE: ${ref}
---
${content}
---

TASK: ${input.entity_id}
ARTIFACTS:
${artifactSummary}

Does this task output satisfy the constraints? Respond with:
RESULT: pass
(reason)
OR:
RESULT: fail
(specific violations)`;

    let llmResponse: string;
    try {
      llmResponse = await this.callLlm(prompt);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ref, result: 'skipped', note: `LLM error: ${message}` };
    }

    const resultMatch = llmResponse.match(/RESULT:\s*(pass|fail)/i);
    const checkResult = resultMatch?.[1]?.toLowerCase() ?? 'skipped';
    const note = llmResponse.replace(/RESULT:\s*(pass|fail)/i, '').trim();

    return { ref, result: checkResult, note };
  }

  private async callLlm(prompt: string): Promise<string> {
    if (this.opts.llmFn) return this.opts.llmFn(prompt);

    const model = this.opts.model ?? 'claude-opus-4-6';
    const { stdout } = await execFileAsync('claude', [
      '--print',
      '--model',
      model,
      prompt,
    ]);
    return stdout;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/tw-daemon && npx vitest run src/constraint/evaluator.test.ts`
Expected: PASS

- [ ] **Step 5: Write test for skipped-when-no-refs**

```typescript
it('returns skipped when constraint_refs is empty', async () => {
  const evaluator = new ConstraintEvaluator({ enabled: true });
  const result = await evaluator.evaluate({
    entity_id: 'T-1',
    constraint_refs: [],
    artifact_refs: [],
  });
  expect(result.result).toBe('skipped');
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/tw-daemon && npx vitest run src/constraint/evaluator.test.ts`
Expected: PASS (already handled by existing logic)

- [ ] **Step 7: Write test for pass via mock LLM**

```typescript
it('returns pass when LLM says pass', async () => {
  const evaluator = new ConstraintEvaluator({
    enabled: true,
    llmFn: async () => 'RESULT: pass\nAll constraints satisfied.',
  });
  const result = await evaluator.evaluate({
    entity_id: 'T-1',
    constraint_refs: ['rules.md'],
    artifact_refs: [{ type: 'code', path: 'src/main.ts' }],
    constraintContents: { 'rules.md': 'Functions must be under 50 lines.' },
  });
  expect(result.result).toBe('pass');
  expect(result.refs_checked).toHaveLength(1);
  expect(result.refs_checked[0].result).toBe('pass');
  expect(result.refs_checked[0].note).toContain('All constraints satisfied');
});
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd packages/tw-daemon && npx vitest run src/constraint/evaluator.test.ts`
Expected: PASS

- [ ] **Step 9: Write test for fail via mock LLM**

```typescript
it('returns fail when LLM says fail', async () => {
  const evaluator = new ConstraintEvaluator({
    enabled: true,
    llmFn: async () => 'RESULT: fail\nFunction exceeds 50 lines.',
  });
  const result = await evaluator.evaluate({
    entity_id: 'T-1',
    constraint_refs: ['rules.md'],
    artifact_refs: [],
    constraintContents: { 'rules.md': 'Functions must be under 50 lines.' },
  });
  expect(result.result).toBe('fail');
  expect(result.refs_checked[0].result).toBe('fail');
  expect(result.refs_checked[0].note).toContain('Function exceeds 50 lines');
});
```

- [ ] **Step 10: Run test to verify it passes**

Run: `cd packages/tw-daemon && npx vitest run src/constraint/evaluator.test.ts`
Expected: PASS

- [ ] **Step 11: Write test for LLM error graceful degradation**

```typescript
it('returns skipped when LLM throws', async () => {
  const evaluator = new ConstraintEvaluator({
    enabled: true,
    llmFn: async () => { throw new Error('connection refused'); },
  });
  const result = await evaluator.evaluate({
    entity_id: 'T-1',
    constraint_refs: ['rules.md'],
    artifact_refs: [],
    constraintContents: { 'rules.md': 'Some constraint.' },
  });
  expect(result.result).toBe('skipped');
  expect(result.refs_checked[0].note).toContain('connection refused');
});
```

- [ ] **Step 12: Run test to verify it passes**

Run: `cd packages/tw-daemon && npx vitest run src/constraint/evaluator.test.ts`
Expected: PASS

- [ ] **Step 13: Write test for missing constraint file**

```typescript
it('returns skipped for missing constraint file', async () => {
  const evaluator = new ConstraintEvaluator({
    enabled: true,
    projectRoot: '/nonexistent',
    llmFn: async () => 'RESULT: pass\nOK',
  });
  const result = await evaluator.evaluate({
    entity_id: 'T-1',
    constraint_refs: ['missing.md'],
    artifact_refs: [],
  });
  expect(result.result).toBe('skipped');
  expect(result.refs_checked[0].note).toBe('Constraint file not found');
});
```

- [ ] **Step 14: Run test to verify it passes**

Run: `cd packages/tw-daemon && npx vitest run src/constraint/evaluator.test.ts`
Expected: PASS

- [ ] **Step 15: Write test for mixed results (one pass, one fail)**

```typescript
it('returns fail when any ref fails', async () => {
  let callCount = 0;
  const evaluator = new ConstraintEvaluator({
    enabled: true,
    llmFn: async () => {
      callCount++;
      return callCount === 1
        ? 'RESULT: pass\nOK'
        : 'RESULT: fail\nViolation found';
    },
  });
  const result = await evaluator.evaluate({
    entity_id: 'T-1',
    constraint_refs: ['a.md', 'b.md'],
    artifact_refs: [],
    constraintContents: { 'a.md': 'Rule A', 'b.md': 'Rule B' },
  });
  expect(result.result).toBe('fail');
  expect(result.refs_checked).toHaveLength(2);
});
```

- [ ] **Step 16: Run test to verify it passes**

Run: `cd packages/tw-daemon && npx vitest run src/constraint/evaluator.test.ts`
Expected: PASS

- [ ] **Step 17: Commit**

```bash
git add packages/tw-daemon/src/constraint/evaluator.ts packages/tw-daemon/src/constraint/evaluator.test.ts
git commit -m "feat(daemon): rebuild ConstraintEvaluator as pure eval layer"
```

---

### Task 3: Create ConstraintHarness (Runtime layer)

**Files:**
- Create: `packages/tw-daemon/src/constraint/harness.ts`
- Create: `packages/tw-daemon/src/constraint/harness.test.ts`

- [ ] **Step 1: Write the failing test for basic harness flow**

```typescript
// packages/tw-daemon/src/constraint/harness.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConstraintHarness } from './harness.js';
import { ConstraintEvaluator } from './evaluator.js';
import type { Entity, TwEvent } from '@traceweaver/types';

function makeEntity(overrides: Partial<Entity> = {}): Entity {
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
  };
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

    const entity = makeEntity({
      constraint_refs: ['rules.md'],
    });

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tw-daemon && npx vitest run src/constraint/harness.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the ConstraintHarness class**

```typescript
// packages/tw-daemon/src/constraint/harness.ts
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

    // 1. Create span
    let spanId: string | undefined;
    try {
      const spanMeta = this.spanManager.createSpan({
        entity_id: `constraint:${entity.id}`,
        entity_type: 'task',
        parent_entity_id: entity.id,
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

      evalResult = {
        entity_id: entity.id,
        result: validation.result as 'pass' | 'fail' | 'skipped',
        checked_at: validation.checked_at,
        duration_ms: Date.now() - start,
        span_id: spanId,
        refs_checked: validation.refs_checked,
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/tw-daemon && npx vitest run src/constraint/harness.test.ts`
Expected: PASS

- [ ] **Step 5: Write test for evaluator failure → skipped result**

```typescript
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
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/tw-daemon && npx vitest run src/constraint/harness.test.ts`
Expected: PASS

- [ ] **Step 7: Write test for timeout**

```typescript
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
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd packages/tw-daemon && npx vitest run src/constraint/harness.test.ts`
Expected: PASS

- [ ] **Step 9: Write test for empty constraint_refs → skipped without calling evaluator**

```typescript
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
```

- [ ] **Step 10: Run test to verify it passes**

Run: `cd packages/tw-daemon && npx vitest run src/constraint/harness.test.ts`
Expected: PASS

- [ ] **Step 11: Write test for event payload structure**

```typescript
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
```

- [ ] **Step 12: Run test to verify it passes**

Run: `cd packages/tw-daemon && npx vitest run src/constraint/harness.test.ts`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
git add packages/tw-daemon/src/constraint/harness.ts packages/tw-daemon/src/constraint/harness.test.ts
git commit -m "feat(daemon): add ConstraintHarness runtime layer with fault isolation"
```

---

### Task 4: Wire into IPC Server + CommandHandler

**Files:**
- Modify: `packages/tw-daemon/src/ipc-server.ts`
- Modify: `packages/tw-daemon/src/index.ts`

- [ ] **Step 1: Read current ipc-server.ts dispatch pattern**

Open `packages/tw-daemon/src/ipc-server.ts` and find the dispatch switch/if-chain to understand where to add new methods.

- [ ] **Step 2: Add constraint.evaluate and constraint.history dispatch**

In the dispatch section of `ipc-server.ts`, add two new method handlers. Follow the existing pattern (e.g., how `trace_spans` or `get_status` is handled):

```typescript
case 'constraint.evaluate': {
  const { entity_id } = params;
  if (!entity_id) return errorResponse(requestId, 'INVALID_PARAMS', 'entity_id required');
  const entity = handler.getEntity(entity_id);
  if (!entity) return errorResponse(requestId, 'ENTITY_NOT_FOUND', `Entity ${entity_id} not found`);
  const result = await constraintHarness.run(entity, {
    constraintContents: params.constraintContents,
  });
  return { request_id: requestId, ok: true, data: result };
}

case 'constraint.history': {
  const { entity_id } = params;
  if (!entity_id) return errorResponse(requestId, 'INVALID_PARAMS', 'entity_id required');
  const events = handler.queryEvents({
    entity_id,
    event_type: 'constraint.evaluated',
    limit: params.limit ?? 50,
  });
  return { request_id: requestId, ok: true, data: events };
}
```

Note: `constraintHarness` will be injected into the IPC server. Read the existing constructor/init pattern to understand how modules are passed in (likely via options object or direct property). Wire it the same way.

- [ ] **Step 3: Read daemon index.ts to understand initialization order**

Open `packages/tw-daemon/src/index.ts` and find where modules are created and wired.

- [ ] **Step 4: Wire ConstraintEvaluator + ConstraintHarness into daemon startup**

Add after the SpanManager and EventBus creation, before IPC server start:

```typescript
import { ConstraintEvaluator } from './constraint/evaluator.js';
import { ConstraintHarness } from './constraint/harness.js';

// After spanManager and eventBus are created:
const constraintEvaluator = new ConstraintEvaluator({
  enabled: true,
  model: 'claude-opus-4-6',
});

const constraintHarness = new ConstraintHarness({
  evaluator: constraintEvaluator,
  spanManager,
  eventBus,
  timeoutMs: 30_000,
});

// Pass constraintHarness to IPC server (follow existing pattern for how
// other modules like handler, traceQuery, etc. are passed)
```

- [ ] **Step 5: Verify daemon starts without errors**

Run: `cd packages/tw-daemon && npx tsc --noEmit`
Expected: no type errors

- [ ] **Step 6: Commit**

```bash
git add packages/tw-daemon/src/ipc-server.ts packages/tw-daemon/src/index.ts
git commit -m "feat(daemon): wire ConstraintHarness into IPC dispatch and daemon init"
```

---

### Task 5: Create CLI constraint command

**Files:**
- Create: `packages/tw-cli/src/commands/constraint.ts`
- Modify: `packages/tw-cli/src/index.ts`

- [ ] **Step 1: Read an existing CLI command for pattern reference**

Open `packages/tw-cli/src/commands/trace.ts` or `packages/tw-cli/src/commands/status.ts` to see the import pattern, `ensureDaemon()` usage, `sendIpc()` call, and `--json` output formatting.

- [ ] **Step 2: Create the constraint CLI command**

```typescript
// packages/tw-cli/src/commands/constraint.ts
import { Command } from 'commander';
import { sendIpc } from '../ipc-client.js';
import { ensureDaemon } from './daemon.js';
import type { ConstraintHarnessResult } from '@traceweaver/types';

export function constraintCommand(): Command {
  const cmd = new Command('constraint').description(
    'Evaluate and query constraint checks'
  );

  cmd
    .command('evaluate <entity_id>')
    .description('Evaluate constraints for an entity')
    .option('--json', 'Output raw JSON')
    .action(async (entityId: string, opts: { json?: boolean }) => {
      await ensureDaemon();
      const res = await sendIpc<ConstraintHarnessResult>({
        method: 'constraint.evaluate',
        params: { entity_id: entityId },
      });

      if (!res.ok) {
        console.error(`Error: ${res.error.message}`);
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }

      const d = res.data;
      const icon =
        d.result === 'pass' ? '✅' : d.result === 'fail' ? '❌' : '⏭️';
      console.log(`${icon} ${d.entity_id}: ${d.result} (${d.duration_ms}ms)`);

      for (const ref of d.refs_checked) {
        const refIcon =
          ref.result === 'pass' ? '  ✓' : ref.result === 'fail' ? '  ✗' : '  -';
        console.log(`${refIcon} ${ref.ref}: ${ref.result}`);
        if (ref.note) console.log(`    ${ref.note}`);
      }

      if (d.error) {
        console.log(`\n⚠ Error: ${d.error}`);
      }
    });

  cmd
    .command('history <entity_id>')
    .description('Show constraint evaluation history')
    .option('--json', 'Output raw JSON')
    .option('--limit <n>', 'Max results', '10')
    .action(async (entityId: string, opts: { json?: boolean; limit: string }) => {
      await ensureDaemon();
      const res = await sendIpc<any[]>({
        method: 'constraint.history',
        params: { entity_id: entityId, limit: parseInt(opts.limit, 10) },
      });

      if (!res.ok) {
        console.error(`Error: ${res.error.message}`);
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }

      if (res.data.length === 0) {
        console.log('No constraint evaluations found.');
        return;
      }

      for (const event of res.data) {
        const attrs = event.attributes ?? {};
        const icon =
          attrs.result === 'pass' ? '✅' :
          attrs.result === 'fail' ? '❌' : '⏭️';
        console.log(`${icon} ${event.ts} — ${attrs.result} (${attrs.duration_ms}ms)`);
      }
    });

  cmd
    .command('show <entity_id>')
    .description('Show latest constraint evaluation detail')
    .option('--json', 'Output raw JSON')
    .action(async (entityId: string, opts: { json?: boolean }) => {
      await ensureDaemon();
      const res = await sendIpc<any[]>({
        method: 'constraint.history',
        params: { entity_id: entityId, limit: 1 },
      });

      if (!res.ok) {
        console.error(`Error: ${res.error.message}`);
        process.exit(1);
      }

      if (res.data.length === 0) {
        console.log('No constraint evaluations found.');
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(res.data[0], null, 2));
        return;
      }

      const event = res.data[0];
      const attrs = event.attributes ?? {};
      console.log(`Entity:   ${event.entity_id}`);
      console.log(`Result:   ${attrs.result}`);
      console.log(`Time:     ${event.ts}`);
      console.log(`Duration: ${attrs.duration_ms}ms`);
      console.log(`Span:     ${attrs.span_id ?? 'n/a'}`);

      if (attrs.refs_checked) {
        console.log('\nRefs checked:');
        for (const ref of attrs.refs_checked) {
          console.log(`  ${ref.result === 'pass' ? '✓' : ref.result === 'fail' ? '✗' : '-'} ${ref.ref}`);
          if (ref.note) console.log(`    ${ref.note}`);
        }
      }

      if (attrs.error) {
        console.log(`\n⚠ Error: ${attrs.error}`);
      }
    });

  return cmd;
}
```

- [ ] **Step 3: Register command in CLI entry point**

Open `packages/tw-cli/src/index.ts` and add the constraint command. Follow the existing pattern for how commands are registered (look for `.addCommand()` calls):

```typescript
import { constraintCommand } from './commands/constraint.js';

// In the command registration section:
program.addCommand(constraintCommand());
```

- [ ] **Step 4: Verify CLI builds**

Run: `cd packages/tw-cli && npx tsc --noEmit`
Expected: no type errors

- [ ] **Step 5: Commit**

```bash
git add packages/tw-cli/src/commands/constraint.ts packages/tw-cli/src/index.ts
git commit -m "feat(cli): add tw constraint evaluate/history/show commands"
```

---

### Task 6: Integration test — full flow

**Files:**
- Create: `packages/tw-daemon/src/constraint/integration.test.ts`

- [ ] **Step 1: Write integration test wiring real CommandHandler + Harness**

```typescript
// packages/tw-daemon/src/constraint/integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandHandler } from '../core/command-handler.js';
import { EventBus } from '../core/event-bus/event-bus.js';
import { SpanManager } from '../otel/span-manager.js';
import { ConstraintEvaluator } from './evaluator.js';
import { ConstraintHarness } from './harness.js';
import type { TwEvent } from '@traceweaver/types';

describe('Constraint Harness Integration', () => {
  let tmpDir: string;
  let handler: CommandHandler;
  let eventBus: EventBus;
  let spanManager: SpanManager;
  let harness: ConstraintHarness;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tw-constraint-'));
    eventBus = new EventBus();
    eventBus.start();
    spanManager = new SpanManager();
    handler = new CommandHandler({
      storeDir: tmpDir,
      eventBus,
      spanManager,
    });
    await handler.init();
  });

  afterEach(async () => {
    eventBus.stop();
    await rm(tmpDir, { recursive: true });
  });

  it('evaluates constraint for registered entity and publishes event', async () => {
    // Register entity with constraint_refs
    await handler.register({
      id: 'T-1',
      entity_type: 'task',
      constraint_refs: ['rules.md'],
      artifact_refs: [{ type: 'code', path: 'src/app.ts' }],
    });
    await handler.updateState({ id: 'T-1', state: 'in_progress' });

    const evaluator = new ConstraintEvaluator({
      enabled: true,
      llmFn: async (prompt) => {
        expect(prompt).toContain('rules.md');
        expect(prompt).toContain('T-1');
        return 'RESULT: pass\nAll constraints satisfied.';
      },
    });

    harness = new ConstraintHarness({
      evaluator,
      spanManager,
      eventBus,
    });

    const events: TwEvent[] = [];
    eventBus.subscribe(ev => events.push(ev));

    const entity = handler.getEntity('T-1');
    const result = await harness.run(entity!, {
      constraintContents: { 'rules.md': 'Functions must be under 50 lines.' },
    });

    expect(result.result).toBe('pass');
    expect(result.entity_id).toBe('T-1');
    expect(result.span_id).toBeDefined();
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();

    // Wait for EventBus drain
    await new Promise(r => setTimeout(r, 100));

    const constraintEvent = events.find(e => e.type === 'constraint.evaluated');
    expect(constraintEvent).toBeDefined();
    expect(constraintEvent!.entity_id).toBe('T-1');
    expect(constraintEvent!.attributes.result).toBe('pass');
  });

  it('does not crash main runtime when evaluator fails', async () => {
    await handler.register({
      id: 'T-2',
      entity_type: 'task',
      constraint_refs: ['rules.md'],
    });

    const evaluator = new ConstraintEvaluator({
      enabled: true,
      llmFn: async () => { throw new Error('Network failure'); },
    });

    harness = new ConstraintHarness({
      evaluator,
      spanManager,
      eventBus,
    });

    const entity = handler.getEntity('T-2');
    const result = await harness.run(entity!, {
      constraintContents: { 'rules.md': 'Some rule.' },
    });

    // Harness degrades gracefully
    expect(result.result).toBe('skipped');
    expect(result.error).toContain('Network failure');

    // Main runtime still works — can still update entity
    await handler.updateState({ id: 'T-2', state: 'in_progress' });
    const updated = handler.getEntity('T-2');
    expect(updated!.state).toBe('in_progress');
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `cd packages/tw-daemon && npx vitest run src/constraint/integration.test.ts`
Expected: PASS

Note: If `CommandHandler` constructor signature differs from what's shown (check Task 4 Step 3), adjust the options object to match the actual pattern.

- [ ] **Step 3: Run full test suite to verify nothing is broken**

Run: `cd packages/tw-daemon && npx vitest run`
Expected: all 275+ existing tests still pass, plus new constraint tests

- [ ] **Step 4: Commit**

```bash
git add packages/tw-daemon/src/constraint/integration.test.ts
git commit -m "test(daemon): add constraint harness integration tests"
```

---

### Task 7: Delete compiled dist and verify end-to-end

**Files:**
- Delete: `packages/tw-daemon/dist/constraint/evaluator.js`
- Delete: `packages/tw-daemon/dist/constraint/evaluator.d.ts`
- Delete: `packages/tw-daemon/dist/constraint/evaluator.js.map`
- Delete: `packages/tw-daemon/dist/constraint/evaluator.d.ts.map`

- [ ] **Step 1: Remove old compiled constraint evaluator**

```bash
rm -f packages/tw-daemon/dist/constraint/evaluator.*
```

- [ ] **Step 2: Rebuild from source**

Run: `cd packages/tw-daemon && npx tsc`
Expected: compiles without errors, produces new dist files

- [ ] **Step 3: Run full test suite one final time**

Run: `npx vitest run`
Expected: all tests pass

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(daemon): remove old compiled constraint evaluator, rebuild from source"
```

---

### Task 8: E2E Demo — full flow with CLI + Jaeger verification

**Files:**
- Create: `examples/src/15-constraint-harness-e2e.ts`

This task validates the entire feature end-to-end, following the real-project-integration-guide.md pattern. It registers entities, runs constraint evaluation, and verifies results through CLI and Jaeger.

- [ ] **Step 1: Start Jaeger (if not running)**

```bash
docker run -d --name jaeger \
  -p 4317:4317 -p 16686:16686 \
  jaegertracing/all-in-one:latest 2>/dev/null || echo "Jaeger already running"

# Verify
nc -z localhost 4317 && echo "Jaeger OK"
```

- [ ] **Step 2: Create the E2E example script**

```typescript
// examples/src/15-constraint-harness-e2e.ts
import { CommandHandler } from '@traceweaver/daemon';
import { EventBus } from '@traceweaver/daemon/core/event-bus/event-bus';
import { SpanManager } from '@traceweaver/daemon/otel/span-manager';
import { ExporterRegistry } from '@traceweaver/daemon/otel/exporter-registry';
import { ConstraintEvaluator } from '@traceweaver/daemon/constraint/evaluator';
import { ConstraintHarness } from '@traceweaver/daemon/constraint/harness';
import type { TwEvent } from '@traceweaver/types';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function main() {
  console.log('=== Example 15: Constraint Harness E2E ===\n');

  // Setup temp store
  const storeDir = await mkdtemp(join(tmpdir(), 'tw-e2e-constraint-'));
  const projectDir = await mkdtemp(join(tmpdir(), 'tw-project-'));

  // Create constraint files in project
  await mkdir(join(projectDir, 'docs', 'harness'), { recursive: true });
  await writeFile(
    join(projectDir, 'docs', 'harness', 'constraints.md'),
    `# Constraints\n- All functions must be under 50 lines\n- No deep nesting (>4 levels)\n- All errors must be handled explicitly\n`
  );

  // Create artifact file
  await mkdir(join(projectDir, 'src'), { recursive: true });
  await writeFile(
    join(projectDir, 'src', 'app.ts'),
    `export function hello() {\n  return 'world';\n}\n`
  );

  // Init modules
  const eventBus = new EventBus();
  eventBus.start();

  const exporterRegistry = new ExporterRegistry({
    exporters: ['console'],  // Change to 'otlp-grpc' for Jaeger
  });
  const spanManager = new SpanManager({ exporterRegistry });

  const handler = new CommandHandler({
    storeDir,
    eventBus,
    spanManager,
  });
  await handler.init();

  // Collect events
  const events: TwEvent[] = [];
  eventBus.subscribe(ev => events.push(ev));

  // --- Phase 1: Register entities ---
  console.log('Phase 1: Registering entities...');

  await handler.register({ id: 'uc-demo', entity_type: 'usecase' });
  await handler.register({ id: 'plan-feature', entity_type: 'plan', parent_id: 'uc-demo' });
  await handler.register({
    id: 'task-impl',
    entity_type: 'task',
    parent_id: 'plan-feature',
    constraint_refs: ['docs/harness/constraints.md'],
    artifact_refs: [{ type: 'code', path: 'src/app.ts' }],
  });

  await handler.updateState({ id: 'uc-demo', state: 'in_progress' });
  await handler.updateState({ id: 'plan-feature', state: 'in_progress' });
  await handler.updateState({ id: 'task-impl', state: 'in_progress' });

  console.log('  ✓ Registered: uc-demo → plan-feature → task-impl\n');

  // --- Phase 2: Run constraint evaluation ---
  console.log('Phase 2: Running constraint evaluation...');

  const evaluator = new ConstraintEvaluator({
    enabled: true,
    projectRoot: projectDir,
    // Use mock LLM for demo (replace with claude --print for production)
    llmFn: async (prompt: string) => {
      console.log(`  [LLM] Evaluating constraint (${prompt.length} chars)...`);
      // Simulate a pass result
      return 'RESULT: pass\nAll functions are under 50 lines. No deep nesting found. Error handling is explicit.';
    },
  });

  const harness = new ConstraintHarness({
    evaluator,
    spanManager,
    eventBus,
    timeoutMs: 30_000,
  });

  const entity = handler.getEntity('task-impl');
  const result = await harness.run(entity!);

  console.log(`\n  Result: ${result.result}`);
  console.log(`  Duration: ${result.duration_ms}ms`);
  console.log(`  Span ID: ${result.span_id}`);
  console.log(`  Refs checked: ${result.refs_checked.length}`);
  for (const ref of result.refs_checked) {
    console.log(`    ${ref.result === 'pass' ? '✓' : '✗'} ${ref.ref}: ${ref.note}`);
  }
  console.log();

  // --- Phase 3: Complete the task ---
  console.log('Phase 3: Completing task...');

  await handler.updateState({ id: 'task-impl', state: 'review' });
  await handler.updateState({ id: 'task-impl', state: 'completed' });
  await handler.updateState({ id: 'plan-feature', state: 'review' });
  await handler.updateState({ id: 'plan-feature', state: 'completed' });
  await handler.updateState({ id: 'uc-demo', state: 'review' });
  await handler.updateState({ id: 'uc-demo', state: 'completed' });

  console.log('  ✓ All entities completed\n');

  // --- Phase 4: Verify via queries ---
  console.log('Phase 4: Verifying results...');

  // Wait for EventBus drain
  await new Promise(r => setTimeout(r, 200));

  // Check constraint event was published
  const constraintEvents = events.filter(e => e.type === 'constraint.evaluated');
  console.log(`  Constraint events: ${constraintEvents.length}`);
  if (constraintEvents.length > 0) {
    const ce = constraintEvents[0];
    console.log(`    entity_id: ${ce.entity_id}`);
    console.log(`    result: ${ce.attributes.result}`);
    console.log(`    span_id: ${ce.attributes.span_id}`);
  }

  // Check spans
  const allSpans = spanManager.getAllSpans();
  console.log(`  Total spans: ${allSpans.length}`);
  for (const span of allSpans) {
    const status = span.status ?? 'UNSET';
    console.log(`    ${span.entity_id} [${status}] trace=${span.trace_id.slice(0, 8)}...`);
  }

  // Check progress
  const status = await handler.getStatus('uc-demo');
  console.log(`  UC progress: ${JSON.stringify((status as any).progress)}`);

  console.log('\n=== E2E Complete ===');
  console.log('\nTo view in Jaeger:');
  console.log('  1. Restart with exporter: otlp-grpc');
  console.log('  2. Open http://localhost:16686');
  console.log('  3. Service: traceweaver-daemon');
  console.log('  4. Look for trace: uc-demo → plan-feature → task-impl + constraint:task-impl');

  // Cleanup
  eventBus.stop();
  await rm(storeDir, { recursive: true });
  await rm(projectDir, { recursive: true });
}

main().catch(err => {
  console.error('E2E failed:', err);
  process.exit(1);
});
```

- [ ] **Step 3: Add run script to root package.json**

Add to the `scripts` section of the root `package.json`:

```json
"example:15": "tsx examples/src/15-constraint-harness-e2e.ts"
```

- [ ] **Step 4: Run the E2E example**

Run: `cd /Users/mac28/workspace/frontend/TraceWeaver && npm run example:15`

Expected output:
```
=== Example 15: Constraint Harness E2E ===

Phase 1: Registering entities...
  ✓ Registered: uc-demo → plan-feature → task-impl

Phase 2: Running constraint evaluation...
  [LLM] Evaluating constraint (XXX chars)...

  Result: pass
  Duration: Xms
  Span ID: span-xxx
  Refs checked: 1
    ✓ docs/harness/constraints.md: All functions are under 50 lines...

Phase 3: Completing task...
  ✓ All entities completed

Phase 4: Verifying results...
  Constraint events: 1
    entity_id: task-impl
    result: pass
    span_id: span-xxx
  Total spans: 4
    uc-demo [OK] trace=xxx...
    plan-feature [OK] trace=xxx...
    task-impl [OK] trace=xxx...
    constraint:task-impl [OK] trace=xxx...
  UC progress: {"done":1,"total":1,"percent":100}

=== E2E Complete ===
```

- [ ] **Step 5: Verify via CLI (daemon must be running)**

```bash
# Start daemon
TW_STORE=/tmp/tw-e2e-cli tw daemon start

# Register + evaluate via CLI
tw register task task-cli-test --constraint-refs docs/constraints.md
tw update task-cli-test --state in_progress
tw constraint evaluate task-cli-test --json

# Check history
tw constraint history task-cli-test --json

# Check trace
tw trace info --entity-id task-cli-test --json

# Stop daemon
tw daemon stop
```

- [ ] **Step 6: Verify via Jaeger (if otlp-grpc configured)**

```bash
# Ensure Jaeger is running
docker ps | grep jaeger

# Open browser
open http://localhost:16686

# In Jaeger UI:
# 1. Service → traceweaver-daemon
# 2. Find trace with "uc-demo" operation
# 3. Verify span tree:
#    uc-demo
#    └── plan-feature
#        └── task-impl
#            └── constraint:task-impl  ← NEW: constraint evaluation span
# 4. Click constraint:task-impl span
# 5. Verify attributes:
#    constraint.result = pass
#    constraint.duration_ms = X
#    constraint.refs_count = 1
```

- [ ] **Step 7: Commit**

```bash
git add examples/src/15-constraint-harness-e2e.ts package.json
git commit -m "feat(examples): add constraint harness E2E demo (example 15)"
```

---

## Summary

| Task | What | Files | Tests |
|------|------|-------|-------|
| 1 | Add type | tw-types/index.ts | typecheck |
| 2 | Rebuild Evaluator (eval layer) | constraint/evaluator.ts | 6 unit tests |
| 3 | Create Harness (runtime layer) | constraint/harness.ts | 5 unit tests |
| 4 | Wire IPC + daemon init | ipc-server.ts, index.ts | typecheck |
| 5 | Create CLI command | commands/constraint.ts | typecheck |
| 6 | Integration test | constraint/integration.test.ts | 2 integration tests |
| 7 | Cleanup old dist | dist/constraint/* | full suite |
| 8 | E2E Demo + Jaeger | examples/15-*.ts + CLI + Jaeger | manual verification |
