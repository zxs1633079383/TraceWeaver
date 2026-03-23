# TraceWeaver Quick Start Guide

TraceWeaver is a lightweight, local-first entity tracking system for AI-assisted workflows. It gives you a state machine, event bus, DAG dependency graph, notification engine, LLM constraint validation, and OpenTelemetry export — all backed by an append-only WAL and operable via CLI, programmatic API, MCP server, or HTTP.

---

## Prerequisites

- **Node.js** v18 or later
- **npm** v9 or later (workspaces support required)
- Optional: an Anthropic API key for constraint validation (`TW_ANTHROPIC_API_KEY`)

---

## Installation

```bash
git clone https://github.com/your-org/traceweaver.git
cd traceweaver
npm install
npm run build
```

Install the CLI globally (optional but recommended):

```bash
npm install -g .
# or use npx tw <command> without global install
```

---

## Core Concepts

### Entities

Every unit of work in TraceWeaver is an **entity**. Three built-in kinds:

| Kind | Purpose |
|------|---------|
| `usecase` | High-level goal or project |
| `plan` | Execution plan under a usecase |
| `task` | Atomic work item under a plan |

Entities form a parent–child tree. A `usecase` can own many `plan`s; a `plan` can own many `task`s.

### State Machine

All entities share the same five-state machine:

```
pending ──→ in_progress ──→ review ──→ completed
   │              │                        │
   └──────────────┴────→ rejected ←────────┘
```

Valid transitions:

| From | To |
|------|----|
| `pending` | `in_progress`, `rejected` |
| `in_progress` | `review`, `rejected` |
| `review` | `completed`, `rejected` |
| `completed` | — (terminal) |
| `rejected` | — (terminal) |

Attempting an invalid transition raises a `TransitionError`.

### Event Bus

Every state change and entity mutation emits a typed event onto the in-process `EventBus`. Subscribers can react in real-time. Events are also persisted to the WAL for query and replay.

### DAG Dependencies

Entities can declare `depends_on` relationships. TraceWeaver tracks the resulting directed acyclic graph (DAG) and can report which entities are blocked, unblocked, or impacted by a given entity's state change.

---

## Your First Entity (5 minutes)

### 1. Register a usecase

```bash
tw register --kind usecase --title "Launch blog redesign" --id blog-v2
```

Output:

```
✔ Registered usecase blog-v2 [pending]
```

### 2. Update state

```bash
tw update blog-v2 --state in_progress
```

Output:

```
✔ blog-v2: pending → in_progress
```

### 3. Query status

```bash
tw status blog-v2
```

Output:

```
blog-v2  usecase  in_progress
  tasks:   0 total  0 done
  updated: 2026-03-23T10:00:00.000Z
```

---

## CLI Reference

### `tw register`

Register a new entity.

```
tw register --kind <usecase|plan|task> --title <text> [--id <id>] [--parent <id>]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--kind` | yes | Entity kind |
| `--title` | yes | Human-readable name |
| `--id` | no | Custom ID (auto-generated if omitted) |
| `--parent` | no | Parent entity ID |

Example:

```bash
tw register --kind task --title "Write hero copy" --parent blog-v2 --id task-hero
# ✔ Registered task task-hero [pending] → parent: blog-v2
```

---

### `tw update`

Advance entity state or set metadata attributes.

```
tw update <id> --state <state>
tw update <id> --attr <key>=<value> [--attr <key>=<value> ...]
```

Examples:

```bash
tw update task-hero --state in_progress
tw update task-hero --attr assignee=alice --attr priority=high
```

---

### `tw status`

Show entity status, or a global summary when no ID is given.

```
tw status [<id>]
```

Global summary output:

```
total: 12  pending: 3  in_progress: 5  review: 2  completed: 2  rejected: 0
```

---

### `tw events`

Query the event history for an entity or all events.

```
tw events [--entity <id>] [--type <eventType>] [--limit <n>]
```

Example:

```bash
tw events --entity blog-v2 --limit 5
```

---

### `tw inbox`

Read notifications delivered to the local inbox.

```
tw inbox [--unread] [--limit <n>]
```

---

### `tw dag`

Print the dependency graph for all entities or a specific one.

```
tw dag [--entity <id>]
```

Example output:

```
blog-v2 (usecase, in_progress)
  └─ plan-1 (plan, pending) [BLOCKED by task-hero]
       └─ task-hero (task, in_progress)
```

---

### `tw impact`

Show which entities are affected if a given entity changes state.

```
tw impact <id>
```

---

## Programmatic API (Node.js)

Use TraceWeaver as a library inside your own Node.js application.

```typescript
import { CommandHandler } from "@traceweaver/core";
import { EventBus } from "@traceweaver/core";
import { SqliteAdapter } from "@traceweaver/core";

const bus = new EventBus();
const store = new SqliteAdapter(".traceweaver/data.db");
const handler = new CommandHandler({ store, bus });

// Subscribe to all state-change events before issuing commands
bus.on("entity:state_changed", (event) => {
  console.log(`[event] ${event.entityId}: ${event.from} → ${event.to}`);
});

// Register a usecase
const { id } = await handler.register({
  kind: "usecase",
  title: "My first workflow",
});

// Advance its state
await handler.updateState(id, "in_progress");

// Read it back
const entity = await handler.getContext(id);
console.log(entity.state); // "in_progress"
```

The `CommandHandler` accepts any storage adapter that implements the `IEntityStore` interface, making it easy to swap SQLite for an in-memory store during tests.

---

## AI Agent Integration

TraceWeaver ships a **Model Context Protocol (MCP) server** so AI assistants (Claude Desktop, Cursor, etc.) can manage your workflows natively.

### Enable the MCP server

Set the environment variable before starting your session:

```bash
TW_MCP=1 tw daemon
```

### Claude Desktop configuration

Add the following to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "traceweaver": {
      "command": "tw",
      "args": ["mcp"],
      "env": {
        "TW_DATA_DIR": "/Users/you/.traceweaver"
      }
    }
  }
}
```

### Available MCP tools

| Tool | Description |
|------|-------------|
| `tw_register` | Register a new entity (kind, title, optional parent/id) |
| `tw_update_state` | Advance an entity to a new state |
| `tw_update_attributes` | Set or overwrite metadata key/value pairs |
| `tw_remove` | Permanently delete an entity |
| `tw_get_context` | Retrieve an entity and its full child tree |
| `tw_get_status` | Global progress summary (counts by state) |
| `tw_get_dag` | Snapshot of the dependency graph |
| `tw_link_artifact` | Attach an artifact reference (URL, file path, etc.) |
| `tw_emit_event` | Emit a custom domain event onto the bus |
| `tw_query_events` | Query persisted event history with optional filters |

---

## HTTP API

TraceWeaver includes a Fastify HTTP server for remote or service-to-service access.

### Enable the HTTP server

```bash
TW_HTTP=1 TW_HTTP_PORT=4000 tw daemon
```

### Route table

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/entities` | Register a new entity |
| `PATCH` | `/entities/:id/state` | Update entity state |
| `PATCH` | `/entities/:id/attrs` | Update entity attributes |
| `GET` | `/entities/:id` | Get entity and its children |
| `DELETE` | `/entities/:id` | Remove entity |
| `GET` | `/status` | Summary stats (counts by state) |
| `POST` | `/events` | Emit a custom event |
| `GET` | `/events` | Query event history |
| `GET` | `/dag` | Dependency graph snapshot |
| `POST` | `/webhook` | Receive inbound webhook notifications |

### Curl examples

**Register an entity:**

```bash
curl -s -X POST http://localhost:4000/entities \
  -H "Content-Type: application/json" \
  -d '{"kind":"usecase","title":"Blog redesign","id":"blog-v2"}' | jq
```

**Advance state:**

```bash
curl -s -X PATCH http://localhost:4000/entities/blog-v2/state \
  -H "Content-Type: application/json" \
  -d '{"state":"in_progress"}' | jq
```

**Query event history:**

```bash
curl -s "http://localhost:4000/events?entityId=blog-v2&limit=10" | jq
```

**Get dependency graph:**

```bash
curl -s http://localhost:4000/dag | jq
```

**Inbound webhook (receive external notification):**

```bash
curl -s -X POST http://localhost:4000/webhook \
  -H "Content-Type: application/json" \
  -d '{"source":"github","event":"push","ref":"refs/heads/main"}' | jq
```

---

## Notification Rules

TraceWeaver's **NotifyEngine** fires rules whenever entity events occur. Rules are declared in `.traceweaver/config.yaml`.

### Example config

```yaml
# .traceweaver/config.yaml

notifications:
  - name: "Alert on task rejection"
    match:
      kind: task
      event: state_changed
      to: rejected
    deliver:
      - channel: inbox
        message: "Task {{entityId}} was rejected."

  - name: "Webhook on usecase completion"
    match:
      kind: usecase
      event: state_changed
      to: completed
    deliver:
      - channel: webhook
        url: "https://hooks.example.com/traceweaver"
        method: POST
```

### Delivery channels

| Channel | Description |
|---------|-------------|
| `inbox` | Writes to the local inbox; readable via `tw inbox` |
| `webhook` | POSTs a JSON payload to the configured URL with automatic retry |

### Rule matching syntax

Each rule's `match` block supports:

| Field | Type | Description |
|-------|------|-------------|
| `kind` | string | Entity kind (`usecase`, `plan`, `task`, or `*`) |
| `event` | string | Event type (e.g., `state_changed`, `attribute_updated`) |
| `to` | string | Target state (for `state_changed` events) |
| `entityId` | string | Match a specific entity ID |

---

## Constraint Validation

TraceWeaver can evaluate **Markdown constraint harnesses** against entity context using an LLM, catching policy violations before state transitions complete.

### What is a constraint file?

A constraint file is a Markdown document that describes rules your entities must satisfy. TraceWeaver sends the entity's full context plus the constraint document to the LLM and receives a structured pass/fail verdict.

### Example constraint file

```markdown
<!-- .traceweaver/constraints/task-done.md -->

# Task Completion Constraints

## Rules

1. A task MUST have an `assignee` attribute set before moving to `review`.
2. A task MUST NOT move to `completed` if its parent plan is still `pending`.
3. A task title MUST NOT be empty or generic (e.g., "Untitled", "TODO").

## Instructions

Evaluate the entity context below against the rules above.
Return JSON: { "pass": boolean, "violations": string[] }
```

### Linking constraints to entities

```bash
tw update task-hero --attr constraint=".traceweaver/constraints/task-done.md"
```

Or via the API:

```bash
curl -s -X PATCH http://localhost:4000/entities/task-hero/attrs \
  -H "Content-Type: application/json" \
  -d '{"constraint":".traceweaver/constraints/task-done.md"}' | jq
```

### Required environment variable

```bash
export TW_ANTHROPIC_API_KEY=sk-ant-...
```

Without this variable, constraint evaluation is skipped and a warning is logged.

---

## OpenTelemetry Export

TraceWeaver emits OpenTelemetry spans for every entity lifecycle event.

### Span lifecycle

| Span event | Triggered when |
|------------|---------------|
| `entity.created` | Entity is registered |
| `entity.state_changed` | State transition succeeds |
| `entity.attribute_updated` | Attributes are modified |
| `entity.removed` | Entity is deleted |

Each span carries attributes: `entity.id`, `entity.kind`, `entity.state`, `entity.parent_id`.

### OTLP HTTP export

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_SERVICE_NAME=traceweaver
tw daemon
```

TraceWeaver uses the OTLP/HTTP exporter by default. Point it at any OTLP-compatible collector (Jaeger, Grafana Tempo, Honeycomb, etc.).

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP collector endpoint |
| `OTEL_SERVICE_NAME` | `traceweaver` | Service name in traces |
| `OTEL_TRACES_SAMPLER` | `always_on` | Sampling strategy |

---

## Examples

All examples live in `examples/src/` and can be run directly from the repo root.

| File | Category | Demonstrates | Run |
|------|----------|-------------|-----|
| `01-basic-entity-lifecycle.ts` | Basic | Register → update → complete a task | `npm run example:01` |
| `02-basic-events.ts` | Basic | EventBus subscribe/publish patterns | `npm run example:02` |
| `03-basic-dag-dependencies.ts` | Basic | DAG with `depends_on` links | `npm run example:03` |
| `04-full-flow-research-project.ts` | Full Flow | Complete R&D project simulation end-to-end | `npm run example:04` |
| `05-full-flow-notify-engine.ts` | Full Flow | Notification rules + local inbox delivery | `npm run example:05` |
| `06-full-flow-constraint-validation.ts` | Full Flow | LLM-powered constraint checking on transitions | `npm run example:06` |
| `07-edge-invalid-transitions.ts` | Edge Case | `TransitionError` handling for illegal moves | `npm run example:07` |
| `08-edge-propagation-bubble-up.ts` | Edge Case | Automatic parent state propagation from children | `npm run example:08` |
| `09-edge-ring-buffer-overflow.ts` | Edge Case | Ring buffer circular overflow under high event volume | `npm run example:09` |
| `10-edge-wal-recovery.ts` | Edge Case | WAL-based crash recovery restoring consistent state | `npm run example:10` |

You can also run any example directly without npm scripts:

```bash
npx tsx examples/src/01-basic-entity-lifecycle.ts
```

---

## Troubleshooting

### Daemon not starting

**Symptom:** `tw` commands hang or return "daemon unavailable".

**Steps:**

1. Check whether the daemon process is running:
   ```bash
   ps aux | grep tw
   ```
2. Start it explicitly:
   ```bash
   tw daemon &
   ```
3. Check logs in `.traceweaver/daemon.log`.

---

### Socket already in use

**Symptom:** `Error: EADDRINUSE — address already in use`.

**Steps:**

1. Identify the process holding the socket:
   ```bash
   lsof -i :<port>
   ```
2. Kill it:
   ```bash
   kill -9 <PID>
   ```
3. Remove the stale socket file if present:
   ```bash
   rm -f /tmp/traceweaver.sock
   ```

---

### WAL corruption recovery

**Symptom:** Startup fails with `WAL checksum mismatch` or entities appear missing.

**Steps:**

1. Run the recovery example to understand the WAL repair process:
   ```bash
   npm run example:10
   ```
2. Trigger manual WAL recovery:
   ```bash
   tw recover --wal .traceweaver/wal.log
   ```
3. If recovery fails, restore from the last clean snapshot in `.traceweaver/snapshots/`.

---

## Next Steps

- Browse the [examples/](../examples/src/) directory for runnable code covering every major feature.
- Read the architecture overview in [docs/ARCHITECTURE.md](./ARCHITECTURE.md) (if present).
- Explore the [packages/](../packages/) directory to understand the module boundaries (`core`, `cli`, `http`, `mcp`, `notify`, `otel`).
- File issues or contribute at the project repository.
