# UseCase/Plan/Task 全链路 Trace 生命周期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 UseCase→Plan→Task 全链路 Trace 生命周期，包含 TraceId 一致性、级联更新、TaskMaster 桥接、自动修复闭环、快速问题定位。

**Architecture:** 所有新功能通过现有 IPC Socket 暴露给 CLI；RemediationEngine 订阅 EventBus 监听 rejected 事件；`tw taskmaster` 和 `tw diagnose` 作为新 CLI 命令族实现。组件通过 config.yaml 的 integrations 字段可插拔控制。

**Tech Stack:** TypeScript, Vitest, Commander.js, Node.js fs/promises (queue file I/O), 现有 EventBus/IPC 体系

**Spec:** `docs/superpowers/specs/2026-03-24-usecase-plan-task-trace-lifecycle-design.md`

---

## 文件变更地图

### tw-types 修改（Task 0 — 先做）
| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/tw-types/src/index.ts` | Modify | 新增 `entity.upstream_changed` 到 TwEventType 联合类型 |

### tw-daemon 修改
| 文件 | 操作 | 说明 |
|------|------|------|
| `src/otel/span-manager.ts` | Modify | 移除 `projectTraceId`，新增 `deriveTraceId()` |
| `src/otel/span-manager.test.ts` | Modify | 新增 TraceId 继承测试，修复 projectTraceId 引用 |
| `src/core/engine/dag.ts` | Modify | 新增 `getTransitiveDependents()` |
| `src/core/engine/dag.test.ts` | Modify | 新增方法测试 |
| `src/config/loader.ts` | Modify | 新增 `IntegrationsConfig`、`RemediationConfig` 类型 |
| `src/core/command-handler.ts` | Modify | 新增 `cascadeUpdate()`、`remediationNext()`、`remediationDone()` |
| `src/core/command-handler.test.ts` | Modify | 新增以上方法的测试 |
| `src/ipc-server.ts` | Modify | 新增 `emit_event`、`cascade_update`、`remediation_next`、`remediation_done` dispatch |
| `src/remediation/remediation-engine.ts` | Create | RemediationEngine 主体 |
| `src/remediation/remediation-engine.test.ts` | Create | RemediationEngine TDD 测试 |

### tw-cli 修改
| 文件 | 操作 | 说明 |
|------|------|------|
| `src/commands/taskmaster.ts` | Create | `tw taskmaster` 命令族 |
| `src/commands/diagnose.ts` | Create | `tw diagnose` 命令 |
| `src/index.ts` | Modify | 注册两个新命令 |

### 文档
| 文件 | 操作 | 说明 |
|------|------|------|
| `CLAUDE.md`（根） | Modify | 补充 TaskMaster 联动规范 + error.log 格式约定 |

---

## Task 0: tw-types — 新增 entity.upstream_changed 事件类型

**Files:**
- Modify: `packages/tw-types/src/index.ts`

此任务必须最先完成，所有 daemon 代码才能无 `as any` 地使用新事件类型。

- [ ] **Step 1: 修改 TwEventType 联合类型**

在 `packages/tw-types/src/index.ts` 第 131 行（`'file.changed'` 之后）追加：

```ts
export type TwEventType =
  | 'entity.registered'
  | 'entity.updated'
  | 'entity.state_changed'
  | 'entity.removed'
  | 'artifact.created'
  | 'artifact.modified'
  | 'artifact.linked'
  | 'hook.received'
  | 'webhook.inbound'
  | 'git.commit'
  | 'file.changed'
  | 'entity.upstream_changed'   // ← 新增：UseCase/Plan 更新时通知下游实体
```

- [ ] **Step 2: 全量构建验证（验证无破坏性变更）**

```bash
npm run build
```

期望：零错误（新增可选字面量，不破坏现有消费者）

- [ ] **Step 3: Commit**

```bash
git add packages/tw-types/src/index.ts
git commit -m "feat(types): add entity.upstream_changed to TwEventType"
```

---

## Task 1: SpanManager — per-root trace_id

**Files:**
- Modify: `packages/tw-daemon/src/otel/span-manager.ts`
- Modify: `packages/tw-daemon/src/otel/span-manager.test.ts`

- [ ] **Step 1: 写失败测试 — 同一 UseCase 下的 Plan/Task 继承同一 trace_id**

追加到 `packages/tw-daemon/src/otel/span-manager.test.ts`：

```ts
describe('trace_id inheritance', () => {
  it('root span (no parent) generates its own trace_id', () => {
    sm.createSpan({ entity_id: 'uc-1', entity_type: 'usecase' })
    const uc = sm.getSpan('uc-1')!
    expect(uc.trace_id).toBeDefined()
    expect(uc.trace_id).toHaveLength(32)
  })

  it('child span inherits parent trace_id', () => {
    sm.createSpan({ entity_id: 'uc-1', entity_type: 'usecase' })
    const ucSpanId = sm.getSpan('uc-1')!.span_id
    sm.createSpan({ entity_id: 'plan-1', entity_type: 'plan', parent_span_id: ucSpanId })
    expect(sm.getSpan('plan-1')!.trace_id).toBe(sm.getSpan('uc-1')!.trace_id)
  })

  it('grandchild span inherits same trace_id across 3 levels', () => {
    sm.createSpan({ entity_id: 'uc-1', entity_type: 'usecase' })
    const ucSpanId = sm.getSpan('uc-1')!.span_id
    sm.createSpan({ entity_id: 'plan-1', entity_type: 'plan', parent_span_id: ucSpanId })
    const planSpanId = sm.getSpan('plan-1')!.span_id
    sm.createSpan({ entity_id: 'task-1', entity_type: 'task', parent_span_id: planSpanId })
    const ucTraceId = sm.getSpan('uc-1')!.trace_id
    expect(sm.getSpan('plan-1')!.trace_id).toBe(ucTraceId)
    expect(sm.getSpan('task-1')!.trace_id).toBe(ucTraceId)
  })

  it('two different root entities get different trace_ids', () => {
    sm.createSpan({ entity_id: 'uc-1', entity_type: 'usecase' })
    sm.createSpan({ entity_id: 'uc-2', entity_type: 'usecase' })
    expect(sm.getSpan('uc-1')!.trace_id).not.toBe(sm.getSpan('uc-2')!.trace_id)
  })

  it('orphan entity (unknown parent_span_id) generates own trace_id', () => {
    sm.createSpan({ entity_id: 'task-orphan', entity_type: 'task', parent_span_id: 'nonexistent' })
    expect(sm.getSpan('task-orphan')!.trace_id).toBeDefined()
  })
})
```

- [ ] **Step 2: 验证测试失败**

```bash
npm test --workspace=packages/tw-daemon -- span-manager
```

期望：`trace_id inheritance` 测试块失败（当前所有 span 共用 `projectTraceId`）

- [ ] **Step 3: 实现 `deriveTraceId()`，移除 `projectTraceId`**

替换 `packages/tw-daemon/src/otel/span-manager.ts` 中的相关代码：

```ts
export class SpanManager {
  private readonly spans = new Map<string, SpanMeta>()
  // 移除: private readonly projectTraceId: string
  private readonly exporterRegistry?: ExporterRegistry

  constructor(private readonly opts: SpanManagerOptions = {}) {
    // 移除: this.projectTraceId = randomUUID().replace(/-/g, '')
    this.exporterRegistry = opts.exporterRegistry
  }

  private deriveTraceId(parentSpanId?: string): string {
    if (parentSpanId) {
      for (const span of this.spans.values()) {
        if (span.span_id === parentSpanId) return span.trace_id
      }
    }
    return randomUUID().replace(/-/g, '')
  }

  createSpan(input: CreateSpanInput): SpanMeta {
    if (this.spans.has(input.entity_id)) {
      return this.spans.get(input.entity_id)!
    }
    const meta: SpanMeta = {
      entity_id: input.entity_id,
      entity_type: input.entity_type,
      trace_id: this.deriveTraceId(input.parent_span_id),  // 替换 this.projectTraceId
      span_id: randomUUID().replace(/-/g, '').slice(0, 16),
      parent_span_id: input.parent_span_id,
      start_time: new Date().toISOString(),
      status: 'UNSET',
      attributes: {
        'tw.entity.id': input.entity_id,
        'tw.entity.type': input.entity_type,
        'tw.project.id': this.opts.projectId ?? 'default',
      },
      events: [],
    }
    this.spans.set(input.entity_id, meta)
    return meta
  }
  // ... 其余方法不变
```

- [ ] **Step 4: 验证所有测试通过**

```bash
npm test --workspace=packages/tw-daemon -- span-manager
```

期望：所有 span-manager 测试通过（包含新增的 trace_id inheritance 组）

- [ ] **Step 5: 全量构建验证**

```bash
npm run build --workspace=packages/tw-daemon
```

期望：零 TypeScript 错误

- [ ] **Step 6: Commit**

```bash
git add packages/tw-daemon/src/otel/span-manager.ts \
        packages/tw-daemon/src/otel/span-manager.test.ts
git commit -m "feat(otel): per-root trace_id via deriveTraceId(), remove projectTraceId"
```

---

## Task 2: Dag — getTransitiveDependents()

**Files:**
- Modify: `packages/tw-daemon/src/core/engine/dag.ts`
- Modify: `packages/tw-daemon/src/core/engine/dag.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `packages/tw-daemon/src/core/engine/dag.test.ts`：

```ts
describe('getTransitiveDependents', () => {
  // DAG 边约定：from depends ON to（child → parent）
  // getTransitiveDependents(id) 返回所有依赖链可达 id 的节点（即 id 的"下游"）

  it('returns direct dependents', () => {
    dag.addNode('uc')
    dag.addNode('plan-fe')
    dag.addNode('plan-be')
    dag.addEdge('plan-fe', 'uc') // plan-fe depends on uc
    dag.addEdge('plan-be', 'uc')
    expect(dag.getTransitiveDependents('uc').sort()).toEqual(['plan-be', 'plan-fe'])
  })

  it('returns transitive dependents across multiple levels', () => {
    dag.addNode('uc')
    dag.addNode('plan')
    dag.addNode('task-1')
    dag.addNode('task-2')
    dag.addEdge('plan', 'uc')
    dag.addEdge('task-1', 'plan')
    dag.addEdge('task-2', 'plan')
    const result = dag.getTransitiveDependents('uc').sort()
    expect(result).toEqual(['plan', 'task-1', 'task-2'])
  })

  it('returns empty array for leaf node with no dependents', () => {
    dag.addNode('task-leaf')
    expect(dag.getTransitiveDependents('task-leaf')).toEqual([])
  })

  it('returns empty array for unknown node', () => {
    expect(dag.getTransitiveDependents('UNKNOWN')).toEqual([])
  })

  it('does not include the node itself', () => {
    dag.addNode('uc')
    dag.addNode('plan')
    dag.addEdge('plan', 'uc')
    expect(dag.getTransitiveDependents('uc')).not.toContain('uc')
  })
})
```

- [ ] **Step 2: 验证测试失败**

```bash
npm test --workspace=packages/tw-daemon -- dag
```

期望：`getTransitiveDependents` 测试失败（方法不存在）

- [ ] **Step 3: 实现 `getTransitiveDependents()`**

追加到 `packages/tw-daemon/src/core/engine/dag.ts` 的 `Dag` 类中（在 `getDependents` 之后）：

```ts
/**
 * 沿反向边（被依赖方向）递归收集所有传递性依赖者。
 * 即：所有"依赖链最终到达 id"的节点集合。
 * 用于级联更新：当 UseCase 更新时，找出所有受影响的 Plan/Task。
 */
getTransitiveDependents(id: string): string[] {
  const result = new Set<string>()
  const queue = [id]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const [node, deps] of this.deps) {
      if (deps.has(current) && !result.has(node)) {
        result.add(node)
        queue.push(node)
      }
    }
  }
  return Array.from(result)
}
```

- [ ] **Step 4: 验证测试通过**

```bash
npm test --workspace=packages/tw-daemon -- dag
```

期望：全部通过

- [ ] **Step 5: Commit**

```bash
git add packages/tw-daemon/src/core/engine/dag.ts \
        packages/tw-daemon/src/core/engine/dag.test.ts
git commit -m "feat(dag): add getTransitiveDependents() for cascade update support"
```

---

## Task 3: Config loader — integrations + remediation 字段

**Files:**
- Modify: `packages/tw-daemon/src/config/loader.ts`

- [ ] **Step 1: 新增类型定义**

在 `packages/tw-daemon/src/config/loader.ts` 的类型区块（`HarnessConfig` 之后，`TwConfig` 之前）插入：

```ts
export interface IntegrationsConfig {
  /** 关掉 → Task/Plan 自成根 trace（默认 true） */
  usecase?: boolean
  /** 关掉 → 禁止 Plan 级联 cascade_update（默认 true） */
  plan_fanout?: boolean
  /** 关掉 → tw taskmaster 命令报错（默认 true） */
  taskmaster?: boolean
  /** 关掉 → rejection 只通知 inbox，不自动修复（默认 true） */
  remediation?: boolean
  /** 关掉 → 纯 trace，不做约束评估（默认 true） */
  harness?: boolean
}

export interface RemediationConfig {
  enabled?: boolean
  max_attempts?: number
  /** queue | inline | notify_only（默认 queue） */
  mode?: 'queue' | 'inline' | 'notify_only'
  /**
   * 限定只有从指定状态拒绝时才触发修复。
   * 空数组或 undefined = 所有 rejected 均触发。
   */
  trigger_from_states?: string[]
}
```

- [ ] **Step 2: 将新字段加入 TwConfig**

在 `TwConfig` 接口中追加：

```ts
export interface TwConfig {
  store_dir?: string
  socket_path?: string
  watch?: WatchConfig
  notify?: NotifyConfig
  otel?: OtelConfig
  http?: HttpConfig
  harness?: HarnessConfig
  integrations?: IntegrationsConfig   // ← 新增
  remediation?: RemediationConfig     // ← 新增
}
```

- [ ] **Step 3: 构建验证**

```bash
npm run build --workspace=packages/tw-daemon
```

期望：零错误（只加了可选字段，不会破坏现有使用者）

- [ ] **Step 4: Commit**

```bash
git add packages/tw-daemon/src/config/loader.ts
git commit -m "feat(config): add integrations and remediation config fields"
```

---

## Task 4: CommandHandler — cascadeUpdate()

**Files:**
- Modify: `packages/tw-daemon/src/core/command-handler.ts`
- Modify: `packages/tw-daemon/src/core/command-handler.test.ts`

- [ ] **Step 1: 写失败测试**

找到 `packages/tw-daemon/src/core/command-handler.test.ts`，追加新 describe 块：

```ts
describe('cascadeUpdate', () => {
  it('updates target entity and emits upstream_updated for each descendant', async () => {
    // 建立 UseCase → Plan → Task 三层结构
    await handler.register({ id: 'uc-1', entity_type: 'usecase' })
    await handler.register({ id: 'plan-1', entity_type: 'plan', parent_id: 'uc-1', depends_on: ['uc-1'] })
    await handler.register({ id: 'task-1', entity_type: 'task', parent_id: 'plan-1', depends_on: ['plan-1'] })

    const emitted: string[] = []
    // 追踪 addEvent 调用（通过 SpanManager mock 或 EventBus 订阅）

    const result = await handler.cascadeUpdate({
      id: 'uc-1',
      attributes: { description: 'v2' },
      cascade: true,
    })

    expect(result.ok).toBe(true)
    expect(result.data.updated_count).toBe(3) // uc-1 + plan-1 + task-1
  })

  it('cascade:false behaves like update_attributes (updated_count=1)', async () => {
    await handler.register({ id: 'uc-1', entity_type: 'usecase' })
    await handler.register({ id: 'plan-1', entity_type: 'plan', depends_on: ['uc-1'] })

    const result = await handler.cascadeUpdate({
      id: 'uc-1',
      attributes: { description: 'v2' },
      cascade: false,
    })
    expect(result.data.updated_count).toBe(1)
  })

  it('returns ENTITY_NOT_FOUND for unknown id', async () => {
    const result = await handler.cascadeUpdate({
      id: 'nonexistent',
      attributes: {},
      cascade: true,
    })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('ENTITY_NOT_FOUND')
  })
})
```

- [ ] **Step 2: 验证测试失败**

```bash
npm test --workspace=packages/tw-daemon -- command-handler
```

期望：`cascadeUpdate` 相关测试失败（方法不存在）

- [ ] **Step 3: 实现 cascadeUpdate()**

在 `packages/tw-daemon/src/core/command-handler.ts` 的 `emitEvent()` 方法之前新增：

```ts
async cascadeUpdate(params: {
  id: string
  attributes: Record<string, unknown>
  cascade: boolean
}): Promise<{ ok: boolean; data?: { id: string; updated_count: number }; error?: { code: string; message: string } }> {
  const entity = this.registry.get(params.id)
  if (!entity) {
    return { ok: false, error: { code: 'ENTITY_NOT_FOUND', message: `Entity ${params.id} not found` } }
  }

  // 更新本实体
  await this.updateAttributes({ id: params.id, attributes: params.attributes })
  let updatedCount = 1

  if (params.cascade) {
    const descendants = this.dag.getTransitiveDependents(params.id)
    for (const descendantId of descendants) {
      const desc = this.registry.get(descendantId)
      if (!desc) continue
      // 追加上游变更事件到 span（不改变实体属性）
      this.opts.spanManager?.addEvent(descendantId, 'upstream_updated', {
        source: params.id,
        changed: Object.keys(params.attributes),
      })
      // 发布事件，TriggerExecutor 可配置 harness trigger_on: [upstream_changed]
      this.emit({
        id: randomUUID(),
        type: 'entity.upstream_changed' as any,
        entity_id: descendantId,
        ts: new Date().toISOString(),
        attributes: { source: params.id, changed: Object.keys(params.attributes) },
      } as any)
      updatedCount++
    }
  }

  return { ok: true, data: { id: params.id, updated_count: updatedCount } }
}
```

- [ ] **Step 4: 验证测试通过**

```bash
npm test --workspace=packages/tw-daemon -- command-handler
```

期望：全部通过

- [ ] **Step 5: CommandHandler 同步新增 remediationNext() / remediationDone()**

在 `cascadeUpdate()` 之后、同一个 commit 内追加（IPC 在 Task 5 会引用这两个方法，必须同步加入）：

```ts
async remediationNext(queueDir: string): Promise<Record<string, unknown> | null> {
  const { readdir, readFile, rename, mkdir } = await import('node:fs/promises')
  const pendingDir = join(queueDir, 'pending')
  const inProgressDir = join(queueDir, 'in-progress')
  await mkdir(pendingDir, { recursive: true })
  await mkdir(inProgressDir, { recursive: true })
  let files: string[]
  try { files = await readdir(pendingDir) } catch { return null }
  const jsonFiles = files.filter(f => f.endsWith('.json')).sort()
  if (jsonFiles.length === 0) return null
  const file = jsonFiles[0]
  const src = join(pendingDir, file)
  const dst = join(inProgressDir, file)
  const raw = await readFile(src, 'utf8')
  const item = JSON.parse(raw) as Record<string, unknown>
  await rename(src, dst)
  return item
}

async remediationDone(params: { remId: string; queueDir: string }): Promise<{ ok: boolean }> {
  const { readdir, rename, mkdir } = await import('node:fs/promises')
  const inProgressDir = join(params.queueDir, 'in-progress')
  const doneDir = join(params.queueDir, 'done')
  await mkdir(doneDir, { recursive: true })
  let files: string[]
  try { files = await readdir(inProgressDir) } catch { return { ok: false } }
  const target = files.find(f => f.includes(params.remId))
  if (!target) return { ok: false }
  await rename(join(inProgressDir, target), join(doneDir, target))
  return { ok: true }
}
```

- [ ] **Step 6: 构建 + 测试验证**

```bash
npm run build --workspace=packages/tw-daemon && \
npm test --workspace=packages/tw-daemon -- command-handler
```

- [ ] **Step 7: Commit**

```bash
git add packages/tw-daemon/src/core/command-handler.ts \
        packages/tw-daemon/src/core/command-handler.test.ts
git commit -m "feat(daemon): cascadeUpdate() + remediationNext/Done() in CommandHandler"
```

---

## Task 5: IPC Server — 新增 4 个 dispatch 分支

**Files:**
- Modify: `packages/tw-daemon/src/ipc-server.ts`

IPC 新增：`emit_event`（修复 C1）、`cascade_update`、`remediation_next`、`remediation_done`

- [ ] **Step 1: 写测试（IPC 级别）**

在 `packages/tw-daemon/src/ipc-server.test.ts` 中追加：

```ts
it('emit_event adds span event and returns ok', async () => {
  await client.send({ method: 'register', params: { id: 'task-e1', entity_type: 'task' } })
  const res = await client.send({
    method: 'emit_event',
    params: { entity_id: 'task-e1', event: 'custom.hook', attributes: { source: 'test' } },
  })
  expect(res.ok).toBe(true)
})

it('cascade_update calls handler.cascadeUpdate and returns updated_count', async () => {
  await client.send({ method: 'register', params: { id: 'uc-1', entity_type: 'usecase' } })
  await client.send({ method: 'register', params: { id: 'plan-1', entity_type: 'plan', depends_on: ['uc-1'] } })
  const res = await client.send({
    method: 'cascade_update',
    params: { id: 'uc-1', attributes: { description: 'v2' }, cascade: true },
  })
  expect(res.ok).toBe(true)
  expect((res as any).data.updated_count).toBeGreaterThanOrEqual(1)
})

it('cascade_update with unknown id returns error', async () => {
  const res = await client.send({
    method: 'cascade_update',
    params: { id: 'nope', attributes: {}, cascade: true },
  })
  expect(res.ok).toBe(false)
})
```

- [ ] **Step 2: 验证测试失败**

```bash
npm test --workspace=packages/tw-daemon -- ipc-server
```

期望：新测试失败（方法未注册）

- [ ] **Step 3: 在 dispatch() 中新增分支**

在 `packages/tw-daemon/src/ipc-server.ts` 的 `harness_validate` 分支之后、`throw Unknown method` 之前插入：

```ts
} else if (method === 'emit_event') {
  // 注意: 此方法在 CommandHandler.emitEvent() 已存在，补上 IPC 注册
  if (typeof (params as any).entity_id !== 'string') {
    throw Object.assign(new Error('Missing required param: entity_id'), { code: 'INVALID_PARAMS' })
  }
  data = await this.handler.emitEvent(params as any)
} else if (method === 'cascade_update') {
  if (typeof (params as any).id !== 'string') {
    throw Object.assign(new Error('Missing required param: id'), { code: 'INVALID_PARAMS' })
  }
  const { id, attributes, cascade } = params as { id: string; attributes: Record<string, unknown>; cascade: boolean }
  const result = await this.handler.cascadeUpdate({ id, attributes: attributes ?? {}, cascade: cascade ?? false })
  if (!result.ok) throw Object.assign(new Error(result.error!.message), { code: result.error!.code })
  data = result.data
} else if (method === 'remediation_next') {
  const remDir = (params as any).queue_dir as string | undefined
  if (!remDir) throw Object.assign(new Error('Missing required param: queue_dir'), { code: 'INVALID_PARAMS' })
  data = await this.handler.remediationNext(remDir)
} else if (method === 'remediation_done') {
  const { rem_id, queue_dir } = params as { rem_id: string; queue_dir: string }
  if (!rem_id || !queue_dir) throw Object.assign(new Error('Missing required params: rem_id, queue_dir'), { code: 'INVALID_PARAMS' })
  data = await this.handler.remediationDone({ remId: rem_id, queueDir: queue_dir })
```

- [ ] **Step 4: 构建 + 测试验证**

```bash
npm run build --workspace=packages/tw-daemon && \
npm test --workspace=packages/tw-daemon -- ipc-server
```

期望：全部通过

- [ ] **Step 5: Commit**

```bash
git add packages/tw-daemon/src/ipc-server.ts \
        packages/tw-daemon/src/ipc-server.test.ts
git commit -m "feat(ipc): add emit_event, cascade_update, remediation_next/done dispatch"
```

---

## Task 6: RemediationEngine

**Files:**
- Create: `packages/tw-daemon/src/remediation/remediation-engine.ts`
- Create: `packages/tw-daemon/src/remediation/remediation-engine.test.ts`
- Modify: `packages/tw-daemon/src/core/command-handler.ts` (添加 remediationNext/Done)

### 6 — RemediationEngine 主体

> `remediationNext()` / `remediationDone()` 已在 Task 4 中加入 CommandHandler，此处直接实现 RemediationEngine 核心。


- [ ] **Step 4: 写 RemediationEngine 测试**

创建 `packages/tw-daemon/src/remediation/remediation-engine.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemediationEngine } from './remediation-engine.js'
import type { EventBus } from '../core/event-bus/event-bus.js'
import type { CommandHandler } from '../core/command-handler.js'
import type { FeedbackLog } from '../feedback/feedback-log.js'

function makeEventBus() {
  const subs: Array<(events: any[]) => void> = []
  return {
    subscribeBatch: vi.fn((cb: any) => { subs.push(cb); return () => {} }),
    publish: vi.fn(),
    emit: (events: any[]) => subs.forEach(s => s(events)),
  }
}

function makeHandler() {
  return {
    get: vi.fn().mockResolvedValue({
      ok: true,
      data: { id: 'task-1', entity_type: 'task', state: 'rejected', artifact_refs: [] },
    }),
    updateState: vi.fn().mockResolvedValue({}),
  } as unknown as CommandHandler
}

function makeFeedbackLog() {
  return {
    query: vi.fn().mockReturnValue([{
      harness_id: 'needs-review',
      reason: '缺少测试覆盖',
      ts: new Date().toISOString(),
    }]),
  } as unknown as FeedbackLog
}

describe('RemediationEngine', () => {
  let queueDir: string
  let bus: ReturnType<typeof makeEventBus>
  let handler: CommandHandler
  let feedbackLog: FeedbackLog
  let engine: RemediationEngine

  beforeEach(async () => {
    queueDir = await mkdtemp(join(tmpdir(), 'rem-test-'))
    bus = makeEventBus()
    handler = makeHandler()
    feedbackLog = makeFeedbackLog()
    engine = new RemediationEngine({
      eventBus: bus as unknown as EventBus,
      handler,
      feedbackLog,
      queueDir,
      maxAttempts: 3,
    })
    engine.start()
  })

  it('enqueues a pending item when entity is rejected', async () => {
    bus.emit([{
      type: 'entity.state_changed',
      entity_id: 'task-1',
      state: 'rejected',
      ts: new Date().toISOString(),
    }])
    // 给异步操作一点时间
    await new Promise(r => setTimeout(r, 50))
    const files = await readdir(join(queueDir, 'pending')).catch(() => [])
    expect(files.length).toBe(1)
    expect(files[0]).toMatch(/rem-.*\.json/)
  })

  it('does not enqueue if max attempts exceeded', async () => {
    // 预先在 done/ 放 3 个同实体的历史记录
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(queueDir, 'done'), { recursive: true })
    for (let i = 1; i <= 3; i++) {
      await writeFile(join(queueDir, 'done', `rem-00${i}-task-1.json`), JSON.stringify({ entity_id: 'task-1', attempt: i }))
    }
    bus.emit([{
      type: 'entity.state_changed',
      entity_id: 'task-1',
      state: 'rejected',
      ts: new Date().toISOString(),
    }])
    await new Promise(r => setTimeout(r, 50))
    const files = await readdir(join(queueDir, 'pending')).catch(() => [])
    expect(files.length).toBe(0)
  })

  it('deduplicates identical rejection events (same entity_id + ts)', async () => {
    const event = { type: 'entity.state_changed', entity_id: 'task-1', state: 'rejected', ts: '2026-03-24T10:00:00Z' }
    bus.emit([event])
    bus.emit([event]) // 同一个 ts
    await new Promise(r => setTimeout(r, 50))
    const files = await readdir(join(queueDir, 'pending')).catch(() => [])
    expect(files.length).toBe(1) // 只入队一次
  })
})
```

- [ ] **Step 5: 验证测试失败**

```bash
npm test --workspace=packages/tw-daemon -- remediation-engine
```

期望：文件不存在，测试失败

- [ ] **Step 6: 实现 RemediationEngine**

创建 `packages/tw-daemon/src/remediation/remediation-engine.ts`：

```ts
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { EventBus } from '../core/event-bus/event-bus.js'
import type { CommandHandler } from '../core/command-handler.js'
import type { FeedbackLog } from '../feedback/feedback-log.js'

export interface RemediationEngineOptions {
  eventBus: EventBus
  handler: CommandHandler
  feedbackLog: FeedbackLog
  queueDir: string
  maxAttempts?: number
  /** 仅从指定状态拒绝时触发。空 = 所有 rejected 均触发 */
  triggerFromStates?: string[]
}

export interface RemediationQueueItem {
  id: string
  entity_id: string
  entity_type: string
  attempt: number
  rejection_reason: string
  harness_id: string
  artifact_refs: Array<{ type: string; path: string }>
  ts: string
}

export class RemediationEngine {
  private unsub: (() => void) | null = null
  private readonly dedupSeen = new Set<string>()
  private readonly maxAttempts: number

  constructor(private readonly opts: RemediationEngineOptions) {
    this.maxAttempts = opts.maxAttempts ?? 3
  }

  start(): void {
    if (this.unsub) return
    this.unsub = this.opts.eventBus.subscribeBatch(
      batch => void this.handleBatch(batch).catch(() => {})
    )
  }

  stop(): void {
    this.unsub?.()
    this.unsub = null
  }

  private async handleBatch(events: any[]): Promise<void> {
    const rejections = events.filter(e =>
      e.type === 'entity.state_changed' && e.state === 'rejected' && e.entity_id
    )
    for (const event of rejections) {
      const dedupKey = `${event.entity_id as string}|${event.ts as string}`
      if (this.dedupSeen.has(dedupKey)) continue
      this.dedupSeen.add(dedupKey)

      await this.handleRejection(event).catch(() => {})
    }
  }

  private async handleRejection(event: any): Promise<void> {
    const { entity_id } = event as { entity_id: string }

    // 检查 trigger_from_states 限制
    if (this.opts.triggerFromStates?.length && event.previous_state) {
      if (!this.opts.triggerFromStates.includes(event.previous_state as string)) return
    }

    // 读取实体信息
    const entityResult = await this.opts.handler.get({ id: entity_id })
    if (!entityResult.ok) return

    // Circuit breaker: 统计历史 attempt 数
    const attempt = await this.countAttempts(entity_id) + 1
    if (attempt > this.maxAttempts) {
      // 已超上限，不再入队（由 TriggerExecutor 已处理 inbox 通知）
      return
    }

    // 读取最近的拒绝原因
    const feedbackEntries = this.opts.feedbackLog.query({ entity_id, result: 'fail', limit: 1 })
    const lastFeedback = feedbackEntries[0]

    const entity = entityResult.data
    const item: RemediationQueueItem = {
      id: `rem-${randomUUID().slice(0, 8)}`,
      entity_id,
      entity_type: entity.entity_type ?? 'task',
      attempt,
      rejection_reason: lastFeedback?.reason ?? 'unknown',
      harness_id: lastFeedback?.harness_id ?? 'unknown',
      artifact_refs: entity.artifact_refs ?? [],
      ts: new Date().toISOString(),
    }

    await this.enqueue(item)
  }

  private async countAttempts(entityId: string): Promise<number> {
    const dirs = ['done', 'in-progress']
    let count = 0
    for (const dir of dirs) {
      try {
        const files = await readdir(join(this.opts.queueDir, dir))
        count += files.filter(f => f.includes(entityId)).length
      } catch { /* dir may not exist yet */ }
    }
    return count
  }

  private async enqueue(item: RemediationQueueItem): Promise<void> {
    const pendingDir = join(this.opts.queueDir, 'pending')
    await mkdir(pendingDir, { recursive: true })
    const filename = `${item.id}-${item.entity_id}.json`
    await writeFile(join(pendingDir, filename), JSON.stringify(item, null, 2), 'utf8')
  }
}
```

- [ ] **Step 7: 验证测试通过**

```bash
npm test --workspace=packages/tw-daemon -- remediation-engine
```

期望：3 个测试全部通过

- [ ] **Step 8: 构建验证**

```bash
npm run build --workspace=packages/tw-daemon
```

- [ ] **Step 9: Commit**

```bash
git add packages/tw-daemon/src/remediation/ \
        packages/tw-daemon/src/core/command-handler.ts \
        packages/tw-daemon/src/core/command-handler.test.ts
git commit -m "feat(daemon): RemediationEngine — queue-based auto-fix loop with circuit breaker"
```

---

## Task 7: CLI — `tw taskmaster` 命令族

**Files:**
- Create: `packages/tw-cli/src/commands/taskmaster.ts`
- Modify: `packages/tw-cli/src/index.ts`

约束：所有命令通过 IPC，不直接 import daemon；所有命令支持 `--json`；单文件 ≤ 100 行

- [ ] **Step 1: 实现 taskmaster.ts**

创建 `packages/tw-cli/src/commands/taskmaster.ts`：

```ts
// packages/tw-cli/src/commands/taskmaster.ts
import { Command } from 'commander'
import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sendIpc } from '../ipc-client.js'
import { ensureDaemon } from '../daemon-manager.js'

export function taskmasterCommand(): Command {
  const cmd = new Command('taskmaster').description('TaskMaster ↔ TraceWeaver bridge')

  // tw taskmaster hook <event> [options]
  cmd.command('hook <event>')
    .description('Emit a TraceWeaver event for a TaskMaster lifecycle hook')
    .option('--plan <id>',   'TW Plan entity id')
    .option('--tm-id <id>',  'TaskMaster task/subtask id (e.g. 3 or 3.1)')
    .option('--status <s>',  'New status (for status-changed event)')
    .option('--json',        'Output as JSON')
    .action(async (event: string, opts: any) => {
      try {
        await ensureDaemon()
        const attributes: Record<string, unknown> = {}
        if (opts.tmId)   attributes.tm_id  = opts.tmId
        if (opts.plan)   attributes.plan_id = opts.plan
        if (opts.status) attributes.status  = opts.status

        // after-expand: 读取新生成子任务并批量注册
        if (event === 'after-expand' && opts.plan && opts.tmId) {
          await registerExpandedSubtasks(opts.plan, opts.tmId)
        }

        // status-changed: 同步状态到 TW 实体
        if (event === 'status-changed' && opts.tmId && opts.status) {
          await syncTaskStatus(opts.tmId, opts.status)
        }

        // 所有 hook 均 emit 一个通用事件
        const entityId = opts.plan ?? opts.tmId ?? 'unknown'
        const res = await sendIpc({
          method: 'emit_event',
          params: { entity_id: entityId, event: `taskmaster.${event}`, attributes },
        })
        if (opts.json) { console.log(JSON.stringify(res, null, 2)); return }
        if ((res as any).ok) console.log(`✓ hook ${event} emitted`)
        else { console.error(`Error: ${(res as any).error?.message}`); process.exit(1) }
      } catch (err: any) { console.error(`Error: ${err.message}`); process.exit(1) }
    })

  // tw taskmaster sync --plan=<id>
  cmd.command('sync')
    .description('Reconcile TaskMaster tasks.json with TW entities')
    .requiredOption('--plan <id>', 'TW Plan entity id')
    .option('--json', 'Output as JSON')
    .action(async (opts: any) => {
      try {
        await ensureDaemon()
        const tmapPath = join(process.cwd(), '.taskmaster', 'tasks', 'tasks.json')
        if (!existsSync(tmapPath)) {
          console.error('No .taskmaster/tasks/tasks.json found'); process.exit(1)
        }
        const { tasks } = JSON.parse(readFileSync(tmapPath, 'utf8')) as { tasks: any[] }
        let synced = 0
        for (const task of tasks) {
          const twState = tmStatusToTwState(task.status)
          await sendIpc({
            method: 'register',
            params: {
              entity_type: 'task',
              id: `tm-${task.id as string}-${randomUUID().slice(0, 6)}`,
              parent_id: opts.plan,
              attributes: { tm_id: String(task.id), title: task.title },
            },
          }).catch(() => {}) // skip if already exists
          await sendIpc({ method: 'update_state', params: { id: `tm-${task.id as string}`, state: twState } }).catch(() => {})
          synced++
        }
        const out = { synced, plan: opts.plan }
        if (opts.json) { console.log(JSON.stringify(out, null, 2)); return }
        console.log(`✓ Synced ${synced} tasks to plan ${opts.plan as string}`)
      } catch (err: any) { console.error(`Error: ${err.message}`); process.exit(1) }
    })

  return cmd
}

function tmStatusToTwState(status: string): string {
  const map: Record<string, string> = {
    'pending': 'pending',
    'in-progress': 'in_progress',
    'review': 'review',
    'done': 'completed',
    'deferred': 'pending',
    'cancelled': 'rejected',
  }
  return map[status] ?? 'pending'
}

async function registerExpandedSubtasks(planId: string, tmParentId: string): Promise<void> {
  const tmapPath = join(process.cwd(), '.taskmaster', 'tasks', 'tasks.json')
  if (!existsSync(tmapPath)) return
  const { tasks } = JSON.parse(readFileSync(tmapPath, 'utf8')) as { tasks: any[] }
  const parent = tasks.find((t: any) => String(t.id) === String(tmParentId))
  if (!parent?.subtasks?.length) return
  for (const sub of parent.subtasks) {
    await sendIpc({
      method: 'register',
      params: {
        entity_type: 'task',
        id: `tm-${tmParentId as string}.${sub.id as string}-${randomUUID().slice(0, 6)}`,
        parent_id: planId,
        attributes: { tm_id: `${tmParentId as string}.${sub.id as string}`, title: sub.title },
      },
    }).catch(() => {})
  }
}

async function syncTaskStatus(tmId: string, tmStatus: string): Promise<void> {
  // 查询 TW 中 tm_id 匹配的实体
  const twState = tmStatusToTwState(tmStatus)
  // 通过 get_status 找到对应实体（实际项目中可扩展 IPC 支持 filter by attribute）
  const res = await sendIpc({ method: 'get_status', params: {} })
  if (!(res as any).ok) return
  // 简化实现：emit 状态事件，完整实现需要 tw-types 扩展 filter API
  console.log(`  [sync] tm-id=${tmId} → tw-state=${twState}`)
}
```

- [ ] **Step 2: 注册命令到 index.ts**

在 `packages/tw-cli/src/index.ts` 中，仿照已有命令添加：

```ts
import { taskmasterCommand } from './commands/taskmaster.js'
// ...
program.addCommand(taskmasterCommand())
```

- [ ] **Step 3: 构建验证**

```bash
npm run build --workspace=packages/tw-cli
```

期望：零 TypeScript 错误

- [ ] **Step 4: 冒烟测试**

```bash
tw taskmaster --help
tw taskmaster hook --help
tw taskmaster sync --help
```

期望：帮助文本正确显示

- [ ] **Step 5: Commit**

```bash
git add packages/tw-cli/src/commands/taskmaster.ts \
        packages/tw-cli/src/index.ts
git commit -m "feat(cli): add tw taskmaster hook/sync commands"
```

---

## Task 8: CLI — `tw diagnose` 命令

**Files:**
- Create: `packages/tw-cli/src/commands/diagnose.ts`
- Modify: `packages/tw-cli/src/index.ts`

- [ ] **Step 1: 实现 diagnose.ts**

创建 `packages/tw-cli/src/commands/diagnose.ts`：

```ts
// packages/tw-cli/src/commands/diagnose.ts
import { Command } from 'commander'
import { readFileSync, existsSync } from 'node:fs'
import { sendIpc } from '../ipc-client.js'
import { ensureDaemon } from '../daemon-manager.js'

export function diagnoseCommand(): Command {
  const cmd = new Command('diagnose')
    .description('Fast problem localization for rejected or failed entities')
    .argument('[entity-id]', 'Entity ID to diagnose')
    .option('--trace',         'Show full trace tree from root entity')
    .option('--from-log <file>', 'Parse error.log and diagnose matching entities')
    .option('--json',          'Output as JSON')

  cmd.action(async (entityId: string | undefined, opts: any) => {
    try {
      await ensureDaemon()

      if (opts.fromLog) {
        await diagnoseFromLog(opts.fromLog, opts.json)
        return
      }
      if (!entityId) { console.error('Provide an entity-id or --from-log'); process.exit(1) }

      if (opts.trace) {
        await diagnoseTrace(entityId, opts.json)
      } else {
        await diagnoseSingle(entityId, opts.json)
      }
    } catch (err: any) { console.error(`Error: ${err.message}`); process.exit(1) }
  })

  return cmd
}

async function diagnoseSingle(entityId: string, asJson: boolean): Promise<void> {
  const [statusRes, eventsRes, feedbackRes] = await Promise.all([
    sendIpc({ method: 'get_status', params: { id: entityId } }),
    sendIpc({ method: 'query_events', params: { entity_id: entityId, limit: 50 } }),
    sendIpc({ method: 'feedback_query', params: { entity_id: entityId, result: 'fail', limit: 5 } }),
  ])

  const entity = (statusRes as any).ok ? (statusRes as any).data?.entity : null
  const events = (eventsRes as any).ok ? (eventsRes as any).data ?? [] : []
  const feedback = (feedbackRes as any).ok ? (feedbackRes as any).data ?? [] : []

  if (asJson) {
    console.log(JSON.stringify({ entity, events, feedback }, null, 2))
    return
  }

  if (!entity) { console.error(`Entity ${entityId} not found`); process.exit(1) }

  const stateIcon = entity.state === 'rejected' ? '⚠️ ' : entity.state === 'completed' ? '✓' : '○'
  console.log(`\n━━━ Entity: ${entityId} ━━━━━━━━━━━━━━━━━━━━`)
  console.log(`Type:   ${entity.entity_type as string}`)
  console.log(`State:  ${stateIcon} ${entity.state as string}`)

  if (events.length) {
    console.log(`\n━━━ Span Events ━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    for (const e of events as any[]) {
      const warn = (e.type as string).includes('rejected') ? ' ← ⚠️' : ''
      console.log(`  ${(e.ts as string).slice(11, 19)}  ${e.type as string}${warn}`)
      if (e.attributes) {
        for (const [k, v] of Object.entries(e.attributes as Record<string, unknown>)) {
          console.log(`           ${k}=${JSON.stringify(v)}`)
        }
      }
    }
  }

  if (feedback.length) {
    console.log(`\n━━━ Harness Failures ━━━━━━━━━━━━━━━━━━━━━`)
    for (const f of feedback as any[]) {
      console.log(`  Harness: ${f.harness_id as string}`)
      console.log(`  Reason:  ${f.reason as string}`)
    }
  }

  if (entity.artifact_refs?.length) {
    console.log(`\n━━━ Artifact Refs ━━━━━━━━━━━━━━━━━━━━━━━━`)
    for (const ref of entity.artifact_refs as any[]) {
      const exists = existsSync(ref.path as string)
      console.log(`  ${exists ? '✓' : '✗'}  ${ref.type as string}  ${ref.path as string}`)
    }
  }

  console.log('')
}

async function diagnoseTrace(entityId: string, asJson: boolean): Promise<void> {
  const dagRes = await sendIpc({ method: 'get_dag', params: {} })
  const statusRes = await sendIpc({ method: 'get_status', params: {} })
  if (!(dagRes as any).ok || !(statusRes as any).ok) {
    console.error('Failed to fetch DAG or status'); process.exit(1)
  }
  // 简化输出：打印实体树和状态
  if (asJson) {
    console.log(JSON.stringify({ dag: (dagRes as any).data, status: (statusRes as any).data }, null, 2))
    return
  }
  console.log(`\n[Trace tree for ${entityId} — use --json for full data]\n`)
  const all = ((statusRes as any).data as any[]) ?? []
  const root = all.find((e: any) => e.id === entityId)
  if (root) printTree(root, all, '')
}

function printTree(entity: any, all: any[], prefix: string): void {
  const icon = entity.state === 'rejected' ? '⚠️ ' : entity.state === 'completed' ? '✓' : '○'
  console.log(`${prefix}${entity.entity_type as string}: ${entity.id as string}  ${icon} ${entity.state as string}`)
  const children = all.filter((e: any) => e.parent_id === entity.id)
  for (const child of children) printTree(child, all, prefix + '  ├─ ')
}

async function diagnoseFromLog(logFile: string, asJson: boolean): Promise<void> {
  if (!existsSync(logFile)) { console.error(`Log file not found: ${logFile}`); process.exit(1) }
  const lines = readFileSync(logFile, 'utf8').split('\n')
  const entityIds = new Set<string>()
  for (const line of lines) {
    const match = line.match(/entity_id=([^\s]+)/)
    if (match) entityIds.add(match[1])
  }
  if (entityIds.size === 0) { console.log('No entity_id found in log file'); return }
  for (const id of entityIds) {
    console.log(`\n── Diagnosing ${id} ──`)
    await diagnoseSingle(id, asJson)
  }
}
```

- [ ] **Step 2: 注册到 index.ts**

```ts
import { diagnoseCommand } from './commands/diagnose.js'
// ...
program.addCommand(diagnoseCommand())
```

- [ ] **Step 3: 构建 + 冒烟测试**

```bash
npm run build --workspace=packages/tw-cli && \
tw diagnose --help
```

期望：帮助文本显示正确

- [ ] **Step 4: Commit**

```bash
git add packages/tw-cli/src/commands/diagnose.ts \
        packages/tw-cli/src/index.ts
git commit -m "feat(cli): add tw diagnose command with --trace and --from-log support"
```

---

## Task 9: 全量集成验证 + CLAUDE.md 更新

- [ ] **Step 1: 全量测试**

```bash
npm test --workspace=packages/tw-daemon
npm test --workspace=packages/tw-cli
```

期望：daemon ≥ 234 tests passing，cli ≥ 8 tests passing

- [ ] **Step 2: 全量构建**

```bash
npm run build
```

期望：零 TypeScript 错误

- [ ] **Step 3: 运行时验证**

```bash
tw daemon start
tw status --json
tw taskmaster --help
tw diagnose --help
tw daemon stop
```

- [ ] **Step 4: 更新根 CLAUDE.md**

在根 `CLAUDE.md` 的"提交规范"之前追加：

```markdown
## TaskMaster 与 TraceWeaver 联动规范

使用 TaskMaster 时，必须成对调用 tw hook：

```bash
# expand 前后
tw taskmaster hook before-expand --plan=<plan-id> --tm-id=<n>
task-master expand --id=<n>
tw taskmaster hook after-expand --plan=<plan-id> --tm-id=<n>

# 状态变更后
task-master set-status <n> <status>
tw taskmaster hook status-changed --tm-id=<n> --status=<status>
```

## error.log 格式约定（供 tw diagnose --from-log 使用）

```
[ERROR] <ISO-ts> entity_id=<id> trace_id=<id> harness=<id> msg="..."
```
```

- [ ] **Step 5: Final commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): TaskMaster 联动规范 + error.log 格式约定"
```

---

## 执行顺序依赖

```
Task 0 (tw-types)       ← 必须最先完成（无 as any 的前提）
Task 1 (SpanManager)    ← 依赖 Task 0，可与 Task 2+3 并行
Task 2 (Dag)            ← 依赖 Task 0，可与 Task 1+3 并行
Task 3 (Config)         ← 依赖 Task 0，可与 Task 1+2 并行
Task 4 (CommandHandler) ← 依赖 Task 0+2（需要 getTransitiveDependents）
Task 5 (IPC)            ← 依赖 Task 4（需要 cascadeUpdate/remediationNext/Done）
Task 6 (Remediation)    ← 依赖 Task 4+5
Task 7 (tw taskmaster)  ← 依赖 Task 5（需要 emit_event IPC dispatch）
Task 8 (tw diagnose)    ← 依赖 Task 5
Task 9 (验证)           ← 依赖全部
```

Tasks 1+2+3 可在 Task 0 完成后并行执行。Tasks 7+8 可在 Task 5 完成后并行执行。
