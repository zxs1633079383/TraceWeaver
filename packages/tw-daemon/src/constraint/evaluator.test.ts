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

  it('returns skipped when constraint_refs is empty', async () => {
    const evaluator = new ConstraintEvaluator({ enabled: true });
    const result = await evaluator.evaluate({
      entity_id: 'T-1',
      constraint_refs: [],
      artifact_refs: [],
    });
    expect(result.result).toBe('skipped');
  });

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
});
