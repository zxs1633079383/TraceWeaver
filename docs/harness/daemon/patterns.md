# daemon — 模式规则

> 记录 daemon 模块开发中"遇到 X 用 Y"的模式。
> 上限 100 条。超出时合并相似规则或淘汰最久未命中的 candidate/trial。
> 置信度生命周期：candidate → trial（3+ 次命中）→ confirmed（5+ 次或人工确认）→ archived（90 天未命中）

---

### [R-daemon-pattern-001] 初始化顺序：EventLog → FeedbackLog → CommandHandler → TraceQueryEngine → ReportGenerator
- **置信度**: confirmed
- **来源**: CLAUDE.md + daemon/src/index.ts, 2026-03-27
- **命中次数**: -
- **触发条件**: 修改 daemon 入口文件或添加新组件时
- **规则**: 严格按照 EventLog → FeedbackLog → CommandHandler.init() → TraceQueryEngine → ReportGenerator 顺序初始化；关闭时反向
- **原因**: 组件间存在依赖链，乱序会导致 null reference

### [R-daemon-pattern-002] 持久化使用 WAL + 原子写入
- **置信度**: confirmed
- **来源**: daemon 设计经验, 2026-03-27
- **命中次数**: -
- **触发条件**: 新增需要持久化的数据时
- **规则**: 写入文件使用 tmp → rename 原子模式；崩溃恢复使用 WAL replay
- **原因**: 防止部分写入导致数据损坏
