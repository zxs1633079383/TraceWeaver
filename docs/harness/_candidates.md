# 候选规则池

> 低置信度规则暂存区。命中 3+ 次 session 且未被推翻后自动升级为 trial。
> 人工标注 `rejected` 的规则不再升级。
> 30 天未命中的规则自动归档删除。

---

<!-- 格式：
### [C-{序号}] 简短描述
- **类型**: decision | constraint | pattern
- **目标模块**: daemon | cli | types | examples
- **置信度**: candidate
- **来源**: session-{id}, {date}
- **命中次数**: {n}
- **阻止次数**: {n}
- **效能**: {0.0-1.0}
- **谱系**: {来源描述}
- **触发条件**: 遇到 X 情况时
- **规则**: 应该 Y / 不应该 Z
- **原因**: 因为 W
-->



### [C-1] npm run build
- **类型**: error
- **目标模块**: 
- **置信度**: candidate
- **来源**: session-demo-session-001, 2026-03-30
- **命中次数**: 1
- **阻止次数**: 0
- **效能**: 0
- **谱系**: session-demo-session-001 自动采集
- **触发条件**: exit_code=1
- **规则**: （待提炼）
- **原因**: 自动采集自 session demo-session-001

### [C-2] Edit /Users/mac28/workspace/frontend/TraceWeaver/packages/tw-daemon/src/core/command-handler.ts
- **类型**: decision
- **目标模块**: daemon
- **置信度**: candidate
- **来源**: session-demo-session-001, 2026-03-30
- **命中次数**: 1
- **阻止次数**: 0
- **效能**: 0
- **谱系**: session-demo-session-001 自动采集
- **触发条件**: src_change
- **规则**: （待提炼）
- **原因**: 自动采集自 session demo-session-001

### [C-3] {\
- **类型**: pattern
- **目标模块**: daemon
- **置信度**: candidate
- **来源**: session-demo-session-001, 2026-03-30
- **命中次数**: 1
- **阻止次数**: 0
- **效能**: 0
- **谱系**: session-demo-session-001 自动采集
- **触发条件**: tests=287
- **规则**: （待提炼）
- **原因**: 自动采集自 session demo-session-001

### [C-4] npm run build --workspace=packages/tw-cli
- **类型**: error
- **目标模块**: cli
- **置信度**: candidate
- **来源**: session-demo-session-001, 2026-03-30
- **命中次数**: 1
- **阻止次数**: 0
- **效能**: 0
- **谱系**: session-demo-session-001 自动采集
- **触发条件**: exit_code=1
- **规则**: （待提炼）
- **原因**: 自动采集自 session demo-session-001
