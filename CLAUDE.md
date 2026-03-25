# CLAUDE.md — TraceWeaver 根索引

> 本文件是约束系统的**入口**，不是全文。具体约束在各模块的 CLAUDE.md 中定义。
> 修改任何模块时，先读对应模块的 CLAUDE.md，再动手。

---

## 项目定位

TraceWeaver 是一个 **AI 原生研发流程可观测引擎**。
追踪 UseCase → Plan → Task 的完整生命周期，给 AI Agent 和工程师提供
实时可查询的研发过程视图。

**核心循环：observe → detect → diagnose → validate → fix**

```
FsWatcher（config.watch.dirs）
    ↓ file.changed
ImpactResolver（file → entity 反向索引）
    ↓ artifact.modified（per entity）
TriggerExecutor（harness trigger_on 匹配 + constraint_refs 过滤）
    ↓ ConstraintEvaluator（LLM）
    ↓ auto-reject → RemediationEngine（修复队列）
    ↓ FeedbackLog（harness 评估历史）
    ↓ NotifyEngine → InboxAdapter
EventLog（NDJSON，可查询）
SpanManager → OtlpGrpcExporter → Jaeger（OTLP/gRPC）
TraceQueryEngine（SpanManager live + EntityRegistry fallback）→ tw trace spans/info
ReportGenerator（四来源聚合）→ tw report daily/list/show
```

---

## 模块索引

| 模块 | 路径 | CLAUDE.md |
|------|------|-----------|
| 共享类型 | `packages/tw-types/` | [→ tw-types/CLAUDE.md](packages/tw-types/CLAUDE.md) |
| Daemon 核心 | `packages/tw-daemon/` | [→ tw-daemon/CLAUDE.md](packages/tw-daemon/CLAUDE.md) |
| CLI | `packages/tw-cli/` | [→ tw-cli/CLAUDE.md](packages/tw-cli/CLAUDE.md) |
| Examples | `examples/` | [→ examples/CLAUDE.md](examples/CLAUDE.md) |
| 文档 | `docs/` | [→ docs/CLAUDE.md](docs/CLAUDE.md) |

---

## 架构边界（全局，不可越界）

```
tw-types  ──▶  被所有包引用，自身不能 import 任何兄弟包
tw-daemon ──▶  不能 import tw-cli
tw-cli    ──▶  只能通过 IPC Socket 与 daemon 通信，禁止直接 import daemon src
examples  ──▶  可直接 import daemon src（演示用），不走 IPC
```

---

## 全局禁令

```
✗ 禁止提交 dist/ 或 src/*.js 编译产物（.gitignore 已强制排除）
✗ 禁止 @ts-ignore / as any（用 as unknown as T 或修正类型）
✗ 禁止静默吞错（catch {} 必须注释原因）
✗ 禁止硬编码路径或密钥（用环境变量或 config.yaml）
```

---

## TaskMaster 与 TraceWeaver 联动规范

使用 TaskMaster 时，必须成对调用 tw hook：

```bash
# expand 前后
tw taskmaster hook before-expand --plan=<plan-id> --tm-id=<n>
task-master expand --id=<n>
tw taskmaster hook after-expand --plan=<plan-id> --tm-id=<n>

# 状态变更后
task-master set-status <n> <status>
tw taskmaster hook status-changed --tm-id=<n> --status=<status>
```

## error.log 格式约定（供 tw diagnose --from-log 使用）

```
[ERROR] <ISO-ts> entity_id=<id> trace_id=<id> harness=<id> msg="..."
```

---

## 提交规范

```
<type>(<scope>): <subject>

type:   feat | fix | refactor | docs | test | chore | perf
scope:  daemon | cli | types | watcher | config | harness | trigger | remediation | examples | docs | report | trace
```

每次提交只做一件事。跨模块变更按顺序拆分：types → daemon → cli → test → docs。

---

*约束即代码，可观测，可验证，持续演进。*
