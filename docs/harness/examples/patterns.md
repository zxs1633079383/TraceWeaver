# examples — 模式规则

> 记录 examples 模块开发中"遇到 X 用 Y"的模式。
> 上限 100 条。超出时合并相似规则或淘汰最久未命中的 candidate/trial。
> 置信度生命周期：candidate → trial（effectiveness>0.5 且 3+ 次命中）→ confirmed（5+ 次或人工确认）→ archived（90 天未命中）
> 效能 = 阻止次数 / 命中次数（-1 表示初始化规则，尚无数据）

---
