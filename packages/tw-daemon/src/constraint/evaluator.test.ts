import { describe, it, expect, vi } from 'vitest'
import { ConstraintEvaluator } from './evaluator.js'

describe('ConstraintEvaluator', () => {
  it('returns skipped when no constraint_refs provided', async () => {
    const evaluator = new ConstraintEvaluator({ enabled: false })
    const result = await evaluator.evaluate({ entity_id: 'T-1', constraint_refs: [], artifact_refs: [] })
    expect(result.result).toBe('skipped')
  })

  it('returns skipped when evaluator is disabled', async () => {
    const evaluator = new ConstraintEvaluator({ enabled: false })
    const result = await evaluator.evaluate({
      entity_id: 'T-1',
      constraint_refs: ['harness/security.md'],
      artifact_refs: []
    })
    expect(result.result).toBe('skipped')
  })

  it('calls llmFn and parses pass result', async () => {
    const mockLlm = vi.fn().mockResolvedValue('RESULT: pass\nAll constraints satisfied.')
    const evaluator = new ConstraintEvaluator({ enabled: true, llmFn: mockLlm })
    const result = await evaluator.evaluate({
      entity_id: 'T-1',
      constraint_refs: ['harness/api.md'],
      artifact_refs: [{ type: 'code', path: './src/api.ts' }],
      constraintContents: { 'harness/api.md': '# API Guidelines\n- Use REST conventions' }
    })
    expect(result.result).toBe('pass')
    expect(result.refs_checked[0].result).toBe('pass')
    expect(mockLlm).toHaveBeenCalledOnce()
  })

  it('calls llmFn and parses fail result', async () => {
    const mockLlm = vi.fn().mockResolvedValue('RESULT: fail\nMissing input validation.')
    const evaluator = new ConstraintEvaluator({ enabled: true, llmFn: mockLlm })
    const result = await evaluator.evaluate({
      entity_id: 'T-1',
      constraint_refs: ['harness/security.md'],
      artifact_refs: [],
      constraintContents: { 'harness/security.md': '# Security\n- Validate inputs' }
    })
    expect(result.result).toBe('fail')
    expect(result.refs_checked[0].note).toContain('Missing input validation')
  })

  it('returns skipped with note when constraint file not found', async () => {
    const evaluator = new ConstraintEvaluator({ enabled: true, llmFn: vi.fn() })
    const result = await evaluator.evaluate({
      entity_id: 'T-1',
      constraint_refs: ['nonexistent/file.md'],
      artifact_refs: [],
    })
    expect(result.result).toBe('skipped')
    expect(result.refs_checked[0].note).toContain('not found')
  })
})
