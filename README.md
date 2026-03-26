# TraceWeaver

**AI-Native Dev Process Observability Engine**
**AI 原生研发流程可观测引擎**

TraceWeaver tracks the full lifecycle of UseCase -> Plan -> Task entities, giving AI Agents and engineers a real-time, queryable view of the development process — with OpenTelemetry traces exported to Jaeger.

TraceWeaver 追踪 UseCase -> Plan -> Task 的完整生命周期，为 AI Agent 和工程师提供实时可查询的研发过程视图，并通过 OpenTelemetry 将 Trace 导出到 Jaeger。

---

## Features / 功能特性

- **Entity Lifecycle Tracking / 实体生命周期追踪** — Register entities and drive them through a well-defined state machine (`pending` -> `in_progress` -> `review` -> `completed` | `rejected`)
- **OpenTelemetry Integration / OTel 集成** — Each entity maps to an OTel Span; state changes emit span events. Export to Jaeger via OTLP/gRPC
- **Trace Query + `_ai_context` / 链路查询** — `tw trace info --json` returns a deterministic `_ai_context` field that tells AI Agents exactly what to do next
- **Daily Reports / 日报生成** — `tw report daily` generates structured Markdown reports aggregating entity status, span trees, and AI context
- **MCP Server** — First-class Model Context Protocol support for AI Agents (Claude, etc.) via stdio transport
- **HTTP API** — Token-authenticated REST API for CI/CD and external integrations
- **Notification Engine / 通知引擎** — Configurable inbox and webhook rules triggered on state transitions
- **File Watcher / 文件监听** — Automatically detects when tracked artifact files change on disk
- **DAG Dependencies / 依赖图** — Declare `depends_on` relationships; query the live entity graph; detect blocked entities
- **Impact Analysis / 影响分析** — Resolve which entities are affected (directly + transitively) when an artifact file changes
- **Persistent Event Log / 持久化事件日志** — NDJSON-based event log survives daemon restarts; full query by entity, type, and time range
- **Span Metrics / 指标** — Cycle time, failure rate, and throughput derived directly from OTel span history

---

## Architecture / 架构

```
tw (CLI)
   |
   | Unix socket (IPC)
   v
tw-daemon
   |
   +---> CommandHandler
   |          |
   |          +---> EntityRegistry + DAG
   |          +---> WAL + FsStore
   |          +---> EventBus
   |          +---> ImpactResolver
   |                    |
   |                    +---> EventLog (NDJSON)
   |                    +---> NotifyEngine --> InboxAdapter / WebhookAdapter
   |                    +---> FsWatcher
   |                    +---> SpanManager (OTel) --> SpanMetrics
   |                    +---> TraceQueryEngine --> _ai_context
   |                    +---> ReportGenerator + ReportScheduler
   |
   +---> McpServer  (stdio, optional)
   +---> HttpServer (port, optional)
```

---

## Install / 安装

```bash
npm install
npm run build
```

Global CLI install (optional but recommended / 全局安装 CLI，可选但推荐)：

```bash
npm install -g .
```

---

## Quick Start / 快速开始

```bash
# Start the daemon / 启动守护进程
tw daemon start

# Register entities / 注册实体
tw register usecase blog-v2 --prd docs/prd.md
tw register plan plan-frontend --parent blog-v2 --domain frontend
tw register task task-hero --parent plan-frontend

# Drive state transitions / 推进状态
tw update task-hero --state in_progress
tw update task-hero --state review
tw update task-hero --state completed

# Query trace with AI context / 查询链路（含 AI 上下文）
tw trace info --entity-id blog-v2 --json

# Generate daily report / 生成日报
tw report daily --all

# View metrics / 查看指标
tw metrics --type task --window 24

# Impact analysis / 影响分析
tw impact src/auth.ts --json

# All commands support --json / 所有命令支持 --json
tw status --json
tw log query --since 1h --json
tw inbox --json
```

See [QUICKSTART.md](./QUICKSTART.md) for the full step-by-step guide.
完整的分步教程请参阅 [QUICKSTART.md](./QUICKSTART.md)。

---

## Configuration / 配置

Create `.traceweaver/config.yaml` in your project root:

```yaml
notify:
  rules:
    - event: entity.state_changed
      state: rejected
    - event: entity.state_changed
      state: completed
  webhook:
    url: https://hooks.example.com/tw
    token: ${TW_WEBHOOK_TOKEN}

otel:
  exporter: otlp-grpc          # console | otlp-http | otlp-grpc
  endpoint: localhost:4317

report:
  schedule: "09:00"             # Auto-generate daily reports at 9am
  output_dir: ~/.traceweaver/reports

watch:
  dirs: ["."]
```

### Environment Variables / 环境变量

| Variable | Description |
|----------|-------------|
| `TW_STORE` | Override storage directory (default: `.traceweaver`) |
| `TW_SOCKET` | Override Unix socket path |
| `TW_HTTP_PORT` | Enable HTTP API on specified port |
| `TW_INBOUND_TOKEN` | HTTP API Bearer Token |
| `TW_MCP_STDIO` | Set to `1` to enable MCP stdio transport |
| `TW_WEBHOOK_TOKEN` | Token for webhook `Authorization` header |

---

## AI Agent Integration / AI Agent 集成

### MCP Server

```json
{
  "mcpServers": {
    "traceweaver": {
      "command": "tw",
      "args": ["daemon", "--mcp"],
      "env": { "TW_MCP_STDIO": "1" }
    }
  }
}
```

Tools: `register_entity`, `update_state`, `get_status`, `query_events`, `get_dag`, `emit_event`

### `_ai_context` — AI Agent Action Guide / AI Agent 行动指南

`tw trace info --json` returns a deterministic `_ai_context` field:

```json
{
  "one_line": "5 entities: 2 completed, task-bad rejected, task-blocked waiting",
  "next_actions": ["task-bad: rejected -> fix and retry", "task-blocked: waiting for upstream"],
  "error_refs": ["events.ndjson -> entity_id=task-bad, state=rejected"]
}
```

AI Agents don't need to understand TraceWeaver internals — just read `_ai_context.next_actions`.
AI Agent 无需理解 TraceWeaver 内部机制，只需读取 `_ai_context.next_actions` 即可知道下一步。

### HTTP API

```
POST   /entities              Register entity
PATCH  /entities/:id/state    Update state
GET    /entities/:id          Get entity + children
GET    /status                Summary stats
GET    /dag                   Dependency graph
```

Requires `Authorization: Bearer <TW_INBOUND_TOKEN>` when token is configured.

---

## Observability Loop / 可观测闭环

```
AI Agent
  |
  +-- tw log query --since 1h        # observe: what happened?
  +-- tw metrics --type task          # detect: any failures?
  +-- tw impact src/auth.ts           # diagnose: which entities affected?
  +-- tw trace info --json            # decide: what should I do next?
  +-- tw update <id> --state ...      # fix: drive state forward
```

---

## Examples / 示例

```bash
npm run run:11 --workspace=examples   # Full observability loop / 全链路可观测闭环
npm run run:12 --workspace=examples   # Jaeger OTLP/gRPC export / Jaeger 导出
npm run run:13 --workspace=examples   # TaskMaster bridge / TaskMaster 联动
npm run run:14 --workspace=examples   # Trace + Report E2E / 链路+日报端到端
```

---

## License

MIT
