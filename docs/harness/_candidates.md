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
- **触发条件**: 遇到 X 情况时
- **规则**: 应该 Y / 不应该 Z
- **原因**: 因为 W
-->


