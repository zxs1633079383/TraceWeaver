# types — 约束规则

> 记录 types 模块开发中"不能这样做"的约束。
> 上限 100 条。超出时合并相似规则或淘汰最久未命中的 candidate/trial。
> 置信度生命周期：candidate → trial（3+ 次命中）→ confirmed（5+ 次或人工确认）→ archived（90 天未命中）

---

### [R-types-constraint-001] tw-types 不可 import 任何兄弟包
- **置信度**: confirmed
- **来源**: CLAUDE.md 初始化, 2026-03-27
- **命中次数**: -
- **触发条件**: tw-types 包新增 import 时
- **规则**: tw-types 只被其他包引用，自身不能 import tw-daemon、tw-cli 或 examples
- **原因**: tw-types 是共享类型层，零依赖是架构根基
