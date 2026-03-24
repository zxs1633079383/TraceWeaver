# TraceWeaver — UseCase / Plan / Task 全链路 Trace 生命周期设计

**日期**: 2026-03-24
**状态**: 已批准
**范围**: tw-daemon · tw-cli · TaskMaster 桥接 · 自动修复闭环 · 快速问题定位

---

## 1. 背景与目标

TraceWeaver 现有实体层级（UseCase → Plan → Task）和 OTel SpanManager，但缺少：

1. UseCase 生命周期与 Trace 的完整映射（包括 Update 的下游级联）
2. 多 Plan 下的 TraceId 一致性保障
3. TaskMaster 与 TW 实体的桥接机制
4. 拒绝后的自动修复闭环
5. 快速问题定位工具

**核心约束**：所有组件**可插拔**，旧项目不强制使用全套流程。

---

## 2. 整体架构

```
UseCase (root trace, trace_id=T1)
  │
  ├── Coordinator Agent (CC / real agent)
  │     ↓ tw register --type=plan --parent=<uc-id>
  │
  ├── Plan [frontend]  ── span child of UseCase (trace_id=T1)
  │     ↓ tw taskmaster import --plan=plan-fe --prd=...
  │     ├── Task fe-1  ── span child of Plan (trace_id=T1)
  │     ├── Task fe-2  (parallel)
  │     └── Task fe-3  (depends_on: fe-1)
  │
  └── Plan [backend]   ── span child of UseCase (trace_id=T1)
        └── Task be-1 / be-2 / ...

Event 流:
UseCase.registered
  → Plan[x].registered (N 个, 共享 trace_id=T1)
    → Task[x.y].registered
      → harness evaluate (review state)
        → PASS → completed → span.end(OK)
        → FAIL → rejected → RemediationEngine
                              → fix → re-review (max 3 次)
```

**新增模块**：

| 模块 | 路径 | 说明 |
|------|------|------|
| `tw taskmaster` 命令族 | `tw-cli/src/commands/taskmaster.ts` | TaskMaster ↔ TW 桥接 |
| `RemediationEngine` | `tw-daemon/src/remediation/` | 自动修复闭环 |
| `tw diagnose` 命令 | `tw-cli/src/commands/diagnose.ts` | 快速问题定位 |
| Remediation Queue | `.traceweaver/remediation-queue/` | NDJSON 队列，CC hook 消费 |
| `Dag.getDescendants()` | `tw-daemon/src/core/engine/dag.ts` | 新增方法，级联更新用 |

所有新模块通过现有 IPC Socket 与 daemon 通信，不破坏架构边界。

---

## 3. TraceId 一致性

### 3.1 现有 gap 与迁移路径

`SpanManager` 当前使用 `projectTraceId`（构造时生成一次，全局共享），所有 span 公用同一个 trace_id。这与"每个 UseCase 独立 trace"的目标冲突。

**迁移方式**：移除 `this.projectTraceId` 字段，改为在 `createSpan` 内通过 `deriveTraceId()` 按需生成：

```ts
// SpanManager 新增私有方法
private deriveTraceId(parentSpanId?: string): string {
  if (parentSpanId) {
    // 从已有 span 继承 trace_id（确保同一棵树共用一个 trace）
    for (const span of this.spans.values()) {
      if (span.span_id === parentSpanId) return span.trace_id
    }
  }
  // 无 parent → 当前实体为根 → 生成新 trace_id
  return randomUUID().replace(/-/g, '')
}
```

`createSpan` 中替换：

```ts
// 旧：trace_id: this.projectTraceId
// 新：
trace_id: this.deriveTraceId(input.parent_span_id),
```

### 3.2 继承规则

```
UseCase 注册（无 parent） → 生成新 trace_id T1
Plan 注册（parent=uc-span） → 继承 T1
Task 注册（parent=plan-span）→ 继承 T1
```

### 3.3 无 UseCase 的场景（可插拔）

```
无 parent → 当前实体自己成为根 → 生成新 trace_id
Plan 作为根 → Task 继承 Plan 的 trace_id
Task 作为根 → 独立 trace
```

> **注意**：`projectTraceId` 字段移除后，现有测试中直接引用该字段的断言需同步更新。

---

## 4. UseCase / Plan / Task 生命周期 → Trace 映射

### 4.1 完整生命周期指令序列

```bash
# ── 1. UseCase 创建 ───────────────────────────────────────
tw register --type=usecase --id=uc-xxx --title="用户登录重构"
# → entity.registered
# → SpanManager: createSpan(uc-xxx) → 生成新 trace_id T1

# ── 2. Coordinator Agent 下发 Plan ──────────────────────
tw register --type=plan --id=plan-fe --title="前端 Plan" --parent=uc-xxx
# → createSpan(plan-fe, parent=uc-span) → trace_id=T1 ✓

tw register --type=plan --id=plan-be --title="后端 Plan" --parent=uc-xxx
# → createSpan(plan-be, parent=uc-span) → trace_id=T1 ✓

# ── 3. 状态推进 ───────────────────────────────────────────
tw update-state uc-xxx in_progress
tw update-state plan-fe in_progress

# ── 4. TaskMaster 拆分后 Task 注册 ───────────────────────
tw taskmaster hook after-expand --plan=plan-fe --tm-id=3
# → tw register --type=task --parent=plan-fe --attr tm_id=3.x
# → trace_id=T1 ✓

# ── 5. Task 完成 ─────────────────────────────────────────
tw update-state task-fe-3.1 completed
# → endSpan(task-fe-3.1, OK) → OTLP export (trace_id=T1)

# ── 6. UseCase 结束 ──────────────────────────────────────
tw update-state uc-xxx completed
# → endSpan(uc-xxx, OK) → 整条 trace T1 在 Jaeger 完整呈现
```

### 4.2 UseCase Update → 下游级联

```bash
tw update uc-xxx --attr description="v2 需求变更" --cascade

# Step 1: entity.updated + addEvent(uc-xxx, "attributes_updated")
# Step 2: Dag.getTransitiveDependents(uc-xxx) → [plan-fe, plan-be, task-fe-1, ...]
#   定义：从 uc-xxx 出发，沿反向边（被依赖方向）递归收集所有节点
#   DAG 边约定：from depends ON to（child→parent），
#   因此 getTransitiveDependents 收集的是所有依赖链可达 uc-xxx 的节点
# Step 3: for each 下游实体:
#   addEvent(entity_id, "upstream_updated", { source: "uc-xxx", changed: ["description"] })
#   emit entity.upstream_changed
# Step 4: TriggerExecutor 可配置 harness trigger_on: [upstream_changed]
#   由 harness 规则决定是否需要重新 review（不强制 rollback）
```

**级联策略**：

| 变更类型 | 推荐行为 |
|---------|---------|
| title / description | `--cascade` 只加 span event，不改状态 |
| 核心 artifact（PRD） | `--cascade` + harness 触发受影响 Plan 回到 `in_progress` |
| Delete UseCase | 所有下游 span 追加 `ancestor_removed` + endSpan(ERROR) |

### 4.3 UseCase Delete

```bash
tw remove uc-xxx
# → entity.removed
# → addEvent(uc-xxx, "entity_removed")
# → endSpan(uc-xxx, ERROR)  ← 未完成删除视为异常终止
# → Dag.getDescendants(uc-xxx) → 各下游 addEvent("ancestor_removed")
```

### 4.4 新增 IPC 命令

```
# 请求
method: "cascade_update"
params: {
  id: string                          // 目标实体 id
  attributes: Record<string, unknown> // 需要更新的属性
  cascade: boolean                    // false 等价于普通 update_attributes
}

# 成功响应
{ ok: true, data: { id, updated_count: number } }
# updated_count = 1（仅本实体） 或 N（本实体 + 所有下游）

# 错误码
ENTITY_NOT_FOUND  → id 不存在
DAG_CYCLE         → 依赖图存在环（理论上不应出现，防御性返回）
```

`cascade: false` 时行为与 `update_attributes` 完全相同，无下游通知。

### 4.5 Jaeger 可视层级

```
[T1] UseCase: 用户登录重构          ████████████████████████████
  events: ● attributes_updated { fields: ["description"] }

  ├─ [T1] Plan: 前端Plan             ████████████████████
  │    events: ● upstream_updated { source: uc-xxx }
  │    ├─ [T1] Task: fe-3.1           ████████
  │    └─ [T1] Task: fe-3.2                    ████████
  └─ [T1] Plan: 后端Plan             ████████████████████
       └─ [T1] Task: be-1.1           ██████████
```

---

## 5. `tw taskmaster` 桥接命令

### 5.1 ID 映射策略

TaskMaster 使用数字 ID（`3`, `3.1`），TW 使用 UUID。

- TW entity attributes 存储 `{ tm_id: "3.1" }`
- 映射持久化在 `.traceweaver/tm-map.json`（可从 entity attributes 重建）

### 5.2 命令族

```bash
# A. 导入 PRD → 批量建 Task 实体
tw taskmaster import \
  --plan=plan-fe \
  --prd=docs/prd-login.md \
  [--num-tasks=8]
# 内部: task-master parse-prd → 读 tasks.json → 批量 tw register

# B. 拆分前后 hook
tw taskmaster hook before-expand --plan=plan-fe --tm-id=3
task-master expand --id=3 --num=5
tw taskmaster hook after-expand --plan=plan-fe --tm-id=3
# after-expand 内部: 读新生成子任务 → 批量 tw register --parent=<tw-parent-id>

# C. 状态变更 hook
task-master set-status 3.1 done
tw taskmaster hook status-changed --tm-id=3.1 --status=done
# 内部: 查 tm-map → tw update-state <tw-id> completed

# D. 新增任务 hook
task-master add-task --prompt="..."
tw taskmaster hook task-added --plan=plan-fe
# 内部: 读最新 tasks.json → 注册新增实体

# E. 手动对齐（补偿机制）
tw taskmaster sync --plan=plan-fe
# diff tasks.json 与 TW 实体 → 更新偏差项（不重复注册）
```

### 5.3 状态映射

| TaskMaster | TW state |
|-----------|---------|
| `pending` | `pending` |
| `in-progress` | `in_progress` |
| `review` | `review` |
| `done` | `completed` |
| `deferred` | `pending` |
| `cancelled` | `rejected` |

### 5.4 CC Agent 调用规范（写入 CLAUDE.md）

```markdown
## TaskMaster 与 TraceWeaver 联动规范

使用 TaskMaster 时必须成对调用 tw hook：

1. expand 前后：
   tw taskmaster hook before-expand --plan=<id> --tm-id=<n>
   task-master expand --id=<n>
   tw taskmaster hook after-expand --plan=<id> --tm-id=<n>

2. 状态变更后：
   task-master set-status <n> <status>
   tw taskmaster hook status-changed --tm-id=<n> --status=<status>

3. 新增任务后：
   task-master add-task --prompt="..."
   tw taskmaster hook task-added --plan=<id>
```

---

## 6. 可插拔架构原则

### 6.1 核心原则

所有组件**只订阅 EventBus，互不直接依赖**。缺少任何一层系统继续工作。

### 6.2 config.yaml 控制

```yaml
# 所有字段可选，默认值均为 true（向后兼容现有项目）
integrations:
  usecase: true        # 关掉 → Task/Plan 自成根 trace
  plan_fanout: true    # 关掉 → 禁止 Plan 级联 cascade_update；UseCase 直连 Task
  taskmaster: true     # 关掉 → tw taskmaster 命令报错并提示未启用
  remediation: true    # 关掉 → rejection 只通知 inbox，不自动修复
  harness: true        # 关掉 → 纯 trace，不做约束评估

remediation:
  enabled: true
  max_attempts: 3
  mode: queue                          # queue | inline | notify_only
  trigger_from_states: []              # 空 = 所有 rejected 均触发；[review] = 仅从 review 拒绝时触发
```

### 6.3 场景覆盖

| 场景 | 启用组件 | Trace 结构 |
|------|---------|-----------|
| 老项目，只有 TaskMaster | `taskmaster` | Task 自成根 trace |
| Plan + TaskMaster | `plan_fanout` + `taskmaster` | Plan 为根 |
| 纯手工注册 | 只用 `tw register` | 随意层级 |
| 完整流程 | 全部启用 | UseCase → Plan → Task |
| 只看 trace，不做约束 | 关闭 `harness` + `remediation` | 纯 OTel span |

---

## 7. 自动修复闭环（RemediationEngine）

### 7.1 触发链路

`error.log` 的出现属于文件变更，通过现有 FsWatcher → ImpactResolver → TriggerExecutor 正常流转，最终仍产生 `entity.state_changed { state: rejected }` 事件。RemediationEngine **统一订阅该事件**，无需单独监听 error.log，避免双重触发竞争。

```
TriggerExecutor
  ↓ entity state → rejected（任意原因：harness fail / error.log / 手动）
  ↓ emit entity.state_changed { state: "rejected" }

RemediationEngine（订阅 EventBus）
  ↓ 过滤 entity.state_changed { state: "rejected" }
  ↓ 去重检查：dedup_key = entity_id + "|" + event.ts
     防止同一 rejection 事件被重复入队
  ↓ 读取 FeedbackLog（rejection reason + harness_id + artifact_refs）
  ↓ 检查 circuit breaker（统计 done/ + in-progress/ 中该 entity 的历史 attempt 数）

  attempt ≤ max → 写入 pending/ + addEvent("remediation_queued")
  attempt > max → 永久 rejected + inbox 通知人工介入
```

可选配置：`remediation.trigger_from_states: [review]`（限定只有从 review 拒绝时才触发自动修复）。

### 7.2 Remediation Queue 结构

```
.traceweaver/
  remediation-queue/
    pending/     ← RemediationEngine 写入
    in-progress/ ← CC 消费时移入
    done/        ← 修复完成后归档
```

Queue item 格式：

```json
{
  "id": "rem-<uuid>",
  "entity_id": "task-fe-3.1",
  "entity_type": "task",
  "attempt": 1,
  "rejection_reason": "缺少测试覆盖或审批标记",
  "harness_id": "needs-review",
  "harness_content": "...",
  "artifact_refs": [
    { "type": "code", "path": "src/auth/login.ts" },
    { "type": "test", "path": "src/auth/login.test.ts" }
  ],
  "span_events": [...],
  "ts": "2026-03-24T10:00:00Z"
}
```

### 7.3 CC 消费命令

```bash
tw remediation next
# → 读取 pending/ 第一个 item → 移入 in-progress/ → 输出完整修复上下文

tw remediation done <rem-id>
# → 移入 done/
# → tw update-state <entity-id> review  ← 重新提交评估
# → addEvent(entity_id, "remediation_applied", { attempt, rem_id })
```

### 7.4 完整闭环时序

```
Task → review
  ↓ TriggerExecutor: harness fail
  ↓ tw update-state task rejected + FeedbackLog.append

RemediationEngine
  ↓ attempt=1 → 写 pending/rem-abc.json
  ↓ addEvent(task, "remediation_queued", { attempt: 1 })

CC
  ↓ tw remediation next → 拿到上下文
  ↓ 修复代码/测试
  ↓ tw remediation done rem-abc
  ↓ tw update-state task review

TriggerExecutor re-evaluate
  ↓ PASS → completed ✓
  ↓ FAIL → attempt=2 → 再次入队
```

### 7.5 Circuit Breaker

| attempt | 行为 |
|---------|------|
| 1 | 自动修复 |
| 2 | 自动修复 + addEvent("remediation_retry") |
| 3 | 自动修复（最后机会）|
| > max | 永久 rejected + inbox 人工介入 + addEvent("remediation_exhausted") |

**attempt count 存储位置**：从 `.traceweaver/remediation-queue/` 的 `done/` 和 `in-progress/` 目录中统计同一 `entity_id` 的历史条目数量得出，**不存储在 entity attributes**（避免污染实体数据模型和 WAL 日志）。

### 7.6 可配置模式

```yaml
remediation:
  enabled: true
  max_attempts: 3
  mode: queue        # queue | inline | notify_only
```

- `queue`：写文件，CC 消费（默认，推荐）
- `inline`：直接 spawn 子进程（无 CC 时）
- `notify_only`：只通知 inbox，人工介入（老项目）

---

## 8. 快速问题定位（`tw diagnose`）

### 8.1 命令设计

```bash
tw diagnose <entity-id>              # 单实体完整链路
tw diagnose <entity-id> --trace      # 整条 trace 树状视图
tw diagnose --from-log error.log     # 从 error.log 自动定位
```

### 8.2 单实体输出

```
━━━ Entity: task-fe-3.1 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Type:    task
State:   rejected
TraceId: a3f2c1...  (UseCase: uc-xxx "用户登录重构")
Parent:  plan-fe → uc-xxx

━━━ Span Events ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
10:00:01  entity_registered
10:00:45  state_changed_to_in_progress
10:03:22  state_changed_to_review
10:03:23  state_changed_to_rejected           ← ⚠️
           from: review
           reason: "缺少测试覆盖或审批标记"
10:03:24  remediation_queued { attempt: 1 }

━━━ Harness Failure ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Harness:  needs-review
Rule:     Task 进入 review 前必须包含 type=test artifact

━━━ Artifact Refs ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✓  code  src/auth/login.ts
✗  test  (缺失)                               ← 直接指出问题

━━━ Remediation Queue ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Status:  pending (attempt 1/3)
File:    .traceweaver/remediation-queue/pending/rem-abc123.json

━━━ Fix Suggestion ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
tw artifact link task-fe-3.1 --type=test --path=src/auth/login.test.ts
tw update-state task-fe-3.1 review
```

### 8.3 全链路树状视图（`--trace`）

```
tw diagnose uc-xxx --trace

UseCase: uc-xxx "用户登录重构"  [in_progress]
  ├─ Plan: plan-fe  [in_progress]
  │    ├─ Task: fe-3.1  ⚠️ rejected
  │    ├─ Task: fe-3.2  ✓ completed
  │    └─ Task: fe-3.3  ○ pending
  └─ Plan: plan-be  [in_progress]
       └─ Task: be-1.1  ✓ completed

问题汇总：
  1. task-fe-3.1 → rejected: 缺少 test artifact
     → tw diagnose task-fe-3.1
```

### 8.4 error.log 自动定位

error.log 格式约定（写入 CLAUDE.md）：

```
[ERROR] 2026-03-24T10:03:23Z entity_id=task-fe-3.1 trace_id=a3f2c1 harness=needs-review msg="..."
```

`tw diagnose --from-log error.log` 解析 `entity_id` / `trace_id` 字段，直接输出对应实体的 diagnose 报告，支持多实体并排。

---

## 9. 新增内容汇总

### 9.1 tw-daemon 新增

| 文件 | 内容 |
|------|------|
| `src/remediation/remediation-engine.ts` | RemediationEngine 主体 |
| `src/remediation/remediation-engine.test.ts` | TDD 测试 |
| `src/core/engine/dag.ts` | 新增 `getTransitiveDependents(id)` 方法（沿反向边递归） |
| `src/otel/span-manager.ts` | 移除 `projectTraceId`，新增 `deriveTraceId()` |
| IPC command: `cascade_update` | 级联更新 + 下游 span event（见 9.3） |
| IPC command: `remediation_next` | 消费队列 |
| IPC command: `remediation_done` | 完成修复 + 重新提交 |
| config.yaml: `integrations` 字段 | 可插拔组件开关（默认全 true） |
| config.yaml: `remediation` 字段 | 修复循环配置 |

### 9.2 tw-cli 新增

| 文件 | 内容 |
|------|------|
| `src/commands/taskmaster.ts` | `tw taskmaster` 命令族 |
| `src/commands/diagnose.ts` | `tw diagnose` 命令 |

### 9.3 文档新增

| 文件 | 内容 |
|------|------|
| `CLAUDE.md`（根） | TaskMaster 联动规范 + error.log 格式约定 |
| `.traceweaver/harness/upstream-changed.md` | upstream_changed 触发示例 |

---

## 10. 不在范围内（本次不做）

- UI 可视化界面
- TaskMaster 源码修改（只做外部桥接）
- 跨 daemon 实例的 trace 合并
- `inline` 模式的 subprocess 实现（先做 `queue` 模式）
