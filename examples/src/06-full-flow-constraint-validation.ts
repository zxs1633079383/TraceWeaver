/**
 * Example 06 — Full-Flow: ConstraintEvaluator with Mock LLM
 *
 * Demonstrates constraint evaluation scenarios:
 *   1. Passing constraint — mock LLM sees "MUST_PASS" keyword → returns pass
 *   2. Failing constraint — mock LLM does not see keyword → returns fail with violations
 *   3. Disabled evaluator — result is always "skipped"
 *   4. No constraint refs supplied — result is "skipped"
 *
 * In production, replace the mock llmFn with a real Anthropic API call.
 */

import { ConstraintEvaluator } from '../../packages/tw-daemon/src/constraint/evaluator.js'

// ── Mock LLM ─────────────────────────────────────────────────────────────────
// Simulates an LLM: pass if the prompt contains "MUST_PASS", otherwise fail.
async function mockLlmFn(prompt: string): Promise<string> {
  console.log('\n  [Mock LLM] Evaluating constraint...')
  console.log('  Prompt preview:', prompt.slice(0, 150) + '...')
  if (prompt.includes('MUST_PASS')) {
    return 'RESULT: pass\nAll constraints satisfied.'
  }
  return 'RESULT: fail\nMissing required test coverage documentation.'
}

async function main(): Promise<void> {
  console.log('\n── ConstraintEvaluator Demonstration ──')

  const results: Array<{ scenario: string; result: string; note?: string }> = []

  // ── Scenario 1: Passing constraint ───────────────────────────────────────
  console.log('\n── Scenario 1: Entity with passing constraint ──')
  const evaluatorEnabled = new ConstraintEvaluator({ enabled: true, llmFn: mockLlmFn })

  const passingResult = await evaluatorEnabled.evaluate({
    entity_id: 'ml-task-passing',
    constraint_refs: ['constraints/testing.md'],
    artifact_refs: [{ type: 'code', path: 'src/model.py' }],
    constraintContents: {
      'constraints/testing.md': '# Testing MUST_PASS\n- All tasks need tests\n- 80% coverage minimum',
    },
  })

  console.log(`  Result:      ${passingResult.result}`)
  console.log(`  Checked at:  ${passingResult.checked_at}`)
  for (const ref of passingResult.refs_checked) {
    console.log(`  Ref: ${ref.ref}  →  ${ref.result}`)
    if (ref.note) console.log(`    Note: ${ref.note}`)
  }
  results.push({ scenario: 'Passing constraint', result: passingResult.result })

  // ── Scenario 2: Failing constraint ───────────────────────────────────────
  console.log('\n── Scenario 2: Entity with failing constraint ──')

  const failingResult = await evaluatorEnabled.evaluate({
    entity_id: 'ml-task-failing',
    constraint_refs: ['constraints/coverage.md'],
    artifact_refs: [{ type: 'code', path: 'src/trainer.py' }],
    constraintContents: {
      'constraints/coverage.md': '# Coverage\n- 80% minimum required\n- No untested branches',
    },
  })

  console.log(`  Result:      ${failingResult.result}`)
  console.log(`  Checked at:  ${failingResult.checked_at}`)
  for (const ref of failingResult.refs_checked) {
    console.log(`  Ref: ${ref.ref}  →  ${ref.result}`)
    if (ref.note) console.log(`    Note: ${ref.note}`)
  }
  results.push({
    scenario: 'Failing constraint',
    result: failingResult.result,
    note: failingResult.refs_checked[0]?.note,
  })

  // ── Scenario 3: Disabled evaluator ───────────────────────────────────────
  console.log('\n── Scenario 3: Disabled evaluator ──')
  const evaluatorDisabled = new ConstraintEvaluator({ enabled: false, llmFn: mockLlmFn })

  const disabledResult = await evaluatorDisabled.evaluate({
    entity_id: 'ml-task-disabled',
    constraint_refs: ['constraints/testing.md'],
    artifact_refs: [],
    constraintContents: {
      'constraints/testing.md': '# Testing MUST_PASS\n- All tasks need tests',
    },
  })

  console.log(`  Result:     ${disabledResult.result}  (evaluator disabled — LLM never called)`)
  results.push({ scenario: 'Disabled evaluator', result: disabledResult.result })

  // ── Scenario 4: No constraint refs ───────────────────────────────────────
  console.log('\n── Scenario 4: No constraint refs supplied ──')

  const noRefsResult = await evaluatorEnabled.evaluate({
    entity_id: 'ml-task-no-refs',
    constraint_refs: [],
    artifact_refs: [{ type: 'code', path: 'src/eval.py' }],
  })

  console.log(`  Result:     ${noRefsResult.result}  (no constraint files to check)`)
  results.push({ scenario: 'No constraint refs', result: noRefsResult.result })

  // ── Summary table ─────────────────────────────────────────────────────────
  console.log('\n── Summary ──')
  const pad = (s: string, n: number) => s.padEnd(n)
  console.log(`  ${pad('Scenario', 30)}  ${pad('Result', 8)}  Note`)
  console.log(`  ${'-'.repeat(30)}  ${'-'.repeat(8)}  ${'-'.repeat(40)}`)
  for (const r of results) {
    console.log(`  ${pad(r.scenario, 30)}  ${pad(r.result, 8)}  ${r.note ?? ''}`)
  }

  console.log('\n✓ Example complete\n')
}

main().catch(console.error)
