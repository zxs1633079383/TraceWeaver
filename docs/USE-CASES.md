# TraceWeaver — Use Case Document

> **版本：** v1.1
> **日期：** 2026-03-26
> **状态：** 已实现（UC-1 ~ UC-8）/ 规划中（UC-9 ~ UC-11）

---

## 系统概述

TraceWeaver 是一个 **AI 原生研发流程可观测引擎**。
它追踪 UseCase → Plan → Task 的完整生命周期，通过声明式约束（Harness）对 AI Agent 和工程师的研发行为进行实时评估，并通过标准可观测协议（OTLP/gRPC → Jaeger）将整个过程结构化输出。

---

## 参与者（Actors）

| Actor | 角色 | 典型操作 |
|-------|------|---------|
| **AI Agent** | 自动化研发主体，执行 Plan/Task | 注册实体、更新状态、查询 trace、读取 _ai_context |
| **工程师** | 人工研发者，监督与介入 | 查看 trace、确认 harness 结果、触发修复 |
| **Tech Lead** | 设计约束规则，评审研发质量 | 编写 Harness 文件、查看 FeedbackLog、生成日报 |
| **TraceWeaver Daemon** | 系统核心进程（内部 Actor） | 文件监听、约束评估、事件持久化、Span 导出 |
| **外部系统** | Jaeger、TaskMaster、MCP 客户端 | 接收 Span 数据、触发 hook、查询 AI 上下文 |

---

## Use Case 清单

### UC-1：注册研发实体

**Actor：** AI Agent / 工程师
**触发：** 新 UseCase / Plan / Task 被创建
**前置条件：** Daemon 已启动

**主流程：**
1. Actor 调用 `tw register` 或 `sendIpc({ method: 'register' })`
2. Daemon 将实体写入 EntityRegistry（WAL 持久化）
3. SpanManager 为该实体创建 OTel Span（trace_id 自动分配）
4. EventLog 记录 `entity.registered` 事件
5. ImpactResolver 建立 artifact_refs → entity 反向索引

**后置条件：** 实体可查，Span 已开始，可被 ImpactResolver 追踪

**约束：**
- entity_type ∈ {usecase, plan, task}
- depends_on 中的实体必须已注册（否则 cascade 失效）
- constraint_refs 声明绑定 harness 子集（空=全量）

---

### UC-2：驱动实体状态流转

**Actor：** AI Agent / 工程师
**触发：** 研发进展（开始实现、提交审核、完成）

**主流程：**
1. Actor 调用 `tw update --id <id> --state <state>` 或 IPC `update_state`
2. StateMachine 验证状态转换合法性（如 `pending → in_progress` ✓，`completed → pending` ✗）
3. 若新状态 = `review`：TriggerExecutor 自动触发绑定 harness 评估
4. EventLog 记录 `entity.state_changed`
5. SpanManager 更新 Span 状态

**后置条件（触发 Harness 评估时）：**
- ConstraintEvaluator 通过 LLM 判定 pass/fail
- pass → 状态继续流转
- fail → auto-reject：状态强制设为 `rejected`，FeedbackLog 记录原因，RemediationEngine 入队

---

### UC-3：Harness 约束评估（声明式约束执行）

**Actor：** Daemon（自动触发）/ 工程师（手动触发）
**触发：** 实体进入 `review` 状态 或 `tw harness run` 命令

**主流程：**
1. TriggerExecutor 匹配 entity 的 `constraint_refs`（或全量 harness）
2. HarnessLoader 提供 harness 内容（`.md` 格式约束描述）
3. ConstraintEvaluator 构造 Prompt：实体上下文 + harness 约束 → LLM
4. LLM 返回 `RESULT: pass/fail` + 原因
5. FeedbackLog 追加评估记录（entity_id, harness_id, result, reason）
6. fail → `updateState(entity, 'rejected')` + NotifyEngine 推送通知
7. RemediationEngine 将 (entity_id, harness_id, reason) 入修复队列

**Harness 文件格式：**
```markdown
---
id: task-needs-test
applies_to: [task]
trigger_on: [review]
---
任务进入 review 前，artifact_refs 中必须包含 type=test 的测试文件。
RESULT: fail if no test artifacts found.
```

**关键设计：** 约束即代码（Constraint as Code）。约束以自然语言声明，LLM 执行评估——不需要 Rego，不需要 DSL。

---

### UC-4：文件变更触发影响分析

**Actor：** FsWatcher（Daemon 自动）
**触发：** `config.watch.dirs` 中的文件发生变化

**主流程：**
1. FsWatcher 检测文件变更，发出 `file.changed` 事件
2. ImpactResolver 通过反向索引（artifact_path → entity）找到受影响实体
3. 对每个直接受影响实体：触发 `artifact.modified`
4. 级联计算：transitively_affected（下游依赖实体）
5. TriggerExecutor 对受影响实体执行 harness 评估

**用例价值：** 工程师修改了某文件，自动知道哪些 Plan/Task 受影响，是否需要重新审核。

---

### UC-5：查询 Trace 链路（AI Agent 消费）

**Actor：** AI Agent / 工程师
**触发：** 需要了解当前研发进展和上下文

**主流程（`tw trace spans`）：**
1. Agent 调用 `tw trace spans --entity-id <id>` 或 `--trace-id <id>`
2. TraceQueryEngine 从 SpanManager 查找 live spans（O(n) scan）
3. 构建 SpanTreeNode 树（state 来自 EntityRegistry，source='live'）
4. 返回嵌套 Span 树

**主流程（`tw trace info` — AI Agent 专用）：**
1. Agent 调用 `tw trace info --trace-id <id> --json`
2. TraceQueryEngine.buildTraceInfo() 计算：
   - summary：total/completed/in_progress/rejected/blocked 计数
   - blocked：depends_on 中有非 completed 实体的列表
   - harness_failures：FeedbackLog 中 result=fail 的记录
3. 生成 `_ai_context`（确定性模板，无 LLM 调用）：
   ```json
   {
     "one_line": "5 实体中 1 完成，task-bad 被 harness 拒绝，task-blocked 等待解锁",
     "next_actions": ["task-bad: 缺少测试文件 → 修复后重新 review"],
     "error_refs": ["events.ndjson → entity_id=task-bad, type=entity.state_changed"]
   }
   ```
4. Agent 消费 `_ai_context` 决定下一步行动

**关键设计：** AI Agent 不需要理解整个 TraceWeaver 系统，只需读 `_ai_context` 就能知道"现在应该做什么"。

---

### UC-6：生成日报

**Actor：** 工程师 / Tech Lead / ReportScheduler（自动）
**触发：** `tw report daily` 命令 或 `config.report.schedule` 定时触发

**主流程：**
1. ReportGenerator.generate({ traceId, date }) 调用 TraceQueryEngine 获取 SpanTree
2. 聚合四来源数据：SpanTree + FeedbackLog + EventLog + _ai_context
3. 原子写入（tmp → rename）到 `output_dir/YYYY-MM-DD-{traceId8}.md`
4. EventLog 追加 `report.generated`（仅文件引用，不含内容）
5. 返回文件路径

**ReportScheduler 幂等机制：** 每次 tick 检查 EventLog 中今日是否已有 `report.generated` → 有则跳过，无则生成。

**报告内容：** 实体汇总 + harness 失败列表 + Span 树 + AI Context + LLM 使用统计（Phase 2 加入）

---

### UC-7：TaskMaster 联动（AI Agent 工作流桥接）

**Actor：** AI Agent（使用 TaskMaster 的工作流）
**触发：** TaskMaster task 状态变更 / expand 操作

**主流程：**
```bash
# expand 前
tw taskmaster hook before-expand --plan=plan-001 --tm-id=5
task-master expand --id=5
tw taskmaster hook after-expand --plan=plan-001 --tm-id=5

# 状态变更
task-master set-status 5 done
tw taskmaster hook status-changed --tm-id=5 --status=done
```

**价值：** 将 TaskMaster 的任务状态同步到 TraceWeaver 的 EntityRegistry，使 AI Agent 的工作流变得可观测、可审计、可约束。

---

### UC-8：预算控制与通知

**Actor：** Tech Lead / Daemon
**触发：** AI Agent 超出研发边界（多次 harness fail / 无限循环）

**主流程：**
1. RemediationEngine 检测修复尝试次数（maxAttempts 上限）
2. 超出上限 → EventBus 广播 `remediation.exhausted`
3. NotifyEngine → InboxAdapter 推送告警通知
4. 工程师查看 `tw inbox` 接收告警并人工介入

---

### UC-9：LLM Token/Cost 可观测（规划中）

**Actor：** Tech Lead / 工程师
**触发：** `tw usage` 命令 / 日报自动包含

**主流程（规划）：**
1. ConstraintEvaluator 每次 LLM 调用后触发 `onUsage(snapshot)` 回调
2. UsageAccumulator 记录：provider / model / input_tokens / output_tokens / cost_usd / duration_ms
3. EventLog 追加 `llm.call.completed` 事件（携带 OTel GenAI 语义属性）
4. SpanManager.addEvent() 将 token 数据 attach 到实体 Span（Jaeger 可视化）
5. `tw usage` 展示聚合：by model / by harness / by entity / total cost

**价值：** 知道每个 Plan/Task 的 harness 评估花了多少钱，哪个约束最"贵"，为模型选型和预算管控提供数据基础。

---

### UC-10：预算熔断（规划中）

**Actor：** Daemon / Tech Lead
**触发：** `llm.budget.daily_usd` 配置存在，且当日消耗超限

**主流程（规划）：**
1. UsageAccumulator 每次记录后检查当日累计 cost
2. 超出 `config.llm.budget.daily_usd` → 广播 `llm.budget.exceeded`
3. NotifyEngine 推送告警
4. 后续 harness 评估降级：跳过 LLM 调用，返回 `result: skipped`（保守模式）

---

### UC-11：多 Agent 协作研发（规划中）

**Actor：** 多个 AI Agent
**场景：** Agent-A 负责 Plan-A，Agent-B 负责 Plan-B，共享同一个 UseCase

**主流程（规划）：**
1. 各 Agent 独立注册自己负责的 Plan/Task 实体（共享 usecase trace_id）
2. Harness 约束在各自 Plan 维度独立评估
3. `tw trace info` 汇总整个 UseCase 的全局进展（多 Agent 视图）
4. depends_on 跨 Plan 的 blocked 检测自动触发协作提示

---

## Use Case 关系图

```
UC-1 注册实体
  ↓
UC-2 状态流转
  ├→ UC-3 Harness 评估（review 触发）
  │     ├→ UC-9 Token/Cost 记录（每次 LLM 调用）
  │     └→ UC-10 预算熔断（累计超限）
  └→ UC-4 文件变更触发（artifact 变化触发重评）
       └→ UC-3 Harness 评估

UC-5 Trace 查询（AI Agent 消费 _ai_context）
  └→ UC-7 TaskMaster 联动（状态同步）
       └→ UC-11 多 Agent 协作

UC-6 日报生成（聚合 UC-1~UC-5 的数据）
  └→ UC-9 LLM Usage 统计（日报 section）

UC-8 预算/告警（UC-3 的副产物）
```

---

## 实现状态

| Use Case | 状态 | 核心代码 |
|---------|------|---------|
| UC-1 实体注册 | ✅ 已实现 | `command-handler.ts` / `entity-registry.ts` |
| UC-2 状态流转 | ✅ 已实现 | `state-machine.ts` / `trigger/executor.ts` |
| UC-3 Harness 评估 | ✅ 已实现 | `constraint/evaluator.ts` / `harness/loader.ts` |
| UC-4 文件变更 | ✅ 已实现 | `watcher/fs-watcher.ts` / `impact/impact-resolver.ts` |
| UC-5 Trace 查询 | ✅ 已实现 | `otel/trace-query.ts` / `tw trace spans\|info` |
| UC-6 日报生成 | ✅ 已实现 | `report/report-generator.ts` / `tw report daily` |
| UC-7 TaskMaster 联动 | ✅ 已实现 | `commands/taskmaster.ts` |
| UC-8 预算/告警 | ✅ 已实现 | `remediation/engine.ts` / `notify/engine.ts` |
| UC-9 Token/Cost | 📋 规划中 | Phase 2（下一 sprint） |
| UC-10 预算熔断 | 📋 规划中 | Phase 3 |
| UC-11 多 Agent 协作 | 🔮 远期 | TBD |
