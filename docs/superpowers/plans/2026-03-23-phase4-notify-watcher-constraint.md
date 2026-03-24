# TraceWeaver Phase 4: Notify + FS Watcher + Constraint System

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete TraceWeaver's reactive loop with a multi-adapter notification system (Inbox, Webhook outbound, Telegram IM, Custom), a filesystem watcher that detects external file changes and invalidates cache, and an AI-interpreted constraint evaluation system that validates tasks against Markdown harness files when they reach `review` state.

**Architecture:** Notification Engine subscribes to EventBus, matches events against adapter configs, dispatches with retry + dead-letter. FS Watcher uses chokidar to detect `.traceweaver/` changes and post `file.changed` events to EventBus. Constraint Evaluator is triggered by `entity.state_changed → review` events, reads constraint Markdown files, calls LLM, blocks `review → completed` if fail.

**Tech Stack:** TypeScript 5, chokidar, @anthropic-ai/sdk (constraint LLM), Vitest

**Spec:** `docs/superpowers/specs/2026-03-23-traceweaver-design.md` §7-8, §4

---

## File Map

```
packages/tw-types/src/index.ts          # extend: NotifyConfig, InboxItem, ConstraintResult

packages/tw-daemon/
  src/
    notify/
      engine.ts            # NotifyEngine: subscribe to EventBus, dispatch to adapters
      engine.test.ts
      inbox.ts             # InboxAdapter: write to .traceweaver/inbox/*.json
      inbox.test.ts
      webhook-adapter.ts   # WebhookAdapter: HTTP POST with retry + dead letter
      webhook-adapter.test.ts
      im/
        telegram.ts        # TelegramAdapter: send message via Bot API
        telegram.test.ts
    watcher/
      fs-watcher.ts        # chokidar-based watcher: emits file.changed events
      fs-watcher.test.ts
    constraint/
      evaluator.ts         # ConstraintEvaluator: load Markdown → LLM → pass/fail
      evaluator.test.ts
    index.ts               # MODIFY: start NotifyEngine + FsWatcher on daemon boot

packages/tw-cli/
  src/
    commands/
      inbox.ts             # tw inbox / tw inbox --ack N
      events.ts            # tw events [entity-id] [--since]
      dag.ts               # tw dag [entity-id]
      impact.ts            # tw impact <artifact-path>
```

---

## Task 1: Extend Types + Inbox Adapter

**Files:**
- Modify: `packages/tw-types/src/index.ts`
- Create: `packages/tw-daemon/src/notify/inbox.ts`
- Create: `packages/tw-daemon/src/notify/inbox.test.ts`

- [ ] **Step 1: 追加通知相关类型**

```typescript
// ─── Notify ────────────────────────────────────────────────────────────────

export interface InboxItem {
  id: string
  ts: string
  event_type: TwEventType
  entity_id?: string
  message: string
  acked: boolean
}

export interface WebhookEndpoint {
  name: string
  url: string
  headers?: Record<string, string>
  events: Array<{ event: TwEventType | '*'; entity_type?: EntityType; state?: EntityState }>
}

export interface NotifyDeliveryConfig {
  retry_count: number
  retry_backoff_ms: number
  timeout_ms: number
  dead_letter: 'inbox' | 'discard'
}

export type ConstraintCheckStatus = 'pass' | 'fail' | 'skipped'

export interface ConstraintCheckResult {
  ref: string
  result: ConstraintCheckStatus
  note: string
}

export interface ConstraintValidationResult {
  result: ConstraintCheckStatus
  checked_at: string
  refs_checked: ConstraintCheckResult[]
}
```

- [ ] **Step 2: 编写 InboxAdapter 测试**

```typescript
// notify/inbox.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InboxAdapter } from './inbox.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

describe('InboxAdapter', () => {
  let tmpDir: string
  let inbox: InboxAdapter

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'tw-inbox-'))
    inbox = new InboxAdapter(path.join(tmpDir, 'inbox'))
  })

  afterEach(() => rm(tmpDir, { recursive: true, force: true }))

  it('writes notification to inbox directory', async () => {
    const item = await inbox.write({
      event_type: 'entity.state_changed',
      entity_id: 'T-1',
      message: 'Task T-1 rejected'
    })
    expect(item.id).toBeDefined()
    expect(item.acked).toBe(false)
  })

  it('list returns all inbox items', async () => {
    await inbox.write({ event_type: 'entity.registered', entity_id: 'UC-1', message: 'UseCase UC-1 registered' })
    await inbox.write({ event_type: 'entity.state_changed', entity_id: 'T-2', message: 'Task T-2 completed' })
    const items = await inbox.list()
    expect(items).toHaveLength(2)
  })

  it('ack marks item as read', async () => {
    const item = await inbox.write({ event_type: 'git.commit', message: 'commit abc123' })
    await inbox.ack(item.id)
    const items = await inbox.list()
    expect(items.find(i => i.id === item.id)?.acked).toBe(true)
  })

  it('list with unackedOnly=true filters acked items', async () => {
    const i1 = await inbox.write({ event_type: 'git.commit', message: 'commit 1' })
    await inbox.write({ event_type: 'git.commit', message: 'commit 2' })
    await inbox.ack(i1.id)
    const unacked = await inbox.list({ unackedOnly: true })
    expect(unacked).toHaveLength(1)
  })
})
```

- [ ] **Step 3: 实现 InboxAdapter**

```typescript
// notify/inbox.ts
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { InboxItem, TwEventType } from '@traceweaver/types'

export interface WriteInput {
  event_type: TwEventType
  entity_id?: string
  message: string
}

export class InboxAdapter {
  constructor(private readonly dir: string) {}

  async write(input: WriteInput): Promise<InboxItem> {
    await mkdir(this.dir, { recursive: true })
    const item: InboxItem = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      event_type: input.event_type,
      entity_id: input.entity_id,
      message: input.message,
      acked: false,
    }
    await writeFile(path.join(this.dir, `${item.id}.json`), JSON.stringify(item), 'utf8')
    return item
  }

  async list(opts: { unackedOnly?: boolean } = {}): Promise<InboxItem[]> {
    try {
      const files = await readdir(this.dir)
      const items: InboxItem[] = []
      for (const file of files.filter(f => f.endsWith('.json'))) {
        try {
          const raw = await readFile(path.join(this.dir, file), 'utf8')
          const item = JSON.parse(raw) as InboxItem
          if (!opts.unackedOnly || !item.acked) items.push(item)
        } catch { /* skip malformed */ }
      }
      return items.sort((a, b) => a.ts.localeCompare(b.ts))
    } catch {
      return []
    }
  }

  async ack(id: string): Promise<void> {
    const file = path.join(this.dir, `${id}.json`)
    const raw = await readFile(file, 'utf8')
    const item = JSON.parse(raw) as InboxItem
    item.acked = true
    await writeFile(file, JSON.stringify(item), 'utf8')
  }
}
```

- [ ] **Step 4: 运行 Inbox 测试**

```bash
npm test --workspace=packages/tw-daemon -- --testPathPattern inbox
```

Expected: All inbox tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/tw-types/src/index.ts packages/tw-daemon/src/notify/inbox.ts packages/tw-daemon/src/notify/inbox.test.ts
git commit -m "feat(notify): InboxAdapter — local .traceweaver/inbox notification persistence"
```

---

## Task 2: Webhook Outbound Adapter

**Files:**
- Create: `packages/tw-daemon/src/notify/webhook-adapter.ts`
- Create: `packages/tw-daemon/src/notify/webhook-adapter.test.ts`

- [ ] **Step 1: 编写 WebhookAdapter 测试**

```typescript
// notify/webhook-adapter.test.ts
import { describe, it, expect, vi } from 'vitest'
import { WebhookAdapter } from './webhook-adapter.js'
import type { TwEvent, WebhookEndpoint } from '@traceweaver/types'

const endpoint: WebhookEndpoint = {
  name: 'test',
  url: 'https://example.com/webhook',
  events: [{ event: '*' }]
}

describe('WebhookAdapter', () => {
  it('sends POST with correct payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    const adapter = new WebhookAdapter([endpoint], {
      retryCount: 0,
      timeoutMs: 1000,
      fetch: fetchMock as any
    })
    const event: TwEvent = { id: 'e1', type: 'entity.state_changed', ts: '' }
    await adapter.dispatch(event, 'Task T-1 completed')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://example.com/webhook')
    expect(JSON.parse(opts.body).event_id).toBe('e1')
  })

  it('retries on failure then falls back to dead letter', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    const inboxMock = { write: vi.fn().mockResolvedValue({}) }
    const adapter = new WebhookAdapter([endpoint], {
      retryCount: 1,
      retryBackoffMs: 10,
      timeoutMs: 100,
      fetch: fetchMock as any,
      deadLetterInbox: inboxMock as any
    })
    const event: TwEvent = { id: 'e2', type: 'git.commit', ts: '' }
    await adapter.dispatch(event, 'git commit abc')
    // 1 initial + 1 retry = 2 calls
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(inboxMock.write).toHaveBeenCalledOnce()
  })

  it('filters events by endpoint subscription', async () => {
    const restrictedEndpoint: WebhookEndpoint = {
      name: 'restricted',
      url: 'https://ci/trigger',
      events: [{ event: 'entity.state_changed', entity_type: 'task', state: 'completed' }]
    }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    const adapter = new WebhookAdapter([restrictedEndpoint], { retryCount: 0, timeoutMs: 100, fetch: fetchMock as any })

    // Should NOT send for rejected state
    await adapter.dispatch({ id: 'e3', type: 'entity.state_changed', entity_type: 'task', state: 'rejected', ts: '' }, '')
    expect(fetchMock).not.toHaveBeenCalled()

    // SHOULD send for completed task
    await adapter.dispatch({ id: 'e4', type: 'entity.state_changed', entity_type: 'task', state: 'completed', ts: '' }, '')
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: 实现 WebhookAdapter**

```typescript
// notify/webhook-adapter.ts
import type { TwEvent, WebhookEndpoint } from '@traceweaver/types'
import type { InboxAdapter } from './inbox.js'

export interface WebhookAdapterOptions {
  retryCount?: number
  retryBackoffMs?: number
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
  deadLetterInbox?: Pick<InboxAdapter, 'write'>
}

export class WebhookAdapter {
  private readonly retryCount: number
  private readonly retryBackoffMs: number
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch
  private readonly deadLetter?: Pick<InboxAdapter, 'write'>

  constructor(
    private readonly endpoints: WebhookEndpoint[],
    opts: WebhookAdapterOptions = {}
  ) {
    this.retryCount = opts.retryCount ?? 3
    this.retryBackoffMs = opts.retryBackoffMs ?? 1000
    this.timeoutMs = opts.timeoutMs ?? 5000
    this.fetchFn = opts.fetch ?? globalThis.fetch
    this.deadLetter = opts.deadLetterInbox
  }

  async dispatch(event: TwEvent, message: string): Promise<void> {
    for (const endpoint of this.endpoints) {
      if (!this.matches(endpoint, event)) continue
      await this.sendWithRetry(endpoint, event, message)
    }
  }

  private matches(endpoint: WebhookEndpoint, event: TwEvent): boolean {
    return endpoint.events.some(sub => {
      if (sub.event !== '*' && sub.event !== event.type) return false
      if (sub.entity_type && sub.entity_type !== event.entity_type) return false
      if (sub.state && sub.state !== event.state) return false
      return true
    })
  }

  private async sendWithRetry(endpoint: WebhookEndpoint, event: TwEvent, message: string): Promise<void> {
    const payload = { event_id: event.id, event_type: event.type, entity_id: event.entity_id, message, ts: event.ts }
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= this.retryCount; attempt++) {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, this.retryBackoffMs * Math.pow(2, attempt - 1)))
      }
      try {
        const res = await this.fetchFn(endpoint.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(endpoint.headers ?? {}) },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
        if (res.ok) return
        lastError = new Error(`HTTP ${res.status}`)
      } catch (err) {
        lastError = err as Error
      }
    }

    // Dead letter
    if (this.deadLetter && lastError) {
      await this.deadLetter.write({
        event_type: event.type,
        entity_id: event.entity_id,
        message: `Webhook delivery failed: ${endpoint.name} — ${lastError.message}`,
      })
    }
  }
}
```

- [ ] **Step 3: 运行 Webhook 测试**

```bash
npm test --workspace=packages/tw-daemon -- --testPathPattern webhook-adapter
```

Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/tw-daemon/src/notify/webhook-adapter.ts packages/tw-daemon/src/notify/webhook-adapter.test.ts
git commit -m "feat(notify): WebhookAdapter — outbound HTTP with retry, backoff, dead-letter"
```

---

## Task 3: Notify Engine

**Files:**
- Create: `packages/tw-daemon/src/notify/engine.ts`
- Create: `packages/tw-daemon/src/notify/engine.test.ts`

- [ ] **Step 1: 编写 NotifyEngine 测试**

```typescript
// notify/engine.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NotifyEngine } from './engine.js'
import { EventBus } from '../core/event-bus/event-bus.js'
import type { TwEvent } from '@traceweaver/types'

describe('NotifyEngine', () => {
  let bus: EventBus

  beforeEach(() => {
    bus = new EventBus({ batchWindowMs: 10 })
    bus.start()
  })

  afterEach(() => bus.stop())

  it('routes event to inbox when inbox enabled', async () => {
    const inboxMock = { write: vi.fn().mockResolvedValue({ id: '1', acked: false }) }
    const engine = new NotifyEngine(bus, {
      inbox: inboxMock as any,
      rules: [{ event: 'entity.state_changed', state: 'rejected' }]
    })
    engine.start()

    bus.publish({ id: 'e1', type: 'entity.state_changed', state: 'rejected', entity_id: 'T-1', ts: '' })
    await new Promise(r => setTimeout(r, 50))
    expect(inboxMock.write).toHaveBeenCalledOnce()
    engine.stop()
  })

  it('does not route unsubscribed events', async () => {
    const inboxMock = { write: vi.fn().mockResolvedValue({}) }
    const engine = new NotifyEngine(bus, {
      inbox: inboxMock as any,
      rules: [{ event: 'entity.state_changed', state: 'completed' }]
    })
    engine.start()

    bus.publish({ id: 'e2', type: 'git.commit', ts: '' }) // not subscribed
    await new Promise(r => setTimeout(r, 50))
    expect(inboxMock.write).not.toHaveBeenCalled()
    engine.stop()
  })
})
```

- [ ] **Step 2: 实现 NotifyEngine**

```typescript
// notify/engine.ts
import type { EventBus } from '../core/event-bus/event-bus.js'
import type { TwEvent, TwEventType, EntityState, EntityType } from '@traceweaver/types'
import type { InboxAdapter } from './inbox.js'
import type { WebhookAdapter } from './webhook-adapter.js'

export interface NotifyRule {
  event: TwEventType | '*'
  entity_type?: EntityType
  state?: EntityState
}

export interface NotifyEngineOptions {
  inbox?: Pick<InboxAdapter, 'write'>
  webhook?: WebhookAdapter
  rules?: NotifyRule[]
}

export class NotifyEngine {
  private unsub: (() => void) | null = null

  constructor(
    private readonly bus: EventBus,
    private readonly opts: NotifyEngineOptions
  ) {}

  start(): void {
    this.unsub = this.bus.subscribe(event => void this.handle(event))
  }

  stop(): void {
    this.unsub?.()
    this.unsub = null
  }

  private async handle(event: TwEvent): Promise<void> {
    if (!this.shouldHandle(event)) return

    const message = this.buildMessage(event)

    if (this.opts.inbox) {
      await this.opts.inbox.write({ event_type: event.type, entity_id: event.entity_id, message })
    }

    if (this.opts.webhook) {
      await this.opts.webhook.dispatch(event, message)
    }
  }

  private shouldHandle(event: TwEvent): boolean {
    const rules = this.opts.rules
    if (!rules || rules.length === 0) return true
    return rules.some(rule => {
      if (rule.event !== '*' && rule.event !== event.type) return false
      if (rule.entity_type && rule.entity_type !== event.entity_type) return false
      if (rule.state && rule.state !== event.state) return false
      return true
    })
  }

  private buildMessage(event: TwEvent): string {
    const id = event.entity_id ? ` [${event.entity_id}]` : ''
    const state = event.state ? ` → ${event.state}` : ''
    return `${event.type}${id}${state}`
  }
}
```

- [ ] **Step 3: 运行 Engine 测试**

```bash
npm test --workspace=packages/tw-daemon -- --testPathPattern "notify"
```

Expected: All notification tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/tw-daemon/src/notify/
git commit -m "feat(notify): NotifyEngine — event-driven dispatch to Inbox + Webhook adapters"
```

---

## Task 4: FS Watcher

**Files:**
- Create: `packages/tw-daemon/src/watcher/fs-watcher.ts`
- Create: `packages/tw-daemon/src/watcher/fs-watcher.test.ts`

- [ ] **Step 1: 安装 chokidar**

```bash
npm install --workspace=packages/tw-daemon chokidar
```

- [ ] **Step 2: 编写 FsWatcher 测试**

```typescript
// watcher/fs-watcher.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { FsWatcher } from './fs-watcher.js'
import { EventBus } from '../core/event-bus/event-bus.js'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

describe('FsWatcher', () => {
  let tmpDir: string
  let bus: EventBus
  let watcher: FsWatcher

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'tw-watch-'))
    bus = new EventBus({ batchWindowMs: 10 })
    bus.start()
    watcher = new FsWatcher(tmpDir, bus)
  })

  afterEach(async () => {
    await watcher.stop()
    bus.stop()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('emits file.changed event when file is created', async () => {
    const events: string[] = []
    bus.subscribe(ev => { if (ev.type === 'file.changed') events.push((ev.attributes as any).path) })
    await watcher.start()

    await writeFile(path.join(tmpDir, 'usecase.yaml'), 'id: UC-1', 'utf8')
    await new Promise(r => setTimeout(r, 300))
    expect(events.some(p => p.includes('usecase.yaml'))).toBe(true)
  })

  it('start/stop lifecycle', async () => {
    await watcher.start()
    await watcher.stop()
    expect(true).toBe(true) // no throw
  })
})
```

- [ ] **Step 3: 实现 FsWatcher**

```typescript
// watcher/fs-watcher.ts
import chokidar, { type FSWatcher } from 'chokidar'
import { randomUUID } from 'node:crypto'
import type { EventBus } from '../core/event-bus/event-bus.js'

export class FsWatcher {
  private watcher: FSWatcher | null = null

  constructor(
    private readonly watchDir: string,
    private readonly bus: EventBus
  ) {}

  async start(): Promise<void> {
    this.watcher = chokidar.watch(this.watchDir, {
      ignoreInitial: true,
      persistent: false,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    })

    this.watcher.on('change', (filePath) => this.emit(filePath, 'changed'))
    this.watcher.on('add', (filePath) => this.emit(filePath, 'added'))
    this.watcher.on('unlink', (filePath) => this.emit(filePath, 'removed'))

    await new Promise<void>((resolve) => this.watcher!.on('ready', resolve))
  }

  async stop(): Promise<void> {
    await this.watcher?.close()
    this.watcher = null
  }

  private emit(filePath: string, action: string): void {
    this.bus.publish({
      id: randomUUID(),
      type: 'file.changed',
      ts: new Date().toISOString(),
      attributes: { path: filePath, action },
    })
  }
}
```

- [ ] **Step 4: 运行测试**

```bash
npm test --workspace=packages/tw-daemon -- --testPathPattern fs-watcher
```

Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/tw-daemon/src/watcher/
git commit -m "feat(watcher): FsWatcher — chokidar-based .traceweaver/ change detection"
```

---

## Task 5: Constraint Evaluator (AI-Interpreted)

**Files:**
- Create: `packages/tw-daemon/src/constraint/evaluator.ts`
- Create: `packages/tw-daemon/src/constraint/evaluator.test.ts`

- [ ] **Step 1: 安装 Anthropic SDK**

```bash
npm install --workspace=packages/tw-daemon @anthropic-ai/sdk
```

- [ ] **Step 2: 编写 ConstraintEvaluator 测试**

```typescript
// constraint/evaluator.test.ts
import { describe, it, expect, vi } from 'vitest'
import { ConstraintEvaluator } from './evaluator.js'

describe('ConstraintEvaluator', () => {
  it('returns skipped when no constraint_refs provided', async () => {
    const evaluator = new ConstraintEvaluator({ enabled: false })
    const result = await evaluator.evaluate({ entity_id: 'T-1', constraint_refs: [], artifact_refs: [] })
    expect(result.result).toBe('skipped')
  })

  it('returns skipped when evaluator disabled', async () => {
    const evaluator = new ConstraintEvaluator({ enabled: false })
    const result = await evaluator.evaluate({
      entity_id: 'T-1',
      constraint_refs: ['harness/security.md'],
      artifact_refs: []
    })
    expect(result.result).toBe('skipped')
  })

  it('calls LLM and parses pass result', async () => {
    const mockLlm = vi.fn().mockResolvedValue('RESULT: pass\nAll constraints satisfied.')
    const evaluator = new ConstraintEvaluator({ enabled: true, llmFn: mockLlm })
    const result = await evaluator.evaluate({
      entity_id: 'T-1',
      constraint_refs: ['harness/api.md'],
      artifact_refs: [{ type: 'code', path: './src/api.ts' }],
      constraintContents: { 'harness/api.md': '# API Guidelines\n- Use REST conventions' }
    })
    expect(result.result).toBe('pass')
    expect(mockLlm).toHaveBeenCalledOnce()
  })

  it('calls LLM and parses fail result', async () => {
    const mockLlm = vi.fn().mockResolvedValue('RESULT: fail\nMissing input validation.')
    const evaluator = new ConstraintEvaluator({ enabled: true, llmFn: mockLlm })
    const result = await evaluator.evaluate({
      entity_id: 'T-1',
      constraint_refs: ['harness/security.md'],
      artifact_refs: [],
      constraintContents: { 'harness/security.md': '# Security Policy\n- Validate all inputs' }
    })
    expect(result.result).toBe('fail')
    expect(result.refs_checked[0].note).toContain('Missing input validation')
  })
})
```

- [ ] **Step 3: 实现 ConstraintEvaluator**

```typescript
// constraint/evaluator.ts
import { readFile } from 'node:fs/promises'
import type { ArtifactRef, ConstraintValidationResult, ConstraintCheckStatus } from '@traceweaver/types'

export interface EvaluateInput {
  entity_id: string
  constraint_refs: string[]
  artifact_refs: ArtifactRef[]
  /** Override constraint file contents (for testing) */
  constraintContents?: Record<string, string>
}

export interface ConstraintEvaluatorOptions {
  enabled: boolean
  projectRoot?: string
  /** Override LLM call for testing */
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
    const result: ConstraintCheckStatus = overallFail ? 'fail' : 'pass'

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

Does this task output satisfy the constraints?
Respond with exactly:
RESULT: pass
(brief reason)

OR:
RESULT: fail
(specific violations found)`

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

    // Real Anthropic API call
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
```

- [ ] **Step 4: 运行 Constraint 测试**

```bash
npm test --workspace=packages/tw-daemon -- --testPathPattern evaluator
```

Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/tw-daemon/src/constraint/
git commit -m "feat(constraint): AI-interpreted constraint evaluator — Markdown harness → LLM → pass/fail"
```

---

## Task 6: New CLI Commands

**Files:**
- Create: `packages/tw-cli/src/commands/inbox.ts`
- Create: `packages/tw-cli/src/commands/events.ts`
- Create: `packages/tw-cli/src/commands/dag.ts`
- Create: `packages/tw-cli/src/commands/impact.ts`
- Modify: `packages/tw-cli/src/index.ts`

- [ ] **Step 1: 实现 `tw inbox` 命令**

```typescript
// commands/inbox.ts
import { Command } from 'commander'
import { sendIpc } from '../ipc-client.js'
import { ensureDaemon } from '../daemon-manager.js'

export function inboxCommand(): Command {
  return new Command('inbox')
    .description('View and manage notification inbox')
    .option('--ack <id>', 'Acknowledge an inbox item by ID')
    .option('--unread', 'Show only unread items')
    .action(async (opts) => {
      await ensureDaemon()
      if (opts.ack) {
        const res = await sendIpc({ method: 'inbox_ack', params: { id: opts.ack } })
        if (res.ok) console.log(`Acknowledged: ${opts.ack}`)
        else console.error(`Error: ${(res as any).error.message}`)
      } else {
        const res = await sendIpc({ method: 'inbox_list', params: { unackedOnly: !!opts.unread } })
        if (res.ok) {
          const items = (res.data as any[])
          if (items.length === 0) { console.log('No notifications'); return }
          for (const item of items) {
            const ack = item.acked ? '[read]' : '[NEW] '
            console.log(`${ack} ${item.ts.slice(0, 19)} ${item.message} (id: ${item.id.slice(0, 8)})`)
          }
        } else {
          console.error(`Error: ${(res as any).error.message}`)
        }
      }
    })
}
```

- [ ] **Step 2: 实现 `tw events` 命令**

```typescript
// commands/events.ts
import { Command } from 'commander'
import { sendIpc } from '../ipc-client.js'
import { ensureDaemon } from '../daemon-manager.js'

export function eventsCommand(): Command {
  return new Command('events')
    .description('Query event history')
    .argument('[entity-id]', 'Filter by entity ID')
    .option('--since <iso>', 'Filter events since ISO timestamp')
    .option('--limit <n>', 'Maximum number of events', '50')
    .action(async (entityId, opts) => {
      await ensureDaemon()
      const res = await sendIpc({
        method: 'query_events',
        params: {
          entity_id: entityId,
          since: opts.since,
          limit: parseInt(opts.limit, 10),
        }
      })
      if (res.ok) {
        const events = (res.data as any[])
        if (events.length === 0) { console.log('No events found'); return }
        for (const ev of events) {
          const entity = ev.entity_id ? ` [${ev.entity_id}]` : ''
          const state = ev.state ? ` → ${ev.state}` : ''
          console.log(`${ev.ts.slice(0, 19)} ${ev.type}${entity}${state}`)
        }
      } else {
        console.error(`Error: ${(res as any).error.message}`)
        process.exit(1)
      }
    })
}
```

- [ ] **Step 3: 实现 `tw dag` 和 `tw impact` 命令**

```typescript
// commands/dag.ts
import { Command } from 'commander'
import { sendIpc } from '../ipc-client.js'
import { ensureDaemon } from '../daemon-manager.js'

export function dagCommand(): Command {
  return new Command('dag')
    .description('Visualize entity dependency DAG')
    .argument('[entity-id]', 'Root entity ID (defaults to all)')
    .action(async (entityId) => {
      await ensureDaemon()
      const res = await sendIpc({ method: 'get_dag', params: { root_id: entityId } })
      if (res.ok) {
        const { nodes, edges } = res.data as any
        console.log(`Nodes: ${nodes.length}, Edges: ${edges.length}`)
        for (const edge of edges) {
          console.log(`  ${edge.from} → ${edge.to}`)
        }
      } else {
        console.error(`Error: ${(res as any).error.message}`)
        process.exit(1)
      }
    })
}

// commands/impact.ts
import { Command } from 'commander'
import { sendIpc } from '../ipc-client.js'
import { ensureDaemon } from '../daemon-manager.js'

export function impactCommand(): Command {
  return new Command('impact')
    .description('Analyze impact of artifact changes')
    .argument('<artifact-ref>', 'Artifact path (e.g. ./prd.md or ./prd.md#section-3)')
    .action(async (ref) => {
      await ensureDaemon()
      const [path, section] = ref.split('#')
      const res = await sendIpc({ method: 'resolve_impact', params: { artifact_path: path, section } })
      if (res.ok) {
        const { affected } = res.data as any
        if (affected.length === 0) { console.log('No affected entities'); return }
        console.log(`Affected entities (${affected.length}):`)
        for (const e of affected) {
          console.log(`  ${e.entity_type.padEnd(8)} ${e.id.padEnd(20)} ${e.state}`)
        }
      } else {
        console.error(`Error: ${(res as any).error.message}`)
        process.exit(1)
      }
    })
}
```

- [ ] **Step 4: 注册新命令到 CLI index**

```typescript
// 在 packages/tw-cli/src/index.ts 中添加:
import { inboxCommand } from './commands/inbox.js'
import { eventsCommand } from './commands/events.js'
import { dagCommand } from './commands/dag.js'
import { impactCommand } from './commands/impact.js'

program.addCommand(inboxCommand())
program.addCommand(eventsCommand())
program.addCommand(dagCommand())
program.addCommand(impactCommand())
```

- [ ] **Step 5: Commit**

```bash
git add packages/tw-cli/src/commands/inbox.ts packages/tw-cli/src/commands/events.ts packages/tw-cli/src/commands/dag.ts packages/tw-cli/src/commands/impact.ts packages/tw-cli/src/index.ts
git commit -m "feat(cli): add inbox, events, dag, impact commands"
```

---

## Task 7: Wire Everything in Daemon + Final Integration Test

**Files:**
- Modify: `packages/tw-daemon/src/index.ts`
- Create: `packages/tw-daemon/src/phase4-integration.test.ts`

- [ ] **Step 1: 更新 index.ts — 注入 NotifyEngine + FsWatcher**

启动时根据 `.traceweaver/config.yaml` 读取通知配置，初始化 NotifyEngine 和 FsWatcher。

- [ ] **Step 2: 运行全量测试**

```bash
npm test --workspace=packages/tw-daemon && npm test --workspace=packages/tw-cli
```

Expected: All tests pass (120+ total)

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(daemon): wire NotifyEngine + FsWatcher + ConstraintEvaluator into daemon startup"
git tag v0.4.0-phase4
```
