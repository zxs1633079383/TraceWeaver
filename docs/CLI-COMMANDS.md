# TraceWeaver CLI 命令大全

> 版本：v0.5.0
> 命令入口：`tw`（全局安装后可用）

---

## 全局选项

| 选项 | 说明 |
|------|------|
| `--help`, `-h` | 显示帮助信息 |
| `--version`, `-V` | 显示版本号 |

所有子命令均支持 `--help` 查看详细用法，例如：

```bash
tw register --help
tw harness --help
```

---

## 守护进程命令

守护进程（`tw-daemon`）是整个系统的核心进程，通过 Unix socket 与 CLI 通信。

### tw daemon start

启动守护进程。

```bash
tw daemon start [--mcp]
```

| 选项 | 说明 |
|------|------|
| `--mcp` | 同时启用 MCP stdio 传输（等效于设置 `TW_MCP_STDIO=1`） |

```bash
# 普通启动
tw daemon start

# 启动并开启 MCP 服务
tw daemon start --mcp
```

### tw daemon stop

停止正在运行的守护进程。

```bash
tw daemon stop
```

### tw daemon status

显示守护进程当前运行状态（是否在线、PID、socket 路径）。

```bash
tw daemon status
```

### tw daemon restart

重启守护进程（等效于 stop + start）。

```bash
tw daemon restart
```

---

## 实体管理

### tw register

注册一个新的研发实体，初始状态为 `pending`。

```bash
tw register <id> --type <type> [选项]
```

**必填参数**：

| 参数 | 说明 |
|------|------|
| `<id>` | 实体唯一标识符（字符串，建议使用 kebab-case，如 `exp-001`） |
| `--type <type>` | 实体类型，支持：`experiment`、`hypothesis`、`task`、`artifact`、`use_case`、`plan` |

**可选参数**：

| 参数 | 说明 |
|------|------|
| `--title <title>` | 实体标题，人类可读的描述性名称 |
| `--depends-on <ids...>` | 依赖的实体 ID 列表（空格分隔），用于构建 DAG |
| `--artifact-refs <refs...>` | 关联的文件路径列表（空格分隔），FsWatcher 会监听这些文件的变更 |
| `--constraint-refs <refs...>` | 关联的约束引用列表 |

**示例**：

```bash
# 注册一个简单任务
tw register task-001 --type task --title "实现用户认证模块"

# 注册带依赖的实验
tw register exp-002 --type experiment \
  --title "A/B 测试：按钮颜色" \
  --depends-on exp-001 \
  --artifact-refs src/components/Button.tsx tests/Button.test.tsx

# 注册带约束引用的实体
tw register task-003 --type task \
  --title "重构缓存层" \
  --depends-on task-001 task-002 \
  --constraint-refs test-coverage performance-budget
```

---

### tw update

更新实体的状态（状态机跳转）。

```bash
tw update <id> --state <state> [--reason <reason>]
```

**必填参数**：

| 参数 | 说明 |
|------|------|
| `<id>` | 要更新的实体 ID |
| `--state <state>` | 目标状态（见合法状态流转图） |

**可选参数**：

| 参数 | 说明 |
|------|------|
| `--reason <reason>` | 状态变更原因，会记录到 EventLog 和通知中 |

**合法状态流转图**：

```
          ┌─────────────────────────────────────┐
          │                                     │
          ▼                                     │
       pending                               rejected
          │                                     ▲
          │ (开始工作)                           │
          ▼                                     │
      in_progress ──────────────────────────────┤
          │                                     │
          │ (提交审查)                           │
          ▼                                     │
        review ──────────────────────────────────┘
          │
          │ (审查通过)
          ▼
       completed
```

合法跳转规则：

| 当前状态 | 可跳转到 |
|---------|---------|
| `pending` | `in_progress`、`rejected` |
| `in_progress` | `review`、`rejected` |
| `review` | `completed`、`rejected`、`in_progress`（退回修改） |
| `completed` | 终态，不可跳转 |
| `rejected` | 终态，不可跳转 |

**示例**：

```bash
# 开始工作
tw update task-001 --state in_progress

# 提交审查
tw update task-001 --state review

# 完成
tw update task-001 --state completed

# 拒绝并注明原因
tw update task-001 --state rejected --reason "缺少单元测试，覆盖率低于 80%"
```

---

### tw status

显示所有已注册实体的状态摘要。

```bash
tw status [--json]
```

**输出格式**（表格模式）：

```
ID          TYPE         STATE        TITLE
task-001    task         in_progress  实现用户认证模块
exp-001     experiment   completed    基线基准测试
```

**输出格式**（`--json`）：

```json
[
  {
    "id": "task-001",
    "type": "task",
    "state": "in_progress",
    "title": "实现用户认证模块",
    "depends_on": [],
    "artifact_refs": [],
    "created_at": "2026-03-24T10:00:00.000Z",
    "updated_at": "2026-03-24T10:30:00.000Z"
  }
]
```

---

### tw get

获取单个实体的详细信息，包含其所有子实体。

```bash
tw get <id> [--json]
```

**示例**：

```bash
tw get exp-001
tw get exp-001 --json
```

---

## 事件与日志

### tw events

查询内存中的事件历史（不持久化，守护进程重启后丢失）。

```bash
tw events [--entity <id>] [--since <duration>] [--limit <n>] [--json]
```

| 选项 | 说明 |
|------|------|
| `--entity <id>` | 只返回指定实体的事件 |
| `--since <duration>` | 时间过滤，格式见下方说明 |
| `--limit <n>` | 最多返回 n 条（默认 50） |
| `--json` | 机器可读 JSON 输出 |

> 注意：如需查询跨守护进程重启的持久化历史，请使用 `tw log query`。

---

### tw log query

查询 NDJSON 持久化事件日志，支持守护进程重启后的历史回溯。

```bash
tw log query [--entity <id>] [--since <duration>] [--type <event-type>] [--limit <n>] [--json]
```

| 选项 | 说明 |
|------|------|
| `--entity <id>` | 只返回指定实体的事件 |
| `--since <duration>` | 时间过滤 |
| `--type <event-type>` | 事件类型过滤，如 `state_changed`、`file.changed` |
| `--limit <n>` | 最多返回 n 条（默认 100） |
| `--json` | 机器可读 JSON 输出 |

**`--since` 支持的格式**：

| 格式 | 示例 | 说明 |
|------|------|------|
| 相对时间（小时） | `1h`、`24h`、`48h` | 最近 N 小时 |
| 相对时间（天） | `7d`、`30d` | 最近 N 天 |
| ISO 8601 时间戳 | `2026-03-24T00:00:00Z` | 指定时间点之后 |

**示例**：

```bash
# 查询最近 1 小时所有事件
tw log query --since 1h

# 查询指定实体最近 24 小时的状态变更事件
tw log query --entity task-001 --since 24h --type state_changed

# AI Agent 使用 --json 消费
tw log query --since 1h --json
```

**`--json` 输出格式**：

```json
[
  {
    "id": "uuid-...",
    "type": "entity.state_changed",
    "entity_id": "task-001",
    "entity_type": "task",
    "state": "review",
    "ts": "2026-03-24T10:30:00.000Z"
  }
]
```

---

### tw watch

以 500ms 轮询间隔实时输出新事件流，直到 Ctrl+C 退出。

```bash
tw watch [--entity <id>] [--json]
```

| 选项 | 说明 |
|------|------|
| `--entity <id>` | 只监听指定实体的事件 |
| `--json` | 每行输出一个事件 JSON 对象（适合 AI Agent 实时消费） |

**说明**：

- 内部使用 500ms 轮询（非 WebSocket，无需保持长连接）
- `--json` 模式下每行是一个独立的 JSON 对象，可通过管道传给 `jq` 等工具实时处理
- Ctrl+C 安全退出，不影响守护进程

**示例**：

```bash
# 终端实时监听
tw watch

# 监听指定实体，AI Agent 程序化消费
tw watch --entity task-001 --json | jq '.state'
```

---

## 指标

### tw metrics

查询从 OpenTelemetry Span 推导的研发效率指标。

```bash
tw metrics [--type <entity-type>] [--window <hours>] [--json]
```

| 选项 | 说明 |
|------|------|
| `--type <entity-type>` | 按实体类型过滤（如 `task`、`experiment`） |
| `--window <hours>` | 时间窗口（小时数，默认 24） |
| `--json` | 机器可读 JSON 输出 |

**输出字段说明**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `failureRate` | `number (0~1)` | 失败率（`rejected` 实体占已结束实体的比例） |
| `throughput` | `number` | 吞吐量（每小时完成的实体数） |
| `activeSpans` | `number` | 当前活跃中的 Span 数量（处于 `in_progress` 或 `review` 状态） |
| `spanCount` | `number` | 时间窗口内的总 Span 数 |
| `avgCycleTime` | `number (ms)` | 平均周期时间（从 `in_progress` 到 `completed` 的平均耗时） |

**示例**：

```bash
# 查看最近 24 小时所有类型的指标
tw metrics

# 只看 task 类型，最近 48 小时
tw metrics --type task --window 48

# AI Agent 使用
tw metrics --json
```

**`--json` 输出格式**：

```json
{
  "type": "task",
  "window": 24,
  "failureRate": 0.15,
  "throughput": 3.5,
  "activeSpans": 4,
  "spanCount": 12,
  "avgCycleTime": 14400000
}
```

---

## 依赖图与影响分析

### tw dag

查询实体依赖有向无环图（DAG）。

```bash
tw dag [--root <id>] [--json]
```

| 选项 | 说明 |
|------|------|
| `--root <id>` | 只返回以指定实体为根的子图 |
| `--json` | 机器可读 JSON 输出 |

**`--json` 输出格式**：

```json
{
  "nodes": [
    { "id": "exp-001", "type": "experiment", "state": "completed" },
    { "id": "task-001", "type": "task", "state": "in_progress" }
  ],
  "edges": [
    { "from": "task-001", "to": "exp-001" }
  ]
}
```

**示例**：

```bash
tw dag
tw dag --root exp-001 --json
```

---

### tw impact

分析指定文件变更会影响哪些研发实体（直接影响 + 传递影响）。

```bash
tw impact <file-path> [--json]
```

**说明**：

- **直接影响**（`directly_affected`）：在 `artifact_refs` 中声明了该文件的实体
- **传递影响**（`transitively_affected`）：通过 `depends_on` 关系，依赖直接影响实体的其他实体（BFS 广度优先遍历）

**输出字段说明**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `directly_affected` | `string[]` | 直接引用该文件的实体 ID 列表 |
| `transitively_affected` | `string[]` | 通过依赖关系间接受影响的实体 ID 列表 |

**示例**：

```bash
# 分析文件变更影响范围
tw impact src/auth/login.ts

# AI Agent 使用
tw impact src/auth/login.ts --json
```

**`--json` 输出格式**：

```json
{
  "file": "src/auth/login.ts",
  "directly_affected": ["task-003", "task-004"],
  "transitively_affected": ["exp-001"]
}
```

---

## Harness 约束管理

Harness 是约束文件，以 Markdown + YAML frontmatter 格式存放在 `.traceweaver/harness/*.md`，定义每种实体类型"完成"的验收标准。守护进程在实体到达触发状态时自动执行约束评估。

### tw harness list

列出所有已加载的 harness 约束文件。

```bash
tw harness list [--json]
```

**示例**：

```bash
tw harness list
tw harness list --json
```

**`--json` 输出格式**：

```json
[
  {
    "id": "test-coverage",
    "applies_to": ["task"],
    "trigger_on": ["review", "completed"]
  }
]
```

---

### tw harness show

显示指定 harness 的完整详情，包括约束描述正文。

```bash
tw harness show <id> [--json]
```

**示例**：

```bash
tw harness show test-coverage
tw harness show test-coverage --json
```

**`--json` 输出格式**：

```json
{
  "id": "test-coverage",
  "applies_to": ["task"],
  "trigger_on": ["review", "completed"],
  "body": "# Test Coverage Constraint\n\nAll tasks MUST include test files..."
}
```

---

### tw harness run

对指定实体手动触发约束评估（不受 `trigger_on` 状态限制）。

```bash
tw harness run <entity-id> --harness-id <id> [--json]
```

**必填参数**：

| 参数 | 说明 |
|------|------|
| `<entity-id>` | 要评估的实体 ID |
| `--harness-id <id>` | 要运行的 harness 约束 ID |

**输出字段说明**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `result` | `"pass" \| "fail" \| "skipped"` | 评估结果。`skipped` 表示 ConstraintEvaluator 未配置（无 API key） |
| `refs_checked` | `string[]` | 本次评估检查的 artifact_refs 列表 |
| `checked_at` | `string (ISO 8601)` | 评估执行时间戳 |
| `reason` | `string?` | 失败原因（result 为 fail 时存在） |

**示例**：

```bash
# 手动运行约束评估
tw harness run task-001 --harness-id test-coverage

# AI Agent 使用
tw harness run task-001 --harness-id test-coverage --json
```

**`--json` 输出格式（pass）**：

```json
{
  "entity_id": "task-001",
  "harness_id": "test-coverage",
  "result": "pass",
  "refs_checked": ["src/auth/login.ts", "tests/auth/login.test.ts"],
  "checked_at": "2026-03-24T10:45:00.000Z"
}
```

**`--json` 输出格式（fail）**：

```json
{
  "entity_id": "task-001",
  "harness_id": "test-coverage",
  "result": "fail",
  "reason": "artifact_refs 中未找到 type 为 test 的测试文件",
  "refs_checked": ["src/auth/login.ts"],
  "checked_at": "2026-03-24T10:45:00.000Z"
}
```

---

## 通知收件箱

### tw inbox

查看和管理通知收件箱。

```bash
tw inbox [--unread] [--ack <id>] [--json]
```

| 选项 | 说明 |
|------|------|
| `--unread` | 只显示未读通知 |
| `--ack <id>` | 确认（标记已读）指定通知 ID |
| `--json` | 机器可读 JSON 输出 |

**触发通知的条件**（由 `notify.rules` 配置）：

- 实体状态变更为 `rejected`
- 实体状态变更为 `completed`
- TriggerExecutor 自动拒绝时

**示例**：

```bash
# 查看所有通知
tw inbox

# 只看未读
tw inbox --unread

# 确认一条通知
tw inbox --ack notif-uuid-...

# AI Agent 消费
tw inbox --json
```

---

## --json 标志说明

`--json` 标志是为 AI Agent 和自动化脚本设计的机器可读输出模式。

**适用场景**：

- AI Agent 通过 CLI 感知系统状态（observe）
- 将输出通过管道传给 `jq` 进行进一步处理
- 在 shell 脚本中解析输出结果

**所有支持 --json 的命令一览**：

| 命令 | 用途 |
|------|------|
| `tw status --json` | 获取所有实体的完整状态快照 |
| `tw get <id> --json` | 获取单个实体的完整详情 |
| `tw events --json` | 获取内存事件列表 |
| `tw log query --json` | 获取持久化事件日志（流式，每行一个 JSON） |
| `tw watch --json` | 实时事件流（流式，每行一个 JSON） |
| `tw metrics --json` | 获取指标摘要对象 |
| `tw dag --json` | 获取依赖图结构（nodes + edges） |
| `tw impact <file> --json` | 获取影响分析结果 |
| `tw harness list --json` | 获取所有 harness 列表 |
| `tw harness show <id> --json` | 获取单个 harness 详情 |
| `tw harness run --json` | 获取约束评估结果 |
| `tw inbox --json` | 获取通知列表 |

---

## 环境变量

| 变量 | 说明 | 示例值 |
|------|------|--------|
| `TW_STORE` | 覆盖存储目录路径（默认 `.traceweaver`） | `/var/data/traceweaver` |
| `TW_SOCKET` | 覆盖 Unix socket 路径（默认 `.traceweaver/tw.sock`） | `/tmp/tw.sock` |
| `TW_HTTP_PORT` | 设置后在指定端口启用 HTTP API | `4321` |
| `TW_INBOUND_TOKEN` | HTTP API 的 Bearer Token 认证密钥 | `your-secret-token` |
| `TW_MCP_STDIO` | 设为 `1` 时启用 MCP stdio 传输 | `1` |
| `TW_WEBHOOK_TOKEN` | Webhook 推送时 `Authorization` 头中的 Token | `webhook-secret` |
| `ANTHROPIC_API_KEY` | 启用 LLM 支持的 harness 约束评估（未设置时 ConstraintEvaluator 进入禁用模式，所有评估返回 `skipped`） | `sk-ant-...` |

**使用示例**：

```bash
# 启动守护进程并开启 HTTP API 和 MCP
TW_HTTP_PORT=4321 TW_MCP_STDIO=1 ANTHROPIC_API_KEY=sk-ant-... tw daemon start

# 使用自定义存储目录
TW_STORE=/data/project/.traceweaver tw daemon start
```

---

## 状态流转速查表

```
                         ┌──────────────────────────────────────────────┐
                         │                                              │
     ┌─────────┐         │   ┌─────────────┐         ┌──────────────┐ │
     │ pending │─────────┼──▶│ in_progress │─────────▶│    review    │ │
     └─────────┘         │   └─────────────┘         └──────────────┘ │
          │              │          │                        │         │
          │              │          │                        │         │
          │   ┌──────────┘          │                        │         │
          │   │                     │  ┌─────────────────────┘         │
          │   │ rejected ◀──────────┴──┘                               │
          │   │   (终态)                                                │
          │   └─────────────────────────────────────────────────────── ┘
          │
          │   ┌─────────────────────────────────────────────┐
          │   │                                             │
          └───┘         completed (终态)                   │
              └─────────────────────────────────────────────┘
```

更清晰的状态跳转表格：

```
┌──────────────┬─────────────────────────────────────────┐
│ 当前状态      │ 可跳转至                                  │
├──────────────┼─────────────────────────────────────────┤
│ pending      │ in_progress, rejected                   │
│ in_progress  │ review, rejected                        │
│ review       │ completed, rejected, in_progress        │
│ completed    │ (终态，不可再跳转)                        │
│ rejected     │ (终态，不可再跳转)                        │
└──────────────┴─────────────────────────────────────────┘
```

**自动触发路径**（TriggerExecutor）：

当实体到达 harness 的 `trigger_on` 中声明的状态时（如 `review`），TriggerExecutor 自动运行 ConstraintEvaluator：

```
实体到达 review / completed
         │
         ▼
  匹配 harness applies_to + trigger_on
         │
         ├── TOCTOU 检查 #1（实体仍在触发状态？）
         │
         ▼
  ConstraintEvaluator.evaluate()
         │
         ├── pass → 记录结果，实体继续生命周期
         │
         └── fail → TOCTOU 检查 #2 → updateState(rejected) → InboxAdapter 通知
```
