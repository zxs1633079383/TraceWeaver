# TraceWeaver

**AI-Native Dev Process Observability Engine**

[中文文档](./README.zh-CN.md)

TraceWeaver tracks the full lifecycle of UseCase -> Plan -> Task entities, giving AI Agents and engineers a real-time, queryable view of the development process — with OpenTelemetry traces exported to Jaeger.

---

## Features

- **Entity Lifecycle Tracking** — Register entities and drive them through a state machine (`pending` -> `in_progress` -> `review` -> `completed` | `rejected`)
- **OpenTelemetry Integration** — Each entity maps to an OTel Span; state changes emit span events. Export to Jaeger via OTLP/gRPC
- **Trace Query + `_ai_context`** — `tw trace info --json` returns a deterministic `_ai_context` field that tells AI Agents exactly what to do next
- **Daily Reports** — `tw report daily` generates structured Markdown reports aggregating entity status, span trees, and AI context
- **MCP Server** — First-class Model Context Protocol support for AI Agents (Claude, etc.) via stdio transport
- **HTTP API** — Token-authenticated REST API for CI/CD and external integrations
- **Notification Engine** — Configurable inbox and webhook rules triggered on state transitions
- **File Watcher** — Automatically detects when tracked artifact files change on disk
- **DAG Dependencies** — Declare `depends_on` relationships; query the live entity graph; detect blocked entities
- **Impact Analysis** — Resolve which entities are affected (directly + transitively) when an artifact file changes
- **Persistent Event Log** — NDJSON-based event log survives daemon restarts; full query by entity, type, and time range
- **Span Metrics** — Cycle time, failure rate, and throughput derived directly from OTel span history

---

## Architecture

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

## Install

```bash
npm install
npm run build
```

Global CLI install (optional but recommended):

```bash
npm install -g .
```

---

## Quick Start

```bash
# Start the daemon
tw daemon start

# Register entities
tw register usecase blog-v2 --prd docs/prd.md
tw register plan plan-frontend --parent blog-v2 --domain frontend
tw register task task-hero --parent plan-frontend

# Drive state transitions
tw update task-hero --state in_progress
tw update task-hero --state review
tw update task-hero --state completed

# Query trace with AI context
tw trace info --entity-id blog-v2 --json

# Generate daily report
tw report daily --all

# View metrics
tw metrics --type task --window 24

# Impact analysis
tw impact src/auth.ts --json

# All commands support --json
tw status --json
tw log query --since 1h --json
tw inbox --json
```

See [QUICKSTART.md](./QUICKSTART.md) for the full step-by-step guide.

---

## Configuration

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

### Environment Variables

| Variable | Description |
|----------|-------------|
| `TW_STORE` | Override storage directory (default: `.traceweaver`) |
| `TW_SOCKET` | Override Unix socket path |
| `TW_HTTP_PORT` | Enable HTTP API on specified port |
| `TW_INBOUND_TOKEN` | HTTP API Bearer Token |
| `TW_MCP_STDIO` | Set to `1` to enable MCP stdio transport |
| `TW_WEBHOOK_TOKEN` | Token for webhook `Authorization` header |

---

## AI Agent Integration

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

### `_ai_context` — AI Agent Action Guide

`tw trace info --json` returns a deterministic `_ai_context` field:

```json
{
  "one_line": "5 entities: 2 completed, task-bad rejected, task-blocked waiting",
  "next_actions": ["task-bad: rejected -> fix and retry", "task-blocked: waiting for upstream"],
  "error_refs": ["events.ndjson -> entity_id=task-bad, state=rejected"]
}
```

AI Agents don't need to understand TraceWeaver internals — just read `_ai_context.next_actions`.

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

## Observability Loop

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

## Examples

```bash
npm run run:11 --workspace=examples   # Full observability loop
npm run run:12 --workspace=examples   # Jaeger OTLP/gRPC export
npm run run:13 --workspace=examples   # TaskMaster bridge
npm run run:14 --workspace=examples   # Trace + Report E2E
```

---

## License

MIT
