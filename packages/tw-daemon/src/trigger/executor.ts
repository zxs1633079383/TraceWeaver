import type { TwEvent, ConstraintValidationResult } from '@traceweaver/types'
import type { EventBus } from '../core/event-bus/event-bus.js'
import type { CommandHandler } from '../core/command-handler.js'
import type { ConstraintEvaluator } from '../constraint/evaluator.js'
import type { HarnessLoader, HarnessEntry } from '../harness/loader.js'
import type { InboxAdapter } from '../notify/inbox.js'
import type { FeedbackLog } from '../feedback/feedback-log.js'

const CONSECUTIVE_FAIL_ALERT = 3

export interface TriggerExecutorOptions {
  handler: CommandHandler
  evaluator: ConstraintEvaluator
  harness: HarnessLoader
  eventBus: EventBus
  inbox?: Pick<InboxAdapter, 'write'>
  feedbackLog?: FeedbackLog
}

export class TriggerExecutor {
  private unsub: (() => void) | null = null
  private inFlight = new Set<string>()

  constructor(private readonly opts: TriggerExecutorOptions) {}

  start(): void {
    if (this.unsub) return  // already started — guard against double-call
    this.unsub = this.opts.eventBus.subscribeBatch(
      batch => void this.handleBatch(batch).catch(() => {})
    )
  }

  stop(): void {
    this.unsub?.()
    this.unsub = null
  }

  /** Public — used by IpcServer for on-demand harness_run requests */
  async runHarness(entity: any, harness: HarnessEntry): Promise<ConstraintValidationResult> {
    return this.opts.evaluator.evaluate({
      entity_id: entity.id,
      constraint_refs: [harness.id],
      artifact_refs: entity.artifact_refs ?? [],
      constraintContents: { [harness.id]: harness.content },
    })
  }

  private async handleBatch(events: TwEvent[]): Promise<void> {
    const stateChanges = events.filter(
      e => e.type === 'entity.state_changed' && e.entity_id && e.state
    )
    for (const event of stateChanges) {
      try {
        const matchingHarnesses = this.opts.harness.list().filter(h =>
          h.trigger_on.includes(event.state!) &&
          (h.applies_to.length === 0 || (event.entity_type && h.applies_to.includes(event.entity_type)))
        )
        if (matchingHarnesses.length === 0) continue

        // Re-fetch entity for latest state (avoid acting on stale snapshot)
        const entityResult = await this.opts.handler.get({ id: event.entity_id! })
        if (!entityResult.ok) continue
        const entity = entityResult.data

        // Race-condition guard: skip if entity already moved past trigger state
        if (entity.state !== event.state) continue

        for (const harness of matchingHarnesses) {
          if (this.inFlight.has(entity.id)) continue
          this.inFlight.add(entity.id)
          try {
            await this.evaluateAndAct(entity, harness, event.state!)
          } finally {
            this.inFlight.delete(entity.id)
          }
        }
      } catch { /* log nothing — don't let one event failure abort the batch */ }
    }
  }

  private async evaluateAndAct(entity: any, harness: HarnessEntry, triggerState: string): Promise<void> {
    const t0 = Date.now()
    const result = await this.runHarness(entity, harness)
    const duration_ms = Date.now() - t0

    this.opts.feedbackLog?.record({
      harness_id: harness.id,
      entity_id: entity.id,
      entity_type: entity.entity_type,
      trigger_state: triggerState,
      result: result.result as 'pass' | 'fail' | 'skipped',
      reason: result.refs_checked[0]?.note ?? '',
      duration_ms,
    })

    if (this.opts.feedbackLog && result.result === 'fail') {
      const summary = this.opts.feedbackLog.getSummary(harness.id)
      if (summary.consecutive_failures >= CONSECUTIVE_FAIL_ALERT) {
        await this.opts.inbox?.write({
          event_type: 'entity.state_changed',
          entity_id: entity.id,
          message: `[FEEDBACK] Harness '${harness.id}' has failed consecutively ${summary.consecutive_failures} times — review constraint alignment`,
        })
      }
    }

    if (result.result === 'fail') {
      try {
        // Final state check before writing — minimise TOCTOU window
        const fresh = await this.opts.handler.get({ id: entity.id })
        if (!fresh.ok || fresh.data.state !== triggerState) return

        await this.opts.handler.updateState({
          id: entity.id,
          state: 'rejected',
          reason: `Auto-rejected: harness '${harness.id}' failed — ${result.refs_checked[0]?.note ?? ''}`,
        })
        await this.opts.inbox?.write({
          event_type: 'entity.state_changed',
          entity_id: entity.id,
          message: `[AUTO-REJECT] ${entity.id} failed constraint '${harness.id}'`,
        })
      } catch { /* already in terminal state or concurrent update */ }
    } else if (result.result === 'pass') {
      await this.opts.inbox?.write({
        event_type: 'entity.state_changed',
        entity_id: entity.id,
        message: `[AUTO-PASS] ${entity.id} passed constraint '${harness.id}'`,
      })
    }
  }
}
