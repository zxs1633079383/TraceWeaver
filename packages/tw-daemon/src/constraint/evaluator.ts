import { readFile } from 'node:fs/promises'
import type { ArtifactRef, ConstraintValidationResult, ConstraintCheckStatus } from '@traceweaver/types'

export interface EvaluateInput {
  entity_id: string
  constraint_refs: string[]
  artifact_refs: ArtifactRef[]
  constraintContents?: Record<string, string>
}

export interface ConstraintEvaluatorOptions {
  enabled: boolean
  projectRoot?: string
  llmFn?: (prompt: string) => Promise<string>
  apiKey?: string
  model?: string
}

export class ConstraintEvaluator {
  constructor(private readonly opts: ConstraintEvaluatorOptions) {}

  async evaluate(input: EvaluateInput): Promise<ConstraintValidationResult> {
    const now = new Date().toISOString()

    if (!this.opts.enabled || input.constraint_refs.length === 0) {
      return { result: 'skipped', checked_at: now, refs_checked: [] }
    }

    const refsChecked = await Promise.all(
      input.constraint_refs.map(ref => this.checkRef(ref, input))
    )

    const overallFail = refsChecked.some(r => r.result === 'fail')
    const allSkipped = refsChecked.every(r => r.result === 'skipped')
    const result: ConstraintCheckStatus = overallFail ? 'fail' : allSkipped ? 'skipped' : 'pass'

    return { result, checked_at: now, refs_checked: refsChecked }
  }

  private async checkRef(ref: string, input: EvaluateInput) {
    let content: string
    if (input.constraintContents?.[ref]) {
      content = input.constraintContents[ref]
    } else {
      const filePath = this.opts.projectRoot ? `${this.opts.projectRoot}/${ref}` : ref
      try {
        content = await readFile(filePath, 'utf8')
      } catch {
        return { ref, result: 'skipped' as ConstraintCheckStatus, note: 'Constraint file not found' }
      }
    }

    const artifactSummary = input.artifact_refs.length > 0
      ? input.artifact_refs.map(a => `${a.type}: ${a.path}`).join('\n')
      : '(no artifacts)'

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
(specific violations)`

    let llmResponse: string
    try {
      llmResponse = await this.callLlm(prompt)
    } catch (err) {
      return { ref, result: 'skipped' as ConstraintCheckStatus, note: `LLM error: ${(err as Error).message}` }
    }

    const resultMatch = llmResponse.match(/RESULT:\s*(pass|fail)/i)
    const checkResult: ConstraintCheckStatus = (resultMatch?.[1]?.toLowerCase() as ConstraintCheckStatus) ?? 'skipped'
    const note = llmResponse.replace(/RESULT:\s*(pass|fail)/i, '').trim()

    return { ref, result: checkResult, note }
  }

  private async callLlm(prompt: string): Promise<string> {
    if (this.opts.llmFn) return this.opts.llmFn(prompt)

    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: this.opts.apiKey ?? process.env.ANTHROPIC_API_KEY })
    const message = await client.messages.create({
      model: this.opts.model ?? 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }]
    })
    return (message.content[0] as any).text ?? ''
  }
}
