/**
 * Example 08 — Edge Case: Propagator Bubble-Up and Cascade-Down
 *
 * Demonstrates the Propagator without any I/O or CommandHandler:
 *   - Builds an in-memory entity tree (usecase → plans → tasks)
 *   - Calls bubbleUp() as tasks complete and shows how parent state
 *     rolls up automatically once all siblings are done
 *   - Calls cascadeDown() to show downward state rejection
 *
 * Entity tree:
 *   usecase-1  (pending)
 *   ├── plan-1 (pending)
 *   │   ├── task-1 (pending)
 *   │   └── task-2 (pending)
 *   └── plan-2 (pending)
 *       └── task-3 (pending)
 */

import { Propagator } from '../../packages/tw-daemon/src/core/propagator/propagator.js'
import type { Entity } from '@traceweaver/types'

function makeEntity(id: string, entity_type: Entity['entity_type'], parent_id?: string): Entity {
  const now = new Date().toISOString()
  return { id, entity_type, state: 'pending', parent_id, created_at: now, updated_at: now }
}

async function main(): Promise<void> {
  console.log('\n── Propagator Bubble-Up and Cascade-Down ──')

  // ── Build entity tree ────────────────────────────────────────────────────
  console.log('\n── Entity tree ──')
  const entities: Entity[] = [
    makeEntity('usecase-1', 'usecase'),
    makeEntity('plan-1',    'plan',  'usecase-1'),
    makeEntity('plan-2',    'plan',  'usecase-1'),
    makeEntity('task-1',    'task',  'plan-1'),
    makeEntity('task-2',    'task',  'plan-1'),
    makeEntity('task-3',    'task',  'plan-2'),
  ]
  for (const e of entities) {
    const indent = e.entity_type === 'usecase' ? '' : e.entity_type === 'plan' ? '  ' : '    '
    console.log(`  ${indent}${e.id}  [${e.entity_type}]  parent=${e.parent_id ?? 'none'}`)
  }

  // Propagator works on the snapshot — we manually update entity.state to simulate
  // the CommandHandler applying changes before re-constructing the Propagator.
  // We use a mutable helper map for this demonstration.
  const byId = new Map(entities.map(e => [e.id, e]))

  function applyState(id: string, state: Entity['state']): void {
    const e = byId.get(id)!
    byId.set(id, { ...e, state })
  }

  // ── Step 1: Complete task-1 ──────────────────────────────────────────────
  console.log('\n── Step 1: Complete task-1 ──')
  applyState('task-1', 'completed')
  let propagator = new Propagator([...byId.values()])
  const result1 = propagator.bubbleUp('task-1', 'completed', 'pending')

  console.log(`  bubbleUp result:  updated=${result1.updated.length}  progress_updates=${result1.progress_updates.length}`)
  for (const upd of result1.updated) {
    console.log(`    UPDATED: ${upd.id}  ${upd.previous_state} → ${upd.new_state}`)
    applyState(upd.id, upd.new_state)
  }
  for (const prog of result1.progress_updates) {
    console.log(`    PROGRESS: ${prog.id}  ${prog.done}/${prog.total} done`)
  }
  console.log('  plan-1 still has task-2 pending — no bubble-up yet (expected)')

  // ── Step 2: Complete task-2 (plan-1 should auto-complete → bubble to usecase) ──
  console.log('\n── Step 2: Complete task-2 ──')
  applyState('task-2', 'completed')
  propagator = new Propagator([...byId.values()])
  const result2 = propagator.bubbleUp('task-2', 'completed', 'pending')

  console.log(`  bubbleUp result:  updated=${result2.updated.length}  progress_updates=${result2.progress_updates.length}`)
  for (const upd of result2.updated) {
    console.log(`    UPDATED: ${upd.id}  ${upd.previous_state} → ${upd.new_state}`)
    applyState(upd.id, upd.new_state)
  }
  for (const prog of result2.progress_updates) {
    console.log(`    PROGRESS: ${prog.id}  ${prog.done}/${prog.total} done`)
  }
  const plan1State = byId.get('plan-1')!.state
  const usecase1StateAfterStep2 = byId.get('usecase-1')!.state
  console.log(`  plan-1 state:     ${plan1State}  (expected: completed)`)
  console.log(`  usecase-1 state:  ${usecase1StateAfterStep2}  (expected: pending — plan-2 still active)`)

  // ── Step 3: Complete task-3 (plan-2 completes → usecase-1 completes) ─────
  console.log('\n── Step 3: Complete task-3 ──')
  applyState('task-3', 'completed')
  propagator = new Propagator([...byId.values()])
  const result3 = propagator.bubbleUp('task-3', 'completed', 'pending')

  console.log(`  bubbleUp result:  updated=${result3.updated.length}  progress_updates=${result3.progress_updates.length}`)
  for (const upd of result3.updated) {
    console.log(`    UPDATED: ${upd.id}  ${upd.previous_state} → ${upd.new_state}`)
    applyState(upd.id, upd.new_state)
  }
  for (const prog of result3.progress_updates) {
    console.log(`    PROGRESS: ${prog.id}  ${prog.done}/${prog.total} done`)
  }
  const plan2State = byId.get('plan-2')!.state
  const usecase1FinalState = byId.get('usecase-1')!.state
  console.log(`  plan-2 state:     ${plan2State}   (expected: completed)`)
  console.log(`  usecase-1 state:  ${usecase1FinalState}  (expected: completed)`)

  // ── Step 4: cascadeDown — reject usecase-1 and all descendants ───────────
  console.log('\n── Step 4: cascadeDown — reject usecase-1 ──')

  // Reset all to completed to demonstrate cascade
  for (const e of byId.values()) applyState(e.id, 'completed')
  applyState('usecase-1', 'completed')
  propagator = new Propagator([...byId.values()])

  const cascadeResult = propagator.cascadeDown('usecase-1', 'rejected')
  console.log(`  cascadeDown result: updated=${cascadeResult.updated.length}`)
  for (const upd of cascadeResult.updated) {
    console.log(`    ${upd.id}  ${upd.previous_state} → ${upd.new_state}`)
    applyState(upd.id, upd.new_state)
  }

  console.log('\n  Final entity states after cascade:')
  for (const e of byId.values()) {
    const indent = e.entity_type === 'usecase' ? '' : e.entity_type === 'plan' ? '  ' : '    '
    console.log(`    ${indent}${e.id}  state=${byId.get(e.id)!.state}`)
  }

  console.log('\n✓ Example complete\n')
}

main().catch(console.error)
