/**
 * Example 03 — Basic DAG Dependencies
 *
 * Demonstrates how to:
 *   1. Register a parent usecase
 *   2. Register child tasks with parent_id to express hierarchy
 *   3. Register a task with depends_on to express an execution dependency
 *   4. Inspect the DAG via getDagSnapshot() — nodes and edges
 *   5. Query getStatus({ id }) to see the usecase and its children
 *   6. Clean up
 *
 * Dependency graph built in this example:
 *
 *   usecase-1
 *     ├── task-1  (no deps)
 *     ├── task-2  (no deps)
 *     └── task-3  depends_on: [task-2]   → task-3 must wait for task-2
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandHandler } from '../../packages/tw-daemon/src/core/command-handler.js'

async function main(): Promise<void> {
  console.log('\n── DAG Dependencies Demo ──')

  // ── Step 1: Create temp store ────────────────────────────────────────────
  const storeDir = await mkdtemp(join(tmpdir(), 'tw-example-03-'))
  console.log(`\n  storeDir: ${storeDir}`)

  const handler = new CommandHandler({ storeDir })
  await handler.init()

  try {
    // ── Step 2: Register parent usecase ─────────────────────────────────
    console.log('\n── Step 2: Register usecase (parent) ──')
    await handler.register({
      id: 'usecase-1',
      entity_type: 'usecase',
      attributes: { title: 'Implement Payment Flow' },
    })
    console.log('  Registered: usecase-1 (usecase)')

    // ── Step 3: Register task-1 under usecase-1 ─────────────────────────
    console.log('\n── Step 3: Register task-1 (child of usecase-1) ──')
    await handler.register({
      id: 'task-1',
      entity_type: 'task',
      parent_id: 'usecase-1',
      attributes: { title: 'Design DB schema' },
    })
    console.log('  Registered: task-1 (task, parent=usecase-1)')

    // ── Step 4: Register task-2 under usecase-1 ─────────────────────────
    console.log('\n── Step 4: Register task-2 (child of usecase-1) ──')
    await handler.register({
      id: 'task-2',
      entity_type: 'task',
      parent_id: 'usecase-1',
      attributes: { title: 'Implement payment API' },
    })
    console.log('  Registered: task-2 (task, parent=usecase-1)')

    // ── Step 5: Register task-3 that depends on task-2 ──────────────────
    // task-3 cannot start until task-2 is completed
    console.log('\n── Step 5: Register task-3 (depends_on: task-2) ──')
    await handler.register({
      id: 'task-3',
      entity_type: 'task',
      parent_id: 'usecase-1',
      depends_on: ['task-2'],
      attributes: { title: 'Write integration tests' },
    })
    console.log('  Registered: task-3 (task, parent=usecase-1, depends_on=[task-2])')

    // ── Step 6: Inspect DAG snapshot ────────────────────────────────────
    console.log('\n── Step 6: getDagSnapshot() ──')
    const snapshot = handler.getDagSnapshot()

    const nodeStr = snapshot.nodes
      .map(n => `${n.id} (${n.entity_type})`)
      .join(', ')
    console.log(`  Nodes: ${nodeStr}`)

    if (snapshot.edges.length === 0) {
      console.log('  Edges: (none)')
    } else {
      console.log('  Edges:')
      for (const edge of snapshot.edges) {
        // edge.from depends on edge.to, so from must wait for to
        console.log(`    ${edge.from} → ${edge.to}`)
      }
    }

    // ── Step 7: Query usecase status to show children ────────────────────
    console.log('\n── Step 7: getStatus({ id: "usecase-1" }) ──')
    const status = await handler.getStatus({ id: 'usecase-1' })
    console.log(`  entity.id:    ${status.entity.id}`)
    console.log(`  entity.state: ${status.entity.state}`)
    console.log(`  children (${status.children.length}):`)
    for (const child of status.children) {
      const deps = (child.depends_on ?? []).join(', ') || '—'
      console.log(`    ${child.id} (${child.entity_type})  state=${child.state}  depends_on=[${deps}]`)
    }

    // ── Step 8: Overall summary ──────────────────────────────────────────
    console.log('\n── Step 8: getStatus() overall summary ──')
    const summary = await handler.getStatus({})
    console.log(`  total:   ${summary.total}`)
    console.log(`  done:    ${summary.done}`)
    console.log(`  percent: ${summary.percent}%`)

  } finally {
    // ── Cleanup ───────────────────────────────────────────────────────────
    await rm(storeDir, { recursive: true, force: true })
    console.log(`\n  Cleaned up storeDir: ${storeDir}`)
  }

  console.log('\n✓ Example complete\n')
}

main().catch(console.error)
