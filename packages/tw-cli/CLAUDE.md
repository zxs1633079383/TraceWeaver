# tw-cli CLAUDE.md

> 上级索引：[← 根 CLAUDE.md](../../CLAUDE.md)

## 职责

`tw-cli` 是面向终端用户和 AI Agent 的命令行界面。
**所有操作通过 IPC Socket 与 daemon 通信**，禁止直接 import daemon 源码。

---

## 一、系统性约束

### IPC 通信规范

```
CLI 命令
  └─▶ ensureDaemon()           # 确保 daemon 已启动
  └─▶ sendIpc({ method, params })  # 单次请求-响应
  └─▶ 格式化输出（human / --json）
```

- 所有命令必须调用 `ensureDaemon()` 后再发 IPC
- IPC 错误（!res.ok）必须 `console.error` + `process.exit(1)`
- 禁止在命令内直接 import `tw-daemon` 任何模块

### --json 规范

**所有命令必须支持 `--json` 标志**，输出机器可读的 JSON：

```typescript
if (opts.json) { console.log(JSON.stringify(data, null, 2)); return }
```

JSON 输出必须是 daemon 返回的原始 `data` 字段，不做裁剪或变形。

### 命令结构规范

```
tw <noun> [<subcommand>] [args] [options]

noun:       daemon | status | register | update | events | dag
            impact | log | metrics | harness | watch | inbox
subcommand: daemon start|stop|restart  /  log query  /  harness list|show|run
```

新增命令必须：
1. 在 `src/commands/<noun>.ts` 中实现
2. 在 `src/index.ts` 中注册 `program.addCommand()`
3. 有 `--json` 选项
4. 在 `integration.test.ts` 中覆盖 happy path

---

## 二、可观测性与验证

### 构建验证

```bash
npm run build --workspace=packages/tw-cli    # 零 TypeScript 错误
```

构建后 `dist/index.js` 必须存在，`bin/tw` 指向 `dist/index.js`。

### 测试验证

```bash
npm test --workspace=packages/tw-cli         # 目标：≥ 8 tests passing
```

### 端到端冒烟（新命令必跑）

```bash
tw daemon start
tw <新命令> --json        # 验证 JSON 输出结构
tw <新命令>               # 验证 human 输出可读
tw daemon stop
```

---

## 三、持续熵管理

### 复杂度预算

| 指标 | 上限 |
|------|------|
| 单命令文件行数 | 100 行 |
| 单 action 函数行数 | 40 行 |

命令文件超过 80 行时，考虑将格式化逻辑提取到 `src/output/` 下。

### 已有输出工具

`src/output/formatter.ts` — 表格/树状输出工具，新命令优先复用。

### 禁止事项

```
✗ 禁止在命令内直接 import tw-daemon src（只能通过 IPC）
✗ 禁止省略 --json 选项
✗ 禁止 process.exit(0) 以外的正常退出（错误用 process.exit(1)）
✗ 禁止在 action 内 throw（必须 try/catch 后 process.exit(1)）
```

### IPC 方法清单（CLI 可用）

| 方法 | 参数 | 说明 |
|------|------|------|
| `get_status` | `{}` | 实体汇总 |
| `register` | RegisterParams | 注册实体 |
| `update_state` | `{id, state}` | 更新状态 |
| `update_attributes` | `{id, attributes}` | 更新属性 |
| `query_events` | `{entity_id?, since?, limit?}` | 查询事件 |
| `get_dag` | `{root_id?}` | 依赖图 |
| `resolve_impact` | `{artifact_path}` | 影响分析 |
| `log_query` | `{entity_id?, event_type?, since?, limit?}` | EventLog 查询 |
| `get_metrics` | `{entity_type?, window_ms?}` | SpanMetrics |
| `harness_list` | `{}` | Harness 列表 |
| `harness_show` | `{id}` | Harness 详情 |
| `harness_run` | `{entity_id, harness_id}` | 手动运行 Harness |
| `inbox_list` | `{unackedOnly?}` | 收件箱 |
| `inbox_ack` | `{id}` | 确认消息 |
| `feedback_query` | `{harness_id?, entity_id?, result?, since?, limit?}` | FeedbackLog 查询 |
| `feedback_summary` | `{harness_id?}` | Harness 评估摘要 |
| `harness_validate` | `{}` | Harness-Entity 对齐检查 |
| `emit_event` | `{entity_id, event, attributes?}` | 发布自定义 span 事件 |
| `cascade_update` | `{id, attributes, cascade}` | 级联更新实体及下游 |
| `remediation_next` | `{queue_dir}` | 取下一个待修复队列项 |
| `remediation_done` | `{rem_id, queue_dir}` | 标记修复完成 |
