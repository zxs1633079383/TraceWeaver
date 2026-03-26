# 快速上手指南

[English](./QUICKSTART.md)

TraceWeaver 是一款轻量级、本地优先的实体追踪系统，专为 AI 辅助研发工作流设计。内置状态机、事件总线、DAG 依赖图、通知引擎和 OpenTelemetry 导出，基于追加写入的 WAL，可通过 CLI、编程 API、MCP Server 或 HTTP 操作。

---

## 前置条件

- **Node.js** v18+
- **npm** v9+（需要 workspaces 支持）

---

## 安装

```bash
git clone https://github.com/anthropics/traceweaver.git
cd traceweaver
npm install
npm run build
```

全局安装 CLI（可选）：

```bash
npm install -g .
# 或使用 npx tw <命令>
```

---

## 核心概念

### 实体（Entities）

TraceWeaver 中的每个工作单元都是一个**实体**，有三种类型：

| 类型 | 用途 |
|------|------|
| `usecase` | 高层目标或项目 |
| `plan` | usecase 下的执行计划 |
| `task` | plan 下的原子工作项 |

实体形成父子树结构：`usecase` -> `plan` -> `task`。

### 状态机

```
pending --> in_progress --> review --> completed
   |              |            |
   +--------------+----> rejected <---+
```

| 起始状态 | 目标状态 |
|---------|---------|
| `pending` | `in_progress`、`rejected` |
| `in_progress` | `review`、`rejected` |
| `review` | `completed`、`rejected` |
| `completed` | — （终态） |
| `rejected` | — （终态） |

无效的状态转换会抛出 `TransitionError`。

### 事件总线

每次状态变更都会向 `EventBus` 发出事件，同时持久化到 WAL，支持查询和回放。

### DAG 依赖

实体可声明 `depends_on` 关系。TraceWeaver 追踪 DAG 并报告哪些实体被阻塞。

---

## 第一步：启动 Daemon

```bash
tw daemon start
tw status
```

期望输出：

```
total: 0  pending: 0  in_progress: 0  review: 0  completed: 0  rejected: 0
```

---

## 第二步：注册实体

```bash
tw register usecase blog-v2 --prd docs/prd.md
tw register plan plan-frontend --parent blog-v2 --domain frontend
tw register task task-hero --parent plan-frontend
```

查看状态：

```bash
tw status
tw status --json
```

---

## 第三步：状态流转

```bash
tw update task-hero --state in_progress
tw update task-hero --state review
tw update task-hero --state completed
```

输出：

```
task-hero: pending -> in_progress
task-hero: in_progress -> review
task-hero: review -> completed
```

---

## 第四步：事件日志

事件持久化到 NDJSON，daemon 重启后仍可查询。

```bash
# 查询最近事件
tw log query --since 1h

# 按实体过滤
tw log query --since 1h --entity blog-v2

# 按事件类型过滤
tw log query --since 1h --type state_changed

# 实时事件流（Ctrl+C 退出）
tw watch --json
```

---

## 第五步：指标

直接从 OTel Span 推导，无需额外配置。

```bash
tw metrics
tw metrics --type task --window 24 --json
```

包含：周期时间、失败率、吞吐量。

---

## 第六步：链路查询

```bash
# Span 树可视化
tw trace spans --entity-id blog-v2

# 完整链路 + AI 上下文
tw trace info --entity-id blog-v2 --json
```

`_ai_context` 字段告诉 AI Agent 下一步该做什么：

```json
{
  "one_line": "3 实体中 2 完成，task-blocked 等待解锁",
  "next_actions": ["task-blocked: 等待上游完成后继续"],
  "error_refs": ["events.ndjson -> entity_id=task-blocked"]
}
```

---

## 第七步：日报

```bash
tw report daily --all
tw report list --date 2026-03-26
tw report show --date 2026-03-26
```

日报是原子写入的 Markdown 文件，包含实体汇总、Span 树和 AI 上下文。

---

## 第八步：依赖与影响分析

```bash
# 查看依赖图
tw dag

# 影响分析：文件变更影响哪些实体？
tw impact src/auth.ts --json
```

---

## 第九步：通知

```bash
tw inbox
tw inbox --unread
tw inbox --ack <通知ID>
```

在 `.traceweaver/config.yaml` 中配置通知规则：

```yaml
notify:
  rules:
    - event: entity.state_changed
      state: rejected
    - event: entity.state_changed
      state: completed
```

---

## 下一步

- **CLI 命令参考** — `tw --help` 或 `tw <命令> --help`
- **示例代码** — 查看 [`examples/src/`](./examples/src/)：
  - `01-basic-entity-lifecycle.ts` — 基础生命周期
  - `11-full-chain-autonomous-loop.ts` — 全链路可观测闭环
  - `14-trace-report-e2e.ts` — 链路 + 日报端到端
- **HTTP API** — `TW_HTTP_PORT=4321 tw daemon start`
- **MCP Server** — `TW_MCP_STDIO=1 tw daemon --mcp`

---

## 常见问题

### Daemon 未启动

```bash
ps aux | grep tw
tw daemon start
# 查看日志：.traceweaver/daemon.log
```

### Socket 被占用

```bash
rm -f .traceweaver/tw.sock
tw daemon start
```

### WAL 恢复

```bash
npm run run:10 --workspace=examples   # WAL 恢复示例
```
