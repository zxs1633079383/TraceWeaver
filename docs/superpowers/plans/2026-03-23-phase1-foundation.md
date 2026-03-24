# TraceWeaver Phase 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the core state engine, file system store, IPC protocol, and basic CLI/Daemon that gives TraceWeaver a fully working, testable foundation — register entities, update state, query status, with WAL-backed persistence and proper state machine guards.

**Architecture:** Two npm workspace packages (`tw-daemon`, `tw-cli`) connected via Unix Socket + NDJSON IPC. Daemon owns all state: state machine, entity registry, DAG, WAL, and YAML store. CLI is a stateless thin client that sends commands over IPC and formats output.

**Tech Stack:** TypeScript 5, Node.js 20+, npm workspaces, Vitest, Commander.js, js-yaml, uuid, tsx (for daemon dev spawn)

**Spec:** `docs/superpowers/specs/2026-03-23-traceweaver-design.md`

---

## Phasing Overview

This is Phase 1 of 4. Each phase ships working software.

| Phase | Scope |
|---|---|
| **1 (this)** | Foundation: state machine, fs-store, WAL, IPC, basic CLI |
| 2 | OTel + Event System + Propagation (Worker threads, Ring Buffer, Spans) |
| 3 | Agent Interfaces: full MCP Server + HTTP API |
| 4 | Notify + FS Watcher + Constraint System (AI-interpreted) |

---

## File Map

```
traceweaver/
├── package.json                                     # npm workspaces root
├── tsconfig.base.json                               # shared TS config
├── vitest.workspace.ts                              # vitest workspace config
│
├── packages/
│   ├── tw-types/                                    # shared types (no runtime deps)
│   │   ├── package.json
│   │   ├── src/index.ts                             # all shared types + constants
│   │   └── tsconfig.json
│   │
│   ├── tw-daemon/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts                             # daemon entry: spawn, socket listen, idle watchdog
│   │   │   ├── ipc-server.ts                        # Unix Socket NDJSON server
│   │   │   ├── core/
│   │   │   │   ├── engine/
│   │   │   │   │   ├── state-machine.ts             # transition table + assertTransition guard
│   │   │   │   │   ├── state-machine.test.ts
│   │   │   │   │   ├── entity-registry.ts           # in-memory CRUD for entities
│   │   │   │   │   ├── entity-registry.test.ts
│   │   │   │   │   ├── dag.ts                       # DAG: add node/edge, topo sort, dependents
│   │   │   │   │   └── dag.test.ts
│   │   │   │   ├── fs-store/
│   │   │   │   │   ├── wal.ts                       # append-only NDJSON WAL + replay
│   │   │   │   │   ├── wal.test.ts
│   │   │   │   │   ├── store.ts                     # YAML read/write for entities
│   │   │   │   │   ├── store.test.ts
│   │   │   │   │   ├── cache.ts                     # in-memory hot cache with invalidation
│   │   │   │   │   └── cache.test.ts
│   │   │   │   ├── command-handler.ts               # unified dispatch: register/update/remove/get
│   │   │   │   └── command-handler.test.ts
│   │   │   └── ipc-server.test.ts
│   │   └── tsconfig.json
│   │
│   └── tw-cli/
│       ├── package.json
│       ├── bin/tw                                   # executable shebang wrapper
│       ├── src/
│       │   ├── index.ts                             # Commander.js root + command registration
│       │   ├── ipc-client.ts                        # Unix Socket NDJSON client + timeout
│       │   ├── ipc-client.test.ts
│       │   ├── daemon-manager.ts                    # spawn daemon, PID file, socket path
│       │   ├── daemon-manager.test.ts
│       │   ├── commands/
│       │   │   ├── register.ts                      # tw register usecase/plan/task
│       │   │   ├── update.ts                        # tw update <id> --state / --attr
│       │   │   ├── status.ts                        # tw status [id] [--tree]
│       │   │   ├── daemon.ts                        # tw daemon start/stop/status
│       │   │   └── sync.ts                          # tw sync (flush + stop hook)
│       │   └── output/
│       │       └── formatter.ts                     # table, tree, JSON output
│       └── tsconfig.json
```

---

## Task 1: Monorepo Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `packages/tw-types/package.json`
- Create: `packages/tw-daemon/package.json`
- Create: `packages/tw-cli/package.json`
- Create: `packages/tw-types/vitest.config.ts`
- Create: `packages/tw-daemon/vitest.config.ts`
- Create: `packages/tw-cli/vitest.config.ts`

- [ ] **Step 1: Create root package.json with workspaces**

```json
{
  "name": "traceweaver",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "npm run build --workspaces",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit --project tsconfig.base.json"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.6.0",
    "@types/node": "^20.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist"
  }
}
```

- [ ] **Step 3: Create vitest.workspace.ts**

```typescript
import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  'packages/tw-daemon/vitest.config.ts',
  'packages/tw-types/vitest.config.ts',
  'packages/tw-cli/vitest.config.ts',
])
```

- [ ] **Step 3b: Create per-package vitest.config.ts files**

Each package needs its own config so `defineWorkspace` can discover it.

```typescript
// packages/tw-daemon/vitest.config.ts  (same pattern for tw-types and tw-cli)
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
```

Create the same file (adjusting the package name in the comment) for `packages/tw-types/vitest.config.ts` and `packages/tw-cli/vitest.config.ts`.

- [ ] **Step 4: Create packages/tw-types/package.json**

```json
{
  "name": "@traceweaver/types",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "build": "tsc" },
  "devDependencies": { "typescript": "*" }
}
```

- [ ] **Step 5: Create packages/tw-daemon/package.json**

```json
{
  "name": "@traceweaver/daemon",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "@traceweaver/types": "*",
    "js-yaml": "^4.1.0",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "typescript": "*",
    "vitest": "*",
    "tsx": "^4.0.0",
    "@types/js-yaml": "^4.0.9",
    "@types/uuid": "^9.0.0"
  }
}
```

- [ ] **Step 6: Create packages/tw-cli/package.json**

```json
{
  "name": "@traceweaver/cli",
  "version": "0.1.0",
  "type": "module",
  "bin": { "tw": "./bin/tw" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@traceweaver/types": "*",
    "commander": "^12.0.0",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "typescript": "*",
    "vitest": "*",
    "tsx": "^4.0.0",
    "@types/node": "*",
    "@types/uuid": "^9.0.0"
  }
}
```

> **Note:** Package name is `@traceweaver/cli` (not `traceweaver`). The `bin` field publishes `tw` as a command but the npm package name is scoped. To install globally: `npm i -g @traceweaver/cli` then run `tw`.

- [ ] **Step 7: Install dependencies**

```bash
npm install
```

Expected: workspace packages linked, node_modules populated.

- [ ] **Step 8: Verify workspace links**

```bash
ls node_modules/@traceweaver/
```

Expected: `types`, `daemon` symlinks present.

- [ ] **Step 9: Commit**

```bash
git init
git add package.json tsconfig.base.json vitest.workspace.ts packages/
git commit -m "chore: scaffold monorepo with npm workspaces"
```

---

## Task 2: Shared Types

**Files:**
- Create: `packages/tw-types/src/index.ts`
- Create: `packages/tw-types/tsconfig.json`

- [ ] **Step 1: Create tsconfig.json for tw-types**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 2: Create all shared types**

```typescript
// packages/tw-types/src/index.ts

// ─── Entity ────────────────────────────────────────────────────────────────

export type EntityType = 'usecase' | 'plan' | 'task'

export type EntityState =
  | 'pending'
  | 'in_progress'
  | 'review'
  | 'completed'
  | 'rejected'

export type UsecaseMutation = 'new' | 'replace' | 'modify' | 'append'

export interface ArtifactRef {
  type: string   // prd | design | code | test
  path: string
  section?: string
}

export interface Entity {
  id: string
  entity_type: EntityType
  state: EntityState
  parent_id?: string
  domain?: string           // plan only
  depends_on?: string[]
  artifact_refs?: ArtifactRef[]
  constraint_refs?: string[]
  attributes?: Record<string, unknown>
  created_at: string        // ISO8601
  updated_at: string        // ISO8601
}

// ─── State machine ────────────────────────────────────────────────────────

export class TransitionError extends Error {
  readonly code = 'INVALID_TRANSITION'
  constructor(from: EntityState, to: EntityState) {
    super(`Cannot transition from ${from} to ${to}`)
    this.name = 'TransitionError'
  }
}

// ─── IPC protocol ─────────────────────────────────────────────────────────

export interface TwRequest {
  request_id: string
  method: string
  params: Record<string, unknown>
}

export type TwResponse<T = unknown> =
  | { request_id: string; ok: true;  data: T }
  | { request_id: string; ok: false; error: { code: string; message: string } }

// ─── Commands ─────────────────────────────────────────────────────────────

export interface RegisterParams {
  entity_type: EntityType
  id: string
  parent_id?: string
  domain?: string
  depends_on?: string[]
  artifact_refs?: ArtifactRef[]
  constraint_refs?: string[]
  attributes?: Record<string, unknown>
}

export interface UpdateStateParams {
  id: string
  state: EntityState
  reason?: string
}

export interface UpdateAttributesParams {
  id: string
  attributes: Record<string, unknown>
}

export interface GetStatusParams {
  id?: string
  format?: 'summary' | 'tree'
}

// ─── WAL ──────────────────────────────────────────────────────────────────

export interface WalEntry {
  seq: number
  op: 'upsert_entity' | 'update_state' | 'update_attributes' | 'remove_entity'
  idempotency_key: string
  payload: Record<string, unknown>
  ts: string  // ISO8601
}

// ─── Project state ────────────────────────────────────────────────────────

export interface ProjectMeta {
  id: string
  name: string
  created_at: string
}

export interface Progress {
  done: number
  total: number
  percent: number
}
```

- [ ] **Step 3: Verify types compile**

```bash
cd packages/tw-types && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/tw-types/
git commit -m "feat: add shared types package (tw-types)"
```

---

## Task 3: State Machine

**Files:**
- Create: `packages/tw-daemon/src/core/engine/state-machine.ts`
- Create: `packages/tw-daemon/src/core/engine/state-machine.test.ts`
- Create: `packages/tw-daemon/tsconfig.json`

- [ ] **Step 1: Create tsconfig.json for tw-daemon**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 2: Write failing tests**

```typescript
// packages/tw-daemon/src/core/engine/state-machine.test.ts
import { describe, it, expect } from 'vitest'
import { canTransition, assertTransition, ALLOWED_TRANSITIONS } from './state-machine.js'
import { TransitionError } from '@traceweaver/types'

describe('canTransition', () => {
  it('allows pending → in_progress', () => {
    expect(canTransition('pending', 'in_progress')).toBe(true)
  })
  it('allows in_progress → review', () => {
    expect(canTransition('in_progress', 'review')).toBe(true)
  })
  it('allows in_progress → rejected', () => {
    expect(canTransition('in_progress', 'rejected')).toBe(true)
  })
  it('allows review → completed', () => {
    expect(canTransition('review', 'completed')).toBe(true)
  })
  it('allows review → rejected', () => {
    expect(canTransition('review', 'rejected')).toBe(true)
  })
  it('allows rejected → in_progress', () => {
    expect(canTransition('rejected', 'in_progress')).toBe(true)
  })
  it('allows completed → rejected (post-hoc review)', () => {
    expect(canTransition('completed', 'rejected')).toBe(true)
  })
  it('rejects pending → completed', () => {
    expect(canTransition('pending', 'completed')).toBe(false)
  })
  it('rejects pending → rejected', () => {
    expect(canTransition('pending', 'rejected')).toBe(false)
  })
  it('rejects completed → pending', () => {
    expect(canTransition('completed', 'pending')).toBe(false)
  })
  it('rejects same-state transition', () => {
    expect(canTransition('in_progress', 'in_progress')).toBe(false)
  })
})

describe('assertTransition', () => {
  it('returns target state on valid transition', () => {
    expect(assertTransition('pending', 'in_progress')).toBe('in_progress')
  })
  it('throws TransitionError on invalid transition', () => {
    expect(() => assertTransition('pending', 'completed')).toThrow(TransitionError)
  })
  it('thrown error has code INVALID_TRANSITION', () => {
    try {
      assertTransition('pending', 'completed')
    } catch (e) {
      expect((e as TransitionError).code).toBe('INVALID_TRANSITION')
    }
  })
})
```

- [ ] **Step 3: Run test — verify it fails**

```bash
cd packages/tw-daemon && npx vitest run src/core/engine/state-machine.test.ts
```

Expected: FAIL — `state-machine.ts` not found.

- [ ] **Step 4: Implement state machine**

```typescript
// packages/tw-daemon/src/core/engine/state-machine.ts
import type { EntityState } from '@traceweaver/types'
import { TransitionError } from '@traceweaver/types'

export const ALLOWED_TRANSITIONS: Readonly<Record<EntityState, EntityState[]>> = {
  pending:     ['in_progress'],
  in_progress: ['review', 'rejected'],
  review:      ['completed', 'rejected'],
  completed:   ['rejected'],
  rejected:    ['in_progress'],
}

export function canTransition(from: EntityState, to: EntityState): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false
}

export function assertTransition(from: EntityState, to: EntityState): EntityState {
  if (!canTransition(from, to)) throw new TransitionError(from, to)
  return to
}
```

- [ ] **Step 5: Run test — verify it passes**

```bash
cd packages/tw-daemon && npx vitest run src/core/engine/state-machine.test.ts
```

Expected: all 11 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/tw-daemon/
git commit -m "feat: implement state machine with transition guards"
```

---

## Task 4: Entity Registry

**Files:**
- Create: `packages/tw-daemon/src/core/engine/entity-registry.ts`
- Create: `packages/tw-daemon/src/core/engine/entity-registry.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/tw-daemon/src/core/engine/entity-registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { EntityRegistry } from './entity-registry.js'
import { TransitionError } from '@traceweaver/types'

let registry: EntityRegistry

beforeEach(() => { registry = new EntityRegistry() })

describe('register', () => {
  it('registers a usecase', () => {
    const e = registry.register({ entity_type: 'usecase', id: 'UC-001' })
    expect(e.id).toBe('UC-001')
    expect(e.state).toBe('pending')
    expect(e.entity_type).toBe('usecase')
  })

  it('registers a plan with parent', () => {
    registry.register({ entity_type: 'usecase', id: 'UC-001' })
    const plan = registry.register({
      entity_type: 'plan', id: 'FE-PLAN', parent_id: 'UC-001', domain: 'frontend',
    })
    expect(plan.parent_id).toBe('UC-001')
  })

  it('throws on duplicate id', () => {
    registry.register({ entity_type: 'usecase', id: 'UC-001' })
    expect(() => registry.register({ entity_type: 'usecase', id: 'UC-001' }))
      .toThrow('DUPLICATE_ID')
  })

  it('throws when parent_id not found', () => {
    expect(() =>
      registry.register({ entity_type: 'plan', id: 'FE-PLAN', parent_id: 'MISSING' })
    ).toThrow('PARENT_NOT_FOUND')
  })
})

describe('updateState', () => {
  it('transitions state via guard', () => {
    registry.register({ entity_type: 'usecase', id: 'UC-001' })
    const updated = registry.updateState('UC-001', 'in_progress')
    expect(updated.state).toBe('in_progress')
  })

  it('throws TransitionError on invalid transition', () => {
    registry.register({ entity_type: 'usecase', id: 'UC-001' })
    expect(() => registry.updateState('UC-001', 'completed')).toThrow(TransitionError)
  })

  it('throws when entity not found', () => {
    expect(() => registry.updateState('MISSING', 'in_progress')).toThrow('ENTITY_NOT_FOUND')
  })
})

describe('updateAttributes', () => {
  it('merges attributes', () => {
    registry.register({ entity_type: 'usecase', id: 'UC-001', attributes: { a: 1 } })
    const updated = registry.updateAttributes('UC-001', { b: 2 })
    expect(updated.attributes).toEqual({ a: 1, b: 2 })
  })
})

describe('remove', () => {
  it('removes entity', () => {
    registry.register({ entity_type: 'usecase', id: 'UC-001' })
    registry.remove('UC-001')
    expect(registry.get('UC-001')).toBeUndefined()
  })
})

describe('getChildrenOf', () => {
  it('returns direct children', () => {
    registry.register({ entity_type: 'usecase', id: 'UC-001' })
    registry.register({ entity_type: 'plan', id: 'FE-PLAN', parent_id: 'UC-001' })
    registry.register({ entity_type: 'plan', id: 'BE-PLAN', parent_id: 'UC-001' })
    expect(registry.getChildrenOf('UC-001').map(e => e.id)).toEqual(['FE-PLAN', 'BE-PLAN'])
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd packages/tw-daemon && npx vitest run src/core/engine/entity-registry.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement entity registry**

```typescript
// packages/tw-daemon/src/core/engine/entity-registry.ts
import { v4 as uuidv4 } from 'uuid'
import type { Entity, EntityState, RegisterParams } from '@traceweaver/types'
import { assertTransition } from './state-machine.js'

class RegistryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RegistryError'
  }
}

export class EntityRegistry {
  private readonly entities = new Map<string, Entity>()

  register(params: RegisterParams): Entity {
    if (this.entities.has(params.id)) {
      throw new RegistryError('DUPLICATE_ID', `Entity ${params.id} already exists`)
    }
    if (params.parent_id && !this.entities.has(params.parent_id)) {
      throw new RegistryError('PARENT_NOT_FOUND', `Parent ${params.parent_id} not found`)
    }
    const now = new Date().toISOString()
    const entity: Entity = {
      ...params,
      state: 'pending',
      created_at: now,
      updated_at: now,
    }
    this.entities.set(entity.id, entity)
    return { ...entity }
  }

  updateState(id: string, to: EntityState, _reason?: string): Entity {
    const entity = this.entities.get(id)
    if (!entity) throw new RegistryError('ENTITY_NOT_FOUND', `Entity ${id} not found`)
    const newState = assertTransition(entity.state, to)
    const updated = { ...entity, state: newState, updated_at: new Date().toISOString() }
    this.entities.set(id, updated)
    return { ...updated }
  }

  updateAttributes(id: string, attrs: Record<string, unknown>): Entity {
    const entity = this.entities.get(id)
    if (!entity) throw new RegistryError('ENTITY_NOT_FOUND', `Entity ${id} not found`)
    const updated = {
      ...entity,
      attributes: { ...entity.attributes, ...attrs },
      updated_at: new Date().toISOString(),
    }
    this.entities.set(id, updated)
    return { ...updated }
  }

  remove(id: string): void {
    this.entities.delete(id)
  }

  get(id: string): Entity | undefined {
    const e = this.entities.get(id)
    return e ? { ...e } : undefined
  }

  getAll(): Entity[] {
    return Array.from(this.entities.values()).map(e => ({ ...e }))
  }

  getChildrenOf(parentId: string): Entity[] {
    return this.getAll().filter(e => e.parent_id === parentId)
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
cd packages/tw-daemon && npx vitest run src/core/engine/entity-registry.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tw-daemon/src/core/engine/
git commit -m "feat: implement entity registry with state machine integration"
```

---

## Task 5: DAG

**Files:**
- Create: `packages/tw-daemon/src/core/engine/dag.ts`
- Create: `packages/tw-daemon/src/core/engine/dag.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/tw-daemon/src/core/engine/dag.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { Dag } from './dag.js'

let dag: Dag

beforeEach(() => { dag = new Dag() })

describe('addNode / addEdge', () => {
  it('adds nodes and edges', () => {
    dag.addNode('A')
    dag.addNode('B')
    dag.addEdge('B', 'A') // B depends on A
    expect(dag.getDependencies('B')).toContain('A')
  })
})

describe('getDependents', () => {
  it('returns all nodes that depend on given node', () => {
    dag.addNode('A')
    dag.addNode('B')
    dag.addNode('C')
    dag.addEdge('B', 'A')
    dag.addEdge('C', 'A')
    expect(dag.getDependents('A').sort()).toEqual(['B', 'C'])
  })
})

describe('isReady', () => {
  it('returns true when all dependencies are in completed states', () => {
    const states = new Map([['A', 'completed'], ['B', 'pending']])
    dag.addNode('A')
    dag.addNode('B')
    dag.addEdge('B', 'A')
    expect(dag.isReady('B', states as Map<string, string>)).toBe(true)
  })

  it('returns false when a dependency is not completed', () => {
    const states = new Map([['A', 'in_progress'], ['B', 'pending']])
    dag.addNode('A')
    dag.addNode('B')
    dag.addEdge('B', 'A')
    expect(dag.isReady('B', states as Map<string, string>)).toBe(false)
  })
})

describe('detectCycle', () => {
  it('detects circular dependency', () => {
    dag.addNode('A')
    dag.addNode('B')
    dag.addEdge('A', 'B')
    expect(() => dag.addEdge('B', 'A')).toThrow('CYCLE_DETECTED')
  })
})

describe('removeNode', () => {
  it('removes node and its edges', () => {
    dag.addNode('A')
    dag.addNode('B')
    dag.addEdge('B', 'A')
    dag.removeNode('A')
    expect(dag.getDependencies('B')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd packages/tw-daemon && npx vitest run src/core/engine/dag.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement DAG**

```typescript
// packages/tw-daemon/src/core/engine/dag.ts

class DagError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'DagError'
  }
}

export class Dag {
  // node → set of dependency node ids (what it depends ON)
  private readonly deps = new Map<string, Set<string>>()

  addNode(id: string): void {
    if (!this.deps.has(id)) this.deps.set(id, new Set())
  }

  addEdge(from: string, to: string): void {
    // from depends on to
    if (!this.deps.has(from)) this.addNode(from)
    if (!this.deps.has(to))   this.addNode(to)
    if (this.wouldCycle(from, to)) {
      throw new DagError('CYCLE_DETECTED', `Adding edge ${from}→${to} creates a cycle`)
    }
    this.deps.get(from)!.add(to)
  }

  removeNode(id: string): void {
    this.deps.delete(id)
    for (const deps of this.deps.values()) deps.delete(id)
  }

  getDependencies(id: string): string[] {
    return Array.from(this.deps.get(id) ?? [])
  }

  getDependents(id: string): string[] {
    const result: string[] = []
    for (const [node, deps] of this.deps) {
      if (deps.has(id)) result.push(node)
    }
    return result
  }

  isReady(id: string, states: Map<string, string>): boolean {
    return this.getDependencies(id).every(dep => states.get(dep) === 'completed')
  }

  private wouldCycle(from: string, to: string): boolean {
    // BFS from `to` — if we can reach `from`, adding the edge creates a cycle
    const visited = new Set<string>()
    const queue = [to]
    while (queue.length > 0) {
      const node = queue.shift()!
      if (node === from) return true
      if (visited.has(node)) continue
      visited.add(node)
      for (const dep of this.deps.get(node) ?? []) queue.push(dep)
    }
    return false
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
cd packages/tw-daemon && npx vitest run src/core/engine/dag.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tw-daemon/src/core/engine/dag.ts packages/tw-daemon/src/core/engine/dag.test.ts
git commit -m "feat: implement DAG with cycle detection and dependency tracking"
```

---

## Task 6: WAL (Write-Ahead Log)

**Files:**
- Create: `packages/tw-daemon/src/core/fs-store/wal.ts`
- Create: `packages/tw-daemon/src/core/fs-store/wal.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/tw-daemon/src/core/fs-store/wal.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Wal } from './wal.js'

let tmpDir: string
let wal: Wal

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'tw-wal-test-'))
  wal = new Wal(join(tmpDir, '.wal'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true })
})

describe('append', () => {
  it('appends entries with sequential seq numbers', async () => {
    const e1 = await wal.append({ op: 'upsert_entity', idempotency_key: 'k1', payload: { id: 'A' } })
    const e2 = await wal.append({ op: 'upsert_entity', idempotency_key: 'k2', payload: { id: 'B' } })
    expect(e1.seq).toBe(1)
    expect(e2.seq).toBe(2)
  })
})

describe('replay', () => {
  it('returns all appended entries in order', async () => {
    await wal.append({ op: 'upsert_entity', idempotency_key: 'k1', payload: { id: 'A' } })
    await wal.append({ op: 'update_state',  idempotency_key: 'k2', payload: { id: 'A', state: 'in_progress' } })
    const entries = await wal.replay()
    expect(entries).toHaveLength(2)
    expect(entries[0].op).toBe('upsert_entity')
    expect(entries[1].op).toBe('update_state')
  })

  it('is idempotent — replaying same idempotency_key skips duplicate', async () => {
    await wal.append({ op: 'upsert_entity', idempotency_key: 'k1', payload: { id: 'A' } })
    await wal.append({ op: 'upsert_entity', idempotency_key: 'k1', payload: { id: 'A' } })
    const entries = await wal.replay()
    // Only one unique idempotency_key
    const keys = new Set(entries.map(e => e.idempotency_key))
    expect(keys.size).toBe(1)
  })

  it('returns empty array when WAL file does not exist', async () => {
    const fresh = new Wal(join(tmpDir, 'nonexistent.wal'))
    expect(await fresh.replay()).toEqual([])
  })
})

describe('truncate', () => {
  it('removes entries with seq <= given seq', async () => {
    await wal.append({ op: 'upsert_entity', idempotency_key: 'k1', payload: {} })
    await wal.append({ op: 'upsert_entity', idempotency_key: 'k2', payload: {} })
    await wal.append({ op: 'upsert_entity', idempotency_key: 'k3', payload: {} })
    await wal.truncate(2)
    const entries = await wal.replay()
    expect(entries).toHaveLength(1)
    expect(entries[0].idempotency_key).toBe('k3')
  })
})

describe('seq continuity after restart', () => {
  it('new Wal instance continues seq after highest existing seq', async () => {
    await wal.append({ op: 'upsert_entity', idempotency_key: 'k1', payload: {} })
    await wal.append({ op: 'upsert_entity', idempotency_key: 'k2', payload: {} })
    // seq is now 2

    // Simulate restart: fresh Wal instance pointing to same file
    const wal2 = new Wal(join(tmpDir, '.wal'))
    const entry = await wal2.append({ op: 'upsert_entity', idempotency_key: 'k3', payload: {} })
    // Must continue from seq=3, not restart at seq=1
    expect(entry.seq).toBe(3)
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd packages/tw-daemon && npx vitest run src/core/fs-store/wal.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement WAL**

```typescript
// packages/tw-daemon/src/core/fs-store/wal.ts
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { WalEntry } from '@traceweaver/types'

type AppendInput = Pick<WalEntry, 'op' | 'idempotency_key' | 'payload'>

export class Wal {
  private seq = 0
  private opened = false

  constructor(private readonly path: string) {}

  /**
   * MUST be called before any append(). Syncs the in-memory seq counter
   * with the highest seq found in the WAL file, preventing seq collisions
   * after a process restart.
   */
  async open(): Promise<void> {
    if (this.opened) return
    if (existsSync(this.path)) {
      const raw = await readFile(this.path, 'utf8')
      for (const line of raw.trim().split('\n').filter(Boolean)) {
        const entry = JSON.parse(line) as WalEntry
        if (entry.seq > this.seq) this.seq = entry.seq
      }
    }
    this.opened = true
  }

  async append(input: AppendInput): Promise<WalEntry> {
    if (!this.opened) await this.open()
    this.seq++
    const entry: WalEntry = {
      seq: this.seq,
      op: input.op,
      idempotency_key: input.idempotency_key,
      payload: input.payload,
      ts: new Date().toISOString(),
    }
    await appendFile(this.path, JSON.stringify(entry) + '\n', 'utf8')
    return entry
  }

  async replay(): Promise<WalEntry[]> {
    if (!existsSync(this.path)) return []
    const raw = await readFile(this.path, 'utf8')
    const lines = raw.trim().split('\n').filter(Boolean)
    const seen = new Set<string>()
    const entries: WalEntry[] = []
    for (const line of lines) {
      const entry = JSON.parse(line) as WalEntry
      if (!seen.has(entry.idempotency_key)) {
        seen.add(entry.idempotency_key)
        entries.push(entry)
        if (entry.seq > this.seq) this.seq = entry.seq
      }
    }
    return entries
  }

  async truncate(upToSeq: number): Promise<void> {
    const entries = await this.replay()
    const remaining = entries.filter(e => e.seq > upToSeq)
    await writeFile(
      this.path,
      remaining.map(e => JSON.stringify(e)).join('\n') + (remaining.length ? '\n' : ''),
      'utf8',
    )
    // Re-sync seq after truncation
    this.seq = remaining.length > 0 ? remaining[remaining.length - 1].seq : 0
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
cd packages/tw-daemon && npx vitest run src/core/fs-store/wal.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tw-daemon/src/core/fs-store/
git commit -m "feat: implement WAL with idempotent replay and truncation"
```

---

## Task 7: YAML Store

**Files:**
- Create: `packages/tw-daemon/src/core/fs-store/store.ts`
- Create: `packages/tw-daemon/src/core/fs-store/store.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/tw-daemon/src/core/fs-store/store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FsStore } from './store.js'
import type { Entity } from '@traceweaver/types'

let tmpDir: string
let store: FsStore

const entity: Entity = {
  id: 'UC-001', entity_type: 'usecase', state: 'pending',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'tw-store-test-'))
  store = new FsStore(tmpDir)
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true })
})

describe('writeEntity / readEntity', () => {
  it('writes and reads back an entity', async () => {
    await store.writeEntity(entity)
    const result = await store.readEntity('UC-001', 'usecase')
    expect(result).toMatchObject({ id: 'UC-001', state: 'pending' })
  })

  it('returns null when entity does not exist', async () => {
    expect(await store.readEntity('MISSING', 'usecase')).toBeNull()
  })
})

describe('listEntities', () => {
  it('lists all entities of a given type', async () => {
    await store.writeEntity(entity)
    await store.writeEntity({ ...entity, id: 'UC-002' })
    const list = await store.listEntities('usecase')
    expect(list.map(e => e.id).sort()).toEqual(['UC-001', 'UC-002'])
  })
})

describe('deleteEntity', () => {
  it('deletes entity file', async () => {
    await store.writeEntity(entity)
    await store.deleteEntity('UC-001', 'usecase')
    expect(await store.readEntity('UC-001', 'usecase')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd packages/tw-daemon && npx vitest run src/core/fs-store/store.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement YAML store**

```typescript
// packages/tw-daemon/src/core/fs-store/store.ts
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import type { Entity, EntityType } from '@traceweaver/types'

export class FsStore {
  constructor(private readonly root: string) {}

  private entityPath(id: string, type: EntityType): string {
    // Phase 1 layout (flat by type):
    //   usecases/UC-001/usecase.yaml
    //   plans/FE-PLAN/plan.yaml
    //   tasks/BE-001/task.yaml
    //
    // NOTE: This diverges from the spec's nested layout
    // (plans/tasks nested under their parent usecase directory).
    // The nested layout will be adopted in Phase 4 when FS Watcher
    // needs to watch specific parent paths. For Phase 1, flat-by-type
    // is simpler and the functional behavior is identical.
    const dir = type === 'usecase' ? 'usecases' : type === 'plan' ? 'plans' : 'tasks'
    return join(this.root, dir, id, `${type}.yaml`)
  }

  async writeEntity(entity: Entity): Promise<void> {
    const path = this.entityPath(entity.id, entity.entity_type)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, yaml.dump(entity), 'utf8')
  }

  async readEntity(id: string, type: EntityType): Promise<Entity | null> {
    const path = this.entityPath(id, type)
    if (!existsSync(path)) return null
    const raw = await readFile(path, 'utf8')
    return yaml.load(raw) as Entity
  }

  async listEntities(type: EntityType): Promise<Entity[]> {
    const dir = type === 'usecase' ? 'usecases' : type === 'plan' ? 'plans' : 'tasks'
    const base = join(this.root, dir)
    if (!existsSync(base)) return []
    const entries = await readdir(base, { withFileTypes: true })
    const results: Entity[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const entity = await this.readEntity(entry.name, type)
      if (entity) results.push(entity)
    }
    return results
  }

  async deleteEntity(id: string, type: EntityType): Promise<void> {
    const path = this.entityPath(id, type)
    if (existsSync(path)) await rm(path)
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
cd packages/tw-daemon && npx vitest run src/core/fs-store/store.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tw-daemon/src/core/fs-store/store.ts packages/tw-daemon/src/core/fs-store/store.test.ts
git commit -m "feat: implement YAML store for entity persistence"
```

---

## Task 8: In-Memory Cache

**Files:**
- Create: `packages/tw-daemon/src/core/fs-store/cache.ts`
- Create: `packages/tw-daemon/src/core/fs-store/cache.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/tw-daemon/src/core/fs-store/cache.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { EntityCache } from './cache.js'
import type { Entity } from '@traceweaver/types'

const e: Entity = {
  id: 'UC-001', entity_type: 'usecase', state: 'pending',
  created_at: '', updated_at: '',
}

let cache: EntityCache

beforeEach(() => { cache = new EntityCache() })

it('stores and retrieves an entity', () => {
  cache.set(e)
  expect(cache.get('UC-001')).toMatchObject({ id: 'UC-001' })
})

it('returns undefined for missing key', () => {
  expect(cache.get('MISSING')).toBeUndefined()
})

it('invalidates an entry', () => {
  cache.set(e)
  cache.invalidate('UC-001')
  expect(cache.get('UC-001')).toBeUndefined()
})

it('returns all entries', () => {
  cache.set(e)
  cache.set({ ...e, id: 'UC-002' })
  expect(cache.getAll()).toHaveLength(2)
})

it('clears all entries', () => {
  cache.set(e)
  cache.clear()
  expect(cache.getAll()).toHaveLength(0)
})
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd packages/tw-daemon && npx vitest run src/core/fs-store/cache.test.ts
```

- [ ] **Step 3: Implement cache**

```typescript
// packages/tw-daemon/src/core/fs-store/cache.ts
import type { Entity } from '@traceweaver/types'

export class EntityCache {
  private readonly store = new Map<string, Entity>()

  set(entity: Entity): void {
    this.store.set(entity.id, { ...entity })
  }

  get(id: string): Entity | undefined {
    const e = this.store.get(id)
    return e ? { ...e } : undefined
  }

  getAll(): Entity[] {
    return Array.from(this.store.values()).map(e => ({ ...e }))
  }

  invalidate(id: string): void {
    this.store.delete(id)
  }

  clear(): void {
    this.store.clear()
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
cd packages/tw-daemon && npx vitest run src/core/fs-store/cache.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/tw-daemon/src/core/fs-store/cache.ts packages/tw-daemon/src/core/fs-store/cache.test.ts
git commit -m "feat: implement in-memory entity cache"
```

---

## Task 9: Command Handler

**Files:**
- Create: `packages/tw-daemon/src/core/command-handler.ts`
- Create: `packages/tw-daemon/src/core/command-handler.test.ts`

This is the unified dispatch layer — wires together Registry, DAG, WAL, Store, and Cache.

- [ ] **Step 1: Write failing tests**

```typescript
// packages/tw-daemon/src/core/command-handler.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CommandHandler } from './command-handler.js'

let tmpDir: string
let handler: CommandHandler

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'tw-cmd-test-'))
  handler = new CommandHandler(tmpDir)
  await handler.init()
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true })
})

describe('register', () => {
  it('registers usecase and persists to store', async () => {
    const entity = await handler.register({ entity_type: 'usecase', id: 'UC-001' })
    expect(entity.id).toBe('UC-001')
    expect(entity.state).toBe('pending')
  })

  it('registers plan with parent usecase', async () => {
    await handler.register({ entity_type: 'usecase', id: 'UC-001' })
    const plan = await handler.register({
      entity_type: 'plan', id: 'BE-PLAN', parent_id: 'UC-001', domain: 'backend',
    })
    expect(plan.parent_id).toBe('UC-001')
  })
})

describe('updateState', () => {
  it('transitions state and writes WAL entry', async () => {
    await handler.register({ entity_type: 'usecase', id: 'UC-001' })
    const updated = await handler.updateState({ id: 'UC-001', state: 'in_progress' })
    expect(updated.state).toBe('in_progress')
  })

  it('rejects invalid transition with INVALID_TRANSITION', async () => {
    await handler.register({ entity_type: 'usecase', id: 'UC-001' })
    await expect(handler.updateState({ id: 'UC-001', state: 'completed' }))
      .rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
  })
})

describe('getStatus', () => {
  it('returns project summary when no id given', async () => {
    await handler.register({ entity_type: 'usecase', id: 'UC-001' })
    const status = await handler.getStatus({})
    expect(status.total).toBeGreaterThanOrEqual(1)
  })

  it('returns entity with children when id given', async () => {
    await handler.register({ entity_type: 'usecase', id: 'UC-001' })
    await handler.register({ entity_type: 'plan', id: 'FE-PLAN', parent_id: 'UC-001' })
    const status = await handler.getStatus({ id: 'UC-001' })
    expect(status.entity.id).toBe('UC-001')
  })
})

describe('init — WAL replay', () => {
  it('restores state from WAL on re-init', async () => {
    await handler.register({ entity_type: 'usecase', id: 'UC-001' })
    await handler.updateState({ id: 'UC-001', state: 'in_progress' })

    // Simulate crash: create fresh handler with same store dir
    const handler2 = new CommandHandler(tmpDir)
    await handler2.init()
    const status = await handler2.getStatus({ id: 'UC-001' })
    expect(status.entity.state).toBe('in_progress')
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd packages/tw-daemon && npx vitest run src/core/command-handler.test.ts
```

- [ ] **Step 3: Implement command handler**

```typescript
// packages/tw-daemon/src/core/command-handler.ts
import { join } from 'node:path'
import { EntityRegistry } from './engine/entity-registry.js'
import { Dag } from './engine/dag.js'
import { Wal } from './fs-store/wal.js'
import { FsStore } from './fs-store/store.js'
import { EntityCache } from './fs-store/cache.js'
import type {
  Entity, EntityType, RegisterParams, UpdateStateParams,
  UpdateAttributesParams, GetStatusParams
} from '@traceweaver/types'

export class CommandHandler {
  private readonly registry = new EntityRegistry()
  private readonly dag = new Dag()
  private readonly wal: Wal
  private readonly store: FsStore
  private readonly cache = new EntityCache()

  constructor(private readonly root: string) {
    this.wal   = new Wal(join(root, '.wal'))
    this.store = new FsStore(root)
  }

  async init(): Promise<void> {
    // Replay WAL to restore in-memory state
    const entries = await this.wal.replay()
    for (const entry of entries) {
      try {
        if (entry.op === 'upsert_entity') {
          const p = entry.payload as RegisterParams
          const entity = this.registry.register(p)
          if (p.depends_on?.length) {
            this.dag.addNode(p.id)
            for (const dep of p.depends_on) {
              this.dag.addNode(dep)
              this.dag.addEdge(p.id, dep)
            }
          }
          this.cache.set(entity)
        } else if (entry.op === 'update_state') {
          const p = entry.payload as UpdateStateParams
          const entity = this.registry.updateState(p.id, p.state, p.reason)
          this.cache.set(entity)
        } else if (entry.op === 'update_attributes') {
          const p = entry.payload as UpdateAttributesParams
          const entity = this.registry.updateAttributes(p.id, p.attributes)
          this.cache.set(entity)
        } else if (entry.op === 'remove_entity') {
          const { id, entity_type } = entry.payload as { id: string; entity_type: EntityType }
          this.registry.remove(id)
          this.dag.removeNode(id)
          this.cache.invalidate(id)
        }
      } catch {
        // Skip replay errors (e.g. duplicate registration)
      }
    }
  }

  async register(params: RegisterParams): Promise<Entity> {
    const entity = this.registry.register(params)
    if (params.depends_on?.length) {
      this.dag.addNode(params.id)
      for (const dep of params.depends_on) {
        this.dag.addNode(dep)
        this.dag.addEdge(params.id, dep)
      }
    }
    this.cache.set(entity)
    await this.wal.append({
      op: 'upsert_entity',
      idempotency_key: `register-${params.id}`,
      payload: params as unknown as Record<string, unknown>,
    })
    await this.store.writeEntity(entity)
    return entity
  }

  async updateState(params: UpdateStateParams): Promise<Entity> {
    const entity = this.registry.updateState(params.id, params.state, params.reason)
    this.cache.set(entity)
    await this.wal.append({
      op: 'update_state',
      idempotency_key: `update_state-${params.id}-${Date.now()}`,
      payload: params as unknown as Record<string, unknown>,
    })
    await this.store.writeEntity(entity)
    return entity
  }

  async updateAttributes(params: UpdateAttributesParams): Promise<Entity> {
    const entity = this.registry.updateAttributes(params.id, params.attributes)
    this.cache.set(entity)
    await this.wal.append({
      op: 'update_attributes',
      idempotency_key: `update_attrs-${params.id}-${Date.now()}`,
      payload: params as unknown as Record<string, unknown>,
    })
    await this.store.writeEntity(entity)
    return entity
  }

  async remove(id: string): Promise<void> {
    const entity = this.registry.get(id)
    if (!entity) return
    this.registry.remove(id)
    this.dag.removeNode(id)
    this.cache.invalidate(id)
    await this.wal.append({
      op: 'remove_entity',
      idempotency_key: `remove-${id}-${Date.now()}`,
      payload: { id, entity_type: entity.entity_type },
    })
  }

  async getStatus(params: GetStatusParams): Promise<any> {
    if (params.id) {
      const entity = this.cache.get(params.id) ?? this.registry.get(params.id)
      if (!entity) throw Object.assign(new Error(`Entity ${params.id} not found`), { code: 'ENTITY_NOT_FOUND' })
      const children = this.registry.getChildrenOf(params.id)
      return { entity, children }
    }
    const all = this.registry.getAll()
    const done = all.filter(e => e.state === 'completed').length
    return { total: all.length, done, percent: all.length ? Math.round(done / all.length * 100) : 0 }
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
cd packages/tw-daemon && npx vitest run src/core/command-handler.test.ts
```

Expected: all tests PASS including WAL replay test.

- [ ] **Step 5: Commit**

```bash
git add packages/tw-daemon/src/core/
git commit -m "feat: implement command handler wiring registry, DAG, WAL, store, cache"
```

---

## Task 10: IPC Server (Daemon Side)

**Files:**
- Create: `packages/tw-daemon/src/ipc-server.ts`
- Create: `packages/tw-daemon/src/ipc-server.test.ts`
- Create: `packages/tw-daemon/src/index.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/tw-daemon/src/ipc-server.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { createConnection } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IpcServer } from './ipc-server.js'
import { CommandHandler } from './core/command-handler.js'

let tmpDir: string
let server: IpcServer

async function startServer() {
  tmpDir = await mkdtemp(join(tmpdir(), 'tw-ipc-test-'))
  const handler = new CommandHandler(tmpDir)
  await handler.init()
  const socketPath = join(tmpDir, 'tw.sock')
  server = new IpcServer(socketPath, handler)
  await server.start()
  return { socketPath, handler }
}

async function sendRequest(socketPath: string, req: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath)
    let buf = ''
    client.on('data', (d) => {
      buf += d.toString()
      if (buf.includes('\n')) {
        resolve(JSON.parse(buf.trim()))
        client.destroy()
      }
    })
    client.on('error', reject)
    client.on('connect', () => {
      client.write(JSON.stringify(req) + '\n')
    })
  })
}

afterEach(async () => {
  await server?.stop()
  if (tmpDir) await rm(tmpDir, { recursive: true })
})

describe('IpcServer', () => {
  it('responds to register command', async () => {
    const { socketPath } = await startServer()
    const res = await sendRequest(socketPath, {
      request_id: 'r1',
      method: 'register',
      params: { entity_type: 'usecase', id: 'UC-001' },
    })
    expect(res.ok).toBe(true)
    expect(res.data.id).toBe('UC-001')
  })

  it('responds with error on invalid transition', async () => {
    const { socketPath } = await startServer()
    await sendRequest(socketPath, {
      request_id: 'r1', method: 'register', params: { entity_type: 'usecase', id: 'UC-001' },
    })
    const res = await sendRequest(socketPath, {
      request_id: 'r2', method: 'update_state', params: { id: 'UC-001', state: 'completed' },
    })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('INVALID_TRANSITION')
  })

  it('responds to unknown method with error', async () => {
    const { socketPath } = await startServer()
    const res = await sendRequest(socketPath, {
      request_id: 'r1', method: 'unknown_method', params: {},
    })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('UNKNOWN_METHOD')
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd packages/tw-daemon && npx vitest run src/ipc-server.test.ts
```

- [ ] **Step 3: Implement IPC server**

```typescript
// packages/tw-daemon/src/ipc-server.ts
import { createServer, type Server, type Socket } from 'node:net'
import { rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { TwRequest, TwResponse } from '@traceweaver/types'
import type { CommandHandler } from './core/command-handler.js'

export class IpcServer {
  private server: Server | null = null

  constructor(
    private readonly socketPath: string,
    private readonly handler: CommandHandler,
  ) {}

  async start(): Promise<void> {
    if (existsSync(this.socketPath)) await rm(this.socketPath)
    await new Promise<void>((resolve) => {
      this.server = createServer(socket => this.handleConnection(socket))
      this.server.listen(this.socketPath, resolve)
    })
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve())
    })
    if (existsSync(this.socketPath)) await rm(this.socketPath)
  }

  private handleConnection(socket: Socket): void {
    let buf = ''
    socket.on('data', async (chunk) => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const req = JSON.parse(line) as TwRequest
          const res = await this.dispatch(req)
          socket.write(JSON.stringify(res) + '\n')
        } catch (e) {
          socket.write(JSON.stringify({
            request_id: 'unknown',
            ok: false,
            error: { code: 'PARSE_ERROR', message: String(e) },
          }) + '\n')
        }
      }
    })
    socket.on('error', () => socket.destroy())
  }

  private async dispatch(req: TwRequest): Promise<TwResponse> {
    const { request_id, method, params } = req
    try {
      let data: unknown
      if (method === 'register') {
        data = await this.handler.register(params as any)
      } else if (method === 'update_state') {
        data = await this.handler.updateState(params as any)
      } else if (method === 'update_attributes') {
        data = await this.handler.updateAttributes(params as any)
      } else if (method === 'remove') {
        await this.handler.remove(params.id as string)
        data = { id: params.id }
      } else if (method === 'get_status') {
        data = await this.handler.getStatus(params as any)
      } else {
        throw Object.assign(new Error(`Unknown method: ${method}`), { code: 'UNKNOWN_METHOD' })
      }
      return { request_id, ok: true, data }
    } catch (e: any) {
      return { request_id, ok: false, error: { code: e.code ?? 'ERROR', message: e.message } }
    }
  }
}
```

- [ ] **Step 4: Create daemon entry point**

```typescript
// packages/tw-daemon/src/index.ts
import { join } from 'node:path'
import { writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { IpcServer } from './ipc-server.js'
import { CommandHandler } from './core/command-handler.js'

const STORE_DIR   = process.env.TW_STORE ?? join(process.cwd(), '.traceweaver')
const SOCKET_PATH = process.env.TW_SOCKET ?? join(STORE_DIR, 'tw.sock')
const PID_FILE    = join(STORE_DIR, 'daemon.pid')
const IDLE_MS     = 30 * 60 * 1000

let lastActivity = Date.now()

async function main() {
  const handler = new CommandHandler(STORE_DIR)
  await handler.init()

  const server = new IpcServer(SOCKET_PATH, handler)
  await server.start()

  await writeFile(PID_FILE, String(process.pid), 'utf8')

  console.log(`tw-daemon started. socket=${SOCKET_PATH} pid=${process.pid}`)

  // Idle watchdog
  const watchdog = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_MS) {
      console.log('tw-daemon idle timeout — shutting down')
      cleanup(server).catch(console.error)
    }
  }, 60_000)

  process.on('SIGTERM', () => cleanup(server).catch(console.error))
  process.on('SIGINT',  () => cleanup(server).catch(console.error))

  async function cleanup(s: IpcServer) {
    clearInterval(watchdog)
    await s.stop()
    if (existsSync(PID_FILE)) await rm(PID_FILE)
    process.exit(0)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
```

- [ ] **Step 5: Run IPC tests — verify they pass**

```bash
cd packages/tw-daemon && npx vitest run src/ipc-server.test.ts
```

Expected: all 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/tw-daemon/src/
git commit -m "feat: implement IPC server and daemon entry point"
```

---

## Task 11: IPC Client + Daemon Manager (CLI Side)

**Files:**
- Create: `packages/tw-cli/src/ipc-client.ts`
- Create: `packages/tw-cli/src/ipc-client.test.ts`
- Create: `packages/tw-cli/src/daemon-manager.ts`
- Create: `packages/tw-cli/tsconfig.json`

- [ ] **Step 1: Create tsconfig.json for tw-cli**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 2: Write failing tests**

```typescript
// packages/tw-cli/src/ipc-client.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IpcClient } from './ipc-client.js'

let tmpDir: string
let server: Server

async function startEchoServer(socketPath: string, response: object) {
  await new Promise<void>(resolve => {
    server = createServer(socket => {
      socket.on('data', () => {
        socket.write(JSON.stringify(response) + '\n')
      })
    })
    server.listen(socketPath, resolve)
  })
}

afterEach(async () => {
  server?.close()
  if (tmpDir) await rm(tmpDir, { recursive: true })
})

describe('IpcClient', () => {
  it('sends request and receives response', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tw-client-test-'))
    const socketPath = join(tmpDir, 'tw.sock')
    const expected = { request_id: 'r1', ok: true, data: { id: 'UC-001' } }
    await startEchoServer(socketPath, expected)

    const client = new IpcClient(socketPath)
    const res = await client.send({ method: 'register', params: { entity_type: 'usecase', id: 'UC-001' } })
    expect(res.ok).toBe(true)
  })

  it('times out when server does not respond', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tw-client-test-'))
    const socketPath = join(tmpDir, 'tw.sock')
    // server that never responds
    await new Promise<void>(resolve => {
      server = createServer(() => {})
      server.listen(socketPath, resolve)
    })
    const client = new IpcClient(socketPath, 100)
    await expect(client.send({ method: 'test', params: {} })).rejects.toThrow('timeout')
  })
})
```

- [ ] **Step 3: Run test — verify it fails**

```bash
cd packages/tw-cli && npx vitest run src/ipc-client.test.ts
```

- [ ] **Step 4: Implement IPC client**

```typescript
// packages/tw-cli/src/ipc-client.ts
import { createConnection } from 'node:net'
import { v4 as uuidv4 } from 'uuid'
import type { TwRequest, TwResponse } from '@traceweaver/types'

type SendInput = Pick<TwRequest, 'method' | 'params'>

export class IpcClient {
  // NOTE: Phase 1 uses a simple request-per-connection model (one socket per send()).
  // This means request_id matching is not needed — each connection gets exactly one response.
  // Phase 3 will upgrade to a persistent multiplexed connection with request_id correlation
  // when concurrent MCP + HTTP callers share the same daemon connection.
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async send<T = unknown>(input: SendInput): Promise<TwResponse<T>> {
    const request_id = uuidv4()
    const req: TwRequest = { request_id, ...input }

    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath)
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`IPC timeout after ${this.timeoutMs}ms`))
      }, this.timeoutMs)

      let buf = ''
      socket.on('data', (chunk) => {
        buf += chunk.toString()
        if (buf.includes('\n')) {
          clearTimeout(timer)
          try {
            resolve(JSON.parse(buf.trim()) as TwResponse<T>)
          } catch (e) {
            reject(e)
          } finally {
            socket.destroy()
          }
        }
      })
      socket.on('error', (e) => { clearTimeout(timer); reject(e) })
      socket.on('connect', () => socket.write(JSON.stringify(req) + '\n'))
    })
  }
}
```

- [ ] **Step 5: Implement daemon manager**

```typescript
// packages/tw-cli/src/daemon-manager.ts
import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function getStorePath(): string {
  return process.env.TW_STORE ?? join(process.cwd(), '.traceweaver')
}

export function getSocketPath(): string {
  return process.env.TW_SOCKET ?? join(getStorePath(), 'tw.sock')
}

export function getPidPath(): string {
  return join(getStorePath(), 'daemon.pid')
}

export async function isDaemonRunning(): Promise<boolean> {
  const pidFile = getPidPath()
  if (!existsSync(pidFile)) return false
  try {
    const pid = parseInt(await readFile(pidFile, 'utf8'), 10)
    process.kill(pid, 0)   // throws if process not running
    return true
  } catch {
    return false
  }
}

export async function ensureDaemonRunning(): Promise<void> {
  if (await isDaemonRunning()) return

  // Resolve daemon bin: prefer compiled dist/index.js, fall back to tsx for dev
  const daemonPkg  = join(__dirname, '../../tw-daemon')
  const daemonDist = join(daemonPkg, 'dist/index.js')
  const daemonSrc  = join(daemonPkg, 'src/index.ts')

  let spawnArgs: string[]
  if (existsSync(daemonDist)) {
    // Production: run compiled output directly
    spawnArgs = [daemonDist]
  } else {
    // Development: use tsx (fast TS runner, no loader flag needed)
    const tsxBin = join(__dirname, '../../../node_modules/.bin/tsx')
    spawnArgs = [tsxBin, daemonSrc]
  }

  const child = spawn(process.execPath, spawnArgs, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, TW_STORE: getStorePath() },
  })
  child.unref()

  // Wait for socket to appear (up to 5s)
  const socketPath = getSocketPath()
  const deadline = Date.now() + 5000
  while (!existsSync(socketPath) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100))
  }
  if (!existsSync(socketPath)) throw new Error('Daemon failed to start within 5s')
}

export async function stopDaemon(): Promise<void> {
  const pidFile = getPidPath()
  if (!existsSync(pidFile)) return
  const pid = parseInt(await readFile(pidFile, 'utf8'), 10)
  try { process.kill(pid, 'SIGTERM') } catch {}
  if (existsSync(pidFile)) await rm(pidFile)
}
```

- [ ] **Step 6: Run IPC client tests — verify they pass**

```bash
cd packages/tw-cli && npx vitest run src/ipc-client.test.ts
```

Expected: 2 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/tw-cli/
git commit -m "feat: implement IPC client and daemon manager"
```

---

## Task 12: CLI Commands

**Files:**
- Create: `packages/tw-cli/src/commands/register.ts`
- Create: `packages/tw-cli/src/commands/update.ts`
- Create: `packages/tw-cli/src/commands/status.ts`
- Create: `packages/tw-cli/src/commands/daemon.ts`
- Create: `packages/tw-cli/src/commands/sync.ts`
- Create: `packages/tw-cli/src/output/formatter.ts`
- Create: `packages/tw-cli/src/index.ts`
- Create: `packages/tw-cli/bin/tw`

- [ ] **Step 1: Create output formatter**

```typescript
// packages/tw-cli/src/output/formatter.ts
import type { Entity } from '@traceweaver/types'

const STATE_COLORS: Record<string, string> = {
  pending:     '\x1b[90m',  // gray
  in_progress: '\x1b[33m',  // yellow
  review:      '\x1b[36m',  // cyan
  completed:   '\x1b[32m',  // green
  rejected:    '\x1b[31m',  // red
}
const RESET = '\x1b[0m'

export function colorState(state: string): string {
  return `${STATE_COLORS[state] ?? ''}${state}${RESET}`
}

export function formatEntity(entity: Entity): string {
  return `${entity.id}  [${colorState(entity.state)}]  type=${entity.entity_type}`
}

export function formatTree(entity: Entity, children: Entity[], indent = 0): string {
  const prefix = '  '.repeat(indent)
  const lines = [`${prefix}${formatEntity(entity)}`]
  for (const child of children) lines.push(`${prefix}  └─ ${formatEntity(child)}`)
  return lines.join('\n')
}

export function formatSummary(total: number, done: number, percent: number): string {
  const bar = '█'.repeat(Math.round(percent / 5)) + '░'.repeat(20 - Math.round(percent / 5))
  return `Progress  [${bar}] ${percent}%  (${done}/${total} completed)`
}
```

- [ ] **Step 2: Create register command**

```typescript
// packages/tw-cli/src/commands/register.ts
import { Command } from 'commander'
import { IpcClient } from '../ipc-client.js'
import { ensureDaemonRunning, getSocketPath } from '../daemon-manager.js'
import { formatEntity } from '../output/formatter.js'

export function registerCommand(program: Command): void {
  const cmd = program.command('register')
  cmd.description('Register a UseCase, Plan, or Task')

  cmd.command('usecase <id>')
    .option('--prd <path>',    'Path to PRD artifact')
    .option('--design <path>', 'Path to design artifact')
    .option('--attr <k=v...>', 'Additional attributes', collect, [])
    .action(async (id: string, opts: any) => {
      await ensureDaemonRunning()
      const client = new IpcClient(getSocketPath())
      const artifact_refs = []
      if (opts.prd)    artifact_refs.push({ type: 'prd',    path: opts.prd })
      if (opts.design) artifact_refs.push({ type: 'design', path: opts.design })
      const res = await client.send({
        method: 'register',
        params: { entity_type: 'usecase', id, artifact_refs },
      })
      if (res.ok) console.log(formatEntity(res.data as any))
      else        { console.error(res.error.message); process.exit(1) }
    })

  cmd.command('plan <id>')
    .requiredOption('--parent <id>', 'Parent UseCase id')
    .option('--domain <domain>',     'Plan domain (frontend|backend|ui|qa|custom)')
    .option('--constraint <path...>','Constraint file refs')
    .action(async (id: string, opts: any) => {
      await ensureDaemonRunning()
      const client = new IpcClient(getSocketPath())
      const res = await client.send({
        method: 'register',
        params: { entity_type: 'plan', id, parent_id: opts.parent, domain: opts.domain,
                  constraint_refs: opts.constraint },
      })
      if (res.ok) console.log(formatEntity(res.data as any))
      else        { console.error(res.error.message); process.exit(1) }
    })

  cmd.command('task <id>')
    .requiredOption('--parent <id>',       'Parent Plan id')
    .option('--depends-on <ids...>',       'Dependency task ids')
    .option('--constraint <paths...>',     'Constraint file refs')
    .action(async (id: string, opts: any) => {
      await ensureDaemonRunning()
      const client = new IpcClient(getSocketPath())
      const res = await client.send({
        method: 'register',
        params: { entity_type: 'task', id, parent_id: opts.parent,
                  depends_on: opts.dependsOn, constraint_refs: opts.constraint },
      })
      if (res.ok) console.log(formatEntity(res.data as any))
      else        { console.error(res.error.message); process.exit(1) }
    })
}

function collect(val: string, prev: string[]) { prev.push(val); return prev }
```

- [ ] **Step 3: Create update command**

```typescript
// packages/tw-cli/src/commands/update.ts
import { Command } from 'commander'
import { IpcClient } from '../ipc-client.js'
import { ensureDaemonRunning, getSocketPath } from '../daemon-manager.js'
import { formatEntity } from '../output/formatter.js'

export function updateCommand(program: Command): void {
  program
    .command('update <id>')
    .description('Update entity state or attributes')
    .option('--state <state>',  'New state')
    .option('--reason <msg>',   'Reason (for rejected state)')
    .option('--attr <k=v...>',  'Attribute key=value pairs', collect, [])
    .action(async (id: string, opts: any) => {
      await ensureDaemonRunning()
      const client = new IpcClient(getSocketPath())

      if (opts.state) {
        const res = await client.send({
          method: 'update_state',
          params: { id, state: opts.state, reason: opts.reason },
        })
        if (res.ok) console.log(formatEntity(res.data as any))
        else        { console.error(res.error.message); process.exit(1) }
      } else if (opts.attr?.length) {
        const attributes: Record<string, string> = {}
        for (const kv of opts.attr as string[]) {
          const [k, v] = kv.split('=')
          attributes[k] = v
        }
        const res = await client.send({ method: 'update_attributes', params: { id, attributes } })
        if (res.ok) console.log(formatEntity(res.data as any))
        else        { console.error(res.error.message); process.exit(1) }
      } else {
        console.error('Specify --state or --attr')
        process.exit(1)
      }
    })
}

function collect(val: string, prev: string[]) { prev.push(val); return prev }
```

- [ ] **Step 4: Create status command**

```typescript
// packages/tw-cli/src/commands/status.ts
import { Command } from 'commander'
import { IpcClient } from '../ipc-client.js'
import { ensureDaemonRunning, getSocketPath } from '../daemon-manager.js'
import { formatTree, formatSummary } from '../output/formatter.js'

export function statusCommand(program: Command): void {
  program
    .command('status [id]')
    .description('Show project or entity status')
    .option('--tree', 'Show tree view with children')
    .option('--json', 'Output raw JSON')
    .action(async (id: string | undefined, opts: any) => {
      await ensureDaemonRunning()
      const client = new IpcClient(getSocketPath())
      const res = await client.send({ method: 'get_status', params: { id } })
      if (!res.ok) { console.error(res.error.message); process.exit(1) }

      if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); return }

      const data = res.data as any
      if (id) {
        console.log(formatTree(data.entity, data.children ?? []))
      } else {
        console.log(formatSummary(data.total, data.done, data.percent))
      }
    })
}
```

- [ ] **Step 5: Create daemon command**

```typescript
// packages/tw-cli/src/commands/daemon.ts
import { Command } from 'commander'
import { ensureDaemonRunning, isDaemonRunning, stopDaemon } from '../daemon-manager.js'

export function daemonCommand(program: Command): void {
  const cmd = program.command('daemon').description('Manage the TraceWeaver daemon')

  cmd.command('start').action(async () => {
    await ensureDaemonRunning()
    console.log('Daemon running.')
  })

  cmd.command('stop').action(async () => {
    await stopDaemon()
    console.log('Daemon stopped.')
  })

  cmd.command('status').action(async () => {
    const running = await isDaemonRunning()
    console.log(running ? 'Daemon: running' : 'Daemon: stopped')
  })
}
```

- [ ] **Step 6: Create sync command**

```typescript
// packages/tw-cli/src/commands/sync.ts
import { Command } from 'commander'
import { isDaemonRunning } from '../daemon-manager.js'

export function syncCommand(program: Command): void {
  program
    .command('sync')
    .description('Flush in-memory state to disk (used by Stop hook)')
    .action(async () => {
      // Phase 1: all writes are synchronous (WAL + YAML written on each command),
      // so there is no in-flight buffer to flush. This command is a no-op placeholder
      // that will gain real behavior in Phase 2 when the async write queue is introduced.
      if (!(await isDaemonRunning())) {
        process.exit(0)
      }
      // Daemon is running — nothing to flush in Phase 1, exit cleanly
      process.exit(0)
    })
}
```

- [ ] **Step 7: Create CLI entry point**

```typescript
// packages/tw-cli/src/index.ts
import { Command } from 'commander'
import { registerCommand } from './commands/register.js'
import { updateCommand }   from './commands/update.js'
import { statusCommand }   from './commands/status.js'
import { daemonCommand }   from './commands/daemon.js'
import { syncCommand }     from './commands/sync.js'

const program = new Command()
program
  .name('tw')
  .description('TraceWeaver — research process observability engine')
  .version('0.1.0')

registerCommand(program)
updateCommand(program)
statusCommand(program)
daemonCommand(program)
syncCommand(program)

program.parseAsync(process.argv).catch(e => { console.error(e); process.exit(1) })
```

- [ ] **Step 8: Create bin/tw executable**

```bash
#!/usr/bin/env node
import('../src/index.js')
```

Then make it executable:

```bash
chmod +x packages/tw-cli/bin/tw
```

- [ ] **Step 9: Commit**

```bash
git add packages/tw-cli/
git commit -m "feat: implement CLI commands (register, update, status, daemon, sync)"
```

---

## Task 13: End-to-End Integration Test

**Files:**
- Create: `packages/tw-cli/src/integration.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// packages/tw-cli/src/integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IpcServer } from '../../tw-daemon/src/ipc-server.js'
import { CommandHandler } from '../../tw-daemon/src/core/command-handler.js'
import { IpcClient } from './ipc-client.js'

let tmpDir: string
let server: IpcServer
let client: IpcClient

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'tw-e2e-test-'))
  const socketPath = join(tmpDir, 'tw.sock')
  const handler = new CommandHandler(tmpDir)
  await handler.init()
  server = new IpcServer(socketPath, handler)
  await server.start()
  client = new IpcClient(socketPath)
})

afterAll(async () => {
  await server.stop()
  await rm(tmpDir, { recursive: true })
})

describe('Full UseCase → Plan → Task lifecycle', () => {
  it('registers UseCase, Plan, Task', async () => {
    const uc = await client.send({ method: 'register', params: { entity_type: 'usecase', id: 'UC-E2E' } })
    expect((uc.data as any).state).toBe('pending')

    const plan = await client.send({
      method: 'register',
      params: { entity_type: 'plan', id: 'BE-PLAN-E2E', parent_id: 'UC-E2E', domain: 'backend' },
    })
    expect((plan.data as any).parent_id).toBe('UC-E2E')

    const task = await client.send({
      method: 'register',
      params: { entity_type: 'task', id: 'BE-TASK-001', parent_id: 'BE-PLAN-E2E' },
    })
    expect((task.data as any).state).toBe('pending')
  })

  it('progresses Task through lifecycle', async () => {
    let res = await client.send({ method: 'update_state', params: { id: 'BE-TASK-001', state: 'in_progress' } })
    expect((res.data as any).state).toBe('in_progress')

    res = await client.send({ method: 'update_state', params: { id: 'BE-TASK-001', state: 'review' } })
    expect((res.data as any).state).toBe('review')

    res = await client.send({ method: 'update_state', params: { id: 'BE-TASK-001', state: 'completed' } })
    expect((res.data as any).state).toBe('completed')
  })

  it('rejects illegal transition', async () => {
    const res = await client.send({ method: 'update_state', params: { id: 'UC-E2E', state: 'completed' } })
    expect(res.ok).toBe(false)
    expect((res as any).error.code).toBe('INVALID_TRANSITION')
  })

  it('simulates post-hoc rejection', async () => {
    const res = await client.send({
      method: 'update_state',
      params: { id: 'BE-TASK-001', state: 'rejected', reason: 'missing tests' },
    })
    expect((res.data as any).state).toBe('rejected')
  })

  it('queries project status', async () => {
    const res = await client.send({ method: 'get_status', params: {} })
    expect(res.ok).toBe(true)
    expect((res.data as any).total).toBeGreaterThan(0)
  })

  it('queries entity status with children', async () => {
    const res = await client.send({ method: 'get_status', params: { id: 'UC-E2E' } })
    expect(res.ok).toBe(true)
    expect((res.data as any).entity.id).toBe('UC-E2E')
    expect((res.data as any).children.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run integration test**

```bash
npx vitest run packages/tw-cli/src/integration.test.ts
```

Expected: all 6 tests PASS.

- [ ] **Step 3: Run full test suite**

```bash
npx vitest run
```

Expected: all tests across all packages PASS.

- [ ] **Step 4: Final commit**

```bash
git add .
git commit -m "feat: end-to-end integration test — Phase 1 complete"
```

---

## Phase 1 Done ✓

At this point TraceWeaver has:
- Full state machine with guards (all 3 interfaces share same guard)
- Entity registry + DAG with cycle detection
- WAL-backed persistence with idempotent replay (crash recovery)
- YAML entity store
- In-memory hot cache
- Unix Socket + NDJSON IPC
- CLI commands: `tw register`, `tw update`, `tw status`, `tw daemon`, `tw sync`
- Daemon auto-spawn on first CLI call

---

## Phase 2 Preview: OTel + Event System + Propagation

Next plan will cover:
- `worker_threads` pool (CPU-bound work off main thread)
- Ring Buffer Event Bus + Trigger Evaluator
- BubbleUp / CascadeDown propagator (run in Worker)
- OTel Deferred Span + OTLP exporter
- Git commit watcher → `git.commit` event

## Phase 3 Preview: Agent Interfaces

- Full MCP Server (10 tools from spec)
- Fastify HTTP server (9 endpoints from spec)
- `tw events`, `tw dag`, `tw impact` CLI commands
- Inbound webhook handler with bulk registration

## Phase 4 Preview: Notify + Watcher + Constraint

- FS Watcher (chokidar)
- Inbox / Webhook / IM notification adapters
- AI-interpreted constraint validation
- `tw-hook-bridge` for Claude Code integration
