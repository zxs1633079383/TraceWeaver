# TraceWeaver

**The AI-Native R&D Process Observability Engine**

TraceWeaver tracks the full lifecycle of R&D entities — experiments, hypotheses, tasks, and artifacts — giving AI agents and human engineers a live, queryable view of your research process.

---

## Features

- **State Machine Tracking** — Register entities and advance them through well-defined lifecycle states (`pending`, `in_progress`, `completed`, `rejected`, `blocked`)
- **OpenTelemetry Integration** — Every entity maps to an OTel span; state changes emit events and span annotations automatically
- **MCP Server** — First-class Model Context Protocol support for AI agent integration via stdio transport
- **HTTP API** — Webhook-friendly REST API with token-based auth for CI/CD and external integrations
- **Notification Engine** — Configurable inbox and webhook rules that fire on state transitions (e.g. `rejected`, `completed`)
- **Filesystem Watcher** — Automatically emits events when tracked artifact files change on disk
- **Dependency DAG** — Declare `depends_on` relationships and query the live entity graph
- **Impact Analysis** — Resolve which entities are affected when an artifact or document section changes

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
     |                    |
     |                    +---> NotifyEngine --> InboxAdapter
     |                    |                 --> WebhookAdapter
     |                    +---> FsWatcher
     |                    +---> SpanManager (OTel)
     |
     +---> McpServer  (stdio, optional)
     +---> HttpServer (port, optional)
```

---

## Installation

```bash
npm install
npm run build
```

To install the `tw` CLI globally:

```bash
npm install -g .
```

---

## Quick Start

```bash
# Register a new experiment entity
tw register exp-001 --type experiment --title "Baseline benchmark"

# Update its state
tw update exp-001 --state in_progress

# Check status of all entities
tw status

# View notification inbox
tw inbox

# Query recent event history
tw events --limit 20

# Inspect the dependency graph
tw dag

# Analyze impact of a document change
tw impact ./docs/prd.md#requirements-section
```

---

## Configuration

Create `.traceweaver/config.yaml` in your project root:

```yaml
# .traceweaver/config.yaml

store_dir: .traceweaver        # Where entities and WAL are persisted
socket_path: .traceweaver/tw.sock

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
  project_id: my-project
  exporter: console            # console | otlp

http:
  port: 4321
  inbound_token: ${TW_INBOUND_TOKEN}
```

Environment variable overrides:

| Variable | Description |
|---|---|
| `TW_STORE` | Override store directory path |
| `TW_SOCKET` | Override socket path |
| `TW_HTTP_PORT` | Enable HTTP API on specified port |
| `TW_INBOUND_TOKEN` | Bearer token for HTTP API auth |
| `TW_MCP_STDIO` | Set to `1` to enable MCP stdio transport |
| `TW_WEBHOOK_TOKEN` | Token sent in webhook `Authorization` header |

---

## Agent Integration

### MCP Server

TraceWeaver exposes a full MCP server for AI agents (Claude, GPT-4, etc.):

```json
{
  "mcpServers": {
    "traceweaver": {
      "command": "tw",
      "args": ["daemon", "--mcp"],
      "env": {
        "TW_MCP_STDIO": "1",
        "TW_STORE": "/path/to/your/project/.traceweaver"
      }
    }
  }
}
```

MCP tools exposed: `register_entity`, `update_state`, `update_attributes`, `get_status`, `query_events`, `get_dag`, `link_artifact`, `emit_event`

### HTTP API

When `TW_HTTP_PORT` is set, the daemon exposes a REST API:

```
Base URL: http://127.0.0.1:<TW_HTTP_PORT>

POST   /entities              Register entity
PATCH  /entities/:id/state    Update state
PATCH  /entities/:id/attrs    Update attributes
GET    /entities/:id          Get entity + children
GET    /status                Summary stats
POST   /events                Emit custom event
GET    /events                Query event history
GET    /dag                   Get dependency graph
```

All requests require `Authorization: Bearer <TW_INBOUND_TOKEN>` when `TW_INBOUND_TOKEN` is set.

---

## License

MIT
