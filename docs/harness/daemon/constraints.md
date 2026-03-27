# daemon — 约束规则

> 记录 daemon 模块开发中"不能这样做"的约束。
> 上限 100 条。超出时合并相似规则或淘汰最久未命中的 candidate/trial。
> 置信度生命周期：candidate → trial（3+ 次命中）→ confirmed（5+ 次或人工确认）→ archived（90 天未命中）

---

### [R-daemon-constraint-001] 不可直接 import tw-cli
- **置信度**: confirmed
- **来源**: CLAUDE.md 初始化, 2026-03-27
- **命中次数**: -
- **触发条件**: daemon 模块新增 import 时
- **规则**: tw-daemon 不能 import tw-cli 的任何模块
- **原因**: 架构边界约束，cli 只能通过 IPC Socket 与 daemon 通信

### [R-daemon-constraint-002] 不可使用 @ts-ignore 或 as any
- **置信度**: confirmed
- **来源**: CLAUDE.md 初始化, 2026-03-27
- **命中次数**: -
- **触发条件**: 编写 TypeScript 代码时
- **规则**: 禁止 @ts-ignore，禁止 as any，需要时使用 as unknown as T
- **原因**: 全局禁止规则，维护类型安全

### [R-daemon-constraint-003] 不可静默吞错
- **置信度**: confirmed
- **来源**: CLAUDE.md 初始化, 2026-03-27
- **命中次数**: -
- **触发条件**: 编写 catch 块时
- **规则**: catch {} 必须包含注释说明为什么忽略错误
- **原因**: 静默吞错导致问题难以排查
