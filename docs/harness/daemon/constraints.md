# daemon — 约束规则

> 记录 daemon 模块开发中"不能这样做"的约束。
> 上限 100 条。超出时合并相似规则或淘汰最久未命中的 candidate/trial。
> 置信度生命周期：candidate → trial（3+ 次命中）→ confirmed（5+ 次或人工确认）→ archived（90 天未命中）

---
