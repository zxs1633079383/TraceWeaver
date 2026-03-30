# cli — 约束规则

> 记录 cli 模块开发中"不能这样做"的约束。
> 上限 100 条。超出时合并相似规则或淘汰最久未命中的 candidate/trial。
> 置信度生命周期：candidate → trial（effectiveness>0.5 且 3+ 次命中）→ confirmed（5+ 次或人工确认）→ archived（90 天未命中）
> 效能 = 阻止次数 / 命中次数（-1 表示初始化规则，尚无数据）

---

### [R-cli-constraint-001] tw-cli 只能通过 IPC Socket 与 daemon 通信
- **置信度**: confirmed
- **来源**: CLAUDE.md 初始化, 2026-03-27
- **命中次数**: 0
- **阻止次数**: 0
- **效能**: -
- **谱系**: CLAUDE.md 架构边界 → confirmed (初始化)
- **触发条件**: cli 模块新增功能时
- **规则**: tw-cli 禁止直接 import packages/tw-daemon/src 下的任何文件，所有交互通过 IPC Socket
- **原因**: 保持进程边界清晰，cli 是 daemon 的纯客户端

### [R-cli-constraint-002] 所有命令必须支持 --json 输出
- **置信度**: confirmed
- **来源**: CLAUDE.md 初始化, 2026-03-27
- **命中次数**: 0
- **阻止次数**: 0
- **效能**: -
- **谱系**: CLAUDE.md 初始化 → confirmed (初始化)
- **触发条件**: 新增 CLI 命令时
- **规则**: 每个 cli 命令必须实现 --json 标志，输出机器可读的 JSON
- **原因**: AI Agent 消费 CLI 输出需要结构化数据
