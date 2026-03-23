import type { TriggerRule, TwEvent } from '@traceweaver/types'

export class TriggerEvaluator {
  constructor(private readonly rules: readonly TriggerRule[]) {}

  match(event: TwEvent): TriggerRule[] {
    return this.rules.filter(rule => this.matches(rule, event))
  }

  private matches(rule: TriggerRule, event: TwEvent): boolean {
    const { on } = rule
    if (on.event !== '*' && on.event !== event.type) return false
    if (on.entity_type !== undefined && on.entity_type !== event.entity_type) return false
    if (on.state !== undefined && on.state !== event.state) return false
    return true
  }
}
