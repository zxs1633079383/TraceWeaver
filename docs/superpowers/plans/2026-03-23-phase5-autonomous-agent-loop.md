# Phase 5: Autonomous Agent Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give AI agents a complete observe→detect→diagnose→validate→fix loop by adding persistent event logs, span-derived metrics, real impact resolution, harness-first constraint engineering, an auto-trigger executor, and a fully machine-readable CLI.

**Architecture:** EventLog persists all TwEvents to NDJSON (no native deps); SpanMetrics derives cycle-time/failure-rate/throughput from SpanManager's in-memory spans; ImpactResolver builds a file→entity reverse index inside CommandHandler; HarnessLoader reads `.traceweaver/harness/*.md` YAML-frontmatter files; TriggerExecutor subscribes to EventBus batches and auto-runs ConstraintEvaluator when an entity reaches a trigger state, auto-rejecting on fail; CLI adds `log`, `metrics`, `harness`, `watch` subcommands and `--json` to all existing commands.

**Tech Stack:** TypeScript ESM, Node.js fs/net, js-yaml (already in deps), Vitest, Commander.js — zero new runtime dependencies.

---

## File Map

### New files — daemon

| File | Responsibility |
|------|---------------|
| `packages/tw-daemon/src/log/event-log.ts` | NDJSON persistent log; `append()` + `query()` + `getHistory()` |
| `packages/tw-daemon/src/log/event-log.test.ts` | Unit tests |
| `packages/tw-daemon/src/metrics/span-metrics.ts` | Derives cycle_time / failure_rate / throughput from SpanManager |
| `packages/tw-daemon/src/metrics/span-metrics.test.ts` | Unit tests |
| `packages/tw-daemon/src/harness/loader.ts` | Scans `harness/*.md`, parses YAML frontmatter, indexes by id |
| `packages/tw-daemon/src/harness/loader.test.ts` | Unit tests |
| `packages/tw-daemon/src/trigger/executor.ts` | subscribeBatch → ConstraintEvaluator → auto-reject on fail |
| `packages/tw-daemon/src/trigger/executor.test.ts` | Unit tests |

### Modified files — daemon

| File | Change |
|------|--------|
| `packages/tw-daemon/src/core/command-handler.ts` | Add `resolveImpact(filePath, section?)` method (impact reverse-index built internally) |
| `packages/tw-daemon/src/ipc-server.ts` | Add IPC methods: `log_query`, `get_metrics`, `resolve_impact` (real), `harness_list`, `harness_show`, `harness_run` |
| `packages/tw-daemon/src/index.ts` | Init EventLog, SpanMetrics, HarnessLoader, TriggerExecutor; wire into IpcServer |
| `packages/tw-daemon/src/phase5-integration.test.ts` | End-to-end: register → review → TriggerExecutor auto-rejects |

### New files — CLI

| File | Responsibility |
|------|---------------|
| `packages/tw-cli/src/commands/log.ts` | `tw log query [filters]` |
| `packages/tw-cli/src/commands/metrics.ts` | `tw metrics [--type] [--window]` |
| `packages/tw-cli/src/commands/harness.ts` | `tw harness list|show|run|status` |
| `packages/tw-cli/src/commands/watch.ts` | `tw watch` — long-poll event stream |

### Modified files — CLI

| File | Change |
|------|--------|
| `packages/tw-cli/src/commands/status.ts` | Add `--json` flag |
| `packages/tw-cli/src/commands/events.ts` | Add `--json` flag; switch to `log_query` IPC |
| `packages/tw-cli/src/commands/impact.ts` | Consume real `resolve_impact` response shape |
| `packages/tw-cli/src/commands/dag.ts` | Add `--json` flag |
| `packages/tw-cli/src/commands/inbox.ts` | Add `--json` flag |
| `packages/tw-cli/src/index.ts` | Register log, metrics, harness, watch commands |

---

## Task 1: EventLog — NDJSON Persistent Event Log

**Files:**
- Create: `packages/tw-daemon/src/log/event-log.ts`
- Create: `packages/tw-daemon/src/log/event-log.test.ts`

---

- [ ] **Step 1.1 — Write the failing test**

```typescript
// packages/tw-daemon/src/log/event-log.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventLog } from './event-log.js'
import type { TwEvent } from '@traceweaver/types'

function makeEvent(overrides: Partial<TwEvent> = {}): TwEvent {
  return {
    id: crypto.randomUUID(),
    type: 'entity.state_changed',
    entity_id: 'ent-1',
    entity_type: 'task',
    state: 'in_progress',
    ts: new Date().toISOString(),
    ...overrides,
  }
}

describe('EventLog', () => {
  let dir: string
  let log: EventLog

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tw-eventlog-'))
    log = new EventLog(join(dir, 'events.ndjson'))
    log.load()
  })
  afterEach(() => rmSync(dir, { recursive: true }))

  it('appends and retrieves all events', () => {
    log.append(makeEvent({ entity_id: 'a' }))
    log.append(makeEvent({ entity_id: 'b' }))
    const history = log.getHistory()
    expect(history).toHaveLength(2)
    expect(history[0].seq).toBe(1)
    expect(history[1].seq).toBe(2)
  })

  it('survives reload from disk', () => {
    log.append(makeEvent({ entity_id: 'persist-me' }))
    const log2 = new EventLog(join(dir, 'events.ndjson'))
    log2.load()
    const history = log2.getHistory()
    expect(history).toHaveLength(1)
    expect(history[0].entity_id).toBe('persist-me')
    expect(history[0].seq).toBe(1)
  })

  it('query filters by entity_id', () => {
    log.append(makeEvent({ entity_id: 'x' }))
    log.append(makeEvent({ entity_id: 'y' }))
    const result = log.query({ entity_id: 'x' })
    expect(result).toHaveLength(1)
    expect(result[0].entity_id).toBe('x')
  })

  it('query filters by event_type', () => {
    log.append(makeEvent({ type: 'entity.registered' }))
    log.append(makeEvent({ type: 'entity.state_changed' }))
    const result = log.query({ event_type: 'entity.registered' })
    expect(result).toHaveLength(1)
  })

  it('query filters by since', () => {
    const past = new Date(Date.now() - 10000).toISOString()
    const future = new Date(Date.now() + 10000).toISOString()
    log.append(makeEvent({ ts: past }))
    log.append(makeEvent({ ts: future }))
    const result = log.query({ since: new Date(Date.now() - 5000).toISOString() })
    expect(result).toHaveLength(1)
    expect(result[0].ts).toBe(future)
  })

  it('query respects limit', () => {
    for (let i = 0; i < 10; i++) log.append(makeEvent())
    const result = log.query({ limit: 3 })
    expect(result).toHaveLength(3)
  })
})
```

- [ ] **Step 1.2 — Run test to confirm it fails**

```bash
cd /Users/mac28/workspace/frontend/TraceWeaver
npm test --workspace=packages/tw-daemon -- --reporter=verbose 2>&1 | grep -A5 "EventLog"
```

Expected: FAIL with "Cannot find module './event-log.js'"

- [ ] **Step 1.3 — Implement EventLog**

```typescript
// packages/tw-daemon/src/log/event-log.ts
import { appendFileSync, readFileSync, existsSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TwEvent, TwEventType, EventRecord } from '@traceweaver/types'

export interface EventLogQuery {
  entity_id?: string
  event_type?: TwEventType
  since?: string      // ISO8601
  until?: string      // ISO8601
  limit?: number
}

export class EventLog {
  private history: EventRecord[] = []
  private seq = 0

  constructor(private readonly logPath: string) {}

  /** Call once at daemon start to replay persisted events */
  load(): void {
    if (!existsSync(this.logPath)) return
    const raw = readFileSync(this.logPath, 'utf8')
    for (const line of raw.trim().split('\n').filter(Boolean)) {
      try {
        const record = JSON.parse(line) as EventRecord
        this.history.push(record)
        if (record.seq > this.seq) this.seq = record.seq
      } catch { /* skip malformed line */ }
    }
  }

  append(event: TwEvent): void {
    this.seq++
    const record: EventRecord = { ...event, seq: this.seq }
    this.history.push(record)
    mkdirSync(dirname(this.logPath), { recursive: true })
    appendFileSync(this.logPath, JSON.stringify(record) + '\n', 'utf8')
  }

  getHistory(since?: string): EventRecord[] {
    if (!since) return [...this.history]
    return this.history.filter(e => e.ts >= since)
  }

  query(params: EventLogQuery): EventRecord[] {
    let result = [...this.history]
    if (params.entity_id)  result = result.filter(e => e.entity_id  === params.entity_id)
    if (params.event_type) result = result.filter(e => e.type        === params.event_type)
    if (params.since)      result = result.filter(e => e.ts          >= params.since!)
    if (params.until)      result = result.filter(e => e.ts          <= params.until!)
    if (params.limit)      result = result.slice(-params.limit)
    return result
  }
}
```

- [ ] **Step 1.4 — Run test to confirm pass**

```bash
npm test --workspace=packages/tw-daemon -- --reporter=verbose 2>&1 | grep -A2 "EventLog"
```

Expected: all EventLog tests PASS

- [ ] **Step 1.5 — Wire EventLog into CommandHandler**

In `packages/tw-daemon/src/core/command-handler.ts`:

Add to `CommandHandlerOptions`:
```typescript
eventLog?: EventLog
```

In `register()`, after `eventBus?.publish(...)`:
```typescript
this.opts.eventLog?.append({ id: randomUUID(), type: 'entity.registered', entity_id: params.id, entity_type: params.entity_type, ts: new Date().toISOString() })
```

Do the same for `updateState()` and `updateAttributes()` — replace or supplement `eventBus?.publish` with `eventLog?.append` on the same events. Both bus and log should receive the event; extract a helper:

```typescript
private emit(event: TwEvent): void {
  this.opts.eventBus?.publish(event)
  this.opts.eventLog?.append(event)
}
```

Replace all `this.opts.eventBus?.publish(...)` calls with `this.emit(...)`.

Also add `resolveImpact` method (see Task 3 step below).

Update `queryEvents` to prefer EventLog if available:
```typescript
async queryEvents(params: { ... }): Promise<any> {
  const history = this.opts.eventLog
    ? this.opts.eventLog.query({ entity_id: params.entity_id, event_type: params.event_type as any, since: params.since, limit: params.limit })
    : (this.opts.eventBus?.getHistory(params.since) ?? [])
  // ... filter and return
}
```

- [ ] **Step 1.6 — Commit**

```bash
git add packages/tw-daemon/src/log/ packages/tw-daemon/src/core/command-handler.ts
git commit -m "feat(log): EventLog — NDJSON persistent event log with query"
```

---

## Task 2: SpanMetrics — Cycle Time / Failure Rate / Throughput

**Files:**
- Create: `packages/tw-daemon/src/metrics/span-metrics.ts`
- Create: `packages/tw-daemon/src/metrics/span-metrics.test.ts`

---

- [ ] **Step 2.1 — Write the failing test**

```typescript
// packages/tw-daemon/src/metrics/span-metrics.test.ts
import { describe, it, expect } from 'vitest'
import { SpanMetrics } from './span-metrics.js'
import { SpanManager } from '../otel/span-manager.js'

function makeManager(): SpanManager {
  const sm = new SpanManager()
  sm.createSpan({ entity_id: 'task-1', entity_type: 'task' })
  sm.addEvent('task-1', 'state_changed_to_in_progress', { from: 'pending' })
  sm.addEvent('task-1', 'state_changed_to_review', { from: 'in_progress' })
  sm.addEvent('task-1', 'state_changed_to_completed', { from: 'review' })
  sm.endSpan('task-1', 'OK')

  sm.createSpan({ entity_id: 'task-2', entity_type: 'task' })
  sm.addEvent('task-2', 'state_changed_to_in_progress', { from: 'pending' })
  sm.addEvent('task-2', 'state_changed_to_rejected', { from: 'in_progress' })
  sm.endSpan('task-2', 'ERROR')

  sm.createSpan({ entity_id: 'uc-1', entity_type: 'usecase' })
  // uc-1 still active (in progress)
  return sm
}

describe('SpanMetrics', () => {
  it('getCycleTime returns phases with duration >= 0', () => {
    const metrics = new SpanMetrics(makeManager())
    const phases = metrics.getCycleTime('task-1')
    expect(phases.length).toBeGreaterThan(0)
    for (const p of phases) {
      expect(p.durationMs).toBeGreaterThanOrEqual(0)
      expect(p.phase).toBeTruthy()
    }
  })

  it('getCycleTime returns empty for unknown entity', () => {
    const metrics = new SpanMetrics(makeManager())
    expect(metrics.getCycleTime('no-such')).toEqual([])
  })

  it('getFailureRate counts rejected spans as failed', () => {
    const metrics = new SpanMetrics(makeManager())
    const rate = metrics.getFailureRate('task')
    expect(rate.total).toBe(2)
    expect(rate.rejected).toBe(1)
    expect(rate.rate).toBeCloseTo(0.5)
  })

  it('getFailureRate with no filter counts all types', () => {
    const metrics = new SpanMetrics(makeManager())
    const rate = metrics.getFailureRate()
    expect(rate.total).toBe(3) // task-1, task-2, uc-1
    expect(rate.rejected).toBe(1)
  })

  it('getThroughput counts completed spans in window', () => {
    const metrics = new SpanMetrics(makeManager())
    const t = metrics.getThroughput(60 * 60 * 1000) // 1h window
    expect(t.completed).toBe(1) // only task-1 is OK/completed
    expect(t.perHour).toBeGreaterThan(0)
  })

  it('getSummary returns all three metrics', () => {
    const metrics = new SpanMetrics(makeManager())
    const summary = metrics.getSummary()
    expect(summary).toHaveProperty('failureRate')
    expect(summary).toHaveProperty('throughput')
    expect(summary).toHaveProperty('activeSpans')
  })
})
```

- [ ] **Step 2.2 — Run test to confirm fail**

```bash
npm test --workspace=packages/tw-daemon -- --reporter=verbose 2>&1 | grep -A2 "SpanMetrics"
```

- [ ] **Step 2.3 — Implement SpanMetrics**

```typescript
// packages/tw-daemon/src/metrics/span-metrics.ts
import type { SpanManager } from '../otel/span-manager.js'
import type { EntityType } from '@traceweaver/types'

export interface PhaseTime {
  phase: string          // e.g. 'pending→in_progress'
  durationMs: number
}

export interface FailureRate {
  total: number
  rejected: number
  rate: number           // 0..1
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
    // Events named 'state_changed_to_<state>' mark phase transitions
    const transitions = span.events.filter(e => e.name.startsWith('state_changed_to_'))
    // Add span start → first transition
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
    const spans = this.getAllSpans(entityType)
    const rejected = spans.filter(s => s.status === 'ERROR').length
    return { total: spans.length, rejected, rate: spans.length ? rejected / spans.length : 0 }
  }

  getThroughput(windowMs = 24 * 60 * 60 * 1000): ThroughputStats {
    const cutoff = Date.now() - windowMs
    const spans = this.getAllSpans()
    const completed = spans.filter(s =>
      s.status === 'OK' && s.end_time && new Date(s.end_time).getTime() >= cutoff
    ).length
    const perHour = completed / (windowMs / (60 * 60 * 1000))
    return { completed, windowMs, perHour }
  }

  getSummary(): MetricsSummary {
    const allSpans = this.getAllSpans()
    return {
      failureRate: this.getFailureRate(),
      throughput: this.getThroughput(),
      activeSpans: this.spanManager.getActiveSpans().length,
      spanCount: allSpans.length,
    }
  }

  private getAllSpans(entityType?: EntityType) {
    // SpanManager exposes getActiveSpans() but not all spans.
    // We expose a small accessor: get all spans regardless of status.
    // NOTE: SpanManager stores spans in a private Map. We access via getActiveSpans()
    // + endedSpans by calling getSpan on known ids isn't possible without the ids.
    // Solution: SpanMetrics maintains its own snapshot via observe().
    return this.spanManager.getAllSpans(entityType)
  }
}
```

**Important:** `SpanManager` needs `getAllSpans(entityType?)` exposed. Add to `packages/tw-daemon/src/otel/span-manager.ts`:

```typescript
getAllSpans(entityType?: EntityType): SpanMeta[] {
  const all = [...this.spans.values()]
  if (!entityType) return all
  return all.filter(s => s.entity_type === entityType)
}
```

- [ ] **Step 2.4 — Run test to confirm pass**

```bash
npm test --workspace=packages/tw-daemon -- --reporter=verbose 2>&1 | grep -A2 "SpanMetrics"
```

- [ ] **Step 2.5 — Commit**

```bash
git add packages/tw-daemon/src/metrics/ packages/tw-daemon/src/otel/span-manager.ts
git commit -m "feat(metrics): SpanMetrics — cycle_time, failure_rate, throughput from OTel spans"
```

---

## Task 3: ImpactResolver — Real Artifact Impact Analysis

**Files:**
- Create: `packages/tw-daemon/src/impact/impact-resolver.ts`
- Create: `packages/tw-daemon/src/impact/impact-resolver.test.ts`
- Modify: `packages/tw-daemon/src/core/command-handler.ts` (add `resolveImpact`)

---

- [ ] **Step 3.1 — Write the failing test**

```typescript
// packages/tw-daemon/src/impact/impact-resolver.test.ts
import { describe, it, expect } from 'vitest'
import { ImpactResolver } from './impact-resolver.js'
import type { Entity } from '@traceweaver/types'

function e(id: string, artifactPaths: string[], dependsOn: string[] = []): Entity {
  return {
    id,
    entity_type: 'task',
    state: 'pending',
    artifact_refs: artifactPaths.map(p => ({ type: 'code', path: p })),
    depends_on: dependsOn,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

describe('ImpactResolver', () => {
  it('returns directly affected entities for a matching artifact path', () => {
    const entities = [
      e('task-a', ['src/auth.ts']),
      e('task-b', ['src/auth.ts', 'src/db.ts']),
      e('task-c', ['src/db.ts']),
    ]
    const resolver = new ImpactResolver()
    resolver.index(entities)
    const result = resolver.resolve('src/auth.ts')
    const directIds = result.directly_affected.map(e => e.id).sort()
    expect(directIds).toEqual(['task-a', 'task-b'])
  })

  it('returns transitively affected entities via depends_on', () => {
    const entities = [
      e('task-a', ['src/auth.ts']),          // directly affected
      e('task-b', [], ['task-a']),             // depends on task-a → transitively affected
      e('task-c', [], []),                     // unrelated
    ]
    const resolver = new ImpactResolver()
    resolver.index(entities)
    const result = resolver.resolve('src/auth.ts')
    const directIds = result.directly_affected.map(e => e.id)
    const transitiveIds = result.transitively_affected.map(e => e.id)
    expect(directIds).toContain('task-a')
    expect(transitiveIds).toContain('task-b')
    expect(transitiveIds).not.toContain('task-a') // already in direct
  })

  it('matches section-filtered paths', () => {
    const entities = [e('task-a', ['docs/prd.md'])]
    const resolver = new ImpactResolver()
    resolver.index(entities)
    // Without section filter: matches
    expect(resolver.resolve('docs/prd.md').directly_affected).toHaveLength(1)
    // With section filter (section is ignored for path matching)
    expect(resolver.resolve('docs/prd.md', 'section-1').directly_affected).toHaveLength(1)
  })

  it('returns empty when no entity references the file', () => {
    const entities = [e('task-a', ['src/other.ts'])]
    const resolver = new ImpactResolver()
    resolver.index(entities)
    const result = resolver.resolve('src/auth.ts')
    expect(result.directly_affected).toHaveLength(0)
    expect(result.transitively_affected).toHaveLength(0)
  })
})
```

- [ ] **Step 3.2 — Run test to confirm fail**

```bash
npm test --workspace=packages/tw-daemon -- --reporter=verbose 2>&1 | grep -A2 "ImpactResolver"
```

- [ ] **Step 3.3 — Implement ImpactResolver**

```typescript
// packages/tw-daemon/src/impact/impact-resolver.ts
import type { Entity } from '@traceweaver/types'

export interface ImpactResult {
  directly_affected: Entity[]
  transitively_affected: Entity[]
}

export class ImpactResolver {
  // filePath → entity ids that reference it
  private readonly fileIndex = new Map<string, Set<string>>()
  // id → dependents (entities that depend_on this id)
  private readonly dependentIndex = new Map<string, Set<string>>()
  private readonly byId = new Map<string, Entity>()

  index(entities: Entity[]): void {
    this.fileIndex.clear()
    this.dependentIndex.clear()
    this.byId.clear()
    for (const entity of entities) {
      this.byId.set(entity.id, entity)
      for (const ref of entity.artifact_refs ?? []) {
        const set = this.fileIndex.get(ref.path) ?? new Set()
        set.add(entity.id)
        this.fileIndex.set(ref.path, set)
      }
      for (const dep of entity.depends_on ?? []) {
        const set = this.dependentIndex.get(dep) ?? new Set()
        set.add(entity.id)
        this.dependentIndex.set(dep, set)
      }
    }
  }

  /** Re-index a single entity (call after register or updateAttributes) */
  upsert(entity: Entity): void {
    this.byId.set(entity.id, entity)
    // Rebuild full index for simplicity (entity count is small)
    this.index([...this.byId.values()])
  }

  resolve(filePath: string, _section?: string): ImpactResult {
    const directIds = new Set(this.fileIndex.get(filePath) ?? [])
    const directly_affected = [...directIds].map(id => this.byId.get(id)!).filter(Boolean)

    // BFS over dependentIndex to find transitive dependents
    const visited = new Set<string>(directIds)
    const queue = [...directIds]
    const transitiveIds = new Set<string>()
    while (queue.length > 0) {
      const id = queue.shift()!
      for (const dependent of this.dependentIndex.get(id) ?? []) {
        if (!visited.has(dependent)) {
          visited.add(dependent)
          transitiveIds.add(dependent)
          queue.push(dependent)
        }
      }
    }
    const transitively_affected = [...transitiveIds].map(id => this.byId.get(id)!).filter(Boolean)
    return { directly_affected, transitively_affected }
  }
}
```

- [ ] **Step 3.4 — Add resolveImpact to CommandHandler**

In `packages/tw-daemon/src/core/command-handler.ts`:

Add import:
```typescript
import { ImpactResolver } from '../impact/impact-resolver.js'
```

Add to class body:
```typescript
private readonly impactResolver = new ImpactResolver()
```

In `register()`, after `this.cache.set(entity)`:
```typescript
this.impactResolver.upsert(entity)
```

In `updateAttributes()`, after `this.cache.set(entity)`:
```typescript
this.impactResolver.upsert(entity)
```

Add new method:
```typescript
resolveImpact(filePath: string, section?: string): ImpactResult {
  return this.impactResolver.resolve(filePath, section)
}
```

Also, in `init()`, after the WAL replay loop completes:
```typescript
this.impactResolver.index(this.registry.getAll())
```

- [ ] **Step 3.5 — Run all tests to confirm pass**

```bash
npm test --workspace=packages/tw-daemon -- --reporter=verbose 2>&1 | grep -E "PASS|FAIL|ImpactResolver"
```

- [ ] **Step 3.6 — Commit**

```bash
git add packages/tw-daemon/src/impact/ packages/tw-daemon/src/core/command-handler.ts
git commit -m "feat(impact): ImpactResolver — file→entity reverse index + transitive DAG propagation"
```

---

## Task 4: HarnessLoader — Constraint Files as Code

**Files:**
- Create: `packages/tw-daemon/src/harness/loader.ts`
- Create: `packages/tw-daemon/src/harness/loader.test.ts`

Harness file format (`.traceweaver/harness/<id>.md`):

```markdown
---
id: test-coverage
applies_to:
  - task
trigger_on:
  - review
  - completed
---
# Test Coverage Constraint

All tasks MUST include test files. Check that artifact_refs contains at least one entry with type "test".

RESULT: pass if tests are present, fail otherwise.
```

---

- [ ] **Step 4.1 — Write the failing test**

```typescript
// packages/tw-daemon/src/harness/loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessLoader } from './loader.js'

const HARNESS_A = `---
id: test-coverage
applies_to:
  - task
trigger_on:
  - review
---
# Test Coverage

All tasks must have test files.
`

const HARNESS_B = `---
id: api-docs
applies_to:
  - usecase
  - plan
trigger_on:
  - completed
---
# API Documentation

Usecases and plans must have linked documentation.
`

const HARNESS_MALFORMED = `not valid yaml frontmatter`

describe('HarnessLoader', () => {
  let harnessDir: string
  let loader: HarnessLoader

  beforeEach(() => {
    harnessDir = mkdtempSync(join(tmpdir(), 'tw-harness-'))
    writeFileSync(join(harnessDir, 'test-coverage.md'), HARNESS_A)
    writeFileSync(join(harnessDir, 'api-docs.md'), HARNESS_B)
    loader = new HarnessLoader(harnessDir)
  })
  afterEach(() => rmSync(harnessDir, { recursive: true }))

  it('scans and loads all harness files', async () => {
    const entries = await loader.scan()
    expect(entries).toHaveLength(2)
  })

  it('parses id, applies_to, trigger_on from frontmatter', async () => {
    await loader.scan()
    const entry = loader.get('test-coverage')
    expect(entry).toBeDefined()
    expect(entry!.id).toBe('test-coverage')
    expect(entry!.applies_to).toContain('task')
    expect(entry!.trigger_on).toContain('review')
  })

  it('content contains body without frontmatter', async () => {
    await loader.scan()
    const entry = loader.get('test-coverage')
    expect(entry!.content).toContain('All tasks must have test files')
    expect(entry!.content).not.toContain('applies_to')
  })

  it('list returns all loaded entries', async () => {
    await loader.scan()
    expect(loader.list()).toHaveLength(2)
  })

  it('get returns undefined for unknown id', async () => {
    await loader.scan()
    expect(loader.get('nonexistent')).toBeUndefined()
  })

  it('skips malformed files gracefully', async () => {
    writeFileSync(join(harnessDir, 'bad.md'), HARNESS_MALFORMED)
    // Should not throw; malformed file skipped or treated as no-frontmatter
    await expect(loader.scan()).resolves.not.toThrow()
  })

  it('returns empty list when harness dir does not exist', async () => {
    const emptyLoader = new HarnessLoader('/nonexistent/path')
    const entries = await emptyLoader.scan()
    expect(entries).toEqual([])
  })
})
```

- [ ] **Step 4.2 — Run test to confirm fail**

```bash
npm test --workspace=packages/tw-daemon -- --reporter=verbose 2>&1 | grep -A2 "HarnessLoader"
```

- [ ] **Step 4.3 — Implement HarnessLoader**

```typescript
// packages/tw-daemon/src/harness/loader.ts
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import yaml from 'js-yaml'
import type { EntityType, EntityState } from '@traceweaver/types'

export interface HarnessEntry {
  id: string
  path: string
  applies_to: EntityType[]
  trigger_on: EntityState[]
  content: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/

export class HarnessLoader {
  private readonly entries = new Map<string, HarnessEntry>()

  constructor(private readonly harnessDir: string) {}

  async scan(): Promise<HarnessEntry[]> {
    this.entries.clear()
    if (!existsSync(this.harnessDir)) return []
    let files: string[]
    try {
      files = await readdir(this.harnessDir)
    } catch {
      return []
    }
    for (const file of files.filter(f => f.endsWith('.md'))) {
      try {
        const raw = await readFile(join(this.harnessDir, file), 'utf8')
        const entry = this.parse(join(this.harnessDir, file), raw)
        if (entry) this.entries.set(entry.id, entry)
      } catch { /* skip unreadable file */ }
    }
    return [...this.entries.values()]
  }

  get(id: string): HarnessEntry | undefined {
    return this.entries.get(id)
  }

  list(): HarnessEntry[] {
    return [...this.entries.values()]
  }

  private parse(path: string, raw: string): HarnessEntry | null {
    const match = FRONTMATTER_RE.exec(raw)
    if (!match) return null
    let fm: Record<string, unknown>
    try {
      fm = yaml.load(match[1]) as Record<string, unknown>
    } catch {
      return null
    }
    if (!fm?.id || typeof fm.id !== 'string') return null
    const applies_to = Array.isArray(fm.applies_to)
      ? (fm.applies_to as string[]).filter(Boolean) as EntityType[]
      : []
    const trigger_on = Array.isArray(fm.trigger_on)
      ? (fm.trigger_on as string[]).filter(Boolean) as EntityState[]
      : []
    return { id: fm.id, path, applies_to, trigger_on, content: match[2].trim() }
  }
}
```

- [ ] **Step 4.4 — Run test to confirm pass**

```bash
npm test --workspace=packages/tw-daemon -- --reporter=verbose 2>&1 | grep -A2 "HarnessLoader"
```

- [ ] **Step 4.5 — Commit**

```bash
git add packages/tw-daemon/src/harness/
git commit -m "feat(harness): HarnessLoader — constraint-as-code from .traceweaver/harness/*.md"
```

---

## Task 5: TriggerExecutor — Auto-Validate and Auto-Reject

**Files:**
- Create: `packages/tw-daemon/src/trigger/executor.ts`
- Create: `packages/tw-daemon/src/trigger/executor.test.ts`

---

- [ ] **Step 5.1 — Write the failing test**

```typescript
// packages/tw-daemon/src/trigger/executor.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TriggerExecutor } from './executor.js'
import { HarnessLoader } from '../harness/loader.js'
import { EventBus } from '../core/event-bus/event-bus.js'
import { CommandHandler } from '../core/command-handler.js'
import { ConstraintEvaluator } from '../constraint/evaluator.js'
import type { TwEvent } from '@traceweaver/types'

const FAIL_HARNESS = `---
id: always-fail
applies_to:
  - task
trigger_on:
  - review
---
# Always Fail Constraint
This constraint always fails for testing.
`

const PASS_HARNESS = `---
id: always-pass
applies_to:
  - task
trigger_on:
  - review
---
# Always Pass Constraint
This constraint always passes.
MUST_PASS
`

describe('TriggerExecutor', () => {
  let dir: string
  let harnessDir: string
  let eventBus: EventBus
  let handler: CommandHandler

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tw-trigger-'))
    harnessDir = join(dir, 'harness')
    mkdirSync(harnessDir)
    eventBus = new EventBus({ batchWindowMs: 20 })
    handler = new CommandHandler({ storeDir: dir, eventBus })
    await handler.init()
    eventBus.start()
  })

  afterEach(async () => {
    eventBus.stop()
    rmSync(dir, { recursive: true })
  })

  it('auto-rejects entity when constraint evaluator returns fail', async () => {
    writeFileSync(join(harnessDir, 'always-fail.md'), FAIL_HARNESS)
    const harness = new HarnessLoader(harnessDir)
    await harness.scan()

    // Evaluator always returns fail
    const evaluator = new ConstraintEvaluator({
      enabled: true,
      llmFn: async () => 'RESULT: fail\nTest constraint failure',
    })

    const executor = new TriggerExecutor({ handler, evaluator, harness, eventBus })
    executor.start()

    // Register + advance to review (triggers executor)
    await handler.register({ id: 'auto-task-1', entity_type: 'task', constraint_refs: ['always-fail'] })
    await handler.updateState({ id: 'auto-task-1', state: 'in_progress' })
    await handler.updateState({ id: 'auto-task-1', state: 'review' })

    // Wait for batch drain + async evaluation
    await new Promise(r => setTimeout(r, 300))
    executor.stop()

    const result = await handler.getStatus({ id: 'auto-task-1' })
    expect(result.entity.state).toBe('rejected')
  })

  it('does NOT reject entity when constraint evaluator returns pass', async () => {
    writeFileSync(join(harnessDir, 'always-pass.md'), PASS_HARNESS)
    const harness = new HarnessLoader(harnessDir)
    await harness.scan()

    const evaluator = new ConstraintEvaluator({
      enabled: true,
      llmFn: async (prompt) => prompt.includes('MUST_PASS')
        ? 'RESULT: pass\nAll good'
        : 'RESULT: fail\nBad',
    })

    const executor = new TriggerExecutor({ handler, evaluator, harness, eventBus })
    executor.start()

    await handler.register({ id: 'pass-task-1', entity_type: 'task', constraint_refs: ['always-pass'] })
    await handler.updateState({ id: 'pass-task-1', state: 'in_progress' })
    await handler.updateState({ id: 'pass-task-1', state: 'review' })

    await new Promise(r => setTimeout(r, 300))
    executor.stop()

    const result = await handler.getStatus({ id: 'pass-task-1' })
    // Still in review — not auto-rejected
    expect(result.entity.state).toBe('review')
  })

  it('ignores events for entity types not in harness applies_to', async () => {
    writeFileSync(join(harnessDir, 'always-fail.md'), FAIL_HARNESS) // only applies to task
    const harness = new HarnessLoader(harnessDir)
    await harness.scan()

    const rejectFn = vi.fn(async () => 'RESULT: fail')
    const evaluator = new ConstraintEvaluator({ enabled: true, llmFn: rejectFn })

    const executor = new TriggerExecutor({ handler, evaluator, harness, eventBus })
    executor.start()

    // Register a USECASE (not in harness applies_to: [task])
    await handler.register({ id: 'uc-no-trigger', entity_type: 'usecase', constraint_refs: ['always-fail'] })
    await handler.updateState({ id: 'uc-no-trigger', state: 'in_progress' })
    // Usecases can't go to review; test that the evaluator is not called for non-matching types
    // (just verify no crash — usecase state machine won't reach review via task path)

    await new Promise(r => setTimeout(r, 200))
    executor.stop()
    // If evaluator was called incorrectly it would have been called for the usecase
    // We can verify by checking the usecase is still in_progress (not rejected due to wrong harness match)
    const result = await handler.getStatus({ id: 'uc-no-trigger' })
    expect(result.entity.state).toBe('in_progress')
  })
})
```

- [ ] **Step 5.2 — Run test to confirm fail**

```bash
npm test --workspace=packages/tw-daemon -- --reporter=verbose 2>&1 | grep -A2 "TriggerExecutor"
```

- [ ] **Step 5.3 — Implement TriggerExecutor**

```typescript
// packages/tw-daemon/src/trigger/executor.ts
import type { TwEvent, ConstraintValidationResult } from '@traceweaver/types'
import type { EventBus } from '../core/event-bus/event-bus.js'
import type { CommandHandler } from '../core/command-handler.js'
import type { ConstraintEvaluator } from '../constraint/evaluator.js'
import type { HarnessLoader, HarnessEntry } from '../harness/loader.js'
import type { InboxAdapter } from '../notify/inbox.js'

export interface TriggerExecutorOptions {
  handler: CommandHandler
  evaluator: ConstraintEvaluator
  harness: HarnessLoader
  eventBus: EventBus
  inbox?: Pick<InboxAdapter, 'write'>
}

export class TriggerExecutor {
  private unsub: (() => void) | null = null

  constructor(private readonly opts: TriggerExecutorOptions) {}

  start(): void {
    this.unsub = this.opts.eventBus.subscribeBatch(
      batch => void this.handleBatch(batch).catch(() => {})
    )
  }

  stop(): void {
    this.unsub?.()
    this.unsub = null
  }

  /** Public — called by IpcServer for on-demand harness_run */
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
      const matchingHarnesses = this.opts.harness.list().filter(h =>
        h.trigger_on.includes(event.state!) &&
        (h.applies_to.length === 0 || (event.entity_type && h.applies_to.includes(event.entity_type)))
      )
      if (matchingHarnesses.length === 0) continue

      // Re-fetch entity to get latest state (avoids acting on stale snapshot)
      const entityResult = await this.opts.handler.get({ id: event.entity_id! })
      if (!entityResult.ok) continue
      const entity = entityResult.data

      // Race-condition guard: skip if entity moved past the trigger state since the event fired
      if (entity.state !== event.state) continue

      for (const harness of matchingHarnesses) {
        await this.evaluateAndAct(entity, harness, event.state!)
      }
    }
  }

  private async evaluateAndAct(entity: any, harness: HarnessEntry, triggerState: string): Promise<void> {
    const result = await this.runHarness(entity, harness)

    if (result.result === 'fail') {
      try {
        // Re-check state immediately before writing to minimise TOCTOU window
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
      } catch { /* already in terminal state or concurrent update — safe to ignore */ }
    } else if (result.result === 'pass') {
      await this.opts.inbox?.write({
        event_type: 'entity.state_changed',
        entity_id: entity.id,
        message: `[AUTO-PASS] ${entity.id} passed constraint '${harness.id}'`,
      })
    }
  }
}
```

- [ ] **Step 5.4 — Run test to confirm pass**

```bash
npm test --workspace=packages/tw-daemon -- --reporter=verbose 2>&1 | grep -A2 "TriggerExecutor"
```

- [ ] **Step 5.5 — Commit**

```bash
git add packages/tw-daemon/src/trigger/
git commit -m "feat(trigger): TriggerExecutor — auto-validate on state change, auto-reject on harness fail"
```

---

## Task 6: IPC + Daemon Integration

**Files:**
- Modify: `packages/tw-daemon/src/ipc-server.ts`
- Modify: `packages/tw-daemon/src/index.ts`
- Create: `packages/tw-daemon/src/phase5-integration.test.ts`

---

- [ ] **Step 6.1 — Update IpcServer with new methods**

In `packages/tw-daemon/src/ipc-server.ts`:

Add imports:
```typescript
import type { EventLog } from './log/event-log.js'
import type { SpanMetrics } from './metrics/span-metrics.js'
import type { HarnessLoader } from './harness/loader.js'
import type { TriggerExecutor } from './trigger/executor.js'
```

Extend `IpcServerOptions`:
```typescript
export interface IpcServerOptions {
  inbox?: InboxAdapter
  eventLog?: EventLog
  spanMetrics?: SpanMetrics
  harnessLoader?: HarnessLoader
  triggerExecutor?: TriggerExecutor
}
```

Store in constructor and add dispatch cases:

```typescript
} else if (method === 'log_query') {
  data = this.eventLog?.query(params as any) ?? []
} else if (method === 'get_metrics') {
  data = this.spanMetrics?.getSummary() ?? { error: 'SpanMetrics not available' }
} else if (method === 'resolve_impact') {
  const { artifact_path, section } = params as any
  data = this.handler.resolveImpact(artifact_path, section)
} else if (method === 'harness_list') {
  data = this.harnessLoader?.list() ?? []
} else if (method === 'harness_show') {
  const { id } = params as any
  const entry = this.harnessLoader?.get(id)
  if (!entry) throw Object.assign(new Error(`Harness '${id}' not found`), { code: 'NOT_FOUND' })
  data = entry
} else if (method === 'harness_run') {
  // On-demand run: evaluate now and return result
  const { entity_id, harness_id } = params as any
  if (!this.harnessLoader || !this.triggerExecutor) {
    throw Object.assign(new Error('Harness not available'), { code: 'NOT_AVAILABLE' })
  }
  const entry = this.harnessLoader.get(harness_id)
  if (!entry) throw Object.assign(new Error(`Harness '${harness_id}' not found`), { code: 'NOT_FOUND' })
  const entityResult = await this.handler.get({ id: entity_id })
  if (!entityResult.ok) throw Object.assign(new Error(entityResult.error.message), { code: entityResult.error.code })
  data = await this.triggerExecutor.runHarness(entityResult.data, entry)
```

**Note:** `evaluateAndAct` needs to be made `public` in TriggerExecutor, or add a public `runHarness(entityId, harness)` method that returns the ConstraintValidationResult instead of acting. Add this to TriggerExecutor:

```typescript
async runHarness(entity: any, harness: HarnessEntry): Promise<ConstraintValidationResult> {
  return this.opts.evaluator.evaluate({
    entity_id: entity.id,
    constraint_refs: [harness.id],
    artifact_refs: entity.artifact_refs ?? [],
    constraintContents: { [harness.id]: harness.content },
  })
}
```

- [ ] **Step 6.2 — Write Phase 5 integration test**

```typescript
// packages/tw-daemon/src/phase5-integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandHandler } from './core/command-handler.js'
import { EventBus } from './core/event-bus/event-bus.js'
import { SpanManager } from './otel/span-manager.js'
import { EventLog } from './log/event-log.js'
import { SpanMetrics } from './metrics/span-metrics.js'
import { HarnessLoader } from './harness/loader.js'
import { TriggerExecutor } from './trigger/executor.js'
import { ConstraintEvaluator } from './constraint/evaluator.js'
import { ImpactResolver } from './impact/impact-resolver.js'

describe('Phase 5 integration', () => {
  let dir: string
  let eventBus: EventBus
  let handler: CommandHandler
  let eventLog: EventLog
  let spanManager: SpanManager

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tw-phase5-'))
    eventBus = new EventBus({ batchWindowMs: 20 })
    spanManager = new SpanManager()
    eventLog = new EventLog(join(dir, 'events.ndjson'))
    eventLog.load()
    handler = new CommandHandler({ storeDir: dir, eventBus, spanManager, eventLog })
    await handler.init()
    eventBus.start()
  })

  afterEach(() => {
    eventBus.stop()
    rmSync(dir, { recursive: true })
  })

  it('EventLog persists events across handler operations', async () => {
    await handler.register({ id: 'persist-1', entity_type: 'task' })
    await handler.updateState({ id: 'persist-1', state: 'in_progress' })
    await new Promise(r => setTimeout(r, 100))
    const history = eventLog.getHistory()
    expect(history.some(e => e.type === 'entity.registered')).toBe(true)
    expect(history.some(e => e.type === 'entity.state_changed')).toBe(true)
  })

  it('EventLog query filters by entity_id', async () => {
    await handler.register({ id: 'q-1', entity_type: 'task' })
    await handler.register({ id: 'q-2', entity_type: 'task' })
    const result = eventLog.query({ entity_id: 'q-1' })
    expect(result.every(e => e.entity_id === 'q-1')).toBe(true)
  })

  it('ImpactResolver resolves directly affected entities', async () => {
    await handler.register({ id: 'imp-1', entity_type: 'task', artifact_refs: [{ type: 'code', path: 'src/auth.ts' }] })
    await handler.register({ id: 'imp-2', entity_type: 'task', artifact_refs: [{ type: 'code', path: 'src/db.ts' }] })
    const result = handler.resolveImpact('src/auth.ts')
    expect(result.directly_affected.map(e => e.id)).toContain('imp-1')
    expect(result.directly_affected.map(e => e.id)).not.toContain('imp-2')
  })

  it('SpanMetrics getSummary returns valid shape', async () => {
    await handler.register({ id: 'sm-1', entity_type: 'task' })
    const metrics = new SpanMetrics(spanManager)
    const summary = metrics.getSummary()
    expect(summary).toHaveProperty('failureRate')
    expect(summary).toHaveProperty('throughput')
    expect(summary).toHaveProperty('activeSpans')
  })

  it('TriggerExecutor auto-rejects entity on harness fail', async () => {
    const harnessDir = join(dir, 'harness')
    mkdirSync(harnessDir)
    writeFileSync(join(harnessDir, 'strict.md'), `---
id: strict
applies_to:
  - task
trigger_on:
  - review
---
Always fail.
`)
    const harness = new HarnessLoader(harnessDir)
    await harness.scan()

    const evaluator = new ConstraintEvaluator({ enabled: true, llmFn: async () => 'RESULT: fail\nViolation' })
    const executor = new TriggerExecutor({ handler, evaluator, harness, eventBus })
    executor.start()

    await handler.register({ id: 'auto-1', entity_type: 'task', constraint_refs: ['strict'] })
    await handler.updateState({ id: 'auto-1', state: 'in_progress' })
    await handler.updateState({ id: 'auto-1', state: 'review' })
    await new Promise(r => setTimeout(r, 400))
    executor.stop()

    const status = await handler.getStatus({ id: 'auto-1' })
    expect(status.entity.state).toBe('rejected')
  })
})
```

- [ ] **Step 6.3 — Update daemon index.ts**

In `packages/tw-daemon/src/index.ts`, add imports and initializations:

```typescript
import { EventLog } from './log/event-log.js'
import { SpanMetrics } from './metrics/span-metrics.js'
import { HarnessLoader } from './harness/loader.js'
import { TriggerExecutor } from './trigger/executor.js'
import { ConstraintEvaluator } from './constraint/evaluator.js'
```

After `eventBus.start()`:
```typescript
const eventLog = new EventLog(join(STORE_DIR, 'events.ndjson'))
eventLog.load()

const spanManager = new SpanManager({ projectId: 'default' })
const spanMetrics = new SpanMetrics(spanManager)
```

Pass `eventLog` and `spanManager` to CommandHandler:
```typescript
const handler = new CommandHandler({ storeDir: STORE_DIR, eventBus, spanManager, eventLog })
```

After NotifyEngine setup:
```typescript
const harnessLoader = new HarnessLoader(join(STORE_DIR, 'harness'))
await harnessLoader.scan()

const evaluator = new ConstraintEvaluator({
  enabled: !!process.env.ANTHROPIC_API_KEY,
  apiKey: process.env.ANTHROPIC_API_KEY,
})
const triggerExecutor = new TriggerExecutor({ handler, evaluator, harness: harnessLoader, eventBus, inbox })
triggerExecutor.start()
```

Pass new services to IpcServer:
```typescript
const server = new IpcServer(SOCKET_PATH, handler, () => { lastActivity = Date.now() }, {
  inbox,
  eventLog,
  spanMetrics,
  harnessLoader,
  triggerExecutor,
})
```

In cleanup:
```typescript
triggerExecutor.stop()
```

- [ ] **Step 6.4 — Run all tests**

```bash
npm test --workspace=packages/tw-daemon -- --reporter=verbose 2>&1 | tail -20
```

Expected: all tests pass (target: 180+ passing)

- [ ] **Step 6.5 — Commit**

```bash
git add packages/tw-daemon/src/ipc-server.ts packages/tw-daemon/src/index.ts packages/tw-daemon/src/phase5-integration.test.ts
git commit -m "feat(daemon): wire Phase 5 — EventLog + SpanMetrics + HarnessLoader + TriggerExecutor into daemon"
```

---

## Task 7: CLI — log, metrics, harness, watch + --json everywhere

**Files:**
- Create: `packages/tw-cli/src/commands/log.ts`
- Create: `packages/tw-cli/src/commands/metrics.ts`
- Create: `packages/tw-cli/src/commands/harness.ts`
- Create: `packages/tw-cli/src/commands/watch.ts`
- Modify: `packages/tw-cli/src/commands/status.ts`, `events.ts`, `impact.ts`, `dag.ts`, `inbox.ts`
- Modify: `packages/tw-cli/src/index.ts`

---

- [ ] **Step 7.1 — Create tw log command**

```typescript
// packages/tw-cli/src/commands/log.ts
import { Command } from 'commander'
import { sendIpc } from '../ipc-client.js'
import { ensureDaemon } from '../daemon-manager.js'

export function logCommand(): Command {
  const cmd = new Command('log').description('Query persisted event log')

  cmd.command('query')
    .description('Query event log with filters')
    .option('--entity <id>', 'Filter by entity ID')
    .option('--type <type>', 'Filter by event type')
    .option('--since <iso>', 'Filter events since ISO timestamp or shorthand (e.g. 1h, 24h)')
    .option('--limit <n>', 'Maximum number of events to return', '50')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        await ensureDaemon()
        // Parse --since shorthand: '1h' → ISO timestamp
        let since = opts.since
        if (since && /^\d+[hmd]$/.test(since)) {
          const units: Record<string, number> = { h: 3600000, m: 60000, d: 86400000 }
          const unit = since.slice(-1)
          const n = parseInt(since.slice(0, -1), 10)
          since = new Date(Date.now() - n * units[unit]).toISOString()
        }
        const res = await sendIpc({
          method: 'log_query',
          params: { entity_id: opts.entity, event_type: opts.type, since, limit: parseInt(opts.limit, 10) },
        })
        if (!res.ok) { console.error(`Error: ${(res as any).error.message}`); process.exit(1) }
        const events = (res as any).data as any[]
        if (opts.json) { console.log(JSON.stringify(events, null, 2)); return }
        if (events.length === 0) { console.log('No events found'); return }
        for (const ev of events) {
          const entity = ev.entity_id ? ` [${ev.entity_id}]` : ''
          const state = ev.state ? ` → ${ev.state}` : ''
          console.log(`${ev.ts.slice(0, 19)}  seq=${ev.seq}  ${ev.type}${entity}${state}`)
        }
      } catch (err: any) { console.error(`Error: ${err.message}`); process.exit(1) }
    })

  return cmd
}
```

- [ ] **Step 7.2 — Create tw metrics command**

```typescript
// packages/tw-cli/src/commands/metrics.ts
import { Command } from 'commander'
import { sendIpc } from '../ipc-client.js'
import { ensureDaemon } from '../daemon-manager.js'

export function metricsCommand(): Command {
  return new Command('metrics')
    .description('Show span-derived metrics (cycle time, failure rate, throughput)')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        await ensureDaemon()
        const res = await sendIpc({ method: 'get_metrics', params: {} })
        if (!res.ok) { console.error(`Error: ${(res as any).error.message}`); process.exit(1) }
        const m = (res as any).data as any
        if (opts.json) { console.log(JSON.stringify(m, null, 2)); return }
        const fr = m.failureRate
        const tp = m.throughput
        console.log(`Failure rate:  ${fr.rejected}/${fr.total} (${(fr.rate * 100).toFixed(1)}%)`)
        console.log(`Throughput:    ${tp.completed} completed in window  (${tp.perHour.toFixed(2)}/hr)`)
        console.log(`Active spans:  ${m.activeSpans}`)
        console.log(`Total spans:   ${m.spanCount}`)
      } catch (err: any) { console.error(`Error: ${err.message}`); process.exit(1) }
    })
}
```

- [ ] **Step 7.3 — Create tw harness command**

```typescript
// packages/tw-cli/src/commands/harness.ts
import { Command } from 'commander'
import { sendIpc } from '../ipc-client.js'
import { ensureDaemon } from '../daemon-manager.js'

export function harnessCommand(): Command {
  const cmd = new Command('harness').description('Manage and run constraint harnesses')

  cmd.command('list')
    .description('List all loaded harness files')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      await ensureDaemon()
      const res = await sendIpc({ method: 'harness_list', params: {} })
      if (!res.ok) { console.error(`Error: ${(res as any).error.message}`); process.exit(1) }
      const entries = (res as any).data as any[]
      if (opts.json) { console.log(JSON.stringify(entries, null, 2)); return }
      if (entries.length === 0) { console.log('No harness files loaded (create .traceweaver/harness/*.md)'); return }
      for (const e of entries) {
        console.log(`${e.id.padEnd(24)} applies_to=${e.applies_to.join(',')}  trigger_on=${e.trigger_on.join(',')}`)
      }
    })

  cmd.command('show <id>')
    .description('Show harness content')
    .action(async (id) => {
      await ensureDaemon()
      const res = await sendIpc({ method: 'harness_show', params: { id } })
      if (!res.ok) { console.error(`Error: ${(res as any).error.message}`); process.exit(1) }
      const entry = (res as any).data as any
      console.log(`# ${entry.id}\n`)
      console.log(`applies_to:  ${entry.applies_to.join(', ')}`)
      console.log(`trigger_on:  ${entry.trigger_on.join(', ')}`)
      console.log(`\n${entry.content}`)
    })

  cmd.command('run <entity-id> <harness-id>')
    .description('Manually run a harness against an entity')
    .option('--json', 'Output as JSON')
    .action(async (entityId, harnessId, opts) => {
      await ensureDaemon()
      const res = await sendIpc({ method: 'harness_run', params: { entity_id: entityId, harness_id: harnessId } })
      if (!res.ok) { console.error(`Error: ${(res as any).error.message}`); process.exit(1) }
      const result = (res as any).data as any
      if (opts.json) { console.log(JSON.stringify(result, null, 2)); return }
      const icon = result.result === 'pass' ? '✓' : result.result === 'fail' ? '✗' : '–'
      console.log(`${icon} ${result.result.toUpperCase()}  (checked at ${result.checked_at})`)
      for (const ref of result.refs_checked ?? []) {
        const r = ref.result === 'pass' ? '✓' : ref.result === 'fail' ? '✗' : '–'
        console.log(`  ${r} ${ref.ref}: ${ref.note}`)
      }
    })

  return cmd
}
```

- [ ] **Step 7.4 — Create tw watch command**

```typescript
// packages/tw-cli/src/commands/watch.ts
import { Command } from 'commander'
import { sendIpc } from '../ipc-client.js'
import { ensureDaemon } from '../daemon-manager.js'

export function watchCommand(): Command {
  return new Command('watch')
    .description('Stream live events from the daemon (Ctrl+C to stop)')
    .option('--entity <id>', 'Filter by entity ID')
    .option('--json', 'Output raw JSON lines')
    .action(async (opts) => {
      await ensureDaemon()
      console.log('Watching events (Ctrl+C to stop)...\n')
      let lastSince = new Date().toISOString()
      const timer = setInterval(async () => {
        const res = await sendIpc({
          method: 'log_query',
          params: { entity_id: opts.entity, since: lastSince, limit: 100 },
        })
        if (!res.ok) return
        const events = (res as any).data as any[]
        for (const ev of events) {
          if (ev.ts > lastSince) lastSince = ev.ts
          if (opts.json) { console.log(JSON.stringify(ev)); continue }
          const entity = ev.entity_id ? ` [${ev.entity_id}]` : ''
          const state = ev.state ? ` → ${ev.state}` : ''
          console.log(`${ev.ts.slice(0, 19)}  ${ev.type}${entity}${state}`)
        }
      }, 500)
      process.on('SIGINT', () => { clearInterval(timer); process.exit(0) })
    })
}
```

- [ ] **Step 7.5 — Add --json to existing commands**

For each of `status.ts`, `events.ts`, `impact.ts`, `dag.ts`, `inbox.ts`, add `.option('--json', 'Output as JSON')` to the Command definition and wrap the output block:

```typescript
if (opts.json) { console.log(JSON.stringify(data, null, 2)); return }
// existing human-readable output...
```

Also update `impact.ts` to use the real response shape from the updated IPC:
```typescript
const result = (res as any).data as { directly_affected: any[]; transitively_affected: any[] }
const all = [...result.directly_affected, ...result.transitively_affected]
```

- [ ] **Step 7.6 — Register all new commands in index.ts**

```typescript
// packages/tw-cli/src/index.ts — add imports
import { logCommand }     from './commands/log.js'
import { metricsCommand } from './commands/metrics.js'
import { harnessCommand } from './commands/harness.js'
import { watchCommand }   from './commands/watch.js'

// add after existing addCommand calls:
program.addCommand(logCommand())
program.addCommand(metricsCommand())
program.addCommand(harnessCommand())
program.addCommand(watchCommand())
```

- [ ] **Step 7.7 — Run CLI tests**

```bash
npm test --workspace=packages/tw-cli -- --reporter=verbose 2>&1 | tail -15
```

Expected: all existing CLI tests pass (new commands have no unit tests — they're thin wrappers)

- [ ] **Step 7.8 — Run full test suite**

```bash
npm test --workspace=packages/tw-daemon --workspace=packages/tw-cli 2>&1 | tail -10
```

Expected: 180+ tests all passing

- [ ] **Step 7.9 — Commit**

```bash
git add packages/tw-cli/src/commands/ packages/tw-cli/src/index.ts
git commit -m "feat(cli): log/metrics/harness/watch commands + --json flag on all commands"
```

---

## Task 8: Final Wire-Up, Tag, and README Update

- [ ] **Step 8.1 — Run full suite one final time**

```bash
npm test --workspace=packages/tw-daemon --workspace=packages/tw-cli 2>&1 | tail -20
```

All tests must be green.

- [ ] **Step 8.2 — Update README with Phase 5 additions**

In `README.md`, update the Architecture diagram to include new components:

```
     +---> EventLog (NDJSON)         ← persistent event history
     +---> SpanMetrics               ← cycle_time / failure_rate / throughput
     +---> ImpactResolver            ← file → entity reverse index
     +---> HarnessLoader             ← .traceweaver/harness/*.md
     +---> TriggerExecutor           ← auto-validate → auto-reject
```

Add `tw log`, `tw metrics`, `tw harness`, `tw watch` to the Quick Start section.

Add a **Harness Engineering** section explaining the harness file format.

- [ ] **Step 8.3 — Tag v0.5.0**

```bash
git tag v0.5.0
git log --oneline -8
```

---

## Acceptance Criteria

- [ ] All existing 163 tests still pass (no regression)
- [ ] EventLog appends on every register/updateState/updateAttributes call
- [ ] EventLog survives daemon restart (confirmed by `10-edge-wal-recovery.ts` pattern)
- [ ] SpanMetrics.getSummary() returns valid shape from SpanManager
- [ ] ImpactResolver.resolve() returns non-empty directly_affected for entities with matching artifact_refs
- [ ] HarnessLoader scans `.traceweaver/harness/*.md` and parses YAML frontmatter
- [ ] TriggerExecutor auto-rejects entity when harness fails
- [ ] `tw log query`, `tw metrics`, `tw harness list|show|run` all succeed against running daemon
- [ ] `tw impact <file>` returns real results (not empty stub)
- [ ] All commands accept `--json` for machine-readable output
- [ ] Total test count ≥ 185

---

## Verification Commands

```bash
# Full test suite
npm test --workspace=packages/tw-daemon --workspace=packages/tw-cli

# Smoke test (requires running daemon)
tw daemon start
tw register exp-smoke --type task
tw update exp-smoke --state in_progress
tw log query --entity exp-smoke
tw metrics
tw impact src/auth.ts
tw harness list
tw daemon stop
```
