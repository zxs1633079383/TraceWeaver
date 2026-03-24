# TraceWeaver 快速上手指南

TraceWeaver 是一款轻量级、本地优先的实体追踪系统，专为 AI 辅助研发工作流设计。它内置状态机、事件总线、DAG 依赖图、通知引擎、LLM 约束验证和 OpenTelemetry 导出——全部基于追加写入的 WAL，可通过 CLI、编程 API、MCP Server 或 HTTP 操作。

---

## 前置条件

- **Node.js** v18 或更高版本
- **npm** v9 或更高版本（需要 workspaces 支持）
- 可选：Anthropic API Key，用于约束验证（`ANTHROPIC_API_KEY`）

---

## 安装

```bash
git clone https://github.com/your-org/traceweaver.git
cd traceweaver
npm install
npm run build
```

全局安装 CLI（可选，但推荐）：

```bash
npm install -g .
# 或者不全局安装，使用 npx tw <命令>
```

---

## 核心概念

### 实体（Entities）

TraceWeaver 中的每个工作单元都是一个**实体**。三种内置类型：

| 类型 | 用途 |
|------|---------|
| `usecase` | 高层目标或项目 |
| `plan` | usecase 下的执行计划 |
| `task` | plan 下的原子工作项 |

实体形成父子树结构。一个 `usecase` 可包含多个 `plan`；一个 `plan` 可包含多个 `task`。

### 状态机

所有实体共享同一套五状态机：

```
pending ──→ in_progress ──→ review ──→ completed
   │              │                        │
   └──────────────┴────→ rejected ←────────┘
```

有效的状态转换：

| 起始状态 | 目标状态 |
|------|----|
| `pending` | `in_progress`、`rejected` |
| `in_progress` | `review`、`rejected` |
| `review` | `completed`、`rejected` |
| `completed` | — （终态） |
| `rejected` | — （终态） |

尝试无效的状态转换会抛出 `TransitionError`。

### 事件总线

每次状态变更和实体修改都会向进程内 `EventBus` 发出有类型的事件。订阅者可实时响应。事件同时持久化到 WAL，支持查询和回放。

### DAG 依赖

实体可声明 `depends_on` 关系。TraceWeaver 追踪由此形成的有向无环图（DAG），并能报告哪些实体因某实体的状态变更而被阻塞、解除阻塞或受到影响。

---

## 第一步：启动 Daemon

Daemon 是 TraceWeaver 的后台进程，负责维护实体状态、事件日志和所有核心功能。

```bash
# 在后台启动 Daemon
tw daemon start

# 验证 Daemon 是否正常运行
tw status
```

期望输出：

```
total: 0  pending: 0  in_progress: 0  review: 0  completed: 0  rejected: 0
```

如果 Daemon 未能启动，检查 `.traceweaver/daemon.log` 中的错误日志。

---

## 第二步：注册第一个实体

### 注册 usecase

```bash
tw register --kind usecase --title "启动博客改版" --id blog-v2
```

输出：

```
✔ Registered usecase blog-v2 [pending]
```

### 在其下创建 task

```bash
tw register --kind task --title "撰写首屏文案" --parent blog-v2 --id task-hero
```

输出：

```
✔ Registered task task-hero [pending] → parent: blog-v2
```

### 查看当前状态

```bash
# 查看特定实体
tw status blog-v2

# 查看所有实体汇总
tw status
```

---

## 第三步：状态流转

```bash
# 将 usecase 推进到进行中
tw update blog-v2 --state in_progress

# 将 task 推进到进行中
tw update task-hero --state in_progress

# 设置元数据属性
tw update task-hero --attr assignee=alice --attr priority=high

# 将 task 提交审核
tw update task-hero --state review

# 完成 task
tw update task-hero --state completed
```

每次状态转换都会输出变更记录：

```
✔ blog-v2: pending → in_progress
✔ task-hero: pending → in_progress
✔ task-hero: in_progress → review
✔ task-hero: review → completed
```

---

## 第四步：查看事件日志

TraceWeaver 将所有事件持久化到 NDJSON 日志中，Daemon 重启后仍可查询。

### 查询历史事件

```bash
# 查询过去 1 小时内的所有事件
tw log query --since 1h

# 按实体过滤
tw log query --since 1h --entity blog-v2

# 按事件类型过滤
tw log query --since 1h --type state_changed

# 组合过滤（指定实体 + 指定类型）
tw log query --since 24h --entity task-hero --type state_changed
```

### 实时流式监听事件

```bash
# 实时监听所有事件（Ctrl+C 退出）
tw watch

# 输出为 JSON 格式（适合程序化处理）
tw watch --json
```

`tw watch` 会持续输出新产生的事件，非常适合在 AI Agent 开发时观察系统行为。

---

## 第五步：查看指标

TraceWeaver 直接从 OTel Span 历史中推导出指标，无需额外配置。

```bash
# 查看所有实体的指标
tw metrics

# 按类型过滤（usecase / plan / task）
tw metrics --type task

# 指定时间窗口（单位：小时）
tw metrics --type task --window 24

# 输出为 JSON 格式
tw metrics --type task --window 24 --json
```

指标包含：周期时间（cycle time）、失败率（failure rate）、吞吐量（throughput）。

---

## 第六步：依赖图与影响分析

### 查看依赖关系图

```bash
# 查看全局依赖图
tw dag

# 查看特定实体的依赖图
tw dag --entity blog-v2
```

示例输出：

```
blog-v2 (usecase, in_progress)
  └─ plan-1 (plan, pending) [BLOCKED by task-hero]
       └─ task-hero (task, in_progress)
```

### 影响分析

当制品文件或文档发生变更时，分析哪些实体会受到影响：

```bash
# 分析某个源文件变更的影响范围
tw impact src/auth.ts

# 分析文档变更的影响范围
tw impact ./docs/prd.md

# 输出为 JSON 格式
tw impact src/auth.ts --json
```

---

## 第七步：Harness 约束文件

Harness 是以 Markdown + YAML frontmatter 格式编写的约束文件，定义实体满足"完成"条件的规则。Daemon 会在实体到达指定状态时自动执行这些约束。

### 创建 Harness 文件

在项目中创建 `.traceweaver/harness/` 目录，然后创建约束文件：

```bash
mkdir -p .traceweaver/harness
```

创建 `.traceweaver/harness/test-coverage.md`：

```markdown
---
id: test-coverage
applies_to:
  - task
trigger_on:
  - review
  - completed
---
# 测试覆盖率约束

所有任务必须包含测试文件。检查 artifact_refs 中是否至少有一项
type 为 "test" 的条目。

RESULT: 测试存在则通过，否则失败。
```

### 管理和运行 Harness

```bash
# 列出所有可用的 Harness
tw harness list

# 查看某个 Harness 的详情
tw harness show test-coverage

# 对某个实体手动运行 Harness
tw harness run task-hero --harness-id test-coverage

# 输出为 JSON 格式
tw harness list --json
tw harness run task-hero --harness-id test-coverage --json
```

### 启用 LLM 驱动的约束评估

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

设置该密钥后，当实体到达 `trigger_on` 中列出的状态时，TriggerExecutor 会自动调用 LLM 评估约束：
- **失败** → 实体自动转换为 `rejected`，并写入收件箱通知
- **通过** → 实体继续其生命周期

---

## 第八步：通知收件箱

```bash
# 查看所有通知
tw inbox

# 只查看未读通知
tw inbox --unread

# 限制显示数量
tw inbox --limit 10

# 输出为 JSON 格式
tw inbox --json
```

在 `.traceweaver/config.yaml` 中配置通知规则：

```yaml
# .traceweaver/config.yaml

notifications:
  - name: "任务被拒绝时告警"
    match:
      kind: task
      event: state_changed
      to: rejected
    deliver:
      - channel: inbox
        message: "任务 {{entityId}} 已被拒绝。"

  - name: "usecase 完成时发送 Webhook"
    match:
      kind: usecase
      event: state_changed
      to: completed
    deliver:
      - channel: webhook
        url: "https://hooks.example.com/traceweaver"
        method: POST
```

---

## 下一步

恭喜！你已完成 TraceWeaver 的基础操作。接下来可以进一步探索：

- **CLI 命令大全** — 查看 `tw --help` 或各子命令的 `tw <命令> --help`
- **示例代码** — 浏览 [`examples/src/`](../examples/src/) 目录，包含覆盖所有主要功能的可运行示例：
  - `01-basic-entity-lifecycle.ts` — 基础实体生命周期
  - `04-full-flow-research-project.ts` — 完整研发项目模拟
  - `06-full-flow-constraint-validation.ts` — LLM 驱动的约束验证
  - `11-full-chain-autonomous-loop.ts` — 自主 Agent 闭环
- **HTTP API** — 启动 HTTP Server 接入 CI/CD 流水线：
  ```bash
  TW_HTTP_PORT=4321 tw daemon start
  ```
- **MCP Server 集成** — 将 TraceWeaver 接入 Claude Desktop 或其他支持 MCP 协议的 AI 工具：
  ```bash
  TW_MCP_STDIO=1 tw daemon --mcp
  ```
- **架构文档** — 阅读 [docs/ARCHITECTURE.md](./ARCHITECTURE.md) 了解模块边界（`core`、`cli`、`http`、`mcp`、`notify`、`otel`）

---

## 常见问题排查

### Daemon 未启动

**症状：** `tw` 命令挂起或返回 "daemon unavailable"。

**解决步骤：**

1. 检查 Daemon 进程是否正在运行：
   ```bash
   ps aux | grep tw
   ```
2. 显式启动 Daemon：
   ```bash
   tw daemon start
   ```
3. 查看 `.traceweaver/daemon.log` 中的日志。

### Socket 地址已被占用

**症状：** `Error: EADDRINUSE — address already in use`。

**解决步骤：**

1. 找出占用 Socket 的进程：
   ```bash
   lsof -i :<port>
   ```
2. 终止该进程：
   ```bash
   kill -9 <PID>
   ```
3. 删除残留的 Socket 文件：
   ```bash
   rm -f /tmp/traceweaver.sock
   ```

### WAL 损坏恢复

**症状：** 启动时出现 `WAL checksum mismatch` 或实体丢失。

**解决步骤：**

1. 运行恢复示例以了解 WAL 修复流程：
   ```bash
   npm run example:10
   ```
2. 触发手动 WAL 恢复：
   ```bash
   tw recover --wal .traceweaver/wal.log
   ```
3. 如果恢复失败，从 `.traceweaver/snapshots/` 中的最近一次干净快照恢复。
