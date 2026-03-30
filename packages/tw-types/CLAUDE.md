# tw-types CLAUDE.md

> 上级索引：[← 根 CLAUDE.md](../../CLAUDE.md)

## 职责

`tw-types` 是整个 monorepo 的**唯一类型源**。所有包通过 `@traceweaver/types` 引用，
tw-types 自身**不能** import 任何兄弟包。

---

## 约束

### 类型变更"完成"定义

| 变更类型 | 必须满足 |
|----------|---------|
| 新增字段 | 字段可选（`?`）或有默认值；不破坏现有序列化 |
| 删除/重命名字段 | 必须同步更新所有引用包；`npm run build` 零错误 |
| 新增 EntityType / EventType | 在 daemon 状态机和 IPC dispatch 中同步处理 |

### 禁止事项

```
✗ 禁止在 tw-types 中 import tw-daemon / tw-cli（反向依赖）
✗ 禁止用 any 作为 export 类型
✗ 禁止删除已有 export（破坏外部使用者）
```

### 验证

```bash
npm run build --workspace=packages/tw-types    # 零错误
npm run build                                  # 全量 build，验证无破坏性变更
```

---

## 关键类型清单

| 类型 | 说明 |
|------|------|
| `Entity` | 实体主体，含 id / entity_type / state / artifact_refs / depends_on / constraint_refs |
| `Entity.constraint_refs` | `string[]`（可选）— 绑定的 harness id 子集；空时评估全部匹配 harness |
| `EntityState` | `pending \| in_progress \| review \| completed \| rejected` |
| `EntityType` | `task \| plan \| usecase` |
| `TwEvent` | 所有事件的基础结构，含 id / type / ts / entity_id |
| `TwEventType` | 所有合法事件类型的字面量联合 |
| `ArtifactRef` | `{ type, path }` — 实体对文件的引用 |
| `RegisterParams.constraint_refs` | `string[]`（可选）— 注册时声明，设置实体绑定的 harness 子集 |
| `TwRequest / TwResponse` | IPC 协议的请求/响应信封 |
| `SpanTreeNode` | 单节点 Span 树（`state` 来自 EntityRegistry 权威；`source: 'live' \| 'reconstructed'` 区分数据来源）|
| `TraceInfo` | 完整 trace 链路（`root` + `summary` + `_ai_context` 确定性模板字段）|
| `ReportMeta` | 报告元数据（`date` / `trace_id` / `path` / `generated_at`）|
| `SpanEvent` | Span 事件（`name` / `attributes?` / `time?`）|
| `UsecaseMutateParams` | `{ id, mutation_type: 'insert'\|'update', context?, entities? }` |
| `UsecaseReplaceParams` | `{ id, supersede: string[], new_entities? }` |
| `SessionRebindParams` | `{ old_entity_id, new_entity_id }` |

### TwEventType 已知值（补充）

`'report.generated'` — 日报生成事件，`attributes` 含 `report_path`（文件引用，不含内容）和 `trace_id`。

`'error.captured'` — 错误采集事件（CC Hook PostToolUse 失败时）

`'usecase.mutated'` — UseCase 变更事件（insert/update）

`'entity.paused'` — 实体暂停（drain 时）

`'entity.superseded'` — 实体被替代（终态）

`'tool.invoked'` / `'tool.completed'` — CC Hook 工具调用事件

`'session.started'` / `'session.ended'` / `'session.rebound'` — 会话生命周期

## 沉淀规则

- [决策规则](../../docs/harness/types/decisions.md) — 为什么这样做
- [约束规则](../../docs/harness/types/constraints.md) — 不能这样做
- [模式规则](../../docs/harness/types/patterns.md) — 遇到 X 用 Y
