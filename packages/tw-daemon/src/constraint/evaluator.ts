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
