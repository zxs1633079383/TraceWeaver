# daemon — 模式规则

> 记录 daemon 模块开发中"遇到 X 用 Y"的模式。
> 上限 100 条。超出时合并相似规则或淘汰最久未命中的 candidate/trial。
> 置信度生命周期：candidate → trial（effectiveness>0.5 且 3+ 次命中）→ confirmed（5+ 次或人工确认）→ archived（90 天未命中）
> 效能 = 阻止次数 / 命中次数（-1 表示初始化规则，尚无数据）

---

### [R-daemon-pattern-001] 初始化顺序：EventLog → SpanManager → ConstraintEvaluator → ConstraintHarness → CommandHandler → TraceQueryEngine → ReportGenerator
- **置信度**: confirmed
- **来源**: CLAUDE.md + daemon/src/index.ts, 2026-03-27 (updated 2026-03-30: +ConstraintEvaluator/Harness)
- **命中次数**: 1
- **阻止次数**: 0
- **效能**: -1
- **谱系**: daemon 设计经验 → confirmed (初始化) → updated (constraint harness 加入)
- **触发条件**: 修改 daemon 入口文件或添加新组件时
- **规则**: 严格按照 EventLog → SpanManager → ConstraintEvaluator → ConstraintHarness → CommandHandler.init() → TraceQueryEngine → ReportGenerator → IpcServer(constraintHarness) 顺序初始化；关闭时反向
- **原因**: ConstraintHarness 依赖 SpanManager 和 EventBus；IpcServer 依赖 ConstraintHarness

### [R-daemon-pattern-002] 持久化使用 WAL + 原子写入
- **置信度**: confirmed
- **来源**: daemon 设计经验, 2026-03-27
- **命中次数**: 0
- **阻止次数**: 0
- **效能**: -
- **谱系**: daemon 设计经验 → confirmed (初始化)
- **触发条件**: 新增需要持久化的数据时
- **规则**: 写入文件使用 tmp → rename 原子模式；崩溃恢复使用 WAL replay
- **原因**: 防止部分写入导致数据损坏

### [R-daemon-pattern-003] 新增旁路功能使用 Harness+Evaluator 双层模式
- **置信度**: confirmed
- **来源**: constraint-harness-separation-design, 2026-03-30
- **命中次数**: 1
- **阻止次数**: 0
- **效能**: -1
- **谱系**: harness trace 研究 → brainstorming → spec → confirmed
- **触发条件**: 新增评估/检查/验证类旁路功能时
- **规则**: Runtime 层(Harness)负责 span/event/timeout/容错，Eval 层负责纯逻辑。Harness 知道 Evaluator，反向不可
- **原因**: 职责分离 + 容错隔离，旁路故障不影响主 runtime

### [R-daemon-pattern-004] constraint_refs 存 entity.attributes（不扩展 Entity 接口）
- **置信度**: confirmed
- **来源**: brainstorming Q5 用户选择, 2026-03-30
- **命中次数**: 1
- **阻止次数**: 0
- **效能**: -1
- **谱系**: 用户选择 B 方案 → confirmed
- **触发条件**: 需要给 entity 附加扩展属性时
- **规则**: 用 `entity.attributes.xxx` 存储，读取时 `entity.attributes?.xxx ?? fallback`
- **原因**: 保持 Entity 接口稳定，避免为每个功能扩展核心类型

### [R-daemon-pattern-005] span 子级通过 parent_span_id 关联（不是 parent_entity_id）
- **置信度**: confirmed
- **来源**: Jaeger 验证中发现 constraint spans 散落, 2026-03-30
- **命中次数**: 1
- **阻止次数**: 1
- **效能**: 1.0
- **谱系**: bug fix → confirmed (阻止了 Jaeger trace 散落)
- **触发条件**: 创建子 span 时
- **规则**: 先 `spanManager.getSpan(parentEntityId)` 获取父 span，取其 `span_id` 传入 `createSpan({ parent_span_id })`
- **原因**: SpanManager.deriveTraceId 通过 parent_span_id 查找 trace_id，保证同一 trace

### [R-daemon-pattern-006] terminal state (completed/rejected/superseded) 必须 endSpan
- **置信度**: confirmed
- **来源**: Jaeger 验证中发现 superseded spans 不导出, 2026-03-30
- **命中次数**: 1
- **阻止次数**: 1
- **效能**: 1.0
- **谱系**: bug fix → confirmed
- **触发条件**: 新增 terminal state 或修改 updateState 逻辑时
- **规则**: updateState 中所有 terminal states 都必须触发 `spanManager.endSpan()`
- **原因**: 未 endSpan 的 span 不会被 OTLP exporter 导出到 Jaeger

### [R-daemon-pattern-007] emitEvent IPC 需同时发布原始事件类型到 EventBus
- **置信度**: confirmed
- **来源**: ErrorBubbler 不响应 IPC error.captured 事件, 2026-03-30
- **命中次数**: 1
- **阻止次数**: 1
- **效能**: 1.0
- **谱系**: bug fix → confirmed
- **触发条件**: emitEvent 需要触发 subscriber 响应时
- **规则**: emitEvent 除了发布 `hook.received`，还需发布原始 event type (如 `error.captured`) 的 TwEvent
- **原因**: subscribers (ErrorBubbler) 监听特定 event type，不监听 hook.received
