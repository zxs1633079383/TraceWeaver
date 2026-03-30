# Real Project Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable TraceWeaver to integrate with real projects via CC Hooks — UseCase→Plan→Task lifecycle tracking, error bubbling, progress tracking, UseCase mutation with drain+replace, and session auto-registration.

**Architecture:** Event-First pipeline enhancement. Three new EventBus subscribers (ErrorBubbler, ProgressTracker, UsecaseMutationHandler) + five CLI hook subcommands (session-start, pre-tool, post-tool, stop, rebind). State machine extended with `paused`/`superseded` states. SpanManager gains `rebindEvents` for session migration.

**Tech Stack:** TypeScript, Node.js, Vitest, Commander.js, Unix IPC socket

**Spec:** `docs/superpowers/specs/2026-03-30-real-project-integration-design.md`

---

## Task 1: Extend Types — EntityState + TwEventType

**Files:**
- Modify: `packages/tw-types/src/index.ts:7-10` (EntityState)
- Modify: `packages/tw-types/src/index.ts:118-132` (TwEventType)

- [ ] **Step 1: Add `paused` and `superseded` to EntityState**

In `packages/tw-types/src/index.ts`, replace:

```typescript
export type EntityState =
  | 'pending'
  | 'in_progress'
  | 'review'
  | 'completed'
  | 'rejected'
```

With:

```typescript
export type EntityState =
  | 'pending'
  | 'in_progress'
  | 'review'
  | 'completed'
  | 'rejected'
  | 'paused'
  | 'superseded'
```

- [ ] **Step 2: Add new TwEventType values**

In `packages/tw-types/src/index.ts`, replace:

```typescript
export type TwEventType =
  | 'entity.registered'
  | 'entity.updated'
  | 'entity.state_changed'
  | 'entity.removed'
  | 'artifact.created'
  | 'artifact.modified'
  | 'artifact.linked'
  | 'hook.received'
  | 'webhook.inbound'
  | 'git.commit'
  | 'file.changed'
  | 'entity.upstream_changed'
  | 'report.generated'
```

With:

```typescript
export type TwEventType =
  | 'entity.registered'
  | 'entity.updated'
  | 'entity.state_changed'
  | 'entity.removed'
  | 'entity.paused'
  | 'entity.superseded'
  | 'artifact.created'
  | 'artifact.modified'
  | 'artifact.linked'
  | 'hook.received'
  | 'webhook.inbound'
  | 'git.commit'
  | 'file.changed'
  | 'entity.upstream_changed'
  | 'report.generated'
  | 'error.captured'
  | 'usecase.mutated'
  | 'tool.invoked'
  | 'tool.completed'
  | 'session.started'
  | 'session.ended'
  | 'session.rebound'
```

- [ ] **Step 3: Add UsecaseMutateParams and UsecaseReplaceParams**

Append after `RemoveEntityParams` in `packages/tw-types/src/index.ts`:

```typescript
export interface UsecaseMutateParams {
  id: string
  mutation_type: 'insert' | 'update'
  context?: string
  entities?: RegisterParams[]
}

export interface UsecaseReplaceParams {
  id: string
  supersede: string[]
  new_entities?: RegisterParams[]
}

export interface SessionRebindParams {
  old_entity_id: string
  new_entity_id: string
}
```

- [ ] **Step 4: Build types to verify**

Run: `npm run build --workspace=packages/tw-types`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add packages/tw-types/src/index.ts
git commit -m "feat(types): add paused/superseded states, new event types, mutation params"
```

---

## Task 2: Extend State Machine

**Files:**
- Modify: `packages/tw-daemon/src/core/engine/state-machine.ts`
- Modify: `packages/tw-daemon/src/core/engine/state-machine.test.ts`

- [ ] **Step 1: Write failing tests for new transitions**

Add to `packages/tw-daemon/src/core/engine/state-machine.test.ts`:

```typescript
describe('paused state transitions', () => {
  it('allows in_progress → paused', () => {
    expect(canTransition('in_progress', 'paused')).toBe(true)
  })

  it('allows review → paused', () => {
    expect(canTransition('review', 'paused')).toBe(true)
  })

  it('allows paused → in_progress (resume)', () => {
    expect(canTransition('paused', 'in_progress')).toBe(true)
  })

  it('allows paused → superseded (replace)', () => {
    expect(canTransition('paused', 'superseded')).toBe(true)
  })

  it('allows paused → rejected', () => {
    expect(canTransition('paused', 'rejected')).toBe(true)
  })

  it('rejects paused → completed', () => {
    expect(canTransition('paused', 'completed')).toBe(false)
  })
})

describe('superseded state transitions', () => {
  it('allows pending → superseded', () => {
    expect(canTransition('pending', 'superseded')).toBe(true)
  })

  it('rejects superseded → any (terminal)', () => {
    expect(canTransition('superseded', 'pending')).toBe(false)
    expect(canTransition('superseded', 'in_progress')).toBe(false)
    expect(canTransition('superseded', 'paused')).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace=packages/tw-daemon -- --grep "paused state|superseded state"`
Expected: FAIL — new states not in ALLOWED_TRANSITIONS

- [ ] **Step 3: Update ALLOWED_TRANSITIONS**

In `packages/tw-daemon/src/core/engine/state-machine.ts`, replace:

```typescript
export const ALLOWED_TRANSITIONS: Readonly<Record<EntityState, readonly EntityState[]>> = {
  pending:     ['in_progress'],
  in_progress: ['review', 'rejected'],
  review:      ['completed', 'rejected'],
  completed:   ['rejected'],
  rejected:    ['in_progress'],
}
```

With:

```typescript
export const ALLOWED_TRANSITIONS: Readonly<Record<EntityState, readonly EntityState[]>> = {
  pending:     ['in_progress', 'superseded'],
  in_progress: ['review', 'rejected', 'paused'],
  review:      ['completed', 'rejected', 'paused'],
  completed:   ['rejected'],
  rejected:    ['in_progress'],
  paused:      ['in_progress', 'superseded', 'rejected'],
  superseded:  [],
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=packages/tw-daemon -- --grep "paused state|superseded state"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/tw-daemon/src/core/engine/state-machine.ts packages/tw-daemon/src/core/engine/state-machine.test.ts
git commit -m "feat(daemon): extend state machine with paused/superseded transitions"
```

---

## Task 3: Extend SpanManager — superseded mapping + rebindEvents

**Files:**
- Modify: `packages/tw-daemon/src/otel/span-manager.ts`
- Modify: `packages/tw-daemon/src/otel/span-manager.test.ts`

- [ ] **Step 1: Write failing test for superseded → UNSET mapping**

Add to `packages/tw-daemon/src/otel/span-manager.test.ts`:

```typescript
it('maps superseded state to UNSET status', () => {
  expect(SpanManager.stateToStatus('superseded')).toBe('UNSET')
})

it('maps paused state to UNSET status', () => {
  expect(SpanManager.stateToStatus('paused')).toBe('UNSET')
})
```

- [ ] **Step 2: Write failing test for rebindEvents**

Add to `packages/tw-daemon/src/otel/span-manager.test.ts`:

```typescript
describe('rebindEvents', () => {
  it('migrates events from old span to new span', () => {
    const sm = new SpanManager()
    sm.createSpan({ entity_id: 'old-1', entity_type: 'task' })
    sm.addEvent('old-1', 'tool.invoked', { tool: 'Bash' })
    sm.addEvent('old-1', 'error.captured', { source: 'build' })

    sm.createSpan({ entity_id: 'new-1', entity_type: 'task' })
    const result = sm.rebindEvents('old-1', 'new-1')

    expect(result).toBe(true)
    const newSpan = sm.getSpan('new-1')!
    expect(newSpan.events).toHaveLength(2)
    expect(newSpan.events[0].name).toBe('tool.invoked')
    expect(newSpan.events[1].name).toBe('error.captured')

    const oldSpan = sm.getSpan('old-1')!
    expect(oldSpan.events).toHaveLength(0)
  })

  it('returns false if old span does not exist', () => {
    const sm = new SpanManager()
    sm.createSpan({ entity_id: 'new-1', entity_type: 'task' })
    expect(sm.rebindEvents('nonexistent', 'new-1')).toBe(false)
  })

  it('returns false if new span does not exist', () => {
    const sm = new SpanManager()
    sm.createSpan({ entity_id: 'old-1', entity_type: 'task' })
    expect(sm.rebindEvents('old-1', 'nonexistent')).toBe(false)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test --workspace=packages/tw-daemon -- --grep "superseded state|paused state|rebindEvents"`
Expected: FAIL

- [ ] **Step 4: Implement stateToStatus update and rebindEvents**

In `packages/tw-daemon/src/otel/span-manager.ts`, replace `stateToStatus`:

```typescript
static stateToStatus(state: Entity['state']): SpanMeta['status'] {
  if (state === 'completed') return 'OK'
  if (state === 'rejected') return 'ERROR'
  return 'UNSET'
}
```

This already handles `paused` and `superseded` → `UNSET` since they fall through to the default. No change needed here (existing tests confirm).

Add `rebindEvents` method before `stateToStatus`:

```typescript
rebindEvents(oldEntityId: string, newEntityId: string): boolean {
  const oldSpan = this.spans.get(oldEntityId)
  const newSpan = this.spans.get(newEntityId)
  if (!oldSpan || !newSpan) return false
  newSpan.events.push(...oldSpan.events)
  oldSpan.events.length = 0
  return true
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test --workspace=packages/tw-daemon -- --grep "superseded state|paused state|rebindEvents"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/tw-daemon/src/otel/span-manager.ts packages/tw-daemon/src/otel/span-manager.test.ts
git commit -m "feat(otel): add rebindEvents to SpanManager for session migration"
```

---

## Task 4: ErrorBubbler Subscriber

**Files:**
- Create: `packages/tw-daemon/src/subscribers/error-bubbler.ts`
- Create: `packages/tw-daemon/src/subscribers/error-bubbler.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/tw-daemon/src/subscribers/error-bubbler.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ErrorBubbler } from './error-bubbler.js'
import type { TwEvent, Entity } from '@traceweaver/types'

describe('ErrorBubbler', () => {
  const mockSpanManager = {
    addEvent: vi.fn(),
  }

  const entities: Record<string, Entity> = {
    'task-1': { id: 'task-1', entity_type: 'task', state: 'in_progress', parent_id: 'plan-1', created_at: '', updated_at: '' },
    'plan-1': { id: 'plan-1', entity_type: 'plan', state: 'in_progress', parent_id: 'uc-1', created_at: '', updated_at: '' },
    'uc-1':   { id: 'uc-1', entity_type: 'usecase', state: 'in_progress', created_at: '', updated_at: '' },
  }

  const mockGetEntity = (id: string) => entities[id]
  const mockUpdateAttributes = vi.fn()

  let bubbler: ErrorBubbler

  beforeEach(() => {
    vi.clearAllMocks()
    bubbler = new ErrorBubbler({
      spanManager: mockSpanManager as any,
      getEntity: mockGetEntity,
      updateAttributes: mockUpdateAttributes,
    })
  })

  it('bubbles error.captured to parent chain', () => {
    const event: TwEvent = {
      id: 'evt-1',
      type: 'error.captured',
      entity_id: 'task-1',
      ts: '2026-03-30T00:00:00Z',
      attributes: { source: 'build', message: 'tsc error TS2345' },
    }

    bubbler.handle(event)

    expect(mockSpanManager.addEvent).toHaveBeenCalledTimes(2)
    expect(mockSpanManager.addEvent).toHaveBeenCalledWith('plan-1', 'child_error', expect.objectContaining({
      origin_entity_id: 'task-1',
      source: 'build',
    }))
    expect(mockSpanManager.addEvent).toHaveBeenCalledWith('uc-1', 'child_error', expect.objectContaining({
      origin_entity_id: 'task-1',
      source: 'build',
    }))
  })

  it('updates parent attributes with errors array', () => {
    const event: TwEvent = {
      id: 'evt-1',
      type: 'error.captured',
      entity_id: 'task-1',
      ts: '2026-03-30T00:00:00Z',
      attributes: { source: 'build', message: 'tsc error TS2345' },
    }

    bubbler.handle(event)

    expect(mockUpdateAttributes).toHaveBeenCalledTimes(2)
    expect(mockUpdateAttributes).toHaveBeenCalledWith('plan-1', expect.objectContaining({
      errors: expect.arrayContaining([expect.objectContaining({ origin_entity_id: 'task-1' })]),
    }))
  })

  it('ignores non-error.captured events', () => {
    const event: TwEvent = {
      id: 'evt-1',
      type: 'entity.state_changed',
      entity_id: 'task-1',
      ts: '2026-03-30T00:00:00Z',
    }

    bubbler.handle(event)

    expect(mockSpanManager.addEvent).not.toHaveBeenCalled()
  })

  it('stops at root entity (no parent_id)', () => {
    const event: TwEvent = {
      id: 'evt-1',
      type: 'error.captured',
      entity_id: 'uc-1',
      ts: '2026-03-30T00:00:00Z',
      attributes: { source: 'tool', message: 'Edit failed' },
    }

    bubbler.handle(event)

    expect(mockSpanManager.addEvent).not.toHaveBeenCalled()
  })

  it('truncates message to 500 characters', () => {
    const event: TwEvent = {
      id: 'evt-1',
      type: 'error.captured',
      entity_id: 'task-1',
      ts: '2026-03-30T00:00:00Z',
      attributes: { source: 'build', message: 'x'.repeat(1000) },
    }

    bubbler.handle(event)

    const callArgs = mockSpanManager.addEvent.mock.calls[0][2]
    expect(callArgs.message.length).toBeLessThanOrEqual(500)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=packages/tw-daemon -- --grep "ErrorBubbler"`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ErrorBubbler**

Create `packages/tw-daemon/src/subscribers/error-bubbler.ts`:

```typescript
import type { TwEvent, Entity, EntityType } from '@traceweaver/types'
import type { SpanManager } from '../otel/span-manager.js'

export interface ErrorBubblerDeps {
  spanManager: SpanManager
  getEntity: (id: string) => Entity | undefined
  updateAttributes: (id: string, attrs: Record<string, unknown>) => void
}

interface BubbledError {
  origin_entity_id: string
  origin_entity_type: EntityType
  source: string
  message: string
  ts: string
}

const MAX_MESSAGE_LENGTH = 500

export class ErrorBubbler {
  constructor(private readonly deps: ErrorBubblerDeps) {}

  handle(event: TwEvent): void {
    if (event.type !== 'error.captured') return
    if (!event.entity_id) return

    const entity = this.deps.getEntity(event.entity_id)
    if (!entity?.parent_id) return

    const rawMessage = String(event.attributes?.message ?? '')
    const bubbledError: BubbledError = {
      origin_entity_id: event.entity_id,
      origin_entity_type: entity.entity_type,
      source: String(event.attributes?.source ?? 'unknown'),
      message: rawMessage.slice(0, MAX_MESSAGE_LENGTH),
      ts: event.ts,
    }

    let currentId: string | undefined = entity.parent_id
    while (currentId) {
      const parent = this.deps.getEntity(currentId)
      if (!parent) break

      this.deps.spanManager.addEvent(currentId, 'child_error', { ...bubbledError })

      const existing = (parent.attributes?.errors as BubbledError[] | undefined) ?? []
      this.deps.updateAttributes(currentId, {
        errors: [...existing, bubbledError],
      })

      currentId = parent.parent_id
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace=packages/tw-daemon -- --grep "ErrorBubbler"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/tw-daemon/src/subscribers/error-bubbler.ts packages/tw-daemon/src/subscribers/error-bubbler.test.ts
git commit -m "feat(daemon): add ErrorBubbler subscriber — error events bubble to parent span chain"
```

---

## Task 5: ProgressTracker Subscriber

**Files:**
- Create: `packages/tw-daemon/src/subscribers/progress-tracker.ts`
- Create: `packages/tw-daemon/src/subscribers/progress-tracker.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/tw-daemon/src/subscribers/progress-tracker.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProgressTracker } from './progress-tracker.js'
import type { TwEvent, Entity } from '@traceweaver/types'

describe('ProgressTracker', () => {
  const makeEntity = (id: string, type: string, state: string, parent?: string): Entity => ({
    id, entity_type: type as any, state: state as any, parent_id: parent, created_at: '', updated_at: '',
  })

  let entities: Record<string, Entity>
  const mockUpdateAttributes = vi.fn()

  let tracker: ProgressTracker

  beforeEach(() => {
    vi.clearAllMocks()
    entities = {
      'uc-1':   makeEntity('uc-1', 'usecase', 'in_progress'),
      'plan-1': makeEntity('plan-1', 'plan', 'in_progress', 'uc-1'),
      'task-1': makeEntity('task-1', 'task', 'completed', 'plan-1'),
      'task-2': makeEntity('task-2', 'task', 'in_progress', 'plan-1'),
      'task-3': makeEntity('task-3', 'task', 'pending', 'plan-1'),
    }
    tracker = new ProgressTracker({
      getEntity: (id: string) => entities[id],
      getChildrenOf: (id: string) => Object.values(entities).filter(e => e.parent_id === id),
      updateAttributes: mockUpdateAttributes,
    })
  })

  it('computes progress on state_changed', () => {
    const event: TwEvent = {
      id: 'evt-1', type: 'entity.state_changed', entity_id: 'task-1', ts: '',
    }

    tracker.handle(event)

    expect(mockUpdateAttributes).toHaveBeenCalledWith('plan-1', {
      progress: {
        done: 1, total: 3, percent: 33,
        in_progress: 1, paused: 0, rejected: 0,
        blocked_by: [],
      },
    })
  })

  it('recursively updates UseCase progress from Plan', () => {
    const event: TwEvent = {
      id: 'evt-1', type: 'entity.state_changed', entity_id: 'task-1', ts: '',
    }

    tracker.handle(event)

    // plan-1 is the only child of uc-1, and plan-1 is in_progress
    expect(mockUpdateAttributes).toHaveBeenCalledWith('uc-1', {
      progress: {
        done: 0, total: 1, percent: 0,
        in_progress: 1, paused: 0, rejected: 0,
        blocked_by: [],
      },
    })
  })

  it('updates on entity.registered', () => {
    const event: TwEvent = {
      id: 'evt-1', type: 'entity.registered', entity_id: 'task-3', ts: '',
      entity_type: 'task',
    }

    tracker.handle(event)

    expect(mockUpdateAttributes).toHaveBeenCalledWith('plan-1', expect.objectContaining({
      progress: expect.objectContaining({ total: 3 }),
    }))
  })

  it('updates on entity.removed', () => {
    const event: TwEvent = {
      id: 'evt-1', type: 'entity.removed', entity_id: 'task-3', ts: '',
    }
    // Simulate removal
    delete entities['task-3']

    tracker.handle(event)

    // After removal task-3 is gone, parent is plan-1
    // But entity is already removed, so we need parent_id from event attributes
    // Actually the entity is gone, so we can't find parent. The handle should
    // use a stored parent_id or the event should carry it.
    // Let's adjust: entity.removed events should carry entity_id of the removed entity's parent
  })

  it('ignores entities without parent_id', () => {
    const event: TwEvent = {
      id: 'evt-1', type: 'entity.state_changed', entity_id: 'uc-1', ts: '',
    }

    tracker.handle(event)

    // uc-1 has no parent, no update needed beyond itself
    expect(mockUpdateAttributes).not.toHaveBeenCalled()
  })

  it('counts paused entities in progress', () => {
    entities['task-2'] = makeEntity('task-2', 'task', 'paused', 'plan-1')

    const event: TwEvent = {
      id: 'evt-1', type: 'entity.state_changed', entity_id: 'task-2', ts: '',
    }

    tracker.handle(event)

    expect(mockUpdateAttributes).toHaveBeenCalledWith('plan-1', {
      progress: expect.objectContaining({ paused: 1 }),
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=packages/tw-daemon -- --grep "ProgressTracker"`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ProgressTracker**

Create `packages/tw-daemon/src/subscribers/progress-tracker.ts`:

```typescript
import type { TwEvent, Entity } from '@traceweaver/types'

export interface ProgressTrackerDeps {
  getEntity: (id: string) => Entity | undefined
  getChildrenOf: (parentId: string) => Entity[]
  updateAttributes: (id: string, attrs: Record<string, unknown>) => void
}

interface Progress {
  done: number
  total: number
  percent: number
  in_progress: number
  paused: number
  rejected: number
  blocked_by: string[]
}

const TRIGGER_EVENTS = new Set([
  'entity.state_changed',
  'entity.registered',
  'entity.removed',
])

export class ProgressTracker {
  // Cache parent_id before entity removal
  private readonly parentCache = new Map<string, string>()

  constructor(private readonly deps: ProgressTrackerDeps) {}

  /** Call on every entity.registered to cache parent_id for later removal tracking. */
  cacheParent(entityId: string, parentId: string): void {
    this.parentCache.set(entityId, parentId)
  }

  handle(event: TwEvent): void {
    if (!TRIGGER_EVENTS.has(event.type)) return
    if (!event.entity_id) return

    let parentId: string | undefined

    if (event.type === 'entity.removed') {
      // Entity already removed from registry, use cached parent
      parentId = this.parentCache.get(event.entity_id)
      this.parentCache.delete(event.entity_id)
    } else {
      const entity = this.deps.getEntity(event.entity_id)
      if (!entity?.parent_id) return
      parentId = entity.parent_id
      this.parentCache.set(event.entity_id, parentId)
    }

    if (!parentId) return
    this.updateProgress(parentId)
  }

  private updateProgress(parentId: string): void {
    const parent = this.deps.getEntity(parentId)
    if (!parent) return

    const children = this.deps.getChildrenOf(parentId)
    if (children.length === 0) return

    const progress: Progress = {
      done: 0,
      total: children.length,
      percent: 0,
      in_progress: 0,
      paused: 0,
      rejected: 0,
      blocked_by: [],
    }

    for (const child of children) {
      if (child.state === 'completed') progress.done++
      else if (child.state === 'in_progress') progress.in_progress++
      else if (child.state === 'paused') progress.paused++
      else if (child.state === 'rejected') progress.rejected++

      if (child.depends_on?.length) {
        const unmet = child.depends_on.filter(depId => {
          const dep = this.deps.getEntity(depId)
          return dep && dep.state !== 'completed'
        })
        if (unmet.length > 0) progress.blocked_by.push(child.id)
      }
    }

    progress.percent = progress.total > 0
      ? Math.round(progress.done / progress.total * 100)
      : 0

    this.deps.updateAttributes(parentId, { progress })

    // Recursively update grandparent
    if (parent.parent_id) {
      this.updateProgress(parent.parent_id)
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace=packages/tw-daemon -- --grep "ProgressTracker"`
Expected: PASS (fix the entity.removed test — it should verify no crash when entity is already gone, and use parentCache)

- [ ] **Step 5: Commit**

```bash
git add packages/tw-daemon/src/subscribers/progress-tracker.ts packages/tw-daemon/src/subscribers/progress-tracker.test.ts
git commit -m "feat(daemon): add ProgressTracker subscriber — real-time parent progress updates"
```

---

## Task 6: UsecaseMutationHandler Subscriber

**Files:**
- Create: `packages/tw-daemon/src/subscribers/usecase-mutation-handler.ts`
- Create: `packages/tw-daemon/src/subscribers/usecase-mutation-handler.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/tw-daemon/src/subscribers/usecase-mutation-handler.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { UsecaseMutationHandler } from './usecase-mutation-handler.js'
import type { TwEvent, Entity } from '@traceweaver/types'

describe('UsecaseMutationHandler', () => {
  const makeEntity = (id: string, type: string, state: string, parent?: string): Entity => ({
    id, entity_type: type as any, state: state as any, parent_id: parent, created_at: '', updated_at: '',
  })

  let entities: Record<string, Entity>
  const mockUpdateState = vi.fn()
  const mockAddEvent = vi.fn()

  let handler: UsecaseMutationHandler

  beforeEach(() => {
    vi.clearAllMocks()
    entities = {
      'uc-1':   makeEntity('uc-1', 'usecase', 'in_progress'),
      'plan-1': makeEntity('plan-1', 'plan', 'in_progress', 'uc-1'),
      'task-1': makeEntity('task-1', 'task', 'in_progress', 'plan-1'),
      'task-2': makeEntity('task-2', 'task', 'review', 'plan-1'),
      'task-3': makeEntity('task-3', 'task', 'pending', 'plan-1'),
      'task-4': makeEntity('task-4', 'task', 'completed', 'plan-1'),
    }
    handler = new UsecaseMutationHandler({
      getEntity: (id: string) => entities[id],
      getDescendants: (id: string) => {
        const result: Entity[] = []
        const children = Object.values(entities).filter(e => e.parent_id === id)
        for (const child of children) {
          result.push(child)
          result.push(...Object.values(entities).filter(e => e.parent_id === child.id))
        }
        return result
      },
      updateState: mockUpdateState,
      spanAddEvent: mockAddEvent,
    })
  })

  it('pauses in_progress and review entities on usecase.mutated', () => {
    const event: TwEvent = {
      id: 'evt-1', type: 'usecase.mutated', entity_id: 'uc-1', ts: '',
      attributes: { mutation_type: 'update' },
    }

    const result = handler.handle(event)

    // task-1 (in_progress) → paused
    expect(mockUpdateState).toHaveBeenCalledWith('task-1', 'paused', 'upstream_updated')
    // task-2 (review) → paused
    expect(mockUpdateState).toHaveBeenCalledWith('task-2', 'paused', 'upstream_updated')
    // plan-1 (in_progress) → paused
    expect(mockUpdateState).toHaveBeenCalledWith('plan-1', 'paused', 'upstream_updated')
    // task-3 (pending) → NOT paused
    expect(mockUpdateState).not.toHaveBeenCalledWith('task-3', 'paused', expect.anything())
    // task-4 (completed) → NOT paused
    expect(mockUpdateState).not.toHaveBeenCalledWith('task-4', 'paused', expect.anything())
  })

  it('adds drain.paused span events', () => {
    const event: TwEvent = {
      id: 'evt-1', type: 'usecase.mutated', entity_id: 'uc-1', ts: '',
      attributes: { mutation_type: 'update' },
    }

    handler.handle(event)

    expect(mockAddEvent).toHaveBeenCalledWith('task-1', 'drain.paused', expect.objectContaining({
      reason: 'upstream_updated',
    }))
  })

  it('returns count of paused entities', () => {
    const event: TwEvent = {
      id: 'evt-1', type: 'usecase.mutated', entity_id: 'uc-1', ts: '',
      attributes: { mutation_type: 'update' },
    }

    const result = handler.handle(event)

    expect(result).toEqual({ paused_count: 3 })  // task-1, task-2, plan-1
  })

  it('ignores insert mutation type', () => {
    const event: TwEvent = {
      id: 'evt-1', type: 'usecase.mutated', entity_id: 'uc-1', ts: '',
      attributes: { mutation_type: 'insert' },
    }

    handler.handle(event)

    expect(mockUpdateState).not.toHaveBeenCalled()
  })

  it('ignores non-usecase.mutated events', () => {
    const event: TwEvent = {
      id: 'evt-1', type: 'entity.state_changed', entity_id: 'uc-1', ts: '',
    }

    handler.handle(event)

    expect(mockUpdateState).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=packages/tw-daemon -- --grep "UsecaseMutationHandler"`
Expected: FAIL — module not found

- [ ] **Step 3: Implement UsecaseMutationHandler**

Create `packages/tw-daemon/src/subscribers/usecase-mutation-handler.ts`:

```typescript
import type { TwEvent, Entity } from '@traceweaver/types'
import type { SpanManager } from '../otel/span-manager.js'

export interface UsecaseMutationHandlerDeps {
  getEntity: (id: string) => Entity | undefined
  getDescendants: (id: string) => Entity[]
  updateState: (id: string, state: string, reason: string) => void
  spanAddEvent: (entityId: string, name: string, attrs: Record<string, unknown>) => void
}

const PAUSABLE_STATES = new Set(['in_progress', 'review'])

export class UsecaseMutationHandler {
  constructor(private readonly deps: UsecaseMutationHandlerDeps) {}

  handle(event: TwEvent): { paused_count: number } | undefined {
    if (event.type !== 'usecase.mutated') return undefined
    if (!event.entity_id) return undefined
    if (event.attributes?.mutation_type !== 'update') return undefined

    const descendants = this.deps.getDescendants(event.entity_id)
    let pausedCount = 0

    for (const entity of descendants) {
      if (!PAUSABLE_STATES.has(entity.state)) continue

      this.deps.updateState(entity.id, 'paused', 'upstream_updated')
      this.deps.spanAddEvent(entity.id, 'drain.paused', {
        reason: 'upstream_updated',
        source_usecase: event.entity_id,
        was_reviewing: entity.state === 'review',
      })
      pausedCount++
    }

    return { paused_count: pausedCount }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace=packages/tw-daemon -- --grep "UsecaseMutationHandler"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/tw-daemon/src/subscribers/usecase-mutation-handler.ts packages/tw-daemon/src/subscribers/usecase-mutation-handler.test.ts
git commit -m "feat(daemon): add UsecaseMutationHandler — drain in_progress/review entities on UseCase update"
```

---

## Task 7: CommandHandler — usecaseMutate + usecaseReplace + sessionRebind

**Files:**
- Modify: `packages/tw-daemon/src/core/command-handler.ts`
- Modify: `packages/tw-daemon/src/core/command-handler.test.ts`

- [ ] **Step 1: Write failing tests for usecaseMutate (insert)**

Add to `packages/tw-daemon/src/core/command-handler.test.ts`:

```typescript
describe('usecaseMutate', () => {
  it('insert: registers multiple entities under usecase', async () => {
    const handler = new CommandHandler({ storeDir: tmpDir, eventBus, spanManager })
    await handler.init()
    await handler.register({ entity_type: 'usecase', id: 'uc-1' })

    const result = await handler.usecaseMutate({
      id: 'uc-1',
      mutation_type: 'insert',
      entities: [
        { entity_type: 'plan', id: 'plan-new', parent_id: 'uc-1' },
        { entity_type: 'task', id: 'task-new', parent_id: 'plan-new' },
      ],
    })

    expect(result.ok).toBe(true)
    expect(result.data?.registered_count).toBe(2)
    expect(handler.getEntityById('plan-new')).toBeDefined()
    expect(handler.getEntityById('task-new')).toBeDefined()
  })

  it('update: emits usecase.mutated event and stores mutation_context', async () => {
    const handler = new CommandHandler({ storeDir: tmpDir, eventBus, spanManager })
    await handler.init()
    await handler.register({ entity_type: 'usecase', id: 'uc-1' })

    const events: any[] = []
    eventBus.subscribe(e => events.push(e))

    const result = await handler.usecaseMutate({
      id: 'uc-1',
      mutation_type: 'update',
      context: '新增登录功能',
    })

    expect(result.ok).toBe(true)
    const entity = handler.getEntityById('uc-1')!
    expect(entity.attributes?.mutation_context).toBe('新增登录功能')
    expect(events.some(e => e.type === 'usecase.mutated')).toBe(true)
  })

  it('fails for non-existent usecase', async () => {
    const handler = new CommandHandler({ storeDir: tmpDir, eventBus, spanManager })
    await handler.init()

    const result = await handler.usecaseMutate({
      id: 'nonexistent',
      mutation_type: 'update',
    })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('ENTITY_NOT_FOUND')
  })
})
```

- [ ] **Step 2: Write failing tests for usecaseReplace**

```typescript
describe('usecaseReplace', () => {
  it('supersedes listed entities and registers new ones', async () => {
    const handler = new CommandHandler({ storeDir: tmpDir, eventBus, spanManager })
    await handler.init()
    await handler.register({ entity_type: 'usecase', id: 'uc-1' })
    await handler.register({ entity_type: 'plan', id: 'plan-1', parent_id: 'uc-1' })
    await handler.register({ entity_type: 'task', id: 'task-1', parent_id: 'plan-1' })
    await handler.updateState({ id: 'task-1', state: 'in_progress' })
    await handler.updateState({ id: 'task-1', state: 'paused' })

    const result = await handler.usecaseReplace({
      id: 'uc-1',
      supersede: ['task-1'],
      new_entities: [
        { entity_type: 'task', id: 'task-2', parent_id: 'plan-1' },
      ],
    })

    expect(result.ok).toBe(true)
    expect(handler.getEntityById('task-1')!.state).toBe('superseded')
    expect(handler.getEntityById('task-2')).toBeDefined()
  })
})
```

- [ ] **Step 3: Write failing test for sessionRebind**

```typescript
describe('sessionRebind', () => {
  it('migrates events from old entity to new entity and supersedes old', async () => {
    const handler = new CommandHandler({ storeDir: tmpDir, eventBus, spanManager })
    await handler.init()
    await handler.register({ entity_type: 'task', id: 'session-abc' })
    await handler.register({ entity_type: 'task', id: 'task-real', parent_id: 'plan-1' })

    // Add some events to session entity
    spanManager.addEvent('session-abc', 'tool.invoked', { tool: 'Bash' })

    const result = await handler.sessionRebind({
      old_entity_id: 'session-abc',
      new_entity_id: 'task-real',
    })

    expect(result.ok).toBe(true)
    expect(handler.getEntityById('session-abc')!.state).toBe('superseded')
    const newSpan = spanManager.getSpan('task-real')!
    expect(newSpan.events.some(e => e.name === 'tool.invoked')).toBe(true)
  })
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm test --workspace=packages/tw-daemon -- --grep "usecaseMutate|usecaseReplace|sessionRebind"`
Expected: FAIL — methods don't exist

- [ ] **Step 5: Implement usecaseMutate**

Add to `packages/tw-daemon/src/core/command-handler.ts` after `cascadeUpdate`:

```typescript
async usecaseMutate(params: {
  id: string
  mutation_type: 'insert' | 'update'
  context?: string
  entities?: RegisterParams[]
}): Promise<{ ok: boolean; data?: { registered_count?: number }; error?: { code: string; message: string } }> {
  const entity = this.registry.get(params.id)
  if (!entity) {
    return { ok: false, error: { code: 'ENTITY_NOT_FOUND', message: `Entity ${params.id} not found` } }
  }

  if (params.mutation_type === 'insert' && params.entities?.length) {
    let count = 0
    for (const e of params.entities) {
      await this.register(e)
      count++
    }
    return { ok: true, data: { registered_count: count } }
  }

  if (params.mutation_type === 'update') {
    await this.updateAttributes({
      id: params.id,
      attributes: {
        mutation_context: params.context,
        mutation_ts: new Date().toISOString(),
        mutation_type: 'update',
      },
    })

    this.emit({
      id: randomUUID(),
      type: 'usecase.mutated',
      entity_id: params.id,
      entity_type: entity.entity_type,
      ts: new Date().toISOString(),
      attributes: { mutation_type: 'update', context: params.context },
    })

    return { ok: true, data: {} }
  }

  return { ok: true, data: {} }
}
```

- [ ] **Step 6: Implement usecaseReplace**

Add to `packages/tw-daemon/src/core/command-handler.ts`:

```typescript
async usecaseReplace(params: {
  id: string
  supersede: string[]
  new_entities?: RegisterParams[]
}): Promise<{ ok: boolean; data?: { superseded_count: number; registered_count: number }; error?: { code: string; message: string } }> {
  const entity = this.registry.get(params.id)
  if (!entity) {
    return { ok: false, error: { code: 'ENTITY_NOT_FOUND', message: `Entity ${params.id} not found` } }
  }

  let supersededCount = 0
  for (const targetId of params.supersede) {
    const target = this.registry.get(targetId)
    if (!target) continue
    await this.updateState({ id: targetId, state: 'superseded', reason: 'replaced_by_new_chain' })
    supersededCount++
  }

  let registeredCount = 0
  if (params.new_entities?.length) {
    for (const e of params.new_entities) {
      await this.register(e)
      registeredCount++
    }
  }

  return { ok: true, data: { superseded_count: supersededCount, registered_count: registeredCount } }
}
```

- [ ] **Step 7: Implement sessionRebind**

Add to `packages/tw-daemon/src/core/command-handler.ts`:

```typescript
async sessionRebind(params: {
  old_entity_id: string
  new_entity_id: string
}): Promise<{ ok: boolean; error?: { code: string; message: string } }> {
  const oldEntity = this.registry.get(params.old_entity_id)
  const newEntity = this.registry.get(params.new_entity_id)
  if (!oldEntity) return { ok: false, error: { code: 'ENTITY_NOT_FOUND', message: `Old entity ${params.old_entity_id} not found` } }
  if (!newEntity) return { ok: false, error: { code: 'ENTITY_NOT_FOUND', message: `New entity ${params.new_entity_id} not found` } }

  this.opts.spanManager?.rebindEvents(params.old_entity_id, params.new_entity_id)

  this.emit({
    id: randomUUID(),
    type: 'session.rebound',
    entity_id: params.new_entity_id,
    ts: new Date().toISOString(),
    attributes: { old_entity_id: params.old_entity_id },
  })

  // Supersede the anonymous session entity
  if (oldEntity.state !== 'completed' && oldEntity.state !== 'rejected' && oldEntity.state !== 'superseded') {
    // pending → superseded is allowed
    if (oldEntity.state === 'pending') {
      await this.updateState({ id: params.old_entity_id, state: 'superseded', reason: 'session_rebound' })
    } else {
      // in_progress → paused → superseded
      await this.updateState({ id: params.old_entity_id, state: 'paused', reason: 'session_rebound' })
      await this.updateState({ id: params.old_entity_id, state: 'superseded', reason: 'session_rebound' })
    }
  }

  return { ok: true }
}
```

- [ ] **Step 8: Add import for UsecaseMutateParams types at top of command-handler.ts**

Add to imports:

```typescript
import type {
  Entity, EntityType, RegisterParams, UpdateStateParams,
  UpdateAttributesParams, GetStatusParams, ArtifactRef, TwEvent, TwEventType,
} from '@traceweaver/types'
```

(No change needed — RegisterParams is already imported.)

- [ ] **Step 9: Run tests to verify they pass**

Run: `npm test --workspace=packages/tw-daemon -- --grep "usecaseMutate|usecaseReplace|sessionRebind"`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add packages/tw-daemon/src/core/command-handler.ts packages/tw-daemon/src/core/command-handler.test.ts
git commit -m "feat(daemon): add usecaseMutate, usecaseReplace, sessionRebind to CommandHandler"
```

---

## Task 8: IPC Server — Wire New Methods

**Files:**
- Modify: `packages/tw-daemon/src/ipc-server.ts:165` (before `else throw`)
- Modify: `packages/tw-daemon/src/ipc-server.test.ts`

- [ ] **Step 1: Write failing test for new IPC methods**

Add to `packages/tw-daemon/src/ipc-server.test.ts`:

```typescript
it('dispatches usecase_mutate method', async () => {
  // Setup: register a usecase first
  await dispatch({ method: 'register', params: { entity_type: 'usecase', id: 'uc-1' } })

  const res = await dispatch({
    method: 'usecase_mutate',
    params: { id: 'uc-1', mutation_type: 'update', context: 'new requirements' },
  })
  expect(res.ok).toBe(true)
})

it('dispatches usecase_replace method', async () => {
  await dispatch({ method: 'register', params: { entity_type: 'usecase', id: 'uc-1' } })
  const res = await dispatch({
    method: 'usecase_replace',
    params: { id: 'uc-1', supersede: [], new_entities: [] },
  })
  expect(res.ok).toBe(true)
})

it('dispatches session_rebind method', async () => {
  await dispatch({ method: 'register', params: { entity_type: 'task', id: 'session-old' } })
  await dispatch({ method: 'register', params: { entity_type: 'task', id: 'task-new' } })
  const res = await dispatch({
    method: 'session_rebind',
    params: { old_entity_id: 'session-old', new_entity_id: 'task-new' },
  })
  expect(res.ok).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=packages/tw-daemon -- --grep "usecase_mutate|usecase_replace|session_rebind"`
Expected: FAIL — UNKNOWN_METHOD

- [ ] **Step 3: Add dispatch branches**

In `packages/tw-daemon/src/ipc-server.ts`, before the `else { throw ... UNKNOWN_METHOD }` block, add:

```typescript
} else if (method === 'usecase_mutate') {
  if (typeof (params as any).id !== 'string') {
    throw Object.assign(new Error('Missing required param: id'), { code: 'INVALID_PARAMS' })
  }
  const result = await this.handler.usecaseMutate(params as any)
  if (!result.ok) throw Object.assign(new Error(result.error!.message), { code: result.error!.code })
  data = result.data
} else if (method === 'usecase_replace') {
  if (typeof (params as any).id !== 'string') {
    throw Object.assign(new Error('Missing required param: id'), { code: 'INVALID_PARAMS' })
  }
  const result = await this.handler.usecaseReplace(params as any)
  if (!result.ok) throw Object.assign(new Error(result.error!.message), { code: result.error!.code })
  data = result.data
} else if (method === 'session_rebind') {
  if (typeof (params as any).old_entity_id !== 'string' || typeof (params as any).new_entity_id !== 'string') {
    throw Object.assign(new Error('Missing required params: old_entity_id, new_entity_id'), { code: 'INVALID_PARAMS' })
  }
  const result = await this.handler.sessionRebind(params as any)
  if (!result.ok) throw Object.assign(new Error(result.error!.message), { code: result.error!.code })
  data = { rebound: true }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace=packages/tw-daemon -- --grep "usecase_mutate|usecase_replace|session_rebind"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/tw-daemon/src/ipc-server.ts packages/tw-daemon/src/ipc-server.test.ts
git commit -m "feat(daemon): wire usecase_mutate, usecase_replace, session_rebind to IPC dispatch"
```

---

## Task 9: Wire Subscribers in Daemon index.ts

**Files:**
- Modify: `packages/tw-daemon/src/index.ts`

- [ ] **Step 1: Import new subscribers**

Add imports at top of `packages/tw-daemon/src/index.ts`:

```typescript
import { ErrorBubbler } from './subscribers/error-bubbler.js'
import { ProgressTracker } from './subscribers/progress-tracker.js'
import { UsecaseMutationHandler } from './subscribers/usecase-mutation-handler.js'
```

- [ ] **Step 2: Initialize subscribers after handler.init()**

After `await handler.init()` (line 60), add:

```typescript
// ── Subscribers ─────────────────────────────────────────────────────────
const errorBubbler = new ErrorBubbler({
  spanManager,
  getEntity: (id: string) => handler.getEntityById(id),
  updateAttributes: (id: string, attrs: Record<string, unknown>) => {
    void handler.updateAttributes({ id, attributes: attrs })
  },
})
eventBus.subscribe(event => errorBubbler.handle(event))

const progressTracker = new ProgressTracker({
  getEntity: (id: string) => handler.getEntityById(id),
  getChildrenOf: (parentId: string) => handler.getAllEntities().filter(e => e.parent_id === parentId),
  updateAttributes: (id: string, attrs: Record<string, unknown>) => {
    void handler.updateAttributes({ id, attributes: attrs })
  },
})
eventBus.subscribe(event => progressTracker.handle(event))

const usecaseMutationHandler = new UsecaseMutationHandler({
  getEntity: (id: string) => handler.getEntityById(id),
  getDescendants: (id: string) => {
    const result: Entity[] = []
    const collect = (parentId: string) => {
      const children = handler.getAllEntities().filter(e => e.parent_id === parentId)
      for (const child of children) {
        result.push(child)
        collect(child.id)
      }
    }
    collect(id)
    return result
  },
  updateState: (id: string, state: string, reason: string) => {
    void handler.updateState({ id, state: state as any, reason })
  },
  spanAddEvent: (entityId: string, name: string, attrs: Record<string, unknown>) => {
    spanManager.addEvent(entityId, name, attrs)
  },
})
eventBus.subscribe(event => usecaseMutationHandler.handle(event))
```

- [ ] **Step 3: Add Entity import**

Add to imports:

```typescript
import type { Entity } from '@traceweaver/types'
```

- [ ] **Step 4: Build to verify**

Run: `npm run build --workspace=packages/tw-daemon`
Expected: 0 errors

- [ ] **Step 5: Run full daemon test suite**

Run: `npm test --workspace=packages/tw-daemon`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add packages/tw-daemon/src/index.ts
git commit -m "feat(daemon): wire ErrorBubbler, ProgressTracker, UsecaseMutationHandler to EventBus"
```

---

## Task 10: CLI Hook Commands — session-start, pre-tool, post-tool, stop, rebind

**Files:**
- Create: `packages/tw-cli/src/commands/hook.ts`

- [ ] **Step 1: Implement hook command group**

Create `packages/tw-cli/src/commands/hook.ts`:

```typescript
import { Command } from 'commander'
import { join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { IpcClient } from '../ipc-client.js'
import { getSocketPath } from '../daemon-manager.js'

const SESSION_FILE = join(process.cwd(), '.traceweaver', '.tw-session')

async function readEntityId(): Promise<string | undefined> {
  if (process.env.TW_ENTITY_ID) return process.env.TW_ENTITY_ID
  try {
    const content = await readFile(SESSION_FILE, 'utf8')
    return content.trim() || undefined
  } catch {
    return undefined
  }
}

async function writeSessionFile(entityId: string): Promise<void> {
  await mkdir(join(process.cwd(), '.traceweaver'), { recursive: true })
  await writeFile(SESSION_FILE, entityId, 'utf8')
}

async function sendSilent(method: string, params: Record<string, unknown>): Promise<boolean> {
  try {
    const client = new IpcClient(getSocketPath(), 2000)
    const res = await client.send({ method, params })
    return res.ok === true
  } catch {
    return false
  }
}

function classifyErrorSource(tool: string, cmd?: string): string {
  if (tool !== 'Bash') return 'tool'
  if (!cmd) return 'command'
  if (/\b(npm run build|tsc|esbuild)\b/.test(cmd)) return 'build'
  if (/\b(npm test|vitest|jest|mocha)\b/.test(cmd)) return 'test'
  if (/\b(node|ts-node|tsx)\b/.test(cmd)) return 'runtime'
  return 'command'
}

export function hookCommand(): Command {
  const cmd = new Command('hook')
  cmd.description('CC Hook integration commands (auto-invoked by Claude Code hooks)')

  cmd.command('session-start')
    .description('Create anonymous session entity (called by SessionStart hook)')
    .action(async () => {
      try {
        const sessionId = `session-${randomUUID().slice(0, 8)}`
        const ok = await sendSilent('register', { entity_type: 'task', id: sessionId })
        if (ok) {
          await writeSessionFile(sessionId)
          await sendSilent('emit_event', {
            entity_id: sessionId,
            event: 'session.started',
            attributes: { anonymous: true },
          })
        }
      } catch {
        // Silent — never block Claude Code
      }
    })

  cmd.command('pre-tool')
    .description('Record tool invocation (called by PreToolUse hook)')
    .requiredOption('--tool <name>', 'Tool name')
    .action(async (opts: { tool: string }) => {
      try {
        const entityId = await readEntityId()
        if (!entityId) return
        await sendSilent('emit_event', {
          entity_id: entityId,
          event: 'tool.invoked',
          attributes: { tool: opts.tool },
        })
      } catch {
        // Silent
      }
    })

  cmd.command('post-tool')
    .description('Record tool result (called by PostToolUse hook)')
    .requiredOption('--tool <name>', 'Tool name')
    .option('--exit-code <code>', 'Exit code', '0')
    .option('--stderr <text>', 'Stderr output')
    .option('--cmd <command>', 'Original command (for Bash source classification)')
    .action(async (opts: { tool: string; exitCode: string; stderr?: string; cmd?: string }) => {
      try {
        const entityId = await readEntityId()
        if (!entityId) return
        const exitCode = parseInt(opts.exitCode, 10)

        if (exitCode === 0) {
          await sendSilent('emit_event', {
            entity_id: entityId,
            event: 'tool.completed',
            attributes: { tool: opts.tool },
          })
        } else {
          const source = classifyErrorSource(opts.tool, opts.cmd)
          const message = (opts.stderr ?? '').slice(0, 500)
          await sendSilent('emit_event', {
            entity_id: entityId,
            event: 'error.captured',
            attributes: { source, tool: opts.tool, exit_code: exitCode, message },
          })
        }
      } catch {
        // Silent
      }
    })

  cmd.command('stop')
    .description('End session (called by Stop hook)')
    .action(async () => {
      try {
        const entityId = await readEntityId()
        if (!entityId) return
        await sendSilent('emit_event', {
          entity_id: entityId,
          event: 'session.ended',
        })
      } catch {
        // Silent
      }
    })

  cmd.command('rebind')
    .description('Rebind session to a formal entity')
    .requiredOption('--entity-id <id>', 'New entity id to bind to')
    .action(async (opts: { entityId: string }) => {
      try {
        const oldEntityId = await readEntityId()
        if (!oldEntityId) {
          console.error('[tw] No active session to rebind')
          return
        }
        const ok = await sendSilent('session_rebind', {
          old_entity_id: oldEntityId,
          new_entity_id: opts.entityId,
        })
        if (ok) {
          await writeSessionFile(opts.entityId)
        }
      } catch {
        // Silent
      }
    })

  return cmd
}
```

- [ ] **Step 2: Register hook command in CLI index**

In `packages/tw-cli/src/index.ts`, add import:

```typescript
import { hookCommand }    from './commands/hook.js'
```

Add registration:

```typescript
program.addCommand(hookCommand())
```

- [ ] **Step 3: Build CLI to verify**

Run: `npm run build --workspace=packages/tw-cli`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add packages/tw-cli/src/commands/hook.ts packages/tw-cli/src/index.ts
git commit -m "feat(cli): add tw hook subcommands — session-start, pre-tool, post-tool, stop, rebind"
```

---

## Task 11: CLI — usecase mutate + usecase replace Commands

**Files:**
- Create: `packages/tw-cli/src/commands/usecase.ts`
- Modify: `packages/tw-cli/src/index.ts`

- [ ] **Step 1: Implement usecase command group**

Create `packages/tw-cli/src/commands/usecase.ts`:

```typescript
import { Command } from 'commander'
import { IpcClient } from '../ipc-client.js'
import { ensureDaemonRunning, getSocketPath } from '../daemon-manager.js'

export function usecaseCommand(): Command {
  const cmd = new Command('usecase')
  cmd.description('UseCase lifecycle management')

  cmd.command('mutate')
    .description('Insert new downstream entities or update UseCase (triggering drain)')
    .requiredOption('--id <id>', 'UseCase id')
    .requiredOption('--type <type>', 'Mutation type: insert | update')
    .option('--context <text>', 'New context/requirements (for update)')
    .option('--entities <json>', 'JSON array of entities to register (for insert)')
    .option('--json', 'JSON output')
    .action(async (opts: any) => {
      try {
        await ensureDaemonRunning()
        const client = new IpcClient(getSocketPath())
        const params: Record<string, unknown> = {
          id: opts.id,
          mutation_type: opts.type,
        }
        if (opts.context) params.context = opts.context
        if (opts.entities) params.entities = JSON.parse(opts.entities)

        const res = await client.send({ method: 'usecase_mutate', params })
        if (res.ok) {
          if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); return }
          console.log(`UseCase ${opts.id} mutation (${opts.type}) applied.`)
          if ((res.data as any)?.registered_count) {
            console.log(`Registered ${(res.data as any).registered_count} new entities.`)
          }
        } else {
          console.error(res.error.message)
          process.exit(1)
        }
      } catch (e: any) {
        console.error(e.message)
        process.exit(1)
      }
    })

  cmd.command('replace')
    .description('Supersede entities and register new ones')
    .requiredOption('--id <id>', 'UseCase id')
    .requiredOption('--supersede <ids...>', 'Entity ids to supersede')
    .option('--new-entities <json>', 'JSON array of new entities to register')
    .option('--json', 'JSON output')
    .action(async (opts: any) => {
      try {
        await ensureDaemonRunning()
        const client = new IpcClient(getSocketPath())
        const params: Record<string, unknown> = {
          id: opts.id,
          supersede: opts.supersede,
        }
        if (opts.newEntities) params.new_entities = JSON.parse(opts.newEntities)

        const res = await client.send({ method: 'usecase_replace', params })
        if (res.ok) {
          if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); return }
          const data = res.data as any
          console.log(`Superseded ${data.superseded_count} entities, registered ${data.registered_count} new entities.`)
        } else {
          console.error(res.error.message)
          process.exit(1)
        }
      } catch (e: any) {
        console.error(e.message)
        process.exit(1)
      }
    })

  return cmd
}
```

- [ ] **Step 2: Register in CLI index**

In `packages/tw-cli/src/index.ts`, add import:

```typescript
import { usecaseCommand }  from './commands/usecase.js'
```

Add registration:

```typescript
program.addCommand(usecaseCommand())
```

- [ ] **Step 3: Build CLI to verify**

Run: `npm run build --workspace=packages/tw-cli`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add packages/tw-cli/src/commands/usecase.ts packages/tw-cli/src/index.ts
git commit -m "feat(cli): add tw usecase mutate/replace commands"
```

---

## Task 12: Integration Test — Full Lifecycle

**Files:**
- Create: `packages/tw-daemon/src/lifecycle-integration.test.ts`

- [ ] **Step 1: Write integration test covering the full lifecycle**

Create `packages/tw-daemon/src/lifecycle-integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CommandHandler } from './core/command-handler.js'
import { EventBus } from './core/event-bus/event-bus.js'
import { SpanManager } from './otel/span-manager.js'
import { EventLog } from './log/event-log.js'
import { ErrorBubbler } from './subscribers/error-bubbler.js'
import { ProgressTracker } from './subscribers/progress-tracker.js'
import { UsecaseMutationHandler } from './subscribers/usecase-mutation-handler.js'
import type { TwEvent, Entity } from '@traceweaver/types'

describe('Lifecycle Integration', () => {
  let tmpDir: string
  let handler: CommandHandler
  let eventBus: EventBus
  let spanManager: SpanManager
  let eventLog: EventLog

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tw-lifecycle-'))
    eventBus = new EventBus()
    eventBus.start()
    spanManager = new SpanManager()
    eventLog = new EventLog(join(tmpDir, 'events.ndjson'))
    eventLog.load()
    handler = new CommandHandler({ storeDir: tmpDir, eventBus, spanManager, eventLog })
    await handler.init()

    // Wire subscribers
    const errorBubbler = new ErrorBubbler({
      spanManager,
      getEntity: (id) => handler.getEntityById(id),
      updateAttributes: (id, attrs) => { void handler.updateAttributes({ id, attributes: attrs }) },
    })
    eventBus.subscribe(event => errorBubbler.handle(event))

    const progressTracker = new ProgressTracker({
      getEntity: (id) => handler.getEntityById(id),
      getChildrenOf: (parentId) => handler.getAllEntities().filter(e => e.parent_id === parentId),
      updateAttributes: (id, attrs) => { void handler.updateAttributes({ id, attributes: attrs }) },
    })
    eventBus.subscribe(event => progressTracker.handle(event))

    const mutationHandler = new UsecaseMutationHandler({
      getEntity: (id) => handler.getEntityById(id),
      getDescendants: (id) => {
        const result: Entity[] = []
        const collect = (pid: string) => {
          const children = handler.getAllEntities().filter(e => e.parent_id === pid)
          for (const child of children) { result.push(child); collect(child.id) }
        }
        collect(id)
        return result
      },
      updateState: (id, state, reason) => { void handler.updateState({ id, state: state as any, reason }) },
      spanAddEvent: (eid, name, attrs) => { spanManager.addEvent(eid, name, attrs) },
    })
    eventBus.subscribe(event => mutationHandler.handle(event))
  })

  afterEach(async () => {
    eventBus.stop()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('scenario: error bubbles from task to usecase', async () => {
    await handler.register({ entity_type: 'usecase', id: 'uc-1' })
    await handler.register({ entity_type: 'plan', id: 'plan-1', parent_id: 'uc-1' })
    await handler.register({ entity_type: 'task', id: 'task-1', parent_id: 'plan-1' })

    await handler.emitEvent({
      entity_id: 'task-1',
      event: 'error.captured',
      attributes: { source: 'build', message: 'tsc error TS2345' },
    })

    // Allow EventBus batch drain
    await new Promise(r => setTimeout(r, 100))

    const ucSpan = spanManager.getSpan('uc-1')
    expect(ucSpan?.events.some(e => e.name === 'child_error')).toBe(true)
  })

  it('scenario: progress updates on task completion', async () => {
    await handler.register({ entity_type: 'usecase', id: 'uc-1' })
    await handler.register({ entity_type: 'plan', id: 'plan-1', parent_id: 'uc-1' })
    await handler.register({ entity_type: 'task', id: 'task-1', parent_id: 'plan-1' })
    await handler.register({ entity_type: 'task', id: 'task-2', parent_id: 'plan-1' })

    await handler.updateState({ id: 'task-1', state: 'in_progress' })
    await handler.updateState({ id: 'task-1', state: 'review' })
    await handler.updateState({ id: 'task-1', state: 'completed' })

    await new Promise(r => setTimeout(r, 100))

    const plan = handler.getEntityById('plan-1')!
    const progress = plan.attributes?.progress as any
    expect(progress.done).toBe(1)
    expect(progress.total).toBe(2)
    expect(progress.percent).toBe(50)
  })

  it('scenario: usecase update drains downstream', async () => {
    await handler.register({ entity_type: 'usecase', id: 'uc-1' })
    await handler.register({ entity_type: 'plan', id: 'plan-1', parent_id: 'uc-1' })
    await handler.register({ entity_type: 'task', id: 'task-1', parent_id: 'plan-1' })
    await handler.updateState({ id: 'task-1', state: 'in_progress' })

    await handler.usecaseMutate({ id: 'uc-1', mutation_type: 'update', context: 'new requirements' })

    await new Promise(r => setTimeout(r, 200))

    const task = handler.getEntityById('task-1')!
    expect(task.state).toBe('paused')
  })

  it('scenario: session rebind migrates events', async () => {
    await handler.register({ entity_type: 'task', id: 'session-anon' })
    spanManager.addEvent('session-anon', 'tool.invoked', { tool: 'Bash' })

    await handler.register({ entity_type: 'usecase', id: 'uc-1' })
    await handler.register({ entity_type: 'plan', id: 'plan-1', parent_id: 'uc-1' })
    await handler.register({ entity_type: 'task', id: 'task-real', parent_id: 'plan-1' })

    await handler.sessionRebind({ old_entity_id: 'session-anon', new_entity_id: 'task-real' })

    const newSpan = spanManager.getSpan('task-real')!
    expect(newSpan.events.some(e => e.name === 'tool.invoked')).toBe(true)

    const oldEntity = handler.getEntityById('session-anon')!
    expect(oldEntity.state).toBe('superseded')
  })
})
```

- [ ] **Step 2: Run the integration test**

Run: `npm test --workspace=packages/tw-daemon -- --grep "Lifecycle Integration"`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `npm test --workspace=packages/tw-daemon`
Expected: All tests pass

- [ ] **Step 4: Build all packages**

Run: `npm run build`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add packages/tw-daemon/src/lifecycle-integration.test.ts
git commit -m "test(daemon): add lifecycle integration tests — error bubbling, progress, drain, rebind"
```

---

## Task 13: Update CLAUDE.md Documentation

**Files:**
- Modify: `packages/tw-types/CLAUDE.md`
- Modify: `packages/tw-daemon/CLAUDE.md`
- Modify: `packages/tw-cli/CLAUDE.md`

- [ ] **Step 1: Update tw-types CLAUDE.md key type table**

Add to the key types table in `packages/tw-types/CLAUDE.md`:

```markdown
| `UsecaseMutateParams` | `{ id, mutation_type: 'insert'\|'update', context?, entities? }` |
| `UsecaseReplaceParams` | `{ id, supersede: string[], new_entities? }` |
| `SessionRebindParams` | `{ old_entity_id, new_entity_id }` |
```

Add to TwEventType known values:

```markdown
`'error.captured'` — 错误采集事件（CC Hook PostToolUse 失败时）
`'usecase.mutated'` — UseCase 变更事件（insert/update）
`'entity.paused'` — 实体暂停（drain 时）
`'entity.superseded'` — 实体被替代（终态）
`'tool.invoked'` / `'tool.completed'` — CC Hook 工具调用事件
`'session.started'` / `'session.ended'` / `'session.rebound'` — 会话生命周期
```

- [ ] **Step 2: Update tw-daemon CLAUDE.md subscriber table**

Add to 子模块职责边界 table in `packages/tw-daemon/CLAUDE.md`:

```markdown
| `subscribers/` | ErrorBubbler / ProgressTracker / UsecaseMutationHandler | 不直接改磁盘实体，只通过 CommandHandler |
```

- [ ] **Step 3: Update tw-cli CLAUDE.md IPC method table**

Add to IPC 方法清单 in `packages/tw-cli/CLAUDE.md`:

```markdown
| `usecase_mutate` | `{id, mutation_type, context?, entities?}` | UseCase insert/update |
| `usecase_replace` | `{id, supersede, new_entities?}` | 批量 supersede + 新建 |
| `session_rebind` | `{old_entity_id, new_entity_id}` | 匿名会话 → 正式实体 |
```

Add to command structure:

```markdown
hook session-start|pre-tool|post-tool|stop|rebind
usecase mutate|replace
```

- [ ] **Step 4: Commit**

```bash
git add packages/tw-types/CLAUDE.md packages/tw-daemon/CLAUDE.md packages/tw-cli/CLAUDE.md
git commit -m "docs: update CLAUDE.md files with new types, subscribers, and IPC methods"
```
