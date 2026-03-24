// packages/tw-daemon/src/harness/validator.ts
import type { Entity } from '@traceweaver/types'
import type { HarnessLoader } from './loader.js'
import type { FeedbackLog } from '../feedback/feedback-log.js'

export type IssueType = 'orphaned_ref' | 'dead_harness' | 'persistent_failure'

export interface AlignmentIssue {
  severity: 'error' | 'warning'
  type: IssueType
  harness_id?: string
  entity_id?: string
  message: string
  suggestion?: string
}

export interface HarnessValidatorOptions {
  consecutiveFailThreshold?: number  // default 3
}

export class HarnessValidator {
  private readonly threshold: number

  constructor(
    private readonly loader: HarnessLoader,
    private readonly feedbackLog: FeedbackLog,
    opts?: HarnessValidatorOptions,
  ) {
    this.threshold = opts?.consecutiveFailThreshold ?? 3
  }

  validate(entities: Entity[]): AlignmentIssue[] {
    const issues: AlignmentIssue[] = []
    const harnessIds = new Set(this.loader.list().map(h => h.id))

    // --- orphaned_ref ---
    for (const entity of entities) {
      for (const ref of entity.constraint_refs ?? []) {
        if (!harnessIds.has(ref)) {
          issues.push({
            severity: 'error',
            type: 'orphaned_ref',
            harness_id: ref,
            entity_id: entity.id,
            message: `Entity '${entity.id}' references non-existent harness '${ref}'`,
            suggestion: `Create .traceweaver/harness/${ref}.md or remove the reference`,
          })
        }
      }
    }

    // --- dead_harness ---
    const entityTypes = new Set(entities.map(e => e.entity_type))
    for (const harness of this.loader.list()) {
      if (harness.applies_to.length > 0) {
        const hasMatch = harness.applies_to.some(t => entityTypes.has(t))
        if (!hasMatch) {
          issues.push({
            severity: 'warning',
            type: 'dead_harness',
            harness_id: harness.id,
            message: `Harness '${harness.id}' applies_to=[${harness.applies_to.join(', ')}] has no matching entity types`,
            suggestion: 'Check applies_to for typos, or register entities of the matching type',
          })
        }
      }
    }

    // --- persistent_failure ---
    for (const harness of this.loader.list()) {
      const summary = this.feedbackLog.getSummary(harness.id)
      if (summary.consecutive_failures >= this.threshold) {
        issues.push({
          severity: 'warning',
          type: 'persistent_failure',
          harness_id: harness.id,
          message: `Harness '${harness.id}' has failed consecutively ${summary.consecutive_failures} times`,
          suggestion: 'Review constraint content and entity structure for alignment',
        })
      }
    }

    return issues
  }
}
