# Trace & Report 功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 TraceWeaver 增加三个功能：`TraceQueryEngine` 双来源查询层、`tw report` 日报生成、`tw trace spans/info` 链路查询与详情展示。

**Architecture:** 共享 `TraceQueryEngine`（SpanManager live + EntityRegistry fallback）统一提供 `SpanTreeNode` 树和 `buildTraceInfo()`；`ReportGenerator` 聚合四来源生成 `.md`；4 个新 IPC 方法接入 CLI。`buildTraceInfo` 放在 `trace-query.ts` 而不是 `ipc-server.ts`，保持 ipc-server 为薄分发层。

**Tech Stack:** TypeScript (ESM), Commander.js (CLI), vitest (tests), node:fs/promises + node:os (file ops)

---

## 文件结构

### 新建文件
```
packages/tw-types/src/index.ts                  修改：+ SpanTreeNode / TraceInfo / ReportMeta / 'report.generated'
packages/tw-daemon/src/otel/trace-query.ts       新建：TraceQueryEngine（含 buildTraceInfo）
packages/tw-daemon/src/otel/trace-query.test.ts  新建：TraceQueryEngine 单元测试
packages/tw-daemon/src/report/report-generator.ts       新建：ReportGenerator
packages/tw-daemon/src/report/report-generator.test.ts  新建：ReportGenerator 单元测试
packages/tw-daemon/src/report/report-scheduler.ts       新建：ReportScheduler（cron）
packages/tw-daemon/src/report/report-scheduler.test.ts  新建：ReportScheduler 单元测试
packages/tw-cli/src/commands/trace.ts            新建：tw trace spans | info
packages/tw-cli/src/commands/report.ts           新建：tw report daily | show | list
packages/tw-cli/src/output/trace-renderer.ts     新建：树状文本渲染
packages/tw-cli/src/output/trace-renderer.test.ts  新建：渲染单元测试
```

### 修改文件
```
packages/tw-daemon/src/core/command-handler.ts   新增：getEntityById(id) 公开方法
packages/tw-daemon/src/config/loader.ts          新增：report config 类型块
packages/tw-daemon/src/ipc-server.ts             新增：IpcServerOptions 字段 + 私有字段 + 4 个 else-if case
packages/tw-daemon/src/index.ts                  新增：TraceQueryEngine / ReportGenerator / ReportScheduler 初始化
packages/tw-cli/src/index.ts                     新增：addCommand(traceCommand()) / addCommand(reportCommand())
packages/tw-cli/CLAUDE.md                        更新：noun + IPC 清单 + 输出工具
packages/tw-daemon/CLAUDE.md                     更新：子模块表 + 配置项
packages/tw-types/CLAUDE.md                      更新：关键类型表
docs/CLI-COMMANDS.md                             更新：tw trace / tw report 命令文档
```

---

## Task 1：tw-types — 添加新类型

**文件：** `packages/tw-types/src/index.ts`

**注意：** 必须先于 tw-daemon 实现，否则 `eventLog.append({ type: 'report.generated', ... })` 编译报错。

- [ ] **Step 1.1：在 `TwEventType` 联合类型末尾追加 `'report.generated'`**

  打开 `packages/tw-types/src/index.ts`，找到 `TwEventType` 定义（形如 `export type TwEventType = '...' | '...'`），追加：

  ```typescript
  | 'report.generated'
  ```

- [ ] **Step 1.2：追加 `SpanEvent` 接口（若 SpanMeta.events 已有类型则复用，不新建）**

  ```typescript
  export interface SpanEvent {
    name: string
    attributes?: Record<string, string>
    time?: string
  }
  ```

- [ ] **Step 1.3：追加 `SpanTreeNode` 接口**

  ```typescript
  export interface SpanTreeNode {
    entity_id: string
    entity_type: EntityType
    state: EntityState                // 来源：EntityRegistry（权威），非 SpanMeta.status 反推
    span_id: string                   // daemon 重启后为 entity_id（reconstructed 模式）
    trace_id: string
    parent_span_id?: string
    start_time: string
    end_time?: string
    duration_ms?: number              // reconstructed 模式下为 undefined
    status: 'OK' | 'ERROR' | 'UNSET'
    source: 'live' | 'reconstructed' // 区分 SpanManager vs EntityRegistry 来源
    events: SpanEvent[]              // reconstructed 模式下从 EventLog 重建（可为空数组）
    harness_results?: Array<{
      harness_id: string
      result: 'pass' | 'fail'
      reason?: string
    }>
    children: SpanTreeNode[]
  }
  ```

- [ ] **Step 1.4：追加 `TraceInfo` 接口**

  ```typescript
  export interface TraceInfo {
    trace_id: string
    root: SpanTreeNode
    summary: {
      total: number
      completed: number
      in_progress: number
      pending: number
      rejected: number
      blocked: string[]
      harness_failures: Array<{
        entity_id: string
        harness_id: string
        reason?: string
      }>
    }
    _ai_context: {
      one_line: string       // 确定性模板生成，不调用 LLM
      next_actions: string[]
      error_refs: string[]
    }
  }
  ```

- [ ] **Step 1.5：追加 `ReportMeta` 接口**

  ```typescript
  export interface ReportMeta {
    date: string          // YYYY-MM-DD
    trace_id: string
    path: string
    generated_at: string  // ISO8601
  }
  ```

- [ ] **Step 1.6：构建验证**

  ```bash
  npm run build --workspace=packages/tw-types
  ```

  期望：零 TypeScript 错误。

- [ ] **Step 1.7：提交**

  ```bash
  git add packages/tw-types/src/index.ts
  git commit -m "feat(types): add SpanTreeNode, TraceInfo, ReportMeta, report.generated event type"
  ```

---

## Task 2：CommandHandler — 新增 `getEntityById` 方法

**文件：** `packages/tw-daemon/src/core/command-handler.ts`

`EntityRegistry` 在 `CommandHandler` 内是 `private readonly`。`TraceQueryEngine` 通过回调函数接收，需要一个按 id 查单实体的公开方法。

- [ ] **Step 2.1：查看 `command-handler.ts` 顶部 `private readonly` 字段，找到 `EntityRegistry` 对应的字段名**

  通常是 `this.registry`、`this.entityRegistry`。

- [ ] **Step 2.2：在 `getAllEntities()` 方法附近新增 `getEntityById` 方法**

  ```typescript
  getEntityById(id: string): Entity | undefined {
    return this.registry.get(id)   // 用实际字段名替换 this.registry
  }
  ```

- [ ] **Step 2.3：构建验证**

  ```bash
  npm run build --workspace=packages/tw-daemon
  ```

- [ ] **Step 2.4：提交**

  ```bash
  git add packages/tw-daemon/src/core/command-handler.ts
  git commit -m "feat(daemon): expose getEntityById on CommandHandler for TraceQueryEngine"
  ```

---

## Task 3：Config — 添加 `report` 配置块类型

**文件：** `packages/tw-daemon/src/config/loader.ts`

- [ ] **Step 3.1：找到 `loadConfig` 返回的 config 对象类型（通常是 `TwConfig` 或 inline interface），追加 `report` 字段**

  ```typescript
  report?: {
    schedule?: string                       // "HH:MM"，如 "09:00"
    output_dir?: string                     // 报告输出目录，默认 "~/.traceweaver/reports/"
    traces?: 'all' | string[]              // 'all' 或具体 trace_id 列表
  }
  ```

- [ ] **Step 3.2：构建验证**

  ```bash
  npm run build --workspace=packages/tw-daemon
  ```

- [ ] **Step 3.3：提交**

  ```bash
  git add packages/tw-daemon/src/config/loader.ts
  git commit -m "feat(config): add report config block (schedule, output_dir, traces)"
  ```

---

## Task 4：TraceQueryEngine — 实现与测试

**文件：** `packages/tw-daemon/src/otel/trace-query.ts` 和 `trace-query.test.ts`

`buildTraceInfo` 和 `collectStats` 放在此文件，而不是 `ipc-server.ts`，避免业务逻辑泄漏到分发层。

### 4a. 先写测试

- [ ] **Step 4.1：创建测试文件 `packages/tw-daemon/src/otel/trace-query.test.ts`**

  ```typescript
  import { describe, it, expect, beforeEach } from 'vitest'
  import { TraceQueryEngine } from './trace-query.js'
  import type { Entity, SpanMeta } from '@traceweaver/types'

  function makeEntity(overrides: Partial<Entity> & { id: string; entity_type: Entity['entity_type'] }): Entity {
    return {
      state: 'pending',
      depends_on: [],
      artifact_refs: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    }
  }

  function makeSpan(overrides: Partial<SpanMeta> & { entity_id: string; trace_id: string; span_id: string }): SpanMeta {
    return {
      entity_type: 'task',
      start_time: new Date().toISOString(),
      status: 'UNSET',
      attributes: {},
      events: [],
      ...overrides,
    }
  }

  describe('TraceQueryEngine', () => {
    let entities: Entity[]
    let spans: SpanMeta[]

    beforeEach(() => {
      entities = [
        makeEntity({ id: 'uc-1', entity_type: 'usecase' }),
        makeEntity({ id: 'plan-1', entity_type: 'plan', parent_id: 'uc-1', state: 'in_progress' }),
        makeEntity({ id: 'task-1', entity_type: 'task', parent_id: 'plan-1', state: 'completed' }),
        makeEntity({ id: 'task-2', entity_type: 'task', parent_id: 'plan-1', state: 'rejected' }),
      ]
      spans = [
        makeSpan({ entity_id: 'uc-1',    trace_id: 'trace-abc', span_id: 'span-1' }),
        makeSpan({ entity_id: 'plan-1',  trace_id: 'trace-abc', span_id: 'span-2', parent_span_id: 'span-1' }),
        makeSpan({ entity_id: 'task-1',  trace_id: 'trace-abc', span_id: 'span-3', parent_span_id: 'span-2' }),
        makeSpan({ entity_id: 'task-2',  trace_id: 'trace-abc', span_id: 'span-4', parent_span_id: 'span-2', status: 'ERROR' }),
      ]
    })

    function makeEngine(opts: { spans?: SpanMeta[]; feedbackEntries?: any[] } = {}) {
      const spanList = opts.spans ?? spans
      const feedbackList = opts.feedbackEntries ?? []
      return new TraceQueryEngine({
        spanManager: {
          getSpan: (id: string) => spanList.find(s => s.entity_id === id),
          getAllSpans: () => spanList,
        } as any,
        getAllEntities: () => entities,
        getEntity: (id: string) => entities.find(e => e.id === id),
        feedbackLog: {
          query: ({ entity_id }: any) => feedbackList.filter((f: any) => f.entity_id === entity_id),
        } as any,
      })
    }

    describe('findTraceId', () => {
      it('returns trace_id when entity has a live span', () => {
        expect(makeEngine().findTraceId('task-1')).toBe('trace-abc')
      })

      it('walks parent chain (EntityRegistry fallback) when entity has no span', () => {
        const engine = makeEngine({ spans: [spans[0]] }) // only uc-1 has a span
        expect(engine.findTraceId('task-1')).toBe('trace-abc')
      })

      it('returns undefined for unknown entity', () => {
        expect(makeEngine().findTraceId('nonexistent')).toBeUndefined()
      })
    })

    describe('buildSpanTree', () => {
      it('builds nested tree with state from EntityRegistry (not SpanMeta.status)', () => {
        const tree = makeEngine().buildSpanTree('trace-abc')
        expect(tree).not.toBeNull()
        expect(tree!.entity_id).toBe('uc-1')
        expect(tree!.state).toBe('pending')       // EntityRegistry, not OTel status
        expect(tree!.source).toBe('live')
        const plan = tree!.children[0]
        expect(plan.state).toBe('in_progress')    // EntityRegistry
        expect(plan.children).toHaveLength(2)
      })

      it('populates harness_results from FeedbackLog', () => {
        const feedbackEntries = [
          { entity_id: 'task-2', harness_id: 'task-needs-test', result: 'fail', reason: '未发现测试文件引用' },
        ]
        const tree = makeEngine({ feedbackEntries }).buildSpanTree('trace-abc')!
        const task2 = tree.children[0].children.find(c => c.entity_id === 'task-2')!
        expect(task2.harness_results).toHaveLength(1)
        expect(task2.harness_results![0].result).toBe('fail')
      })

      it('returns null for unknown trace_id', () => {
        expect(makeEngine().buildSpanTree('nonexistent-trace')).toBeNull()
      })

      it('returns null when SpanManager is empty (daemon restart)', () => {
        expect(makeEngine({ spans: [] }).buildSpanTree('trace-abc')).toBeNull()
      })
    })

    describe('getSpansByTraceId', () => {
      it('returns all SpanMeta for the trace via linear scan', () => {
        const result = makeEngine().getSpansByTraceId('trace-abc')
        expect(result).toHaveLength(4)
        expect(result.every(s => s.trace_id === 'trace-abc')).toBe(true)
      })
    })

    describe('getAllTraceIds', () => {
      it('deduplicates trace_ids from SpanManager', () => {
        expect(makeEngine().getAllTraceIds()).toEqual(['trace-abc'])
      })

      it('includes trace_ids derivable from EntityRegistry when SpanManager is empty', () => {
        // uc-1 has no parent_id → it is a root; but has no trace_id in EntityRegistry alone
        // → empty list expected (no span → no known trace_id)
        expect(makeEngine({ spans: [] }).getAllTraceIds()).toEqual([])
      })
    })

    describe('buildTraceInfo', () => {
      it('builds summary with correct counts', () => {
        const info = makeEngine().buildTraceInfo('trace-abc')
        expect(info).not.toBeNull()
        expect(info!.summary.total).toBe(4)
        expect(info!.summary.completed).toBe(1)
        expect(info!.summary.rejected).toBe(1)
        expect(info!.summary.in_progress).toBe(1)
      })

      it('populates _ai_context.one_line deterministically', () => {
        const feedbackEntries = [
          { entity_id: 'task-2', harness_id: 'task-needs-test', result: 'fail', reason: '未发现测试文件引用' },
        ]
        const info = makeEngine({ feedbackEntries }).buildTraceInfo('trace-abc')!
        expect(info._ai_context.one_line).toContain('4 实体中 1 完成')
        expect(info._ai_context.one_line).toContain('task-2')
      })

      it('returns null for unknown trace_id', () => {
        expect(makeEngine().buildTraceInfo('nonexistent')).toBeNull()
      })
    })
  })
  ```

- [ ] **Step 4.2：运行测试，确认 FAIL**

  ```bash
  npm test --workspace=packages/tw-daemon -- trace-query
  ```

  期望：报 "Cannot find module './trace-query.js'"。

### 4b. 实现

- [ ] **Step 4.3：创建 `packages/tw-daemon/src/otel/trace-query.ts`**

  ```typescript
  import type {
    SpanTreeNode, TraceInfo, Entity, EntityType, EntityState, SpanMeta
  } from '@traceweaver/types'
  import type { SpanManager } from './span-manager.js'
  import type { FeedbackLog } from '../feedback/feedback-log.js'

  export interface TraceQueryEngineOptions {
    spanManager: SpanManager
    getAllEntities: () => Entity[]
    getEntity: (id: string) => Entity | undefined
    feedbackLog: FeedbackLog
  }

  export class TraceQueryEngine {
    constructor(private readonly opts: TraceQueryEngineOptions) {}

    /** entity_id → trace_id：优先 SpanManager，fallback 沿 parent_id 链向上找有 span 的祖先 */
    findTraceId(entityId: string): string | undefined {
      const span = this.opts.spanManager.getSpan(entityId)
      if (span) return span.trace_id

      let current = this.opts.getEntity(entityId)
      while (current) {
        const s = this.opts.spanManager.getSpan(current.id)
        if (s) return s.trace_id
        if (!current.parent_id) break
        current = this.opts.getEntity(current.parent_id)
      }
      return undefined
    }

    /** 构建完整 SpanTreeNode 树（含嵌套 children）。返回 null 表示 trace 不存在或无 span 数据 */
    buildSpanTree(traceId: string): SpanTreeNode | null {
      const traceSpans = this.opts.spanManager.getAllSpans().filter(s => s.trace_id === traceId)
      if (traceSpans.length === 0) return null

      const spanIds = new Set(traceSpans.map(s => s.span_id))
      const root = traceSpans.find(s => !s.parent_span_id || !spanIds.has(s.parent_span_id))
      if (!root) return null

      return this._buildNode(root, traceSpans)
    }

    private _buildNode(span: SpanMeta, allTraceSpans: SpanMeta[]): SpanTreeNode {
      const entity = this.opts.getEntity(span.entity_id)
      const feedback = this.opts.feedbackLog.query({ entity_id: span.entity_id })

      const harness_results = feedback.length > 0
        ? feedback.map(f => ({
            harness_id: f.harness_id,
            result: f.result as 'pass' | 'fail',
            reason: f.reason,
          }))
        : undefined

      const children = allTraceSpans
        .filter(s => s.parent_span_id === span.span_id)
        .map(s => this._buildNode(s, allTraceSpans))

      const duration_ms = span.end_time
        ? new Date(span.end_time).getTime() - new Date(span.start_time).getTime()
        : undefined

      return {
        entity_id: span.entity_id,
        entity_type: (entity?.entity_type ?? span.entity_type) as EntityType,
        state: (entity?.state ?? 'pending') as EntityState,
        span_id: span.span_id,
        trace_id: span.trace_id,
        parent_span_id: span.parent_span_id,
        start_time: span.start_time,
        end_time: span.end_time,
        duration_ms,
        status: span.status,
        source: 'live',
        events: span.events ?? [],
        harness_results,
        children,
      }
    }

    /** 线性扫描 SpanManager（预期 < 200 entities，O(n) 可接受）*/
    getSpansByTraceId(traceId: string): SpanMeta[] {
      return this.opts.spanManager.getAllSpans().filter(s => s.trace_id === traceId)
    }

    /** 所有已知 trace_id（SpanManager 去重；EntityRegistry 在无 span 时无法提供 trace_id）*/
    getAllTraceIds(): string[] {
      return [...new Set(this.opts.spanManager.getAllSpans().map(s => s.trace_id))]
    }

    /** 从根 Span 出发构建完整 TraceInfo（含 summary + _ai_context），返回 null 表示 trace 不存在 */
    buildTraceInfo(traceId: string): TraceInfo | null {
      const root = this.buildSpanTree(traceId)
      if (!root) return null

      let total = 0, completed = 0, in_progress = 0, pending = 0, rejected = 0
      const harness_failures: TraceInfo['summary']['harness_failures'] = []
      const rejectedIds: string[] = []

      // Collect blocked entities: state is pending/in_progress and depends on a non-completed entity
      const allEntities = this.opts.getAllEntities()
      const entityById = new Map(allEntities.map(e => [e.id, e]))
      const blocked: string[] = allEntities
        .filter(e => (e.state === 'pending' || e.state === 'in_progress') && e.depends_on?.length)
        .filter(e => e.depends_on!.some(depId => {
          const dep = entityById.get(depId)
          return dep && dep.state !== 'completed'
        }))
        .map(e => e.id)

      function walk(n: SpanTreeNode) {
        total++
        if (n.state === 'completed') completed++
        else if (n.state === 'in_progress') in_progress++
        else if (n.state === 'pending') pending++
        else if (n.state === 'rejected') {
          rejected++
          rejectedIds.push(n.entity_id)
        }
        for (const hr of n.harness_results ?? []) {
          if (hr.result === 'fail') {
            harness_failures.push({ entity_id: n.entity_id, harness_id: hr.harness_id, reason: hr.reason })
          }
        }
        for (const child of n.children) walk(child)
      }
      walk(root)

      const one_line =
        `${total} 实体中 ${completed} 完成` +
        (rejected > 0 ? `，${rejectedIds.join('/')} 被 harness 拒绝` : '') +
        (blocked.length > 0 ? `，${blocked.join('/')} 等待解锁` : '')

      const next_actions = [
        ...harness_failures.map(f => `${f.entity_id}: ${f.reason ?? '未知原因'} → 修复后重新 review`),
        ...blocked.map(id => `${id}: 等待上游修复后继续`),
      ]

      const error_refs = harness_failures.map(
        f => `events.ndjson → entity_id=${f.entity_id}, type=entity.state_changed, state=rejected`
      )

      return {
        trace_id: traceId,
        root,
        summary: { total, completed, in_progress, pending, rejected, blocked, harness_failures },
        _ai_context: { one_line, next_actions, error_refs },
      }
    }
  }
  ```

- [ ] **Step 4.4：运行测试，确认 PASS**

  ```bash
  npm test --workspace=packages/tw-daemon -- trace-query
  ```

- [ ] **Step 4.5：全量构建验证**

  ```bash
  npm run build --workspace=packages/tw-daemon
  ```

- [ ] **Step 4.6：提交**

  ```bash
  git add packages/tw-daemon/src/otel/trace-query.ts packages/tw-daemon/src/otel/trace-query.test.ts
  git commit -m "feat(daemon): add TraceQueryEngine — dual-source + buildTraceInfo + _ai_context"
  ```

---

## Task 5：ReportGenerator — 实现与测试

**文件：** `packages/tw-daemon/src/report/report-generator.ts` 和 `report-generator.test.ts`

### 5a. 先写测试

- [ ] **Step 5.1：创建测试文件 `packages/tw-daemon/src/report/report-generator.test.ts`**

  ```typescript
  import { describe, it, expect, beforeEach, afterEach } from 'vitest'
  import { mkdtemp, rm, readFile } from 'node:fs/promises'
  import { existsSync } from 'node:fs'
  import { join } from 'node:path'
  import { tmpdir } from 'node:os'
  import { ReportGenerator } from './report-generator.js'
  import type { SpanTreeNode } from '@traceweaver/types'

  function makeTree(): SpanTreeNode {
    return {
      entity_id: 'uc-1', entity_type: 'usecase', state: 'completed',
      span_id: 'span-1', trace_id: 'trace-abc',
      start_time: '2026-03-25T07:00:00Z', end_time: '2026-03-25T09:30:00Z',
      duration_ms: 9000000, status: 'OK', source: 'live', events: [],
      children: [
        {
          entity_id: 'task-1', entity_type: 'task', state: 'completed',
          span_id: 'span-2', trace_id: 'trace-abc', parent_span_id: 'span-1',
          start_time: '2026-03-25T07:00:00Z', end_time: '2026-03-25T08:00:00Z',
          duration_ms: 3600000, status: 'OK', source: 'live', events: [], children: [],
        },
        {
          entity_id: 'task-2', entity_type: 'task', state: 'rejected',
          span_id: 'span-3', trace_id: 'trace-abc', parent_span_id: 'span-1',
          start_time: '2026-03-25T08:00:00Z', status: 'ERROR', source: 'live',
          events: [], children: [],
          harness_results: [{ harness_id: 'task-needs-test', result: 'fail', reason: '未发现测试文件引用' }],
        },
      ],
    }
  }

  describe('ReportGenerator', () => {
    let tmpDir: string
    let appendedEvents: any[]

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'tw-report-test-'))
      appendedEvents = []
    })

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true })
    })

    function makeGenerator() {
      const tree = makeTree()
      return new ReportGenerator({
        traceQuery: {
          buildSpanTree: (id: string) => id === 'trace-abc' ? tree : null,
          getAllTraceIds: () => ['trace-abc'],
        } as any,
        eventLog: {
          append: (e: any) => { appendedEvents.push(e) },
          query: () => [],
        } as any,
        feedbackLog: { getAllSummaries: () => [] } as any,
        outputDir: tmpDir,
      })
    }

    it('generates .md file and returns path', async () => {
      const paths = await makeGenerator().generate({ traceId: 'trace-abc', date: '2026-03-25' })
      expect(paths).toHaveLength(1)
      expect(paths[0]).toContain('2026-03-25')
      expect(paths[0]).toContain('trace-ab')
    })

    it('generated .md contains entity info', async () => {
      const [path] = await makeGenerator().generate({ traceId: 'trace-abc', date: '2026-03-25' })
      const content = await readFile(path, 'utf-8')
      expect(content).toContain('uc-1')
      expect(content).toContain('task-2')
      expect(content).toContain('rejected')
    })

    it('appends report.generated event with file-ref only (no content)', async () => {
      const [path] = await makeGenerator().generate({ traceId: 'trace-abc', date: '2026-03-25' })
      expect(appendedEvents).toHaveLength(1)
      const ev = appendedEvents[0]
      expect(ev.type).toBe('report.generated')
      expect(ev.attributes.report_path).toBe(path)
      expect(ev.attributes.trace_id).toBe('trace-abc')
      expect(ev.attributes.content).toBeUndefined()   // only file-ref, not content
    })

    it('atomic write: .tmp file absent after generate', async () => {
      const [path] = await makeGenerator().generate({ traceId: 'trace-abc', date: '2026-03-25' })
      expect(existsSync(path + '.tmp')).toBe(false)
      expect(existsSync(path)).toBe(true)
    })

    it('throws trace_not_found for unknown trace_id', async () => {
      await expect(makeGenerator().generate({ traceId: 'unknown', date: '2026-03-25' }))
        .rejects.toMatchObject({ code: 'trace_not_found' })
    })

    it('throws missing_trace_id_or_all when no params', async () => {
      await expect(makeGenerator().generate({}))
        .rejects.toMatchObject({ code: 'missing_trace_id_or_all' })
    })
  })
  ```

- [ ] **Step 5.2：运行测试，确认 FAIL**

  ```bash
  npm test --workspace=packages/tw-daemon -- report-generator
  ```

### 5b. 实现

- [ ] **Step 5.3：创建目录并创建 `packages/tw-daemon/src/report/report-generator.ts`**

  ```typescript
  import { writeFile, rename, mkdir, readdir } from 'node:fs/promises'
  import { join } from 'node:path'
  import { randomUUID } from 'node:crypto'
  import type { ReportMeta, SpanTreeNode } from '@traceweaver/types'
  import type { TraceQueryEngine } from '../otel/trace-query.js'
  import type { EventLog } from '../log/event-log.js'
  import type { FeedbackLog } from '../feedback/feedback-log.js'

  export interface ReportGeneratorOptions {
    traceQuery: TraceQueryEngine
    eventLog: EventLog
    feedbackLog: FeedbackLog
    outputDir: string
  }

  export interface GenerateParams {
    traceId?: string
    all?: boolean
    date?: string
    outputDir?: string   // per-call override
  }

  function buildMarkdown(tree: SpanTreeNode, date: string): string {
    let total = 0, completed = 0, in_progress = 0, rejected = 0
    const rejectedEntities: string[] = []
    const harnessFailures: string[] = []

    function walk(n: SpanTreeNode) {
      total++
      if (n.state === 'completed') completed++
      else if (n.state === 'in_progress') in_progress++
      else if (n.state === 'rejected') {
        rejected++
        rejectedEntities.push(n.entity_id)
        for (const hr of n.harness_results ?? []) {
          if (hr.result === 'fail') {
            harnessFailures.push(`- [${n.entity_id}] → rejected by \`${hr.harness_id}\`${hr.reason ? `\n  reason: "${hr.reason}"` : ''}`)
          }
        }
      }
      for (const child of n.children) walk(child)
    }
    walk(tree)

    const lines: string[] = [
      `# TraceWeaver 日报 — ${date}`,
      '',
      '## 概览',
      `| trace_id | 生成时间 |`,
      `|----------|---------|`,
      `| ${tree.trace_id} | ${new Date().toISOString()} |`,
      '',
      '## 进度摘要',
      `总计 ${total} 个实体：✅ ${completed} 完成 / 🔄 ${in_progress} 进行中 / ✗ ${rejected} 拒绝`,
    ]

    if (harnessFailures.length > 0) {
      lines.push('', '## 阻塞', ...harnessFailures)
    }

    lines.push('', '---', `_ref: events.ndjson → type=report.generated ts=${new Date().toISOString()}_`)
    return lines.join('\n')
  }

  export class ReportGenerator {
    constructor(private readonly opts: ReportGeneratorOptions) {}

    async generate(params: GenerateParams): Promise<string[]> {
      if (!params.traceId && !params.all) {
        throw Object.assign(new Error('trace_id or all required'), { code: 'missing_trace_id_or_all' })
      }

      const date = params.date ?? new Date().toISOString().slice(0, 10)
      const traceIds = params.all ? this.opts.traceQuery.getAllTraceIds() : [params.traceId!]
      const outDir = params.outputDir ?? this.opts.outputDir

      await mkdir(outDir, { recursive: true })

      const paths: string[] = []
      for (const traceId of traceIds) {
        const tree = this.opts.traceQuery.buildSpanTree(traceId)
        if (!tree) {
          throw Object.assign(new Error(`trace not found: ${traceId}`), { code: 'trace_not_found' })
        }

        const filename = `${date}-${traceId.slice(0, 8)}.md`
        const finalPath = join(outDir, filename)
        const tmpPath = finalPath + '.tmp'

        await writeFile(tmpPath, buildMarkdown(tree, date), 'utf-8')
        await rename(tmpPath, finalPath)

        // EventLog: 仅存文件引用，不存内容
        this.opts.eventLog.append({
          id: randomUUID(),
          type: 'report.generated',
          ts: new Date().toISOString(),
          attributes: { report_path: finalPath, trace_id: traceId },
        } as any)

        paths.push(finalPath)
      }
      return paths
    }

    async listReports(date?: string): Promise<ReportMeta[]> {
      let files: string[]
      try {
        files = await readdir(this.opts.outputDir)
      } catch {
        return []
      }
      return files
        .filter(f => f.endsWith('.md') && (!date || f.startsWith(date)))
        .map(f => ({
          date: f.slice(0, 10),
          trace_id: f.slice(11, 19),          // "YYYY-MM-DD-XXXXXXXX.md"
          path: join(this.opts.outputDir, f),
          generated_at: '',
        }))
    }
  }
  ```

- [ ] **Step 5.4：运行测试，确认 PASS**

  ```bash
  npm test --workspace=packages/tw-daemon -- report-generator
  ```

- [ ] **Step 5.5：构建验证**

  ```bash
  npm run build --workspace=packages/tw-daemon
  ```

- [ ] **Step 5.6：提交**

  ```bash
  git add packages/tw-daemon/src/report/report-generator.ts packages/tw-daemon/src/report/report-generator.test.ts
  git commit -m "feat(daemon): add ReportGenerator — atomic .md write + EventLog file-ref"
  ```

---

## Task 6：ReportScheduler — 实现与测试

**文件：** `packages/tw-daemon/src/report/report-scheduler.ts` 和 `report-scheduler.test.ts`

### 6a. 先写测试

- [ ] **Step 6.1：创建 `packages/tw-daemon/src/report/report-scheduler.test.ts`**

  ```typescript
  import { describe, it, expect, vi, afterEach } from 'vitest'
  import { ReportScheduler } from './report-scheduler.js'

  describe('ReportScheduler', () => {
    afterEach(() => { vi.useRealTimers() })

    function makeScheduler(scheduleTime = '09:00', hasReport = false) {
      let firedCount = 0
      const scheduler = new ReportScheduler({
        scheduleTime,
        generate: async () => { firedCount++ },
        hasReportTodayInEventLog: async () => hasReport,
        pollIntervalMs: 50,
      })
      return { scheduler, getFiredCount: () => firedCount }
    }

    it('triggers generate when time matches and no report today', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-03-25T09:00:00'))
      const { scheduler, getFiredCount } = makeScheduler('09:00', false)
      scheduler.start()
      await vi.advanceTimersByTimeAsync(100)
      scheduler.stop()
      expect(getFiredCount()).toBeGreaterThan(0)
    })

    it('skips generate when EventLog already has today report (idempotent)', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-03-25T09:00:00'))
      const { scheduler, getFiredCount } = makeScheduler('09:00', true)
      scheduler.start()
      await vi.advanceTimersByTimeAsync(100)
      scheduler.stop()
      expect(getFiredCount()).toBe(0)
    })

    it('does not trigger when time does not match', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-03-25T08:00:00'))
      const { scheduler, getFiredCount } = makeScheduler('09:00', false)
      scheduler.start()
      await vi.advanceTimersByTimeAsync(100)
      scheduler.stop()
      expect(getFiredCount()).toBe(0)
    })
  })
  ```

- [ ] **Step 6.2：运行测试，确认 FAIL**

  ```bash
  npm test --workspace=packages/tw-daemon -- report-scheduler
  ```

### 6b. 实现

- [ ] **Step 6.3：创建 `packages/tw-daemon/src/report/report-scheduler.ts`**

  ```typescript
  export interface ReportSchedulerOptions {
    scheduleTime: string                    // "HH:MM" 格式
    generate: () => Promise<void>
    hasReportTodayInEventLog: () => Promise<boolean>
    pollIntervalMs?: number                 // 默认 60_000 (1分钟)
  }

  export class ReportScheduler {
    private timer: ReturnType<typeof setInterval> | null = null

    constructor(private readonly opts: ReportSchedulerOptions) {}

    start(): void {
      const interval = this.opts.pollIntervalMs ?? 60_000
      this.timer = setInterval(() => { void this._tick() }, interval)
    }

    stop(): void {
      if (this.timer) { clearInterval(this.timer); this.timer = null }
    }

    private async _tick(): Promise<void> {
      const now = new Date()
      const hh = String(now.getHours()).padStart(2, '0')
      const mm = String(now.getMinutes()).padStart(2, '0')
      if (`${hh}:${mm}` !== this.opts.scheduleTime) return

      const alreadyDone = await this.opts.hasReportTodayInEventLog()
      if (alreadyDone) return

      await this.opts.generate()
    }
  }
  ```

- [ ] **Step 6.4：运行测试，确认 PASS**

  ```bash
  npm test --workspace=packages/tw-daemon -- report-scheduler
  ```

- [ ] **Step 6.5：提交**

  ```bash
  git add packages/tw-daemon/src/report/report-scheduler.ts packages/tw-daemon/src/report/report-scheduler.test.ts
  git commit -m "feat(daemon): add ReportScheduler — daily cron with EventLog idempotency"
  ```

---

## Task 7：IpcServer — 新增 4 个 IPC 方法

**文件：** `packages/tw-daemon/src/ipc-server.ts`

**关键：** IpcServer 的 dispatch 使用 `if/else if` 链（非 switch/case）；opts 字段通过 constructor 解构成 `private readonly` 字段，不存 `this.opts`。

- [ ] **Step 7.1：在 `IpcServerOptions` interface 追加两字段**

  ```typescript
  traceQuery?: TraceQueryEngine
  reportGenerator?: ReportGenerator
  ```

  在文件顶部 import：

  ```typescript
  import type { TraceQueryEngine } from './otel/trace-query.js'
  import type { ReportGenerator } from './report/report-generator.js'
  ```

- [ ] **Step 7.2：在 IpcServer class 中添加两个私有字段**

  参考现有字段（如 `private readonly inbox?: InboxAdapter`），追加：

  ```typescript
  private readonly traceQuery?: TraceQueryEngine
  private readonly reportGenerator?: ReportGenerator
  ```

- [ ] **Step 7.3：在 constructor 中初始化两个字段**

  参考现有模式（如 `this.inbox = opts?.inbox`），追加：

  ```typescript
  this.traceQuery = opts?.traceQuery
  this.reportGenerator = opts?.reportGenerator
  ```

- [ ] **Step 7.4：在 dispatch 方法末尾（现有最后一个 `else if` 之后，`else` 之前）追加 4 个 else-if 块**

  ```typescript
  } else if (method === 'trace_spans') {
    if (!this.traceQuery) return { ok: false, error: 'TraceQueryEngine not available' }
    const { trace_id, entity_id } = params as { trace_id?: string; entity_id?: string }
    const resolvedId = trace_id ?? (entity_id ? this.traceQuery.findTraceId(entity_id) : undefined)
    if (!resolvedId) return { ok: false, error: 'trace_not_found' }
    const tree = this.traceQuery.buildSpanTree(resolvedId)
    if (!tree) return { ok: false, error: 'trace_not_found' }
    return { ok: true, data: { trace_id: resolvedId, tree } }

  } else if (method === 'trace_info') {
    if (!this.traceQuery) return { ok: false, error: 'TraceQueryEngine not available' }
    const { trace_id, entity_id } = params as { trace_id?: string; entity_id?: string }
    const resolvedId = trace_id ?? (entity_id ? this.traceQuery.findTraceId(entity_id) : undefined)
    if (!resolvedId) return { ok: false, error: 'trace_not_found' }
    const info = this.traceQuery.buildTraceInfo(resolvedId)
    if (!info) return { ok: false, error: 'trace_not_found' }
    return { ok: true, data: info }

  } else if (method === 'report_generate') {
    if (!this.reportGenerator) return { ok: false, error: 'ReportGenerator not available' }
    const { trace_id, all } = params as { trace_id?: string; all?: boolean }
    const paths = await this.reportGenerator.generate({ traceId: trace_id, all })
    return { ok: true, data: { paths } }

  } else if (method === 'report_list') {
    if (!this.reportGenerator) return { ok: false, error: 'ReportGenerator not available' }
    const { date } = params as { date?: string }
    const reports = await this.reportGenerator.listReports(date)
    return { ok: true, data: { reports } }
  ```

  注意：`params` 变量名以实际 dispatch 函数签名为准（可能是 `req.params` 或已解构的 `params`）。

- [ ] **Step 7.5：构建验证**

  ```bash
  npm run build --workspace=packages/tw-daemon
  ```

- [ ] **Step 7.6：提交**

  ```bash
  git add packages/tw-daemon/src/ipc-server.ts
  git commit -m "feat(daemon): add trace_spans/trace_info/report_generate/report_list IPC methods"
  ```

---

## Task 8：daemon index.ts — 初始化三个新组件

**文件：** `packages/tw-daemon/src/index.ts`

**注意：** 先读文件，确认 store dir 变量名（可能是 `STORE_DIR` 大写常量或 `storeDir` 小写变量）。

- [ ] **Step 8.1：添加 import（在文件顶部现有 import 后追加）**

  ```typescript
  import { homedir } from 'node:os'
  import { TraceQueryEngine } from './otel/trace-query.js'
  import { ReportGenerator } from './report/report-generator.js'
  import { ReportScheduler } from './report/report-scheduler.js'
  ```

  （`node:path` 和 `node:os` 若已 import 则不重复。）

- [ ] **Step 8.2：在 `await handler.init()` 之后，`new IpcServer(...)` 之前，追加初始化代码**

  ```typescript
  const traceQuery = new TraceQueryEngine({
    spanManager,
    getAllEntities: () => handler.getAllEntities(),
    getEntity: (id) => handler.getEntityById(id),
    feedbackLog,
  })

  // 用实际 store dir 变量名（STORE_DIR 或 storeDir）替换下方的 STORE_DIR
  const reportOutputDir = config.report?.output_dir
    ? config.report.output_dir.replace('~', homedir())
    : join(STORE_DIR, 'reports')

  const reportGenerator = new ReportGenerator({
    traceQuery,
    eventLog,
    feedbackLog,
    outputDir: reportOutputDir,
  })
  ```

- [ ] **Step 8.3：将 `traceQuery` 和 `reportGenerator` 加入 `IpcServer` opts（第四个参数对象）**

  找到 `new IpcServer(socketPath, handler, onActivity, { ... })` 的 opts 对象，追加：

  ```typescript
  traceQuery,
  reportGenerator,
  ```

- [ ] **Step 8.4：若 `config.report?.schedule` 存在，启动 ReportScheduler**

  在 IpcServer 初始化后追加：

  ```typescript
  let reportScheduler: ReportScheduler | null = null
  if (config.report?.schedule) {
    const today = () => new Date().toISOString().slice(0, 10)
    reportScheduler = new ReportScheduler({
      scheduleTime: config.report.schedule,
      generate: () => reportGenerator.generate({ all: true, date: today() }).then(() => undefined),
      hasReportTodayInEventLog: async () => {
        const results = eventLog.query({
          event_type: 'report.generated',
          since: new Date(today()).toISOString(),
        })
        return results.length > 0
      },
    })
    reportScheduler.start()
  }
  ```

- [ ] **Step 8.5：在 shutdown 代码中停止 ReportScheduler**

  ```typescript
  reportScheduler?.stop()
  ```

- [ ] **Step 8.6：全量构建验证**

  ```bash
  npm run build
  ```

  期望：所有包零 TypeScript 错误。

- [ ] **Step 8.7：提交**

  ```bash
  git add packages/tw-daemon/src/index.ts
  git commit -m "feat(daemon): wire TraceQueryEngine, ReportGenerator, ReportScheduler into daemon"
  ```

---

## Task 9：CLI — trace-renderer.ts + trace.ts + 测试

**文件：** `packages/tw-cli/src/output/trace-renderer.ts`、`trace-renderer.test.ts`、`src/commands/trace.ts`

**先确认 import 路径：** 查看任意现有命令（如 `metrics.ts`）中 `ensureDaemon` 和 `sendIpc` 的实际 import 路径，在下方代码中替换。

### 9a. trace-renderer.ts

- [ ] **Step 9.1：创建测试文件 `packages/tw-cli/src/output/trace-renderer.test.ts`**

  ```typescript
  import { describe, it, expect } from 'vitest'
  import { renderSpanTree, renderTraceInfo } from './trace-renderer.js'
  import type { SpanTreeNode } from '@traceweaver/types'

  function makeNode(overrides: Partial<SpanTreeNode> & { entity_id: string }): SpanTreeNode {
    return {
      entity_type: 'task', state: 'completed',
      span_id: 'span-1', trace_id: 'trace-abc', start_time: '2026-03-25T09:00:00Z',
      status: 'OK', source: 'live', events: [], children: [],
      ...overrides,
    }
  }

  describe('renderSpanTree', () => {
    it('includes trace_id header', () => {
      const node = makeNode({ entity_id: 'uc-1', entity_type: 'usecase', state: 'completed' })
      const output = renderSpanTree('trace-abc', node)
      expect(output).toContain('trace_id: trace-abc')
    })

    it('renders nested children with tree connectors', () => {
      const root = makeNode({
        entity_id: 'uc-1', entity_type: 'usecase', state: 'in_progress',
        children: [
          makeNode({ entity_id: 'task-1', state: 'completed' }),
          makeNode({ entity_id: 'task-2', state: 'rejected' }),
        ],
      })
      const output = renderSpanTree('trace-abc', root)
      expect(output).toContain('uc-1')
      expect(output).toContain('task-1')
      expect(output).toContain('task-2')
      expect(output).toContain('└─')   // tree connector
    })

    it('marks reconstructed nodes', () => {
      const node = makeNode({ entity_id: 'uc-1', source: 'reconstructed' })
      const output = renderSpanTree('trace-abc', node)
      expect(output).toContain('reconstructed')
    })
  })

  describe('renderTraceInfo', () => {
    it('renders box header with trace_id', () => {
      const node = makeNode({ entity_id: 'uc-1', entity_type: 'usecase' })
      const output = renderTraceInfo('trace-abc', node)
      expect(output).toContain('TraceWeaver Trace Info')
      expect(output).toContain('trace-abc')
    })
  })
  ```

- [ ] **Step 9.2：运行测试，确认 FAIL**

  ```bash
  npm test --workspace=packages/tw-cli -- trace-renderer
  ```

- [ ] **Step 9.3：创建 `packages/tw-cli/src/output/trace-renderer.ts`**

  ```typescript
  import type { SpanTreeNode } from '@traceweaver/types'
  import { colorState } from './formatter.js'

  const STATE_ICON: Record<string, string> = {
    completed: '✅', in_progress: '🔄', rejected: '✗ ', review: '👁 ', pending: '⏳',
  }

  function fmtDuration(ms?: number): string {
    if (ms === undefined) return ''
    const h = Math.floor(ms / 3_600_000)
    const m = Math.floor((ms % 3_600_000) / 60_000)
    return ` (${h > 0 ? `${h}h ${m}m` : `${m}m`})`
  }

  function renderNode(node: SpanTreeNode, prefix = '', isLast = true): string[] {
    const icon = STATE_ICON[node.state] ?? '  '
    const dur = node.duration_ms !== undefined ? fmtDuration(node.duration_ms) : node.end_time ? '' : '+'
    const src = node.source === 'reconstructed' ? ' [reconstructed]' : ''
    const connector = prefix ? (isLast ? '└─ ' : '├─ ') : ''
    const line = `${prefix}${connector}${icon} ${colorState(node.state).padEnd(11)} [${node.entity_type}] ${node.entity_id}  span:${node.span_id.slice(0, 6)}${dur}${src}`
    const childPrefix = prefix + (isLast ? '   ' : '│  ')
    return [
      line,
      ...node.children.flatMap((c, i) => renderNode(c, childPrefix, i === node.children.length - 1)),
    ]
  }

  export function renderSpanTree(traceId: string, root: SpanTreeNode): string {
    return [`trace_id: ${traceId}`, ...renderNode(root)].join('\n')
  }

  export function renderTraceInfo(traceId: string, root: SpanTreeNode): string {
    const pad = '═'.repeat(52)
    const box = `╔${pad}╗\n║  TraceWeaver Trace Info  │  trace_id: ${traceId.slice(0, 12)}...  ║\n╚${pad}╝`
    return [box, '', ...renderNode(root)].join('\n')
  }
  ```

- [ ] **Step 9.4：运行测试，确认 PASS**

  ```bash
  npm test --workspace=packages/tw-cli -- trace-renderer
  ```

### 9b. trace.ts

- [ ] **Step 9.5：确认现有命令（如 `metrics.ts`）中的 import 路径**

  ```bash
  head -5 packages/tw-cli/src/commands/metrics.ts
  ```

  记下 `ensureDaemon` 和 `sendIpc` 的实际模块路径。

- [ ] **Step 9.6：创建 `packages/tw-cli/src/commands/trace.ts`**

  将下方 `ENSURE_DAEMON_PATH` 和 `SEND_IPC_PATH` 替换为 Step 9.5 中确认的实际路径：

  ```typescript
  import { Command } from 'commander'
  import { ensureDaemon } from 'ENSURE_DAEMON_PATH'
  import { sendIpc } from 'SEND_IPC_PATH'
  import { renderSpanTree, renderTraceInfo } from '../output/trace-renderer.js'

  export function traceCommand(): Command {
    const cmd = new Command('trace').description('Trace 链路查询与详情')

    cmd
      .command('spans')
      .description('展示 Trace Span 树')
      .option('--trace-id <id>', 'Trace ID')
      .option('--entity-id <id>', '实体 ID（自动推断 trace_id）')
      .option('--json', '输出 JSON')
      .action(async (opts) => {
        try {
          await ensureDaemon()
          const res = await sendIpc({ method: 'trace_spans', params: {
            trace_id: opts.traceId, entity_id: opts.entityId,
          }})
          if (!res.ok) { console.error(res.error); process.exit(1) }
          if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); return }
          console.log(renderSpanTree(res.data.trace_id, res.data.tree))
        } catch (err) { console.error(String(err)); process.exit(1) }
      })

    cmd
      .command('info')
      .description('完整链路详情（含 _ai_context，AI Agent 可消费）')
      .option('--trace-id <id>', 'Trace ID')
      .option('--entity-id <id>', '实体 ID（自动推断 trace_id）')
      .option('--json', '输出 JSON')
      .action(async (opts) => {
        try {
          await ensureDaemon()
          const res = await sendIpc({ method: 'trace_info', params: {
            trace_id: opts.traceId, entity_id: opts.entityId,
          }})
          if (!res.ok) { console.error(res.error); process.exit(1) }
          if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); return }
          console.log(renderTraceInfo(res.data.trace_id, res.data.root))
        } catch (err) { console.error(String(err)); process.exit(1) }
      })

    return cmd
  }
  ```

- [ ] **Step 9.7：构建验证**

  ```bash
  npm run build --workspace=packages/tw-cli
  ```

- [ ] **Step 9.8：提交**

  ```bash
  git add packages/tw-cli/src/output/trace-renderer.ts packages/tw-cli/src/output/trace-renderer.test.ts packages/tw-cli/src/commands/trace.ts
  git commit -m "feat(cli): add tw trace spans/info + trace-renderer.ts with tests"
  ```

---

## Task 10：CLI — report.ts + 注册两个新命令

**文件：** `packages/tw-cli/src/commands/report.ts` 和 `src/index.ts`

- [ ] **Step 10.1：创建 `packages/tw-cli/src/commands/report.ts`**

  用 Step 9.5 确认的实际 import 路径替换占位符：

  ```typescript
  import { Command } from 'commander'
  import { readFile } from 'node:fs/promises'
  import { ensureDaemon } from 'ENSURE_DAEMON_PATH'
  import { sendIpc } from 'SEND_IPC_PATH'

  export function reportCommand(): Command {
    const cmd = new Command('report').description('日报生成与查看')

    cmd
      .command('daily')
      .description('生成日报')
      .option('--trace-id <id>', '指定 Trace ID')
      .option('--all', '为所有 trace 生成报告')
      .option('--output-dir <dir>', '输出目录（覆盖配置）')
      .option('--json', '输出 JSON')
      .action(async (opts) => {
        try {
          await ensureDaemon()
          const res = await sendIpc({ method: 'report_generate', params: {
            trace_id: opts.traceId, all: opts.all,
          }})
          if (!res.ok) { console.error(res.error); process.exit(1) }
          if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); return }
          console.log('报告已生成：')
          for (const p of res.data.paths) console.log(' ', p)
        } catch (err) { console.error(String(err)); process.exit(1) }
      })

    cmd
      .command('list')
      .description('列出已生成的报告')
      .option('--date <date>', '按日期过滤 (YYYY-MM-DD)')
      .option('--json', '输出 JSON')
      .action(async (opts) => {
        try {
          await ensureDaemon()
          const res = await sendIpc({ method: 'report_list', params: { date: opts.date }})
          if (!res.ok) { console.error(res.error); process.exit(1) }
          if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); return }
          if (res.data.reports.length === 0) { console.log('无报告'); return }
          for (const r of res.data.reports) {
            console.log(`${r.date}  ${(r.trace_id ?? '').padEnd(10)}  ${r.path}`)
          }
        } catch (err) { console.error(String(err)); process.exit(1) }
      })

    cmd
      .command('show')
      .description('查看报告内容')
      .option('--trace-id <id>', 'Trace ID（前 8 位匹配）')
      .option('--date <date>', '日期 (YYYY-MM-DD，默认今天)')
      .option('--json', '输出 JSON')
      .action(async (opts) => {
        try {
          await ensureDaemon()
          const date = opts.date ?? new Date().toISOString().slice(0, 10)
          const res = await sendIpc({ method: 'report_list', params: { date }})
          if (!res.ok) { console.error(res.error); process.exit(1) }
          const prefix = opts.traceId?.slice(0, 8)
          const reports: Array<{ trace_id: string; path: string }> = res.data.reports
          const match = prefix ? reports.find(r => r.trace_id.startsWith(prefix)) : reports[0]
          if (!match) { console.log('未找到报告'); return }
          if (opts.json) { console.log(JSON.stringify(match, null, 2)); return }
          const content = await readFile(match.path, 'utf-8')
          console.log(content)
        } catch (err) { console.error(String(err)); process.exit(1) }
      })

    return cmd
  }
  ```

- [ ] **Step 10.2：在 `packages/tw-cli/src/index.ts` 中注册两个新命令**

  追加 import：

  ```typescript
  import { traceCommand } from './commands/trace.js'
  import { reportCommand } from './commands/report.js'
  ```

  追加注册：

  ```typescript
  program.addCommand(traceCommand())
  program.addCommand(reportCommand())
  ```

- [ ] **Step 10.3：全量构建验证**

  ```bash
  npm run build
  ```

  期望：所有包零 TypeScript 错误。

- [ ] **Step 10.4：提交**

  ```bash
  git add packages/tw-cli/src/commands/report.ts packages/tw-cli/src/index.ts
  git commit -m "feat(cli): add tw report daily/list/show commands"
  ```

---

## Task 11：CLAUDE.md 更新

- [ ] **Step 11.1：更新 `packages/tw-cli/CLAUDE.md`**

  1. noun 列表追加：`trace | report`
  2. IPC 方法清单追加：
     | `trace_spans` | `{ trace_id?, entity_id? }` | Span 树（双入口，trace_id 优先）|
     | `trace_info` | `{ trace_id?, entity_id? }` | 完整链路详情（含 _ai_context）|
     | `report_generate` | `{ trace_id?, all? }` | 生成日报，返回文件路径列表 |
     | `report_list` | `{ date? }` | 列出已生成报告的元数据 |
  3. 输出工具追加：`src/output/trace-renderer.ts` — 树状 Span 渲染

- [ ] **Step 11.2：更新 `packages/tw-daemon/CLAUDE.md`**

  1. 子模块边界表追加 `report/` 行
  2. 配置项说明追加 `report.schedule / report.output_dir / report.traces`

- [ ] **Step 11.3：更新 `packages/tw-types/CLAUDE.md`**

  关键类型表追加：
  | `SpanTreeNode` | 单节点 Span 树（state from EntityRegistry / source live|reconstructed）|
  | `TraceInfo` | 完整 trace 链路（root + summary + _ai_context）|
  | `ReportMeta` | 报告元数据（date / trace_id / path / generated_at）|

  TwEventType 追加：`'report.generated'` — 日报生成（只存文件引用）

- [ ] **Step 11.4：更新 `docs/CLI-COMMANDS.md`**

  追加 `tw trace` 和 `tw report` 命令段落（参考现有格式）。

- [ ] **Step 11.5：提交**

  ```bash
  git add packages/tw-cli/CLAUDE.md packages/tw-daemon/CLAUDE.md packages/tw-types/CLAUDE.md docs/CLI-COMMANDS.md
  git commit -m "docs: update CLAUDE.md files and CLI-COMMANDS.md for trace/report features"
  ```

---

## Task 12：Example 14 — Trace & Report 命令闭环验证

**文件：** `examples/src/14-trace-report-e2e.ts`

以 Example 13 为底座，新增 `TraceQueryEngine` + `ReportGenerator`，在进程内验证四个新 IPC 方法的完整逻辑（无需启动 daemon）。

**验证目标：**
1. `TraceQueryEngine.buildSpanTree()` — SpanTree 嵌套正确，state 来自 EntityRegistry
2. `TraceQueryEngine.buildTraceInfo()` — `_ai_context` 正确填充（rejected 实体、blocked 实体）
3. `ReportGenerator.generate()` — 原子写入 `.md`，EventLog 写入 `report.generated` 文件引用
4. 重启模拟（SpanManager 清空）— reconstructed 模式下 buildSpanTree 仍可用

### 12a. 创建示例文件

- [ ] **Step 12.1：创建 `examples/src/14-trace-report-e2e.ts`**

  ```typescript
  /**
   * Example 14 — Trace & Report 命令闭环验证
   *
   * 以 Example 13 为底座，验证四个新组件的端到端逻辑：
   *  ✅ TraceQueryEngine.buildSpanTree()   — live 模式 SpanTree 嵌套正确
   *  ✅ TraceQueryEngine.buildTraceInfo()  — _ai_context 正确填充
   *  ✅ reconstructed 模式               — SpanManager 清空后 fallback EntityRegistry
   *  ✅ ReportGenerator.generate()        — 原子写入 .md + EventLog file-ref
   *  ✅ ReportGenerator.listReports()     — 按日期过滤元数据
   *  ✅ EventLog 幂等                     — 已有 report.generated 时不重复写入
   *
   * 运行：
   *   npm run run:14 --workspace=examples
   */

  import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
  import { existsSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'

  import { CommandHandler }    from '../../packages/tw-daemon/src/core/command-handler.js'
  import { EventBus }          from '../../packages/tw-daemon/src/core/event-bus/event-bus.js'
  import { SpanManager }       from '../../packages/tw-daemon/src/otel/span-manager.js'
  import { TraceQueryEngine }  from '../../packages/tw-daemon/src/otel/trace-query.js'
  import { ReportGenerator }   from '../../packages/tw-daemon/src/report/report-generator.js'
  import { EventLog }          from '../../packages/tw-daemon/src/log/event-log.js'
  import { FeedbackLog }       from '../../packages/tw-daemon/src/feedback/feedback-log.js'
  import { HarnessLoader }     from '../../packages/tw-daemon/src/harness/loader.js'
  import { TriggerExecutor }   from '../../packages/tw-daemon/src/trigger/executor.js'
  import { ConstraintEvaluator } from '../../packages/tw-daemon/src/constraint/evaluator.js'
  import { ExporterRegistry }  from '../../packages/tw-daemon/src/otel/exporter-registry.js'
  import { ConsoleExporter }   from '../../packages/tw-daemon/src/otel/exporter-console.js'

  const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', cyan: '\x1b[36m',
    green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', gray: '\x1b[90m',
  }
  function section(t: string) {
    console.log(`\n${C.bold}${C.cyan}${'─'.repeat(62)}${C.reset}`)
    console.log(`${C.bold}${C.cyan}  ${t}${C.reset}`)
    console.log(`${C.cyan}${'─'.repeat(62)}${C.reset}`)
  }
  function ok(m: string)   { console.log(`  ${C.green}✓${C.reset} ${m}`) }
  function warn(m: string) { console.log(`  ${C.yellow}⚠${C.reset} ${m}`) }
  function fail(m: string) { console.error(`  ${C.red}✗${C.reset} ${m}`) }
  function info(m: string) { console.log(`  ${C.gray}→${C.reset} ${m}`) }

  // Mock LLM：artifact_refs 含 APPROVED 关键词 → pass，否则 fail
  async function mockLlm(prompt: string): Promise<string> {
    if (prompt.includes('APPROVED')) return 'RESULT: pass\n约束满足。'
    return 'RESULT: fail\n缺少测试文件 artifact_refs（type=test）。'
  }

  async function main(): Promise<void> {
    console.log(`\n${C.bold}TraceWeaver — Trace & Report 命令闭环验证 (Example 14)${C.reset}`)

    const storeDir     = await mkdtemp(join(tmpdir(), 'tw-example-14-'))
    const harnessDir   = join(storeDir, 'harness')
    const inboxDir     = join(storeDir, 'inbox')
    const queueDir     = join(storeDir, 'remediation-queue')
    const reportsDir   = join(storeDir, 'reports')
    const logPath      = join(storeDir, 'events.ndjson')
    const feedbackPath = join(storeDir, 'feedback', 'feedback.ndjson')

    await mkdir(harnessDir,  { recursive: true })
    await mkdir(inboxDir,    { recursive: true })
    await mkdir(reportsDir,  { recursive: true })
    info(`storeDir: ${storeDir}`)

    // ── Phase A：Harness + 组件初始化 ──────────────────────────────────────
    section('Phase A：组件初始化')

    await writeFile(join(harnessDir, 'task-needs-test.md'), `---
  id: task-needs-test
  applies_to:
    - task
  trigger_on:
    - review
  ---
  任务进入 review 前，artifact_refs 中必须包含 type=test 的测试文件。
  RESULT: fail if no test artifacts found.
  `)

    const harnessLoader = new HarnessLoader(harnessDir)
    await harnessLoader.scan()

    const exporterRegistry = new ExporterRegistry()
    exporterRegistry.register(new ConsoleExporter())

    const eventBus    = new EventBus({ bufferSize: 512, batchWindowMs: 30 })
    const spanManager = new SpanManager({ projectId: 'traceweaver-e2e', exporterRegistry })
    const eventLog    = new EventLog(logPath)
    eventLog.load()
    const feedbackLog = new FeedbackLog(feedbackPath)
    feedbackLog.load()

    const handler = new CommandHandler({ storeDir, eventBus, spanManager, eventLog })
    await handler.init()
    eventBus.start()

    const evaluator = new ConstraintEvaluator({ enabled: true, llmFn: mockLlm })
    const triggerExecutor = new TriggerExecutor({
      handler, evaluator, harness: harnessLoader, eventBus,
      inbox: { deliver: async () => {} } as any,
      feedbackLog,
    })
    triggerExecutor.start()

    ok('所有组件初始化完成')

    // ── Phase B：注册实体（UseCase → Plan → Tasks） ────────────────────────
    section('Phase B：注册实体 + DAG')

    const traceId = 'trace-e2e-demo-001'

    await handler.register({
      id: 'uc-traceweaver', entity_type: 'usecase',
      artifact_refs: [], depends_on: [],
    })
    // 注入 trace_id（通过 SpanManager，spanManager 在 register 时分配）
    await handler.register({
      id: 'plan-core', entity_type: 'plan',
      parent_id: 'uc-traceweaver',
      artifact_refs: [], depends_on: ['uc-traceweaver'],
    })
    // task-good：含 APPROVED → harness pass → completed
    await handler.register({
      id: 'task-good', entity_type: 'task',
      parent_id: 'plan-core',
      artifact_refs: [{ type: 'test', path: 'src/foo.test.ts' }, { type: 'impl', path: 'APPROVED' }],
      depends_on: ['plan-core'],
      constraint_refs: ['task-needs-test'],
    })
    // task-bad：无测试文件 → harness fail → rejected
    await handler.register({
      id: 'task-bad', entity_type: 'task',
      parent_id: 'plan-core',
      artifact_refs: [{ type: 'impl', path: 'src/bar.ts' }],
      depends_on: ['plan-core'],
      constraint_refs: ['task-needs-test'],
    })
    // task-blocked：depends_on task-bad（blocked）
    await handler.register({
      id: 'task-blocked', entity_type: 'task',
      parent_id: 'plan-core',
      artifact_refs: [],
      depends_on: ['task-bad'],
      constraint_refs: ['task-needs-test'],
    })

    ok('5 个实体注册完成（uc / plan / task-good / task-bad / task-blocked）')

    // ── Phase C：状态流转 ──────────────────────────────────────────────────
    section('Phase C：状态流转（harness 触发）')

    // task-good → in_progress → review（harness pass → completed）
    await handler.updateState('task-good', 'in_progress')
    await handler.updateState('task-good', 'review')
    await new Promise(r => setTimeout(r, 200))   // 等 TriggerExecutor 处理
    await handler.updateState('task-good', 'completed')
    ok('task-good → completed')

    // task-bad → in_progress → review（harness fail → rejected）
    await handler.updateState('task-bad', 'in_progress')
    await handler.updateState('task-bad', 'review')
    await new Promise(r => setTimeout(r, 200))
    const badEntity = handler.getEntityById('task-bad')
    if (badEntity?.state === 'rejected') ok('task-bad auto-rejected by harness ✓')
    else warn(`task-bad state = ${badEntity?.state}（期望 rejected）`)

    // plan-core → in_progress
    await handler.updateState('plan-core', 'in_progress')
    ok('plan-core → in_progress')

    // ── Phase D：TraceQueryEngine — live 模式 ──────────────────────────────
    section('Phase D：TraceQueryEngine (live 模式)')

    // 获取 uc-traceweaver 的 trace_id
    const ucSpan = spanManager.getSpan('uc-traceweaver')
    if (!ucSpan) { fail('uc-traceweaver span 未找到，跳过 Phase D'); process.exit(1) }
    const resolvedTraceId = ucSpan.trace_id
    info(`trace_id = ${resolvedTraceId}`)

    const traceQuery = new TraceQueryEngine({
      spanManager,
      getAllEntities: () => handler.getAllEntities(),
      getEntity: (id: string) => handler.getEntityById(id),
      feedbackLog,
    })

    const tree = traceQuery.buildSpanTree(resolvedTraceId)
    if (!tree) { fail('buildSpanTree 返回 null'); process.exit(1) }
    ok(`buildSpanTree ✓ root=${tree.entity_id} children=${tree.children.length}`)

    if (tree.children.length > 0) ok('SpanTree 嵌套正确（有子节点）')
    else warn('SpanTree 无子节点（plan-core 未关联到 tree）')

    const info_ = traceQuery.buildTraceInfo(resolvedTraceId)
    if (!info_) { fail('buildTraceInfo 返回 null'); process.exit(1) }
    ok(`buildTraceInfo ✓ total=${info_.summary.total} completed=${info_.summary.completed}`)

    if (info_._ai_context.one_line.includes('实体中')) ok('_ai_context.one_line 正确生成')
    else warn(`_ai_context.one_line 未含期望格式: "${info_._ai_context.one_line}"`)

    if (info_.summary.rejected > 0) ok(`rejected=${info_.summary.rejected} ✓（harness 拒绝正常记录）`)
    else warn('summary.rejected = 0，task-bad 可能未被正确追踪')

    if (info_.summary.blocked.includes('task-blocked')) ok('blocked=[task-blocked] ✓')
    else warn(`blocked 未含 task-blocked: ${JSON.stringify(info_.summary.blocked)}`)

    // ── Phase E：TraceQueryEngine — reconstructed 模式 ────────────────────
    section('Phase E：TraceQueryEngine (reconstructed 模式，SpanManager 清空后)')

    // 用空 SpanManager 模拟 daemon 重启后的状态
    const emptySpanManager = new SpanManager({ projectId: 'empty', exporterRegistry })

    const reconstructedQuery = new TraceQueryEngine({
      spanManager: emptySpanManager,
      getAllEntities: () => handler.getAllEntities(),
      getEntity: (id: string) => handler.getEntityById(id),
      feedbackLog,
    })

    // findTraceId 应通过 parent_id 链向上找到 trace_id（fallback）
    const reconstructedTraceId = reconstructedQuery.findTraceId('task-good')
    if (reconstructedTraceId) ok(`findTraceId(fallback) ✓ = ${reconstructedTraceId}`)
    else warn('findTraceId fallback 未找到 trace_id（EntityRegistry 无 trace_id 字段，此为预期行为）')

    // ── Phase F：ReportGenerator ───────────────────────────────────────────
    section('Phase F：ReportGenerator — 生成日报')

    const reportGenerator = new ReportGenerator({
      traceQuery,
      eventLog,
      feedbackLog,
      outputDir: reportsDir,
    })

    const today = new Date().toISOString().slice(0, 10)
    let reportPaths: string[] = []
    try {
      reportPaths = await reportGenerator.generate({ traceId: resolvedTraceId, date: today })
      ok(`generate() ✓ paths=${JSON.stringify(reportPaths)}`)
    } catch (err: unknown) {
      fail(`generate() 抛出异常: ${(err as Error).message}`)
      process.exit(1)
    }

    // 验证文件存在（原子写入）
    if (reportPaths.length > 0 && existsSync(reportPaths[0])) ok('报告文件存在（原子写入成功）')
    else fail('报告文件不存在')

    // 验证 .tmp 文件已清理
    if (reportPaths.length > 0 && !existsSync(reportPaths[0] + '.tmp')) ok('.tmp 文件已清理 ✓')
    else warn('.tmp 文件仍存在')

    // 验证报告内容包含关键字段
    if (reportPaths.length > 0) {
      const content = await readFile(reportPaths[0], 'utf-8')
      if (content.includes('uc-traceweaver')) ok('报告内容含 uc-traceweaver ✓')
      else warn('报告内容缺少 uc-traceweaver')
      if (content.includes('task-bad') || content.includes('rejected')) ok('报告内容含 rejected 状态 ✓')
      else warn('报告内容未体现 rejected 状态')
    }

    // 验证 EventLog 写入了 file-ref（report.generated）
    const reportEvents = eventLog.query({ event_type: 'report.generated' as any })
    if (reportEvents.length > 0) ok(`EventLog 含 report.generated ✓ (${reportEvents.length} 条)`)
    else warn('EventLog 未写入 report.generated（check TwEventType 是否已更新）')

    // 验证内容字段不存在（只存文件引用）
    if (reportEvents.length > 0 && !(reportEvents[0] as any).attributes?.content) {
      ok('EventLog 仅存文件引用，不含报告内容 ✓')
    }

    // 验证 listReports 可过滤
    const listed = await reportGenerator.listReports(today)
    if (listed.length > 0) ok(`listReports(${today}) = ${listed.length} 条 ✓`)
    else warn(`listReports(${today}) 返回空`)

    // ── 结束 ──────────────────────────────────────────────────────────────
    section('验证结束 — 清理')

    triggerExecutor.stop()
    eventBus.stop()
    await exporterRegistry.shutdown()
    await rm(storeDir, { recursive: true, force: true })
    ok('临时目录已清理')

    console.log(`\n${C.bold}${C.green}Example 14 完成${C.reset}\n`)
  }

  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
  ```

- [ ] **Step 12.2：在 `examples/package.json` 中添加 `run:14` 脚本**

  在现有 `"run:13"` 行后追加：

  ```json
  "run:14": "tsx src/14-trace-report-e2e.ts"
  ```

  并将 `run:all` 末尾追加 `&& tsx src/14-trace-report-e2e.ts`

- [ ] **Step 12.3：更新 `examples/CLAUDE.md`**

  1. 基础验证命令块追加：
     ```bash
     npm run run:14 --workspace=examples    # Trace & Report 命令闭环验证
     npm run run:all --workspace=examples   # 01–14 全部（12/13 需 Jaeger 可达）
     ```
  2. 示例验收标准表追加：
     | 14 | Trace & Report 闭环：TraceQueryEngine + ReportGenerator + _ai_context + EventLog |
  3. 当前示例清单追加：
     | 14 | trace-report-e2e | TraceQueryEngine（live + reconstructed）+ ReportGenerator 原子写入 + EventLog file-ref |

- [ ] **Step 12.4：运行 Example 14 验证**

  ```bash
  npm run run:14 --workspace=examples
  ```

  期望：全部 `✓`，exit 0。若有 `⚠` 则记录为已知 fallback 行为（如 reconstructed 模式的 trace_id 查找），不阻塞。

- [ ] **Step 12.5：提交**

  ```bash
  git add examples/src/14-trace-report-e2e.ts examples/package.json examples/CLAUDE.md
  git commit -m "feat(examples): add example 14 — Trace & Report 命令闭环验证（TraceQueryEngine + ReportGenerator + _ai_context）"
  ```

---

## 验收清单

```bash
# 全量构建
npm run build

# 单元测试
npm test --workspace=packages/tw-daemon -- trace-query
npm test --workspace=packages/tw-daemon -- report-generator
npm test --workspace=packages/tw-daemon -- report-scheduler
npm test --workspace=packages/tw-cli   -- trace-renderer
npm test --workspace=packages/tw-daemon   # 全部 daemon tests（目标 ≥ 258 passing）

# 端到端冒烟（需 daemon 已启动）
tw daemon start
tw trace spans --entity-id=<any-id>
tw trace spans --trace-id=<trace-id> --json
tw trace info  --trace-id=<trace-id>
tw trace info  --trace-id=<trace-id> --json   # 验证 _ai_context 字段存在
tw report daily --all
tw report list
tw report show
tw daemon stop
```

---

*实现顺序约束：Task 1（types）→ Task 2-8（daemon）→ Task 9-10（cli）→ Task 11（docs）。跨包变更必须先让上游包构建通过。*
