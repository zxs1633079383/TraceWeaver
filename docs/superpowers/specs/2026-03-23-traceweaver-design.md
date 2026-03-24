# TraceWeaver — 设计文档

**日期：** 2026-03-23
**版本：** v0.2
**项目路径：** `/Users/mac28/workspace/frontend/TraceWeaver`

---

## 1. 定位与边界

### 核心定位

TraceWeaver 是**研发流程的可观测性引擎 + 事件响应系统**，以 OpenTelemetry 语义模型为骨架，追踪从 UseCase → Plan → Task → Execution 的全链路状态。

### 职责边界

**TraceWeaver 做的事：**
- **感知** — 实体状态变更、文件变更、外部事件
- **记录** — 全链路 OTel Trace，形成可观测闭环
- **校验** — 状态变更时检查约束（AI 解释型）、依赖关系
- **响应** — 触发通知、级联传播、Hook 调用
- **暴露能力** — CLI / MCP Server / HTTP API，任何 Agent 或系统可调用

**TraceWeaver 不做的事：**
- 不拆分任务
- 不生成 Plan
- 不决定约束挂载位置
- 不规划执行顺序
- 不驱动 Agent 行为

> **核心哲学：暴露能力，不做决策。上游告诉我什么，我如实记录并追踪。**

---

## 2. 整体架构

### 双进程模型

```
┌─────────────┐      IPC (Unix Socket, NDJSON)     ┌──────────────────────┐
│   tw-cli    │ ◄──────────────────────────────► │     tw-daemon        │
│             │                                   │                      │
│ • 命令解析   │                                   │ • 状态引擎            │
│ • 输出格式化  │                                   │ • MCP Server         │
│ • 无状态     │                                   │ • HTTP Server        │
│             │                                   │ • Webhook 入站监听    │
│             │                                   │ • FS Watcher         │
│             │                                   │ • Worker Pool        │
│             │                                   │ • OTel Export        │
└─────────────┘                                   └──────────────────────┘
```

- CLI 是无状态薄客户端，所有逻辑在 Daemon
- Daemon 按需自启（CLI 调用时如未运行则自动 spawn）
- IPC 通过 Unix Socket 通信，协议为换行分隔 JSON（NDJSON）
- "空闲"定义：无活跃 Span 且无 IPC 活动超过 30min，Daemon 自动退出

### IPC 协议

所有 CLI → Daemon 通信使用换行分隔 JSON（NDJSON），基于 Unix Socket：

```jsonc
// 请求（CLI → Daemon）
{ "request_id": "uuid-v4", "method": "update_state", "params": { ... } }\n

// 响应（Daemon → CLI）
{ "request_id": "uuid-v4", "ok": true, "data": { ... } }\n
{ "request_id": "uuid-v4", "ok": false, "error": { "code": "INVALID_TRANSITION", "message": "..." } }\n
```

### 代码结构

```
traceweaver/
├── packages/
│   ├── tw-cli/              # CLI 入口（无状态薄客户端）
│   └── tw-daemon/           # 核心常驻进程
│       ├── core/
│       │   ├── engine/      # 状态机 + DAG + 转换守卫
│       │   ├── fs-store/    # 文件系统持久化 + WAL + 缓存
│       │   ├── propagator/  # 双向状态传播
│       │   └── constraint/  # 约束加载 + AI 校验调度
│       ├── otel/            # OTel Span 生成 + OTLP 导出
│       ├── mcp/             # MCP Server
│       ├── hooks/           # Git Hook + CC PostToolUse 处理
│       ├── notify/          # 通知系统（Outbound + Inbound）
│       ├── watcher/         # 文件系统 watch
│       └── workers/         # Worker 线程池
```

### 项目状态文件结构

```
.traceweaver/
├── config.yaml              # 项目配置（OTel、通知、Trigger 规则）
├── project.yaml             # 项目元信息
├── triggers.yaml            # 自定义 Trigger 规则
├── daemon.pid               # Daemon PID 文件
├── .wal                     # Write-Ahead Log（NDJSON 追加写，崩溃恢复）
├── usecases/
│   └── UC-001/
│       ├── usecase.yaml
│       ├── plans/
│       │   ├── FE-PLAN.yaml
│       │   └── BE-PLAN.yaml
│       └── tasks/
│           ├── BE-001.yaml
│           └── BE-002.yaml
└── inbox/                   # 本地通知收件箱
```

---

## 3. 状态机 + 双向传播

### 合法状态转换表

| 当前状态 | 允许的目标状态 | 说明 |
|---|---|---|
| `pending` | `in_progress` | 开始执行 |
| `in_progress` | `review` | 提交审核 |
| `in_progress` | `rejected` | 直接打回（无需经过 review） |
| `review` | `completed` | 审核通过 |
| `review` | `rejected` | 审核打回 |
| `rejected` | `in_progress` | 重新执行 |
| `completed` | `rejected` | 事后打回（任务管理系统审查后） |

**非法转换**（如 `pending → completed`）返回错误：

```json
{ "ok": false, "error": { "code": "INVALID_TRANSITION", "message": "Cannot transition from pending to completed" } }
```

状态转换守卫在 `core/engine/` 中强制执行，MCP / CLI / HTTP 三个接口共用同一守卫，无法绕过。

### 传播规则

**自下而上（Bubble Up）：**

```
Task completed
  → 同 Plan 下所有 Task 均 completed？
    → 是：Plan → completed → 继续向上聚合 UseCase 进度
    → 否：更新 Plan 进度（如 3/7）
```

**自上而下（Cascade Down）：**

| UseCase 变更类型 | Plan 影响 | Task 影响 | OTel 处理 |
|---|---|---|---|
| Modify（部分） | 受影响 Plan → rejected | 受影响 Task → rejected | 旧 Span 标记 rollback，新 Span link 指向旧 |
| Replace（整体） | 所有 Plan → rejected | 所有 Task → rejected | 旧 Trace 关闭，新 Trace 生成，parent 指向旧 Trace |
| Append（追加） | 新增 Plan | 新增 Task | 新 Span 追加到现有 Trace |

**打回场景完整链路：**

```
任务管理系统事后审查 → 未通过 → 入站 Webhook
  ↓
Task completed → rejected（合法转换，见上表）
  ↓
OTel: Task Span 追加 Event { name: "rollback", reason: "..." }
  ↓
Plan: completed → in_progress（bubble_up 触发）
  ↓
UseCase: 进度降级
  ↓
通知: 推送给关联 Agent / 负责人
  ↓
Agent 重新进入该 Task（new Span v2 created，link → Span v1）
```

### 传播引擎

传播在 Worker 线程中异步执行，通过事件队列解耦：

```
状态变更 → Event Queue → Worker 消费 → 传播计算 → 批量写入文件 → OTel Span 更新
```

---

## 4. OTel 数据模型

### Trace 层级映射

```
Project Trace (trace_id = project_id)
 │
 └── UseCase Span（root span）
      ├── tw.usecase.mutation = new | replace | modify | append
      ├── tw.usecase.version  = git_sha
      │
      └── Plan Span
           ├── tw.plan.domain = frontend | backend | ui | qa | custom
           │
           └── Task Span
                ├── tw.task.assignee_type = agent | human
                ├── tw.task.retry_count   = N
                ├── tw.constraint.refs    = [...]
                ├── tw.artifact.refs      = [...]
                │
                ├── Event: task_started
                ├── Event: code_generated
                ├── Event: ai_review_passed
                ├── Event: rollback { reason }
                └── Event: task_completed
```

### 语义约定命名空间（`tw.*`）

```
tw.entity.type          usecase | plan | task
tw.entity.id            UC-001
tw.entity.state         pending | in_progress | review | completed | rejected
tw.usecase.mutation     new | replace | modify | append
tw.plan.domain          frontend | backend | ui | qa | custom
tw.task.assignee_type   agent | human
tw.task.retry_count     number
tw.artifact.type        prd | design | code | test
tw.artifact.ref         prd.md#section-3.2
tw.constraint.refs      string[]
tw.constraint.result    pass | fail | skipped
tw.project.id           string
```

### Span Status 映射

| 实体状态 | OTel Span Status |
|---|---|
| pending / in_progress / review | UNSET |
| completed | OK |
| rejected | ERROR |

### 延迟 Span 模式（Deferred Span）

研发流程 Span 持续时间可能是数小时甚至数天：

- Span 创建时记录 `start_time + attributes`，不立即导出
- 状态变更时增量追加 Event 并刷出（增量 Event 实时可查）
- 实体 `completed` / `rejected` 时 `end()` 并全量导出

**Daemon 退出保护**：Daemon 检测到有活跃（未 end）的 Span 时，忽略空闲超时，保持运行。

### Retry Span 生命周期

```
Task BE-002 → rejected
  ↓ 触发 rollback，Span v1 end(ERROR)，立即导出
  ↓
Agent 重新接手（tw update BE-002 --state in_progress）
  ↓ 创建 Span v2，start_time = 此刻，link → Span v1
  ↓
Task BE-002 → completed
  ↓ Span v2 end(OK)，导出
```

### Rollback Span Link

```
Task BE-002 Span v1  (status=ERROR, event=rollback)
    ← link { tw.link.type=retry, tw.link.reason="human_rejected" } ←
Task BE-002 Span v2  (status=OK, event=task_completed)
```

### 采样策略

`always_on` — 研发流程 Span 量级低但每个都有业务价值，全量记录，不采样。

---

## 5. 事件系统

### 架构

```
外部输入 / 内部状态变更
       ↓
   Event Bus（Ring Buffer）
       ↓
  State Engine（状态机 + 转换守卫）
       ↓
  Trigger Evaluator（规则匹配）
       ↓          ↓          ↓
  Validator   Propagator   Action Runner
  (约束校验)  (状态传播)   (通知/Webhook/Hook)
       ↓
  OTel Span 记录（全程）
```

### 事件类型

```yaml
# 实体生命周期
entity.registered       # UseCase/Plan/Task 注册到 TraceWeaver
entity.updated          # 属性变更
entity.state_changed    # 状态流转
entity.removed          # 被移除

# 工件事件
artifact.created        # PRD/Design/Code 工件产生
artifact.modified       # 工件内容变更
artifact.linked         # 工件与实体建立关联

# 外部事件
hook.received           # CC PostToolUse Hook 触发
webhook.inbound         # 外部系统回调
git.commit              # Git commit 被感知
file.changed            # FS Watcher 捕获文件变更
```

### Trigger 规则事件过滤语法

统一使用结构化 YAML，不使用冒号分隔字符串：

```yaml
# .traceweaver/triggers.yaml
triggers:
  - on:
      event: entity.state_changed
      entity_type: task          # 可省略，匹配所有类型
      state: completed           # 可省略，匹配所有状态
    actions:
      - propagate: bubble_up
      - notify: { channel: webhook, template: task_completed }

  - on:
      event: entity.state_changed
      state: rejected
    actions:
      - propagate: bubble_up
      - otel: { event: rollback }
      - notify: { channel: im, template: task_rejected }

  - on:
      event: artifact.modified
      artifact_type: prd
    actions:
      - resolve_refs: { find: dependent_entities }
      - validate: { check: constraint_alignment }
      - notify: { channel: inbox, template: prd_changed_impact }

  - on:
      event: git.commit
    actions:
      - resolve: { match: commit_to_task }
      - propagate: bubble_up
```

通知配置中的 `events` 字段同样使用结构化对象：

```yaml
notify:
  adapters:
    im:
      providers:
        - type: telegram
          events:
            - { event: entity.state_changed, state: rejected }
            - { event: entity.state_changed, entity_type: usecase, state: completed }
```

### 内置 Action 类型

| Action | 说明 |
|---|---|
| `propagate` | 状态传播（bubble_up / cascade_down） |
| `validate` | 触发约束校验（AI 解释型） |
| `notify` | 推送通知（inbox / webhook / im） |
| `otel` | 追加 OTel Event / 更新 Span |
| `resolve_refs` | 通过依赖图找受影响实体 |
| `webhook` | 调用外部 HTTP 端点 |
| `exec` | 执行本地命令 |

### Ring Buffer + 批量消费

- Ring Buffer 替代普通队列，固定内存，零 GC 压力
- 批量消费：50ms 时间窗口内事件合并处理
- 合并同一实体的多次变更，只取最终态
- 背压控制：队列满时 Producer 降速，不丢事件

---

## 6. Agent 接口层

### 核心原则

TraceWeaver 是 **Agent-callable 的基础设施**，任何 Agent 都可以调用它，TraceWeaver 不适配任何特定 Agent。三种接口共用同一 Command Handler：

```
CLI ─────┐
MCP ─────┤──→ Command Handler ──→ State Engine ──→ Event Bus
HTTP ────┘         ↑
              统一参数校验 + 转换守卫
```

### 统一响应信封

所有接口（MCP / HTTP）均使用统一响应结构：

```typescript
type TwResponse<T> =
  | { ok: true;  data: T }
  | { ok: false; error: { code: string; message: string } }
```

### MCP Tools（完整接口定义）

#### `tw_register`

注册单个实体。批量注册（如入站 Webhook）由 HTTP 接口处理，内部复用同一 Command Handler。

```typescript
// input
{
  entity_type: 'usecase' | 'plan' | 'task'
  id: string
  parent_id?: string          // plan 的 parent 是 usecase；task 的 parent 是 plan
  domain?: string             // plan 专用：frontend | backend | ui | qa | custom
  depends_on?: string[]       // task 的上游依赖 task id 列表
  artifact_refs?: Array<{ type: string; path: string; section?: string }>
  constraint_refs?: string[]  // harness 文件相对路径
  attributes?: Record<string, unknown>
}

// output
{ ok: true; data: { id: string; state: 'pending'; created_at: string } }
```

#### `tw_update_state`

```typescript
// input
{ id: string; state: 'in_progress' | 'review' | 'completed' | 'rejected'; reason?: string }

// output
{ ok: true; data: { id: string; previous_state: string; current_state: string } }
// error: INVALID_TRANSITION | ENTITY_NOT_FOUND
```

#### `tw_update_attributes`

```typescript
// input
{ id: string; attributes: Record<string, unknown> }  // merge 语义，不替换

// output
{ ok: true; data: { id: string; attributes: Record<string, unknown> } }
```

#### `tw_remove`

```typescript
// input
{ id: string }
// output
{ ok: true; data: { id: string } }
```

#### `tw_get_context`

```typescript
// input
{ id: string; depth?: number }  // 0=仅自身（默认），1=含直接子级，-1=全部

// output
{
  ok: true
  data: {
    entity: EntitySnapshot
    constraints: Array<{ ref: string; content: string }>  // 约束文件内容
    dependencies: Array<{ id: string; state: string }>
    artifacts: Array<{ type: string; path: string; section?: string }>
    children?: EntitySnapshot[]  // depth > 0 时
  }
}
```

#### `tw_get_status`

```typescript
// input
{ id?: string; format?: 'summary' | 'tree' | 'dag' }  // id 不传则返回项目级

// output: summary
{ ok: true; data: { id: string; state: string; progress: { done: number; total: number } } }
```

#### `tw_get_dag`

```typescript
// input
{ root_id?: string }

// output
{ ok: true; data: { nodes: DagNode[]; edges: DagEdge[] } }
```

#### `tw_link_artifact`

```typescript
// input
{ entity_id: string; artifact: { type: string; path: string; section?: string } }
// output
{ ok: true; data: { entity_id: string; artifact_ref: string } }
```

#### `tw_resolve_impact`

```typescript
// input
{ artifact_path: string; section?: string }

// output
{ ok: true; data: { affected: Array<{ id: string; entity_type: string; state: string }> } }
```

#### `tw_emit_event`

```typescript
// input
{ entity_id: string; event: string; attributes?: Record<string, unknown> }
// output
{ ok: true; data: { event_id: string; timestamp: string } }
```

#### `tw_query_events`

```typescript
// input
{ entity_id?: string; event_type?: string; since?: string; limit?: number }

// output
{ ok: true; data: { events: EventRecord[] } }
```

### CLI 命令

```bash
# 实体管理
tw register usecase UC-001 --prd ./prd.md --design ./design.md
tw register plan FE-PLAN-001 --parent UC-001 --domain frontend
tw register task BE-001 --parent BE-PLAN-001 --depends-on BE-000

# tw update 根据 flag 分发到 update_state 或 update_attributes
tw update BE-001 --state completed
tw update BE-001 --state rejected --reason "API 不符合规范"
tw update BE-001 --attr key=value              # 更新 attributes

# 查询
tw status                     # 项目级概览
tw status UC-001              # UseCase 详情
tw status UC-001 --tree       # 树形展开
tw dag UC-001                 # DAG 可视化
tw impact ./prd.md            # PRD 变更影响分析
tw impact ./prd.md#section-3  # 段落级影响分析

# 事件
tw events BE-001              # 实体事件流
tw events --since 2026-03-22

# 通知
tw inbox                      # 查看待处理项
tw inbox --ack 3              # 确认已读

# 同步（用于 Session 结束 Hook，将内存状态刷入文件）
tw sync

# Daemon 管理
tw daemon start
tw daemon stop
tw daemon status
```

### HTTP API

请求/响应均使用 `Content-Type: application/json`，统一信封：`{ ok, data }` / `{ ok, error }`。

```
# 实体
POST   /api/v1/entities
  body: 同 tw_register input

PATCH  /api/v1/entities/:id
  body: { state?: string; reason?: string; attributes?: object }

DELETE /api/v1/entities/:id

GET    /api/v1/entities/:id
  query: depth=0|1|-1, format=summary|tree|dag

GET    /api/v1/entities/:id/dag

# 工件
POST   /api/v1/entities/:id/artifacts
  body: { type, path, section? }

GET    /api/v1/artifacts/impact
  query: ref=./prd.md, section=section-3.2

# 项目状态
GET    /api/v1/status

# 事件
POST   /api/v1/events
  body: { entity_id, event, attributes? }

GET    /api/v1/events
  query: entity_id?, event_type?, since?, limit?

# Webhook 入站（批量注册 + 状态回调）
POST   /api/v1/webhooks/inbound
  body: 见 Section 9
```

---

## 7. 约束系统（AI 解释型）

### 约束文件格式

约束存储为 Markdown 文件，位于 `harness/` 目录：

```
harness/
├── system/
│   ├── architecture_principles.md
│   └── security_policy.md
└── module/
    ├── rest_api_guideline.md
    └── fe_standard.md
```

### 校验流程

1. Task 注册时携带 `constraint_refs`（harness 文件相对路径）
2. 状态变更为 `review` 时，触发约束校验
3. 校验通过 AI 解释：将约束文件内容 + Task 输出工件路径 打包为 prompt，调用配置的 LLM
4. AI 返回 `pass | fail`，附带理由
5. 结果写入 Task 的 `tw.constraint.result` 属性，追加 OTel Event

```yaml
# 约束校验结果写入 Task
constraint_validation:
  result: pass | fail | skipped
  checked_at: ISO8601
  refs_checked:
    - ref: harness/rest_api_guideline.md
      result: pass
      note: "..."
    - ref: harness/security_policy.md
      result: fail
      note: "缺少输入校验"
```

校验结果影响状态流转：`fail` 时阻止 `review → completed`，返回 `CONSTRAINT_VIOLATION` 错误。

### LLM 配置

```yaml
# .traceweaver/config.yaml
constraint:
  llm:
    provider: anthropic          # anthropic | openai | custom
    model: claude-sonnet-4-6
    api_key_env: ANTHROPIC_API_KEY
```

---

## 8. 通知系统

### 架构

```
Event Bus
  ↓
Notify Engine
  ├── Inbox Adapter       本地 .traceweaver/inbox/（始终开启）
  ├── Webhook Adapter     HTTP POST 出站（可配多个端点）
  ├── IM Adapter          Telegram / 飞书 / Slack / 企微（可配多个）
  └── Custom Adapter      用户自定义脚本（接收 JSON stdin）
```

### 出站可靠性策略

```yaml
notify:
  delivery:
    retry_count: 3
    retry_backoff_ms: 1000       # 指数退避基数
    timeout_ms: 5000
    dead_letter: inbox           # 出站失败后降级写入本地 inbox
```

### 配置示例（`.traceweaver/config.yaml`）

```yaml
notify:
  delivery:
    retry_count: 3
    retry_backoff_ms: 1000
    timeout_ms: 5000
    dead_letter: inbox

  adapters:
    inbox:
      enabled: true

    webhook:
      enabled: true
      endpoints:
        - name: task-system
          url: "https://your-system/api/webhook"
          headers:
            Authorization: "Bearer ${TW_WEBHOOK_TOKEN}"
          events:
            - { event: "*" }           # 订阅所有事件
        - name: ci-trigger
          url: "https://ci/api/trigger"
          events:
            - { event: entity.state_changed, entity_type: task, state: completed }

    im:
      enabled: true
      providers:
        - type: telegram
          bot_token: "${TW_TELEGRAM_TOKEN}"
          chat_id: "${TW_TELEGRAM_CHAT}"
          events:
            - { event: entity.state_changed, state: rejected }
            - { event: entity.state_changed, entity_type: usecase, state: completed }

    custom:
      enabled: false
      command: "./scripts/notify.sh"   # 接收 JSON stdin

  inbound:
    enabled: true
    auth:
      type: bearer
      token: "${TW_INBOUND_TOKEN}"
```

---

## 9. Human-in-the-loop（事后审查模式）

TraceWeaver **不阻塞等人**。AI review 通过后直接标记 completed，继续下一个 Task。人是**事后**审查，发现问题再通过入站 Webhook 打回。

```
Task completed（Agent 完成）
  ↓
AI loop review（自动，可配重试次数）
  ↓ pass
tw_update_state → completed（不等人，直接完成）
  ↓
Propagator: bubble_up 向上聚合进度
  ↓
继续执行下一个 Task（不阻塞）
  ↓（异步）通知推送到任务管理系统

...... 事后 ......

任务管理系统审查
  ├── 通过 → 无操作（已 completed）
  └── 未通过 → 入站 Webhook 打回
       ↓
     tw_update_state → rejected（completed → rejected 为合法转换）
       ↓
     Propagator: cascade 影响链（状态降级）
       ↓
     OTel: Span ERROR + rollback event + Span Link
       ↓
     通知 Agent 重新处理
```

---

## 10. 上下游双向反馈闭环

### 入站 Webhook 负载（批量注册）

入站 Webhook 调用与 `tw_register` 共用同一内部 Command Handler，支持批量注册：

```json
POST /api/v1/webhooks/inbound
Authorization: Bearer ${TW_INBOUND_TOKEN}
Content-Type: application/json

{
  "source": "requirement-system",
  "type": "usecase.create",
  "usecase": {
    "id": "UC-042",
    "mutation": "new",
    "artifact_refs": [
      { "type": "prd",    "path": "https://docs/prd-042.md" },
      { "type": "design", "path": "https://docs/design-042.md" }
    ]
  },
  "plans": [
    {
      "id": "FE-PLAN-042",
      "domain": "frontend",
      "depends_on": ["BE-PLAN-042"],
      "constraint_refs": ["harness/module/fe_standard.md"]
    },
    {
      "id": "BE-PLAN-042",
      "domain": "backend",
      "constraint_refs": ["harness/module/rest_api_guideline.md"]
    }
  ]
}
```

TraceWeaver 收到后：**只做记录** — 存储实体、创建 OTel Spans、开始感知状态变更。不做任何决策。

### 状态回调负载

```json
POST /api/v1/webhooks/inbound
{
  "source": "task-management-system",
  "type": "task.rejected",
  "entity_id": "BE-002",
  "state": "rejected",
  "reason": "需要补充单元测试",
  "operator": "张三"
}
```

### 完整双向闭环

```
上游（需求系统）              TraceWeaver                下游（Agent / 任务系统）
     │                            │                              │
     │── UseCase + PRD ─────────→│                              │
     │   Plans + 约束 + 依赖      │── 记录实体，创建 Spans        │
     │                            │── 暴露接口 ─────────────────→│
     │                            │                              │
     │                            │←── tw_update_state: completed│
     │                            │    （AI review 通过，不阻塞）  │
     │                            │── bubble_up 传播             │
     │←── UseCase 进度通知 ───────│                              │
     │                            │                              │
     │── 事后审查: 打回 ──────────→│                              │
     │   (入站 Webhook)            │── rejected 传播 ────────────→│
     │                            │── rollback OTel Event        │
     │                            │                              │
     │                            │←── Task 重新完成 ────────────│
     │←── UseCase completed ──────│                              │
```

---

## 11. 高性能架构

### Worker 线程模型

```
Main Thread（事件循环 — 只做 IO 调度）
 ├── IPC 请求接收（Unix Socket / NDJSON）
 ├── HTTP 请求接收（Fastify）
 ├── MCP 消息处理
 ├── FS Watcher 事件接收
 └── Event Bus 分发
      │
      └── Worker Pool（CPU 密集任务，动态伸缩）
           ├── Worker: 状态传播计算（DAG 遍历）
           ├── Worker: OTel Span 批量生成 + 序列化（protobuf）
           └── Worker: 约束校验调度（LLM 调用协调）
```

### WAL 格式

WAL 为 NDJSON 追加写文件（`.traceweaver/.wal`），每行一条操作记录：

```jsonc
{ "seq": 1, "op": "upsert_entity", "idempotency_key": "UC-001-v1", "payload": { ... }, "ts": "ISO8601" }
{ "seq": 2, "op": "update_state",  "idempotency_key": "BE-002-completed-1",  "payload": { ... }, "ts": "ISO8601" }
```

- `idempotency_key` 保证 replay 幂等（重复 replay 不产生副作用）
- WAL replay 冲突：以 WAL 中最高 `seq` 为准
- WAL 定期 compact（将已刷入 YAML 的条目截断）

### 文件系统优化

```
写入：WAL 追加 → 异步批量刷入 YAML（100ms 或 50 条，取先到者）→ 崩溃恢复 replay WAL
读取：内存热缓存 → FS Watcher 感知外部修改时失效缓存 → 查询走缓存不读文件
```

### OTel 导出优化

```
Span 生成（Worker 线程，protobuf 序列化）→ 内存 Buffer → 批量 OTLP Export
  批次大小: 512 spans
  刷新间隔: 5s
  压缩: gzip
  重试: 指数退避（最多 3 次）
```

### 性能目标

| 指标 | 目标 |
|---|---|
| 状态变更 → 传播完成 | < 100ms |
| CLI 命令响应 | < 50ms（命中缓存） |
| OTel Span 生成吞吐 | > 10,000 spans/s |
| 内存占用（idle） | < 50MB |
| 内存占用（活跃项目） | < 200MB |

---

## 12. Claude Code 集成

### 双模式集成

- **Hook** — 被动接收事件，Task 完成时自动触发状态回流
- **MCP Server** — Agent 主动查询和操作 TraceWeaver（查约束、查依赖、更新状态）

### Hook 配置示例（测试时临时配置，验证后调整）

```jsonc
// .claude/settings.json
// 注意：$TASK_ID / $STATUS 等变量需通过 Hook 脚本从工具调用参数中提取
// 此处为伪代码示意，实际使用时通过包装脚本解析 CC Hook 的 JSON payload
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "mcp__taskmaster__set_task_status",
        "command": "tw-hook-bridge set_task_status"
        // tw-hook-bridge 从 stdin 读取 CC Hook JSON payload，提取 task_id + status，调用 tw update
      },
      {
        "matcher": "Write",
        "command": "tw-hook-bridge write_event"
        // 从 payload 中提取 file_path，调用 tw emit-event
      }
    ],
    "Stop": [
      { "command": "tw sync" }
    ]
  }
}
```

`tw-hook-bridge` 为 TraceWeaver 内置的 Hook 适配脚本，负责解析 Claude Code Hook payload 并调用对应 `tw` 命令。

---

## 13. FS Watcher

监听范围：

1. `.traceweaver/` YAML 文件变更 → 人手动修改了实体 → 生成 `entity.updated` 事件 → 走 Event Bus
2. `harness/` 约束文件变更 → 触发关联实体重新校验
3. Artifact 文件变更（PRD/Design）→ `tw_resolve_impact` 找受影响实体，标记需重新审查

防抖：300ms 内合并。Git 操作期间暂停 watch（检测 `.git/index.lock`）。

---

## 14. 分发方式

```bash
npx traceweaver status    # 零安装
npm i -g traceweaver      # 全局安装（推荐：tw status）
npm i -D traceweaver      # 项目 devDependency
```

---

## 15. 首个验证场景

1. **自举** — 用 TraceWeaver 管理 TraceWeaver 自身的开发（dogfooding）
2. **CSES 项目** — 接入真实业务项目，验证通用性

---

## 16. 技术栈

| 层 | 技术选型 |
|---|---|
| 语言 | TypeScript (Node.js) |
| CLI 框架 | Commander.js |
| IPC 协议 | Unix Socket + NDJSON |
| HTTP Server | Fastify |
| 文件监听 | chokidar |
| Worker | Node.js worker_threads |
| OTel SDK | @opentelemetry/sdk-node |
| MCP | @modelcontextprotocol/sdk |
| 序列化 | js-yaml（文件）/ protobuf（OTel 导出） |
| 测试 | Vitest |
