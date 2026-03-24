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
| `Entity` | 实体主体，含 id / entity_type / state / artifact_refs / depends_on |
| `EntityState` | `pending \| in_progress \| review \| completed \| rejected` |
| `EntityType` | `task \| plan \| usecase` |
| `TwEvent` | 所有事件的基础结构，含 id / type / ts / entity_id |
| `TwEventType` | 所有合法事件类型的字面量联合 |
| `ArtifactRef` | `{ type, path }` — 实体对文件的引用 |
| `TwRequest / TwResponse` | IPC 协议的请求/响应信封 |
