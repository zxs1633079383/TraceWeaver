import type { SpanManager } from '../otel/span-manager.js'
import type { EntityType } from '@traceweaver/types'

export interface PhaseTime {
  phase: string
  durationMs: number
}

export interface FailureRate {
  total: number
  rejected: number
  rate: number
}

export interface ThroughputStats {
  completed: number
  windowMs: number
  perHour: number
}

export interface MetricsSummary {
  failureRate: FailureRate
  throughput: ThroughputStats
  activeSpans: number
  spanCount: number
}

export class SpanMetrics {
  constructor(private readonly spanManager: SpanManager) {}

  getCycleTime(entityId: string): PhaseTime[] {
    const span = this.spanManager.getSpan(entityId)
    if (!span) return []
    const phases: PhaseTime[] = []
    const transitions = span.events.filter(e => e.name.startsWith('state_changed_to_'))
    let prevTs = new Date(span.start_time).getTime()
    let prevLabel = 'created'
    for (const ev of transitions) {
      const evTs = new Date(ev.ts).getTime()
      const toState = ev.name.replace('state_changed_to_', '')
      phases.push({ phase: `${prevLabel}→${toState}`, durationMs: Math.max(0, evTs - prevTs) })
      prevTs = evTs
      prevLabel = toState
    }
    if (span.end_time) {
      const endTs = new Date(span.end_time).getTime()
      phases.push({ phase: `${prevLabel}→end`, durationMs: Math.max(0, endTs - prevTs) })
    }
    return phases
  }

  getFailureRate(entityType?: EntityType): FailureRate {
    const spans = this.spanManager.getAllSpans(entityType)
    const rejected = spans.filter(s => s.status === 'ERROR').length
    return { total: spans.length, rejected, rate: spans.length ? rejected / spans.length : 0 }
  }

  getThroughput(windowMs = 24 * 60 * 60 * 1000): ThroughputStats {
    const cutoff = Date.now() - windowMs
    const spans = this.spanManager.getAllSpans()
    const completed = spans.filter(s =>
      s.status === 'OK' && s.end_time && new Date(s.end_time).getTime() >= cutoff
    ).length
    const perHour = windowMs > 0 ? completed / (windowMs / 3_600_000) : 0
    return { completed, windowMs, perHour }
  }

  getSummary(): MetricsSummary {
    const allSpans = this.spanManager.getAllSpans()
    return {
      failureRate: this.getFailureRate(),
      throughput: this.getThroughput(),
      activeSpans: this.spanManager.getActiveSpans().length,
      spanCount: allSpans.length,
    }
  }
}
