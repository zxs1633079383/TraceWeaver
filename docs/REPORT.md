# TraceWeaver v0.6.0 项目完成报告

> 日期：2026-03-24
> 版本：v0.6.0
> 状态：已完成，242 个测试全部通过

---

## 1. 项目概述

### 项目定位

TraceWeaver 是一款 **AI 原生研发流程可观测引擎**，面向 AI Agent 与工程师协作的现代研发团队。它跟踪研发实体（实验、假设、任务、制品）的完整生命周期，为 AI Agent 和人类工程师提供实时、可查询的研究过程视图。

### 核心理念

TraceWeaver 的设计目标是让 AI Agent 能够自主完成完整的反馈闭环：

```
observe → detect → diagnose → validate → fix
```

具体来说：

- **observe**：通过 `tw log query` 查看近期发生了什么
- **detect**：通过 `tw metrics` 检测是否存在失败或异常
- **diagnose**：通过 `tw impact` 分析哪些实体受到影响
- **validate**：通过 `tw harness run` 验证实体是否满足约束条件
- **fix**：通过 `tw update` 在条件满足时推进实体状态

所有命令均支持 `--json` 标志，输出机器可读格式，便于 AI Agent 程序化消费。

---

## 2. 整体架构

### 架构分层

```
tw (CLI)
   |
   | Unix socket (IPC)
   v
tw-daemon
   |
   +---> CommandHandler
   |          |
   |          +---> EntityRegistry + DAG（实体注册 + 依赖图）
   |          +---> WAL + FsStore（写前日志 + 文件持久化）
   |          +---> EventBus（事件总线）
   |          +---> ImpactResolver（文件 → 实体反向索引 + DAG 传播）
   |                    |
   |                    +---> EventLog（NDJSON 持久化日志）
   |                    +---> NotifyEngine --> InboxAdapter（通知收件箱）
   |                    |                 --> WebhookAdapter（Webhook 推送）
   |                    +---> FsWatcher（文件系统变更监听）
   |                    +---> SpanManager (OTel) --> SpanMetrics（指标推导）
   |                    +---> HarnessLoader（约束文件加载器）
   |                    +---> TriggerExecutor（自动验证 → 自动拒绝）
   |                              └─> ConstraintEvaluator（LLM 支持）
   |
   +---> McpServer（stdio，可选）
   +---> HttpServer（HTTP 端口，可选）
```

### 技术栈

| 层次 | 技术选型 |
|------|---------|
| 语言 | TypeScript ESM |
| 运行时 | Node.js（fs、net、path、os 内置模块） |
| 测试框架 | Vitest |
| CLI 框架 | Commander.js |
| YAML 解析 | js-yaml（已有依赖，非新增） |
| 协议 | MCP stdio + HTTP REST + Unix socket IPC |
| 持久化 | NDJSON 文件（EventLog）、JSON 文件（FsStore）、WAL |

### 零新增运行时依赖原则

Phase 5 全程遵循"零新增运行时依赖"原则：所有新增组件均基于 Node.js 内置模块和已有依赖实现，不引入任何新的 `node_modules` 依赖，确保部署轻量、供应链安全可控。

---

## 3. 各阶段交付物

### Phase 1：核心实体引擎（基础设施）

建立整个系统的数据层与状态管理基础：

- **状态机（StateMachine）**：定义合法状态及跳转规则（`pending → in_progress → review → completed / rejected`），非法跳转返回 `INVALID_TRANSITION` 错误
- **WAL（Write-Ahead Log）**：所有变更先写日志，支持崩溃恢复，保障数据一致性
- **FsStore**：基于 JSON 文件的持久化存储层，支持实体的 CRUD 操作
- **EntityRegistry**：实体注册中心，管理实体生命周期，内置 EventBus 触发状态变更事件

### Phase 2：OTel + DAG + 约束评估 + 通知引擎

扩展观测能力与依赖分析：

- **SpanManager（OTel 集成）**：每个实体映射为一个 OpenTelemetry Span，状态变更自动记录 span 事件和注解
- **DAG（依赖有向无环图）**：通过 `depends_on` 声明实体间依赖关系，支持拓扑查询
- **ConstraintEvaluator**：LLM 支持的约束评估器，在设置 `ANTHROPIC_API_KEY` 时使用真实 AI 评估，否则进入禁用模式
- **NotifyEngine**：基于规则的通知引擎，支持 InboxAdapter（本地收件箱）和 WebhookAdapter（HTTP 推送）

### Phase 3：MCP Server + HTTP API

提供 AI Agent 与外部系统的集成接口：

- **McpServer**：通过 stdio 传输暴露 MCP 工具（`register_entity`、`update_state`、`update_attributes`、`get_status`、`query_events`、`get_dag`、`link_artifact`、`emit_event`），支持 Claude 等 AI Agent 直接集成
- **HTTP API**：基于 Bearer Token 认证的 REST API，支持 CI/CD 集成和 Webhook 接入，提供实体管理、状态推进、事件查询等完整端点

### Phase 4：FsWatcher + InboxAdapter + WebhookAdapter

完善外部事件接入与通知分发：

- **FsWatcher**：监听 `artifact_refs` 中声明的文件路径，文件变更时自动触发 `file.changed` 事件，关联到引用该文件的实体
- **InboxAdapter**：本地持久化通知收件箱，支持按已读/未读过滤和确认操作
- **WebhookAdapter**：向配置的 URL 推送通知，支持 Bearer Token 认证，失败时记录错误

### Phase 5：自主 Agent 闭环

### Phase 6：FeedbackLog + HarnessValidator + OTLP/gRPC（本版本重点）

强化可观测性与约束质量闭环：

- **FeedbackLog**：NDJSON 持久化评估历史，记录每次 harness 评估的结果、耗时、entity_id，支持按 harness_id / result / limit 过滤查询，提供 `getSummary()` 计算 pass/fail/failure_rate/consecutive_failures/trend
- **HarnessValidator**：对齐检测器，在 daemon 启动和 harness 目录变更时自动运行，检测孤儿引用（entity 引用了不存在的 harness）、死约束（harness 未被任何 entity 引用）和持续失败（consecutive_failures ≥ 阈值），发现问题自动写入收件箱
- **TriggerExecutor 接入 FeedbackLog**：每次约束评估后记录结果，连续失败 ≥ 3 次时向收件箱发送 `[FEEDBACK]` 建议消息
- **OTLP 多适配器**：ExporterRegistry 支持 console / otlp-http / otlp-grpc 三种 exporter，通过 `TW_OTEL_EXPORTER` 环境变量或 `config.yaml` 切换；OTLP/gRPC 使用 `@grpc/grpc-js` + proto 动态加载，兼容 Jaeger 4317 端口
- **artifact.modified → SpanEvent**：FsWatcher 触发的文件变更现在同步记录为 OTel span event，Jaeger trace 中可看到文件影响链路
- **Phase 6 CLI 命令**：`tw feedback query`、`tw feedback summary`、`tw harness validate`

完成全链路自主反馈闭环：

- **EventLog**：NDJSON 持久化事件日志，守护进程重启后可重放历史
- **SpanMetrics**：从 SpanManager 内存 Span 推导周期时间、失败率、吞吐量指标
- **ImpactResolver**：三层索引结构，支持文件变更的传递影响分析
- **HarnessLoader**：读取 `.traceweaver/harness/*.md` 的 YAML frontmatter，约束文件即代码
- **TriggerExecutor**：批处理订阅 EventBus，实体到达触发状态时自动运行约束评估，失败则自动拒绝
- **Phase 5 CLI 命令**：`tw log query`、`tw metrics`、`tw harness list/show/run`、`tw watch`

---

## 4. 测试覆盖

### 总体数据

| 指标 | 数值 |
|------|------|
| 总测试数 | 242 |
| 守护进程测试（tw-daemon） | 234 |
| CLI 集成测试（tw-cli） | 8 |
| 测试文件总数 | 36 |
| 测试文件通过率 | 100% |

### Phase 6 新增测试场景

`packages/tw-daemon/src/feedback/feedback-log.test.ts` 和 `harness/validator.test.ts` 新增 47 个测试：

- FeedbackLog：record/query/getSummary/getAllSummaries/NDJSON 持久化/consecutive_failures 计算/trend 算法
- HarnessValidator：孤儿引用检测、死约束检测、持续失败阈值告警
- TriggerExecutor：评估后 feedbackLog 有记录、连续失败 3 次后收件箱有 [FEEDBACK] 消息
- ExporterRegistry：console/otlp-http/otlp-grpc 三种适配器注册与 shutdown
- OtlpGrpcExporter：mock gRPC client，验证 proto payload 格式

### Phase 5 集成测试场景（5 个）

`packages/tw-daemon/src/phase5-integration.test.ts` 覆盖以下端到端场景：

1. **自动拒绝场景**：注册实体 → 推进到 `review` 状态 → TriggerExecutor 检测到触发状态 → ConstraintEvaluator 返回 `fail` → 实体被自动转为 `rejected`，收件箱收到通知
2. **WAL 恢复场景**：写入多个事件后模拟重启，验证 WAL 重放后实体状态一致
3. **EventLog 跨实例重放**：停止守护进程后创建新实例，验证 NDJSON 日志可被正确加载和查询
4. **空影响集合**：对未被任何实体引用的文件调用 impact，返回空集合而不报错
5. **无效状态跳转**：尝试非法状态跳转（如 `pending → completed`），返回 `INVALID_TRANSITION` 错误而不破坏实体状态

---

## 5. Phase 5 详细说明

### 5.1 EventLog：NDJSON 持久化事件日志

**文件**：`packages/tw-daemon/src/log/event-log.ts`

**核心设计**：

- 使用 NDJSON（换行分隔的 JSON）格式存储，每行一条事件，天然支持追加写入
- 完全基于 Node.js 内置 `fs` 模块，零依赖
- 守护进程启动时调用 `load()` 从磁盘恢复历史事件到内存，后续新事件同时写盘和更新内存索引

**核心 API**：

| 方法 | 说明 |
|------|------|
| `load()` | 从磁盘加载历史事件到内存 |
| `append(event)` | 追加一条事件（同步写盘） |
| `query(filters)` | 按 entityId、since、type、limit 过滤查询 |
| `getHistory(entityId)` | 获取指定实体的完整事件历史 |

### 5.2 SpanMetrics：OTel Span 指标推导

**文件**：`packages/tw-daemon/src/metrics/span-metrics.ts`

**核心设计**：

- 从 SpanManager 的内存 Span 数据推导指标，不依赖外部监控系统
- 支持按实体类型和时间窗口过滤
- 指标全部在查询时实时计算，无需独立持久化

**核心 API**：

| 方法 | 说明 |
|------|------|
| `getCycleTime(type?, window?)` | 计算平均周期时间（ms） |
| `getFailureRate(type?, window?)` | 计算失败率（0~1） |
| `getThroughput(type?, window?)` | 计算吞吐量（entities/hour） |
| `getSummary(type?, window?)` | 返回包含所有指标的聚合摘要 |

### 5.3 ImpactResolver：传递影响分析

**文件**：`packages/tw-daemon/src/impact/impact-resolver.ts`

**核心设计**：

三层索引结构，在 `CommandHandler` 内部维护，每次实体注册或更新时自动重建：

- `fileIndex`：文件路径 → 直接引用该文件的实体 ID 集合
- `dependentIndex`：实体 ID → 依赖该实体的其他实体 ID 集合（反向 DAG）
- `byId`：实体 ID → 实体对象

BFS 传递影响计算：从直接受影响实体出发，沿 `dependentIndex` 广度优先遍历，收集所有传递影响的实体，保证不重复、不死循环。

**输出格式**：

```json
{
  "directly_affected": ["task-1", "task-2"],
  "transitively_affected": ["exp-1"]
}
```

### 5.4 HarnessLoader：约束文件加载器

**文件**：`packages/tw-daemon/src/harness/loader.ts`

**核心设计**：

- 扫描 `.traceweaver/harness/*.md` 目录下的所有 Markdown 文件
- 使用 `js-yaml` 解析文件头部的 YAML frontmatter，提取 `id`、`applies_to`（实体类型列表）、`trigger_on`（触发状态列表）
- 文件正文（frontmatter 之后的 Markdown 内容）作为约束描述传给 ConstraintEvaluator

**Harness 文件格式示例**：

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

All tasks MUST include test files. Check that artifact_refs contains at least
one entry with type "test".

RESULT: pass if tests are present, fail otherwise.
```

### 5.5 TriggerExecutor：自动触发与拒绝

**文件**：`packages/tw-daemon/src/trigger/executor.ts`

**核心设计**：

- 通过 `EventBus.subscribeBatch()` 批处理订阅 `entity.state_changed` 事件，减少高频触发时的系统开销
- TOCTOU 双重防护：在评估前和提交 `rejected` 前各检查一次实体当前状态，防止并发竞争导致对已完成实体进行误拒绝
- `in-flight Set`：记录正在评估中的实体 ID，防止同一实体被并发触发多次
- 自动拒绝：ConstraintEvaluator 返回 `fail` 时，自动调用 `updateState(entityId, 'rejected', reason)`，并向收件箱写入通知

**触发流程**：

```
EventBus batch → 过滤 state_changed 事件
  → 匹配 harness applies_to + trigger_on
  → 检查 in-flight（跳过已在评估中的实体）
  → 加入 in-flight Set
  → 一次 TOCTOU 检查（确认实体仍在触发状态）
  → 调用 ConstraintEvaluator.evaluate()
  → 二次 TOCTOU 检查（确认实体未被其他流程修改）
  → pass → 记录结果，从 in-flight 移除
  → fail → updateState(rejected) → InboxAdapter 通知 → 从 in-flight 移除
```

---

## 6. CLI 命令全览（Phase 5 新增）

### tw log query

```bash
tw log query [--entity <id>] [--since <duration>] [--type <event-type>] [--limit <n>] [--json]
```

查询 NDJSON 持久化事件日志，支持跨守护进程重启的历史查询。`--since` 支持 `1h`、`24h`、`7d` 或 ISO 8601 时间戳。

### tw metrics

```bash
tw metrics [--type <entity-type>] [--window <hours>] [--json]
```

查询从 OTel Span 推导的指标摘要，包含失败率、吞吐量、活跃 Span 数和总 Span 数。

### tw harness list

```bash
tw harness list [--json]
```

列出 `.traceweaver/harness/` 目录下所有已加载的约束文件及其基本信息。

### tw harness show

```bash
tw harness show <id> [--json]
```

显示指定 harness 的完整信息，包括 `applies_to`、`trigger_on` 和约束正文。

### tw harness run

```bash
tw harness run <entity-id> --harness-id <id> [--json]
```

对指定实体手动运行约束评估。输出包含 `result`（pass/fail/skipped）、`refs_checked` 和 `checked_at`。

### tw watch

```bash
tw watch [--entity <id>] [--json]
```

500ms 轮询实时事件流，持续输出新事件直到 Ctrl+C。`--json` 模式每行输出一个 JSON 对象，适合 AI Agent 实时消费。

### --json 标志

所有 Phase 5 新增命令及已有命令均支持 `--json` 标志：

| 命令 | --json 输出说明 |
|------|----------------|
| `tw status --json` | 实体列表 + 状态摘要的 JSON 数组 |
| `tw metrics --json` | 指标摘要 JSON 对象 |
| `tw log query --json` | 事件记录 JSON 数组 |
| `tw harness list --json` | harness 列表 JSON 数组 |
| `tw harness run --json` | 评估结果 JSON 对象 |
| `tw watch --json` | 每行一个事件 JSON 对象（流式） |
| `tw dag --json` | 节点和边的 JSON 图结构 |
| `tw impact --json` | 直接/传递影响实体的 JSON 对象 |

---

## 7. 关键工程决策

### 为什么用 NDJSON 而不是 SQLite

SQLite 需要 native addon（`better-sqlite3` 等），会引入平台相关的二进制依赖，增加安装复杂度和供应链风险。NDJSON 基于 Node.js 内置 `fs` 模块，零依赖，天然支持追加写入和流式读取，对 TraceWeaver 的查询模式（按时间范围、实体 ID 过滤）已足够高效，且文件内容人类可读，便于调试。

### 为什么用 mock LLM 而不强依赖 Anthropic API

强依赖 LLM API 会导致：测试速度慢（网络请求）、测试成本高（API 计费）、CI 环境需要 secret 管理。采用 mock 策略使 242 个测试在 ~4 秒内全部通过，无需任何 API key。生产环境只需设置 `ANTHROPIC_API_KEY` 即可启用真实 LLM 评估，测试环境保持零成本隔离。

### 为什么 TriggerExecutor 要做双重 TOCTOU 防护

单次检查存在竞争窗口：在"检查实体状态"到"执行拒绝"之间，实体可能已被用户或其他流程推进到 `completed`。双重检查策略：

- **第一次检查**（评估前）：确认实体仍在触发状态，避免对已完成实体浪费 LLM 调用
- **第二次检查**（拒绝前）：确认实体在评估期间未被修改，避免将合法的 `completed` 实体误改为 `rejected`

in-flight Set 则防止同一实体被并发触发多次评估（例如快速连续的状态变更事件）。

---

## 8. 边界条件处理

以下边界条件均已通过测试验证：

| 场景 | 处理方式 |
|------|---------|
| 非法状态跳转（如 `pending → completed`） | 返回 `INVALID_TRANSITION` 错误，实体状态不变 |
| TriggerExecutor 并发触发同一实体 | in-flight Set 跳过已在评估中的实体，保证幂等 |
| 评估期间实体被外部推进（TOCTOU） | 双重检查，第二次检查失败则放弃拒绝，不破坏实体状态 |
| 空影响集合（文件未被任何实体引用） | `directly_affected: [], transitively_affected: []`，不报错 |
| WAL 崩溃恢复 | 守护进程启动时重放 WAL，恢复到最后一致状态 |
| EventLog 跨实例重放 | 新守护进程实例调用 `load()` 从 NDJSON 文件重建内存索引 |
| Harness 目录不存在 | HarnessLoader 返回空列表，不抛出异常 |
| ConstraintEvaluator 未配置 API key | 进入禁用模式，所有评估返回 `skipped`，不触发自动拒绝 |
| `tw watch` 守护进程未运行 | 输出友好错误提示，不崩溃 |
| `tw metrics` 无 Span 数据 | 返回零值摘要，不报错 |

---

## 9. 验证方式

### 单元测试与集成测试

```bash
npm test
# Expected: Test Files 36 passed, Tests 242 passed
```

### 全链路闭环 Demo

```bash
npm run example:11
# 运行 examples/src/11-full-chain-autonomous-loop.ts
# 演示完整的 observe → detect → diagnose → validate → fix 闭环
```

### 版本标签

```bash
git tag v0.6.0
```

---

## 10. 后续规划

Phase 6 完成了经验感知与约束质量闭环。以下是可选的 Phase 7 方向，按优先级排列：

| 方向 | 说明 | 优先级 |
|------|------|--------|
| `blocked` 状态支持 | 状态机新增 `blocked` 状态，用于表达外部阻塞（类型已预留，实现待补） | 高 |
| `milestone` 实体类型 | 新增 milestone 实体，跨 plan 聚合进度追踪 | 中 |
| 持久化 SpanMetrics | 将 Span 指标写入磁盘（NDJSON 或 SQLite），支持跨重启查询历史指标 | 中 |
| 多项目支持 | 支持在一个守护进程中管理多个独立项目的实体命名空间 | 中 |
| Web Dashboard | 基于 HTTP API 的可视化仪表盘，展示实体状态图、指标趋势、约束结果 | 低 |
| Jaeger 冒烟验收 | 配置 `TW_OTEL_EXPORTER=otlp-grpc` 后在 Jaeger UI 验证完整链路可见（T08 验收） | 低 |
