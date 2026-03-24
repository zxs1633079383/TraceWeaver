# T02 — HarnessValidator: md-代码对齐检测

**状态：** pending
**依赖：** T01

---

## 目标

持续检测 harness `.md` 文件与实体注册表的偏差，在三类对齐问题出现时立即发现并给出修正建议。

## 接口规范

```typescript
export type IssueType = 'orphaned_ref' | 'dead_harness' | 'persistent_failure'

export interface AlignmentIssue {
  severity: 'error' | 'warning'
  type: IssueType
  harness_id?: string
  entity_id?: string
  message: string
  suggestion?: string
}

export interface HarnessValidatorOptions {
  consecutiveFailThreshold?: number  // 默认 3
}

export class HarnessValidator {
  constructor(loader: HarnessLoader, feedbackLog: FeedbackLog, opts?: HarnessValidatorOptions)
  validate(entities: Entity[]): AlignmentIssue[]
}
```

## 三类检测逻辑

### orphaned_ref
```
for entity in entities:
  for ref in entity.constraint_refs:
    if ref not in loader.list().map(h => h.id):
      → error: "实体 'X' 引用了不存在的 harness 'Y'"
      → suggestion: "在 .traceweaver/harness/Y.md 创建文件，或移除引用"
```

### dead_harness
```
entityTypes = Set(entities.map(e => e.entity_type))
for harness in loader.list():
  if harness.applies_to.length > 0:
    if not any(t in entityTypes for t in harness.applies_to):
      → warning: "Harness 'X' applies_to=[...] 无匹配实体类型"
      → suggestion: "检查 applies_to 是否拼写正确"
```

### persistent_failure
```
for harness in loader.list():
  summary = feedbackLog.getSummary(harness.id)
  if summary.consecutive_failures >= threshold:
    → warning: "Harness 'X' 已连续失败 N 次"
    → suggestion: "审查约束内容与实体结构是否仍一致"
```

## 测试清单（7 个）

- [ ] 全部对齐时返回空数组
- [ ] orphaned_ref 被检测（entity 引用不存在 harness）
- [ ] dead_harness 被检测（无匹配类型的实体）
- [ ] persistent_failure 被检测（consecutive_failures >= threshold）
- [ ] 低于阈值时不报 persistent_failure
- [ ] orphaned_ref severity=error
- [ ] issue.suggestion 非空
