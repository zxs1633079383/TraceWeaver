# Quick Start Guide

[中文版](./QUICKSTART.zh-CN.md)

TraceWeaver is a lightweight, local-first entity tracking system for AI-assisted dev workflows. It includes a state machine, event bus, DAG dependencies, notification engine, and OpenTelemetry export — all backed by an append-only WAL, accessible via CLI, programmatic API, MCP Server, or HTTP.

---

## Prerequisites

- **Node.js** v18+
- **npm** v9+ (workspaces support)

---

## Install

```bash
git clone https://github.com/anthropics/traceweaver.git
cd traceweaver
npm install
npm run build
```

Optional global CLI install:

```bash
npm install -g .
# Or use: npx tw <command>
```

---

## Core Concepts

### Entities

Every work unit in TraceWeaver is an **entity** with three built-in types:

| Type | Purpose |
|------|---------|
| `usecase` | High-level goal or project |
| `plan` | Execution plan under a usecase |
| `task` | Atomic work item under a plan |

Entities form a parent-child tree: `usecase` -> `plan` -> `task`.

### State Machine

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
| `completed` | — (terminal) |
| `rejected` | — (terminal) |

Invalid transitions throw `TransitionError`.

### Event Bus

Every state change emits a typed event to the in-process `EventBus`. Events are persisted to WAL for query and replay.

### DAG Dependencies

Entities can declare `depends_on` relationships. TraceWeaver tracks the resulting DAG and reports which entities are blocked.

---

## Step 1: Start the Daemon

```bash
tw daemon start
tw status
```

Expected output:

```
total: 0  pending: 0  in_progress: 0  review: 0  completed: 0  rejected: 0
```

---

## Step 2: Register Entities

```bash
tw register usecase blog-v2 --prd docs/prd.md
tw register plan plan-frontend --parent blog-v2 --domain frontend
tw register task task-hero --parent plan-frontend
```

Check status:

```bash
tw status
tw status --json
```

---

## Step 3: State Transitions

```bash
tw update task-hero --state in_progress
tw update task-hero --state review
tw update task-hero --state completed
```

Output:

```
task-hero: pending -> in_progress
task-hero: in_progress -> review
task-hero: review -> completed
```

---

## Step 4: Event Log

Events are persisted to NDJSON and survive daemon restarts.

```bash
# Query recent events
tw log query --since 1h

# Filter by entity
tw log query --since 1h --entity blog-v2

# Filter by event type
tw log query --since 1h --type state_changed

# Live event stream (Ctrl+C to exit)
tw watch --json
```

---

## Step 5: Metrics

Derived directly from OTel spans — no extra setup.

```bash
tw metrics
tw metrics --type task --window 24 --json
```

Includes: cycle time, failure rate, throughput.

---

## Step 6: Trace Query

```bash
# Span tree visualization
tw trace spans --entity-id blog-v2

# Full trace info with AI context
tw trace info --entity-id blog-v2 --json
```

The `_ai_context` field tells AI Agents what to do next:

```json
{
  "one_line": "3 entities: 2 completed, task-blocked waiting",
  "next_actions": ["task-blocked: waiting for upstream to complete"],
  "error_refs": ["events.ndjson -> entity_id=task-blocked"]
}
```

---

## Step 7: Daily Reports

```bash
tw report daily --all
tw report list --date 2026-03-26
tw report show --date 2026-03-26
```

Reports are atomic-written Markdown files with entity summaries, span trees, and AI context.

---

## Step 8: Dependencies & Impact

```bash
# View dependency graph
tw dag

# Impact analysis: which entities are affected by a file change?
tw impact src/auth.ts --json
```

---

## Step 9: Notifications

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

## What's Next

- **CLI Reference** — `tw --help` or `tw <command> --help`
- **Examples** — see [`examples/src/`](./examples/src/):
  - `01-basic-entity-lifecycle.ts` — Basic lifecycle
  - `11-full-chain-autonomous-loop.ts` — Full observability loop
  - `14-trace-report-e2e.ts` — Trace + Report E2E
- **HTTP API** — `TW_HTTP_PORT=4321 tw daemon start`
- **MCP Server** — `TW_MCP_STDIO=1 tw daemon --mcp`

---

## Troubleshooting

### Daemon not starting

```bash
ps aux | grep tw
tw daemon start
# Check logs: .traceweaver/daemon.log
```

### Socket in use

```bash
rm -f .traceweaver/tw.sock
tw daemon start
```

### WAL recovery

```bash
npm run run:10 --workspace=examples   # WAL recovery demo
```
