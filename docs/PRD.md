# TraceWeaver — Product Requirements Document

> **版本：** v1.0
> **日期：** 2026-03-26
> **作者：** TraceWeaver Team
> **状态：** Phase 1 已交付 / Phase 2 规划中

---

## 1. 产品定位

### 1.1 我们解决的问题

AI Agent 正在替代工程师执行研发任务——写代码、拆需求、执行 Plan。
但现有工具链（Jira、GitHub Issues、Prometheus）无法回答这些问题：

- **这个 AI Agent 正在做什么？** 它在执行哪个 Plan，当前进展如何？
- **它的决策符合团队约束吗？** 代码有没有测试？文档有没有更新？架构有没有违规？
- **它消耗了多少资源？** 用了多少 token？花了多少钱？哪个约束评估最贵？
- **出错了怎么追溯？** 哪个实体在哪个时间点被 reject，原因是什么？

这是 **2026 年软件工程的可观测性盲区**。

### 1.2 产品定义

TraceWeaver 是一个 **AI 原生研发流程可观测引擎（AI-Native Dev Process Observability Engine）**：

- **可观测**：UseCase → Plan → Task 全生命周期，实时可查，Jaeger 可视化
- **可约束**：Harness-as-Code，自然语言声明约束，LLM 执行评估，自动 reject + 修复
- **可审计**：EventLog（NDJSON）全量历史，FeedbackLog 评估记录，永不删改
- **AI Agent 原生**：`_ai_context` 字段，AI Agent 无需理解系统即可消费行动指引

### 1.3 类比定位

| 你熟悉的 | TraceWeaver 对应 |
|---------|-----------------|
| Kubernetes 资源管理 | UseCase/Plan/Task 实体生命周期管理 |
| OPA / Admission Controller | Harness 约束评估（自然语言 + LLM） |
| Prometheus + Grafana | SpanManager + Jaeger + tw metrics |
| kubectl apply | tw register / tw update |
| Pod Event log | EventLog NDJSON |
| Horizontal reconcile loop | TriggerExecutor + RemediationEngine |

---

## 2. 目标用户

### Primary：AI Agent（系统自动化使用者）

AI Agent 是 TraceWeaver 最重要的消费者。它通过：
- IPC Socket（`sendIpc`）注册和更新实体
- `tw trace info --json` 消费 `_ai_context` 决定下一步
- 响应 `blocked` 列表调整执行顺序

**Agent 不需要理解 TraceWeaver 的内部机制**，它只需要知道：`_ai_context.next_actions` 是它的行动清单。

### Secondary：Tech Lead / 工程师

负责：
- 编写 Harness 约束文件（定义团队编码标准）
- 查看 `tw trace info` 了解整体进展
- 阅读 `tw report daily` 日报
- 通过 `tw inbox` 接收 harness fail 告警并介入

### Tertiary：管理层 / 合伙人

通过日报（`.md` 文件）了解：
- AI Agent 今天完成了什么、卡在哪里
- LLM 花了多少钱（Phase 2）
- Harness 通过率（代码质量趋势）

---

## 3. 核心功能需求

### 3.1 实体生命周期追踪（P0 — 已交付）

**需求描述：** 以 UseCase → Plan → Task 层次结构追踪研发过程中每个工作单元的完整生命周期。

**功能点：**
- 实体注册（id / entity_type / artifact_refs / depends_on / constraint_refs）
- 状态机（pending → in_progress → review → completed | rejected）
- WAL 持久化（daemon 重启后状态恢复）
- DAG 依赖图（depends_on 级联更新）
- ImpactResolver（artifact_path → entity 反向索引）

**验收标准：**
- 注册的实体可通过 `tw status` 查询
- 状态转换违规被拒绝并返回错误
- 实体在 Jaeger 中有对应 Span 记录
- daemon 重启后实体状态从 WAL 恢复

---

### 3.2 Harness 约束系统（P0 — 已交付）

**需求描述：** 工程师以声明式 Markdown 文件定义研发约束，系统自动在适当时机调用 LLM 评估。

**功能点：**
- HarnessLoader：扫描 `.traceweaver/harness/*.md`
- 触发条件：`trigger_on: [review]` / `applies_to: [task]`
- constraint_refs：实体可选择性绑定 harness 子集
- ConstraintEvaluator：LLM 判定 pass/fail + reason
- Auto-reject：fail → 强制 rejected + FeedbackLog + RemediationEngine
- 手动触发：`tw harness run --entity-id --harness-id`

**验收标准：**
- Harness 文件变更后 `tw harness list` 立即反映
- Task 进入 review 后 ≤ 5s 完成评估（本地 LLM）
- fail 实体状态自动变为 `rejected`
- FeedbackLog 可查询历史评估记录
- harness pass 率在 `tw metrics` 中可见

---

### 3.3 Trace 链路查询（P0 — 已交付）

**需求描述：** AI Agent 和工程师可以实时查询任意实体的完整链路状态，获取可直接行动的上下文。

**功能点：**
- `tw trace spans`：SpanTree 可视化（live + reconstructed 双来源）
- `tw trace info`：完整 TraceInfo（summary + _ai_context）
- `_ai_context` 三字段：one_line / next_actions / error_refs
- blocked 检测：depends_on 中有非 completed 实体
- `--entity-id` 和 `--trace-id` 双入口
- `--json` 机器可读输出

**验收标准：**
- `tw trace info --json` 的 `_ai_context` 被 AI Agent 消费后能正确行动
- daemon 重启后 reconstructed 模式仍可返回部分数据
- `blocked` 列表准确反映实际依赖阻塞情况
- Jaeger 中 Span 树与 `tw trace spans` 输出一致

---

### 3.4 日报生成（P1 — 已交付）

**需求描述：** 系统自动或按需生成结构化 Markdown 日报，聚合当日研发进展、约束评估结果和阻塞情况。

**功能点：**
- `tw report daily --trace-id | --all`：生成日报
- `tw report list --date`：列出历史报告
- `tw report show`：查看报告内容
- 原子写入（tmp → rename）防止文件损坏
- EventLog file-ref：只存路径，不存内容
- ReportScheduler：按 config.report.schedule 定时生成（HH:MM 格式）
- 幂等机制：EventLog 查询今日是否已生成，避免重复

**报告包含：**
- 实体汇总（total/completed/in_progress/rejected/blocked）
- Harness 失败列表（entity_id + harness_id + reason）
- Span 树（实体层次）
- AI Context（one_line + next_actions）

**验收标准：**
- 生成的 .md 文件包含当日所有关键实体状态
- 同一天运行两次 `tw report daily` 不重复生成（幂等）
- .tmp 文件在生成完成后不存在（原子写入验证）

---

### 3.5 LLM Token/Cost 可观测（P1 — 规划中 Phase 2）

**需求描述：** 记录每次 Harness 评估的 LLM token 消耗和成本，提供按实体、按模型、按时间的多维聚合查询。

**功能点：**
- `LlmUsageSnapshot`：provider / model / input_tokens / output_tokens / cost_usd / duration_ms
- OTel GenAI 语义属性：`gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` 附到 Span Event
- EventLog `llm.call.completed` 事件（永久可查）
- UsageAccumulator：内存聚合，30s TTL
- Pricing Config：`config.llm.pricing[modelId]` = { input_per_1m, output_per_1m, ... }
- `tw usage`：today 汇总 / by model / by harness / by entity
- `tw usage --since 7d`：历史区间查询
- 日报自动包含 `## LLM Usage` section

**价格计算公式：**
```
cost_usd = (input_tokens * price.input_per_1m +
            output_tokens * price.output_per_1m +
            cache_read * price.cache_read_per_1m +
            cache_write * price.cache_write_per_1m) / 1_000_000
```

**验收标准：**
- `tw usage --json` 输出包含 totalTokens / totalCost / byModel
- Jaeger 中实体 Span 的 events 包含 `gen_ai.usage.input_tokens` 属性
- 日报的 LLM Usage section 数据与 `tw usage` 一致
- `config.llm.pricing` 缺省时，只显示 token 数不显示 cost

---

### 3.6 预算熔断（P2 — 规划中 Phase 3）

**需求描述：** 当日 LLM 消耗超出配置预算时，系统自动降级（跳过 LLM 评估）并告警。

**功能点：**
- `config.llm.budget.daily_usd`：每日预算上限
- UsageAccumulator 累计检查（每次 record 后）
- 超限 → `llm.budget.exceeded` 事件 → NotifyEngine 推送
- 降级模式：后续 harness 评估返回 `result: skipped`，实体不被 reject
- `tw usage --budget`：显示当日预算使用率

---

## 4. 非功能需求

### 4.1 性能

| 指标 | 要求 |
|------|------|
| 实体状态查询延迟 | < 50ms（本地 IPC） |
| Harness 评估延迟 | 由 LLM API 决定，不阻塞主流程 |
| SpanTree 构建（200 实体） | < 100ms（O(n) scan 可接受） |
| EventLog 写入 | append-only，无索引，任意规模 |
| daemon 启动时间 | < 2s（含 WAL replay） |

### 4.2 可靠性

- WAL 持久化：daemon 崩溃后状态 100% 恢复
- EventLog append-only：历史记录不可修改（audit trail）
- 原子文件写入：report / WAL 使用 tmp → rename 模式
- Harness 评估失败不影响实体状态（LLM 调用超时 → 跳过，不 reject）

### 4.3 可扩展性

- 支持多 Harness 文件（不限数量）
- 支持多 Provider（Anthropic / OpenAI / Bedrock，通过 config.llm）
- Exporter 注册模式：OtlpGrpcExporter + ConsoleExporter 可叠加
- IPC 方法 if/else if 链：新增方法无需修改现有逻辑

### 4.4 安全性

- 无硬编码密钥（API Key 通过环境变量或 config.yaml 注入）
- IPC Socket 权限：Unix Socket 文件权限控制
- 无远程代码执行：Harness 只是 Prompt 内容，不执行代码

---

## 5. 架构约束（不可越界）

```
tw-types  ──▶  被所有包引用，自身不能 import 任何兄弟包
tw-daemon ──▶  不能 import tw-cli
tw-cli    ──▶  只能通过 IPC Socket 与 daemon 通信，禁止直接 import daemon src
examples  ──▶  可直接 import daemon src（演示用），不走 IPC
```

**子模块职责边界（daemon 内）：**
- `core/`：状态机、WAL — 不能 import watcher/harness/trigger
- `otel/`：SpanManager + TraceQueryEngine — 不能 import trigger/harness
- `report/`：ReportGenerator + ReportScheduler — 不能 import trigger/harness
- `log/`：EventLog — 只追加，不修改历史

---

## 6. 发布路线图

### Phase 1（已交付）— 核心引擎

| 功能 | 状态 |
|------|------|
| 实体生命周期追踪（UC-1/2） | ✅ |
| Harness 约束系统（UC-3） | ✅ |
| 文件变更影响分析（UC-4） | ✅ |
| Trace 链路查询 `tw trace`（UC-5） | ✅ |
| 日报生成 `tw report`（UC-6） | ✅ |
| TaskMaster 联动（UC-7） | ✅ |
| OTLP/gRPC → Jaeger | ✅ |
| MCP Server（AI Agent 接口） | ✅ |

### Phase 2（下一 sprint）— 成本可观测

| 功能 | 预计 |
|------|------|
| LlmUsageSnapshot + UsageAccumulator | Sprint 1 |
| ConstraintEvaluator onUsage 回调 | Sprint 1 |
| `tw usage` CLI 命令 | Sprint 1 |
| OTel GenAI 语义属性 attach Span | Sprint 1 |
| 日报 LLM Usage section | Sprint 2 |
| Pricing Config（config.yaml） | Sprint 2 |

### Phase 3（后续）— 预算控制与多 Agent

| 功能 | 预计 |
|------|------|
| 预算熔断（`llm.budget.daily_usd`） | TBD |
| Web UI Dashboard | TBD |
| 多 Agent 协作（共享 UseCase trace） | TBD |
| k8s 部署模式（daemon as DaemonSet） | TBD |
| Harness 市场（开箱即用约束库） | TBD |

---

## 7. 成功指标

### 功能指标
- AI Agent 消费 `_ai_context` 后正确行动率 > 90%
- Harness 评估误报率（pass 实际不满足）< 5%
- daemon 崩溃恢复成功率 100%（WAL 保证）
- 日报覆盖率：有 Trace 数据的日期，报告生成率 100%

### 开发者体验指标
- `tw daemon start` → `tw status` 流程 < 5s
- 新增 Harness 文件 → 生效 < 10s（热加载）
- `tw trace info --json` → AI Agent 行动 < 2s（不含 LLM 延迟）

### 商业指标（Phase 2 后可见）
- 每 Plan 平均 LLM 成本
- Harness 通过率趋势（反映代码质量改进）
- 月 token 消耗预测 vs 实际

---

## 8. 竞品对比

| 产品 | 观测维度 | 约束执行 | AI Agent 原生 | 研发流程集成 |
|------|---------|---------|--------------|------------|
| **TraceWeaver** | 研发流程实体 + LLM calls | Harness-as-Code（自然语言）| ✅ `_ai_context` | ✅ UseCase/Plan/Task |
| Langfuse | LLM API 调用 | ❌ | 部分 | ❌ |
| Helicone | LLM API 调用 + 成本 | ❌ | ❌ | ❌ |
| Traceloop | LLM spans（OTel） | ❌ | ❌ | ❌ |
| Linear / Jira | 任务状态 | 人工规则 | ❌ | ✅ |

**差异化：** TraceWeaver 是唯一将「研发实体生命周期」「自然语言约束自动评估」「AI Agent 行动上下文」三者统一在同一可观测链路中的产品。

---

## 9. 开放问题

| 问题 | 优先级 | 负责人 |
|------|--------|--------|
| k8s 部署方案：daemon 以 DaemonSet 还是 sidecar 运行？ | P1 | 技术合伙人 |
| 多租户隔离：不同团队的 entity namespace 如何分离？ | P1 | 架构讨论 |
| Harness 市场：约束库的托管和分发方式？ | P2 | 产品讨论 |
| Web UI：自研还是接入现有 Jaeger UI 扩展？ | P2 | TBD |
| Bedrock / Vertex AI 支持（Pricing 配置）？ | P2 | TBD |
| ReportGenerator 输出格式：Markdown only 还是 JSON + MD？ | P3 | TBD |
