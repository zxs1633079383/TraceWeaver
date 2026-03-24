# TraceWeaver Phase 6 — 用户故事 (User Stories)

> 阶段目标：构建 Harness 内部可观测性基础设施 + 真实 Jaeger 链路接入，实现全流程闭环演进的可验证交付。

---

## UC-01 Harness 经验积累与反馈闭环

**作为** TraceWeaver 系统内部基础设施，
**我需要** 在每次 harness 约束评估后持久化结果（pass/fail/skipped + 原因 + 耗时），
**以便** 系统能够跨生命周期积累经验，自动检测退化趋势，并在约束持续失败时主动发出改进建议。

**验收条件：**
- [ ] 每次 TriggerExecutor 评估后写入 `feedback.ndjson`
- [ ] 支持按 harness_id / entity_id / result / since 查询历史
- [ ] `getSummary(harness_id)` 返回 total/pass/fail/failure_rate/consecutive_failures/trend
- [ ] 连续失败 ≥ 3 次时自动写入收件箱：附原因 + 修正建议
- [ ] 跨 Daemon 重启后经验历史仍可查询

---

## UC-02 Harness 与代码实时对齐验证

**作为** TraceWeaver 系统内部基础设施，
**我需要** 持续检测 harness `.md` 文件与实体注册表/代码现实的偏差，
**以便** 在 harness 内容失效（孤儿引用、死约束、持续失败）时立即发现并提示修正。

**验收条件：**
- [ ] 检测孤儿引用：entity.constraint_refs 指向不存在的 harness → severity=error
- [ ] 检测死约束：harness.applies_to 中的实体类型在注册表中不存在 → severity=warning
- [ ] 检测持续失败：consecutive_failures ≥ 阈值 → severity=warning + suggestion
- [ ] `.traceweaver/harness/` 目录文件变更时自动 rescan + revalidate
- [ ] 发现问题时写入收件箱 + 发布 `harness.misaligned` 事件
- [ ] IPC: `harness_validate` 返回完整 AlignmentIssue 列表
- [ ] CLI: `tw harness validate [--json]` 展示对齐报告
- [ ] CLI: `tw feedback [query|summary] [--harness-id] [--json]` 查询经验历史

---

## UC-03 真实 Jaeger 链路接入

**作为** 工程师或 AI Agent，
**我需要** TraceWeaver 将实体生命周期的 OTel Span 通过 OTLP/gRPC 协议导出到 Jaeger，
**以便** 在 Jaeger UI 中看到完整的研发链路（usecase → plan → task），包括状态变更、约束评估等关键事件。

**验收条件：**
- [ ] 新增 OTLP/gRPC 导出适配器（使用 `@grpc/grpc-js`）
- [ ] 配置 `TW_OTEL_EXPORTER=otlp-grpc` + `TW_OTEL_ENDPOINT=<grpc endpoint>` 启用
- [ ] 支持多适配器：`console` | `otlp-http` | `otlp-grpc`（可配置，互不冲突）
- [ ] 实体从 pending → completed/rejected 的完整 span 出现在 Jaeger
- [ ] Span attributes 包含 `tw.entity.id`, `tw.entity.type`, `tw.project.id`
- [ ] Span events 对应每次状态变更和 harness 评估结果
- [ ] 链路在 Jaeger 可通过 `service.name=traceweaver-daemon` 检索

---

## UC-04 全流程闭环验收

**作为** 工程师，
**我需要** 运行一个端到端演示，
**以便** 验证：

```
注册实体 → 状态流转 → Harness 自动评估 → 经验记录 → 对齐检测 → Span 导出 → Jaeger 可见
```

**验收条件：**
- [ ] `tw daemon start` 后运行 Example 11，所有 Phase 验证通过
- [ ] `tw feedback summary` 显示 harness 评估历史
- [ ] `tw harness validate` 显示当前对齐状态
- [ ] Jaeger UI 中可看到 traceweaver-daemon 的 span 链路
