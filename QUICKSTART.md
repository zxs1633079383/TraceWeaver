# Quick Start Guide / 快速上手指南

TraceWeaver is a lightweight, local-first entity tracking system for AI-assisted dev workflows. It includes a state machine, event bus, DAG dependencies, notification engine, and OpenTelemetry export — all backed by an append-only WAL, accessible via CLI, programmatic API, MCP Server, or HTTP.

TraceWeaver 是一款轻量级、本地优先的实体追踪系统，专为 AI 辅助研发工作流设计。内置状态机、事件总线、DAG 依赖图、通知引擎和 OpenTelemetry 导出，基于追加写入的 WAL，可通过 CLI、编程 API、MCP Server 或 HTTP 操作。

---

## Prerequisites / 前置条件

- **Node.js** v18+
- **npm** v9+ (workspaces support)

---

## Install / 安装

```bash
git clone https://github.com/anthropics/traceweaver.git
cd traceweaver
npm install
npm run build
```

Optional global CLI install / 可选全局安装：

```bash
npm install -g .
# Or use: npx tw <command>
```

---

## Core Concepts / 核心概念

### Entities / 实体

Every work unit in TraceWeaver is an **entity** with three built-in types:
TraceWeaver 中的每个工作单元都是一个**实体**，有三种类型：

| Type / 类型 | Purpose / 用途 |
|-------------|---------------|
| `usecase` | High-level goal or project / 高层目标 |
| `plan` | Execution plan under a usecase / 执行计划 |
| `task` | Atomic work item under a plan / 原子工作项 |

Entities form a parent-child tree: `usecase` -> `plan` -> `task`.

### State Machine / 状态机

```
pending --> in_progress --> review --> completed
   |              |            |
   +--------------+----> rejected <---+
```

| From | To |
|------|----|
| `pending` | `in_progress`, `rejected` |
| `in_progress` | `review`, `rejected` |
| `review` | `completed`, `rejected` |
| `completed` | — (terminal / 终态) |
| `rejected` | — (terminal / 终态) |

Invalid transitions throw `TransitionError`.

### Event Bus / 事件总线

Every state change emits a typed event to the in-process `EventBus`. Events are persisted to WAL for query and replay.
每次状态变更都会发出事件，同时持久化到 WAL，支持查询和回放。

### DAG Dependencies / 依赖图

Entities can declare `depends_on` relationships. TraceWeaver tracks the resulting DAG and reports which entities are blocked.
实体可声明 `depends_on` 关系，TraceWeaver 追踪 DAG 并报告阻塞状态。

---

## Step 1: Start the Daemon / 启动 Daemon

```bash
tw daemon start
tw status
```

Expected output / 期望输出：

```
total: 0  pending: 0  in_progress: 0  review: 0  completed: 0  rejected: 0
```

---

## Step 2: Register Entities / 注册实体

```bash
# Register a usecase / 注册用例
tw register usecase blog-v2 --prd docs/prd.md

# Create a plan and task / 创建计划和任务
tw register plan plan-frontend --parent blog-v2 --domain frontend
tw register task task-hero --parent plan-frontend
```

Check status / 查看状态：

```bash
tw status
tw status --json
```

---

## Step 3: State Transitions / 状态流转

```bash
tw update task-hero --state in_progress
tw update task-hero --state review
tw update task-hero --state completed
```

Output / 输出：

```
task-hero: pending -> in_progress
task-hero: in_progress -> review
task-hero: review -> completed
```

---

## Step 4: Event Log / 事件日志

Events are persisted to NDJSON and survive daemon restarts.
事件持久化到 NDJSON，daemon 重启后仍可查询。

```bash
# Query recent events / 查询最近事件
tw log query --since 1h

# Filter by entity / 按实体过滤
tw log query --since 1h --entity blog-v2

# Filter by event type / 按事件类型过滤
tw log query --since 1h --type state_changed

# Live event stream / 实时事件流 (Ctrl+C to exit)
tw watch --json
```

---

## Step 5: Metrics / 指标

Derived directly from OTel spans — no extra setup.
直接从 OTel Span 推导，无需额外配置。

```bash
tw metrics
tw metrics --type task --window 24 --json
```

Includes: cycle time, failure rate, throughput.
包含：周期时间、失败率、吞吐量。

---

## Step 6: Trace Query / 链路查询

```bash
# Span tree visualization / Span 树可视化
tw trace spans --entity-id blog-v2

# Full trace info with AI context / 完整链路 + AI 上下文
tw trace info --entity-id blog-v2 --json
```

The `_ai_context` field tells AI Agents what to do next:
`_ai_context` 字段告诉 AI Agent 下一步该做什么：

```json
{
  "one_line": "3 entities: 2 completed, task-blocked waiting",
  "next_actions": ["task-blocked: waiting for upstream to complete"],
  "error_refs": ["events.ndjson -> entity_id=task-blocked"]
}
```

---

## Step 7: Daily Reports / 日报

```bash
# Generate report for all traces / 为所有 trace 生成日报
tw report daily --all

# List generated reports / 列出已生成报告
tw report list --date 2026-03-26

# View report content / 查看报告内容
tw report show --date 2026-03-26
```

Reports are atomic-written Markdown files with entity summaries, span trees, and AI context.
日报是原子写入的 Markdown 文件，包含实体汇总、Span 树和 AI 上下文。

---

## Step 8: Dependencies & Impact / 依赖与影响分析

```bash
# View dependency graph / 查看依赖图
tw dag

# Impact analysis: which entities are affected by a file change?
# 影响分析：文件变更影响哪些实体？
tw impact src/auth.ts --json
```

---

## Step 9: Notifications / 通知

```bash
tw inbox
tw inbox --unread
tw inbox --ack <notification-id>
```

Configure notification rules in `.traceweaver/config.yaml`:

```yaml
notify:
  rules:
    - event: entity.state_changed
      state: rejected
    - event: entity.state_changed
      state: completed
```

---

## What's Next / 下一步

- **CLI Reference** — `tw --help` or `tw <command> --help`
- **Examples / 示例** — see [`examples/src/`](./examples/src/):
  - `01-basic-entity-lifecycle.ts` — Basic lifecycle / 基础生命周期
  - `11-full-chain-autonomous-loop.ts` — Full observability loop / 全链路闭环
  - `14-trace-report-e2e.ts` — Trace + Report E2E / 链路+日报端到端
- **HTTP API** — `TW_HTTP_PORT=4321 tw daemon start`
- **MCP Server** — `TW_MCP_STDIO=1 tw daemon --mcp`

---

## Troubleshooting / 常见问题

### Daemon not starting / Daemon 未启动

```bash
ps aux | grep tw
tw daemon start
# Check logs: .traceweaver/daemon.log
```

### Socket in use / Socket 被占用

```bash
rm -f .traceweaver/tw.sock
tw daemon start
```

### WAL recovery / WAL 恢复

```bash
npm run run:10 --workspace=examples   # WAL recovery demo
```
