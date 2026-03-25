# TraceWeaver Trace & Report 功能设计 Spec

> 版本：v1.2（reviewer 修正 × 2）
> 日期：2026-03-25
> 状态：待实现

---

## 目标

为 TraceWeaver 补齐三个能力：

1. **每日汇报**（`tw report`）：按 TraceId 维度聚合 UseCase/Plan/Task 的完成进度、阻塞、Error Log，生成结构化 `.md` 报告；支持手动触发与 Daemon 定时生成。
2. **Trace Span 查询**（`tw trace spans`）：从任意维度（trace_id 或 entity_id）进入，展示完整 Span 树，供上游按需获取执行流程。
3. **链路详情展示**（`tw trace info`）：从根 Span 出发展示完整链路（含事件、Harness 结果、耗时），默认人类可读树状文本，`--json` 输出含 `_ai_context` 摘要字段，专为 AI Agent 消费设计。

---

## 架构

### 新增组件

```
packages/tw-daemon/src/
  otel/
    trace-query.ts           TraceQueryEngine — 三个功能的共享查询层
    trace-query.test.ts
  report/
    report-generator.ts      ReportGenerator — 生成 .md 报告
    report-generator.test.ts
    report-scheduler.ts      ReportScheduler — cron 定时触发
    report-scheduler.test.ts

packages/tw-cli/src/
  commands/
    trace.ts                 tw trace spans | info
    report.ts                tw report daily | show | list
  output/
    trace-renderer.ts        树状文本渲染（从 trace.ts 抽取，避免超出 100 行限制）

packages/tw-types/src/index.ts
  + SpanTreeNode
  + TraceInfo
  + ReportMeta
  + 'report.generated' 加入 TwEventType 联合类型
```

### SpanManager 易失性策略（关键约束）

**SpanManager 是内存存储**，daemon 重启后 spans 清空。`TraceQueryEngine` 采用**双来源策略**：

1. **优先读 SpanManager**（live 数据）：有 `span_id`、`events`、`start_time`、`end_time`、精确 `duration_ms`
2. **Fallback 读 EntityRegistry**（持久化数据）：有 `entity_type`、`state`、`depends_on`、`parent_id`，可重建 trace 树结构（无 `span_id`、无 events detail）

当 SpanManager 无数据（daemon 重启后）：`TraceQueryEngine` 从 `EntityRegistry.getAll()` 重建虚拟 Span 树，`span_id` 用 `entity_id` 代替，`events` 从 `EventLog` 查询重建，`duration_ms` 为 `undefined`。`tw trace spans` 和 `tw trace info` 正常工作，数据标注 `source: 'reconstructed'`。

### 数据流

```
CLI tw trace / tw report
      ↓ IPC
  ipc-server.ts（4 个新方法，需更新 IpcServerOptions）
      ↓
  TraceQueryEngine(spanManager, getAllEntities, getEntity, feedbackLog)
      ↑ 双来源：SpanManager(live) + handler.getAllEntities()/getEntity() fallback
      ↓ SpanTreeNode 树（含 state from EntityRegistry，harness_results from FeedbackLog）
  ReportGenerator(traceQuery, getAllEntities, eventLog, feedbackLog)
      ↓
  reports/YYYY-MM-DD-<traceId前8位>.md  +  EventLog 写入 file-ref 事件
```

### IpcServerOptions 更新

在 `ipc-server.ts` 的 `IpcServerOptions` 中新增：

```typescript
interface IpcServerOptions {
  // ... 现有字段 ...
  traceQuery?: TraceQueryEngine      // trace_spans / trace_info
  reportGenerator?: ReportGenerator  // report_generate / report_list
}
```

新 IPC 方法以 `if (!this.traceQuery) throw Object.assign(new Error('TraceQueryEngine not available'), { code: 'NOT_AVAILABLE' })` 守卫。

daemon `src/index.ts` 初始化顺序（紧跟现有 `await handler.init()` 之后）：

> **注意**：`EntityRegistry` 在 `CommandHandler` 内部为 `private readonly`，无法直接访问。
> `TraceQueryEngine` 通过回调函数接收数据访问能力，避免破坏 `CommandHandler` 封装。

```typescript
// handler.getAllEntities() 和 handler.getEntity(id) 是 CommandHandler 上已有的公开方法
const traceQuery = new TraceQueryEngine({
  spanManager,
  getAllEntities: () => handler.getAllEntities(),
  getEntity: (id) => handler.getEntity(id),
  feedbackLog,
})
const reportGenerator = new ReportGenerator({
  traceQuery,
  getAllEntities: () => handler.getAllEntities(),
  eventLog,
  feedbackLog,
  outputDir: config.report?.output_dir ?? '~/.traceweaver/reports/',
})

// IpcServer 构造函数签名：new IpcServer(socketPath, handler, onActivity?, opts?)
// traceQuery / reportGenerator 通过第四个参数 opts 传入
const ipcServer = new IpcServer(
  SOCKET_PATH,
  handler,
  () => { lastActivity = Date.now() },
  { inbox, eventLog, spanMetrics, harnessLoader, triggerExecutor, feedbackLog,
    harnessValidator, traceQuery, reportGenerator },
)
```

**实现顺序约束（防止 TypeScript 构建失败）**：
1. `tw-types` 先添加 `SpanTreeNode / TraceInfo / ReportMeta` 和 `'report.generated'` → 构建验证
2. `tw-daemon` 再实现 `TraceQueryEngine / ReportGenerator / ReportScheduler` → 构建验证
3. `tw-cli` 最后实现 `trace.ts / report.ts` → 构建验证

跨包变更必须按此顺序，否则 `TwEventType` 的 `'report.generated'` 在步骤 2 写入 `eventLog.append()` 时会报 TypeScript 类型错误。

### 架构边界

- `TraceQueryEngine` 只读（SpanManager / EntityRegistry / FeedbackLog），不改任何状态
- `report/` 子模块不能 import `trigger/` 或 `harness/`
- `_ai_context` 字段由**确定性字符串模板**生成（不调用 LLM），见下方规则
- Error 的软/硬引用分类由外部 AI Agent 根据自身上下文判断，TraceWeaver 只做结构化输出

---

## Feature 1：每日汇报（`tw report`）

### ReportGenerator

从四个来源聚合数据：

| 数据 | 来源 | 持久化 |
|------|------|--------|
| 实体状态与进度 | `EntityRegistry` | ✅ WAL |
| 事件时间线与 Error Log | `EventLog` | ✅ NDJSON |
| Harness 评估统计 | `FeedbackLog` | ✅ NDJSON |
| Span 树与耗时 | `TraceQueryEngine` | ⚠️ 双来源（见上） |

生成路径：`config.report.output_dir/YYYY-MM-DD-<traceId前8位>.md`

写入策略：先写临时文件 `<path>.tmp`，成功后原子 rename → `<path>`，防止部分写入导致下次存在性检查误判。

### 报告格式

```markdown
# TraceWeaver 日报 — 2026-03-25

## 概览
| trace_id | 生成时间 | 项目 |
| abc12345... | 2026-03-25T09:00:00Z | traceweaver-minikms |

## 进度摘要
| 实体 | 类型 | 状态 | 子任务 |
| uc-minikms | usecase | ✅ completed | 3/3 plans |
| plan-infra  | plan    | ✅ completed | 3/3 tasks |
| plan-api    | plan    | 🔄 in_progress | 2/3 tasks |

## 已完成
- [task] tm-1  tm-2  tm-3  tm-4

## 进行中
- [task] tm-5 — 等待修复（rejected by task-needs-test）

## 阻塞
- [task] tm-5 → rejected by `task-needs-test`
  - 最后事件：2026-03-25T08:30:00Z  msg="未发现测试文件引用"

## Error Log
- [ERROR] 2026-03-25T08:30:00Z entity_id=tm-5 harness=task-needs-test msg="..."

## Harness 评估统计
| harness | pass | fail | 失败率 |
| task-needs-test | 4 | 1 | 20% |

---
_ref: events.ndjson → type=report.generated ts=... path=reports/2026-03-25-abc12345.md_
```

### EventLog 写入（仅文件引用，类型为 `report.generated`）

```json
{
  "id": "...",
  "type": "report.generated",
  "ts": "2026-03-25T09:00:00Z",
  "attributes": {
    "report_path": "~/.traceweaver/reports/2026-03-25-abc12345.md",
    "trace_id": "abc12345..."
  }
}
```

`'report.generated'` 需加入 `tw-types/src/index.ts` 的 `TwEventType` 联合类型。

### ReportScheduler（cron）

```yaml
# config.yaml
report:
  schedule: "09:00"                    # 每天本地时间 09:00 触发
  output_dir: "~/.traceweaver/reports/"
  traces: all                          # all | [trace_id, ...]
```

幂等策略：触发前先检查 EventLog 中当日是否已有 `report.generated` 事件（不依赖文件存在性）。若 EventLog 有记录则跳过，避免文件部分写入时的误判。

### CLI 命令

```bash
tw report daily [--trace-id=xxx | --all] [--output-dir=path] [--json]
tw report show  [--trace-id=xxx | --date=2026-03-25]           [--json]
tw report list  [--date=2026-03-25]                            [--json]
```

**CLI 实现规范**：
- `packages/tw-cli/src/commands/report.ts` — 导出 `export function reportCommand(): Command`，在 `src/index.ts` 用 `program.addCommand(reportCommand())` 注册
- `packages/tw-cli/src/commands/trace.ts` — 导出 `export function traceCommand(): Command`，同上注册
- 树状渲染逻辑提取到 `src/output/trace-renderer.ts`，确保 `trace.ts` 不超过 100 行

### `report_generate` 错误边界

- `trace_id` 不存在（SpanManager + EntityRegistry 均无）→ `{ ok: false, error: 'trace_not_found' }`
- `trace_id` 存在但无子实体 → 生成仅含概览的最小报告，`paths` 非空
- 无参数且无 `all: true` → `{ ok: false, error: 'missing_trace_id_or_all' }`

---

## Feature 2：Trace Span 查询（`tw trace spans`）

### 命令

```bash
tw trace spans --entity-id=tm-5
tw trace spans --trace-id=abc123 --json
```

两个参数同时传时以 `--trace-id` 优先。任意一个均可作为入口。

### 默认输出（树状）

```
trace_id: abc123...8ef
─ uc-minikms        [usecase]  ✅ completed   span: a1b2c3
  ├─ plan-infra     [plan]     ✅ completed   span: d4e5f6
  │   ├─ tm-1       [task]     ✅ completed   span: g7h8i9
  │   └─ tm-3       [task]     ✅ completed   span: m3n4o5
  └─ plan-api       [plan]     🔄 in_progress span: p6q7r8
      ├─ tm-5       [task]     ✗  rejected    span: v2w3x4
      └─ tm-6       [task]     🔄 in_progress span: w3x4y5
```

### `--json` 输出

扁平数组，每节点含：`entity_id / entity_type / state / span_id / trace_id / parent_span_id / depth / source`（`source: 'live' | 'reconstructed'`）

---

## Feature 3：链路详情（`tw trace info`）

### 命令

```bash
tw trace info --entity-id=uc-minikms
tw trace info --trace-id=abc123 --json
```

### 默认输出（树 + 事件 + Harness 结果 + 耗时）

```
╔══════════════════════════════════════════════════════╗
║  TraceWeaver Trace Info  │  trace_id: abc123...8ef   ║
╚══════════════════════════════════════════════════════╝

[usecase] uc-minikms  ✅ completed  (2h 31m)
  events: registered → in_progress → review → completed
  ├─ [plan] plan-infra  ✅ completed  (58m)
  │    ├─ [task] tm-1  ✅ completed  harness: task-needs-test → PASS
  │    └─ [task] tm-3  ✅ completed  harness: task-needs-test → PASS
  └─ [plan] plan-api  🔄 in_progress  (1h 12m+)
       ├─ [task] tm-5  ✗  rejected
       │    harness: task-needs-test → FAIL
       │    reason: "未发现测试文件引用"
       │    error_ref: events.ndjson#entity_id=tm-5&type=entity.state_changed
       └─ [task] tm-6  🔄 in_progress  (blocked by tm-5)
```

树状文本渲染逻辑（含 box-drawing 字符）提取到 `packages/tw-cli/src/output/trace-renderer.ts`，保持 `trace.ts` 在 100 行限制内。

### `--json` 输出

```json
{
  "trace_id": "abc123...",
  "root": {
    "entity_id": "uc-minikms",
    "entity_type": "usecase",
    "state": "completed",
    "span_id": "a1b2c3",
    "source": "live",
    "duration_ms": 9060000,
    "events": [...],
    "harness_results": [],
    "children": [...]
  },
  "summary": {
    "total": 12, "completed": 8, "in_progress": 2,
    "pending": 1, "rejected": 1,
    "blocked": ["tm-6"],
    "harness_failures": [
      { "entity_id": "tm-5", "harness_id": "task-needs-test",
        "reason": "未发现测试文件引用" }
    ]
  },
  "_ai_context": {
    "one_line": "12 实体中 8 完成，tm-5 因缺少 test: artifact 被拒绝，tm-6 等待解锁。",
    "next_actions": [
      "tm-5: 补充 test: 类型 artifact_refs → 重新 review",
      "tm-6: 等待 tm-5 修复后继续"
    ],
    "error_refs": [
      "events.ndjson → entity_id=tm-5, type=entity.state_changed, state=rejected"
    ]
  }
}
```

### `_ai_context` 确定性生成规则（无 LLM）

```
one_line  = "{total} 实体中 {completed} 完成"
          + (rejected > 0 ? "，{rejected_ids} 被 harness 拒绝" : "")
          + (blocked.length > 0 ? "，{blocked_ids} 等待解锁" : "")

// 下方模板为规范性定义；JSON 示例中的措辞是说明性的，以此模板为准
next_actions = harness_failures.map(f =>
  `${f.entity_id}: ${f.reason} → 修复后重新 review`)
  .concat(blocked.map(id => `${id}: 等待上游修复后继续`))

error_refs = harness_failures.map(f =>
  `events.ndjson → entity_id=${f.entity_id}, type=entity.state_changed, state=rejected`)
```

---

## 新增类型（tw-types）

```typescript
// TwEventType 联合类型增加：
export type TwEventType =
  // ... 现有类型 ...
  | 'report.generated'   // ← 新增

export interface SpanTreeNode {
  entity_id: string
  entity_type: EntityType
  state: EntityState              // 来源：EntityRegistry（权威），非 SpanMeta.status 反推
  span_id: string                 // daemon 重启后为 entity_id（reconstructed 模式）
  trace_id: string
  parent_span_id?: string
  start_time: string
  end_time?: string
  duration_ms?: number            // reconstructed 模式下为 undefined
  status: 'OK' | 'ERROR' | 'UNSET'
  source: 'live' | 'reconstructed'  // 区分 SpanManager vs EntityRegistry 来源
  events: SpanEvent[]             // reconstructed 模式下从 EventLog 重建
  harness_results?: Array<{       // 来源：FeedbackLog（TraceQueryEngine 依赖）
    harness_id: string
    result: 'pass' | 'fail'
    reason?: string
  }>
  children: SpanTreeNode[]
}

export interface TraceInfo {
  trace_id: string
  root: SpanTreeNode
  summary: {
    total: number; completed: number; in_progress: number
    pending: number; rejected: number
    blocked: string[]
    harness_failures: Array<{ entity_id: string; harness_id: string; reason?: string }>
  }
  _ai_context: {
    one_line: string       // 确定性模板生成，不调用 LLM
    next_actions: string[]
    error_refs: string[]
  }
}

export interface ReportMeta {
  date: string          // YYYY-MM-DD
  trace_id: string
  path: string
  generated_at: string  // ISO8601
}
```

---

## 新增 IPC 方法

| 方法 | 参数 | 返回 |
|------|------|------|
| `trace_spans` | `{ trace_id?: string; entity_id?: string }` | `{ trace_id: string; tree: SpanTreeNode }` |
| `trace_info` | `{ trace_id?: string; entity_id?: string }` | `TraceInfo` |
| `report_generate` | `{ trace_id?: string; all?: boolean }` | `{ paths: string[] }` |
| `report_list` | `{ date?: string }` | `{ reports: ReportMeta[] }` |

`report_list` 的 `date` 参数格式 `YYYY-MM-DD`，省略时返回全部报告。

---

## TraceQueryEngine 接口

```typescript
interface TraceQueryEngineOptions {
  spanManager: SpanManager
  // EntityRegistry 通过回调注入，避免访问 CommandHandler 的 private 字段
  getAllEntities: () => Entity[]
  getEntity: (id: string) => Entity | undefined
  feedbackLog: FeedbackLog         // harness_results 来源
}

class TraceQueryEngine {
  constructor(opts: TraceQueryEngineOptions)

  // entity_id → trace_id
  // 优先查 SpanManager，fallback 用 getEntity(id) 沿 parent_id 链向上查找 trace_id
  findTraceId(entityId: string): string | undefined

  // 构建带 children 嵌套的完整 SpanTreeNode 树
  // state 来自 getEntity()（权威），events 来自 SpanMeta（或 EventLog 重建）
  // harness_results 来自 FeedbackLog.query({ entity_id })
  buildSpanTree(traceId: string): SpanTreeNode | null

  // 获取同一 trace 下所有节点（扁平）
  // 实现：对 spanManager.getAllSpans() 做全量线性扫描过滤 trace_id
  // 预期数据量：单 trace 通常 < 200 entities，O(n) 可接受
  getSpansByTraceId(traceId: string): SpanMeta[]

  // 列出所有已知 trace_id（SpanManager + getAllEntities() 合并去重）
  getAllTraceIds(): string[]
}
```

---

## 测试策略

| 层 | 测试内容 |
|----|---------|
| `TraceQueryEngine` | live 模式：`findTraceId`、`buildSpanTree` 正确嵌套、`harness_results` 填充；reconstructed 模式：daemon 重启后 EntityRegistry fallback；孤儿 entity（无 parent）作为根节点；trace_id 不存在返回 null |
| `ReportGenerator` | mock 四个依赖 → 验证 `.md` 含关键字段；EventLog 只写 file-ref；原子 rename（tmpfile → final）；`report_generate` 错误边界（trace_not_found / missing 参数） |
| `ReportScheduler` | mock `Date.now` 验证 cron 触发；同日幂等（EventLog 有记录则跳过，而非文件存在性检查） |
| CLI `tw trace` | integration：`--trace-id` 和 `--entity-id` 双入口；`--json` 含 `_ai_context` 和 `source` 字段；`trace-renderer.ts` 单元测试验证树状输出格式 |
| CLI `tw report` | integration：`daily` 生成文件 + EventLog ref；`list --date` 正确过滤 |

---

## CLAUDE.md 更新（完成后）

- `packages/tw-daemon/CLAUDE.md`：子模块表加 `report/` 行；`config/loader.ts` 说明加 `report` 配置块
- `packages/tw-cli/CLAUDE.md`：noun 列表加 `trace | report`；IPC 清单加 4 个新方法；输出工具加 `trace-renderer.ts`
- `packages/tw-types/CLAUDE.md`：关键类型表加 `SpanTreeNode / TraceInfo / ReportMeta`；TwEventType 说明加 `report.generated`
- `docs/CLI-COMMANDS.md`：新增 `tw trace` 和 `tw report` 命令文档（含所有子命令、选项、示例）
- `packages/tw-daemon/src/config/loader.ts`：config 类型定义加 `report?: { schedule?: string; output_dir?: string; traces?: 'all' | string[] }`

---

*设计原则：TraceQueryEngine 双来源（SpanManager live + EntityRegistry fallback）确保 daemon 重启后三个功能仍可用；`_ai_context` 确定性生成，零 LLM 调用。*
