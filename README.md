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
- **Persistent Event Log** — NDJSON-backed event log survives daemon restarts; full query API by entity, type, and time range
- **Span Metrics** — Derive cycle time, failure rate, and throughput directly from OTel span history
- **Harness Engineering** — Constraint files as code (`.traceweaver/harness/*.md`); auto-validate entities on state changes, auto-reject on failure
- **Autonomous Agent Loop** — AI agents can observe → detect → diagnose → validate → fix in a complete closed loop via CLI or MCP

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
     |          +---> ImpactResolver     (file → entity reverse index + DAG propagation)
     |                    |
     |                    +---> EventLog         (NDJSON persistent log)
     |                    +---> NotifyEngine --> InboxAdapter
     |                    |                 --> WebhookAdapter
     |                    +---> FsWatcher
     |                    +---> SpanManager (OTel) --> SpanMetrics
     |                    +---> HarnessLoader   (.traceweaver/harness/*.md)
     |                    +---> TriggerExecutor (auto-validate → auto-reject)
     |                              └─> ConstraintEvaluator (LLM-backed)
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

# Query recent event history (persistent log, survives restarts)
tw log query --since 1h --entity exp-001 --type state_changed

# Stream live events
tw watch

# View span-derived metrics
tw metrics --type task --window 24

# Inspect the dependency graph
tw dag

# Analyze impact of a document change
tw impact ./docs/prd.md

# Harness engineering — constraint files as code
tw harness list
tw harness show test-coverage
tw harness run exp-001 --harness-id test-coverage

# All commands support --json for machine-readable output
tw status --json
tw metrics --json
tw harness list --json
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
| `ANTHROPIC_API_KEY` | Enables LLM-backed harness constraint evaluation |

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

## Harness Engineering

Harnesses are constraint files that live alongside your project as Markdown with YAML frontmatter. They define what "done" means for each entity type, and the daemon enforces them automatically.

### Harness file format

Create `.traceweaver/harness/<id>.md`:

```markdown
---
id: test-coverage
applies_to:
  - task
trigger_on:
  - review
  - completed
---
# Test Coverage Constraint

All tasks MUST include test files. Check that artifact_refs contains at least
one entry with type "test".

RESULT: pass if tests are present, fail otherwise.
```

### Auto-enforcement

When an entity reaches a state listed in `trigger_on`, the TriggerExecutor automatically:
1. Evaluates the harness constraint via the ConstraintEvaluator (LLM-backed when `ANTHROPIC_API_KEY` is set)
2. On **fail** → automatically transitions the entity to `rejected` and writes an inbox notification
3. On **pass** → records the result; the entity continues its lifecycle

Enable AI-backed evaluation:

```bash
export ANTHROPIC_API_KEY=sk-...
```

Without the key, the evaluator runs in disabled mode (no auto-reject).

### Environment variable

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Enables LLM-backed constraint evaluation in TriggerExecutor |

---

## Autonomous Agent Loop

Phase 5 completes the full observe → detect → diagnose → validate → fix loop:

```
AI Agent
  │
  ├── tw log query --since 1h          # observe: what happened?
  ├── tw metrics --type task           # detect: are there failures?
  ├── tw impact src/auth.ts            # diagnose: what is affected?
  ├── tw harness run <id> --harness-id # validate: does it pass constraints?
  └── tw update <id> --state completed # fix: advance when ready
```

All commands emit `--json` for programmatic use. The MCP server exposes the same operations as tools (`tw_query_log`, `tw_get_metrics`, `tw_resolve_impact`, `tw_harness_run`).

---

## License

MIT
