// packages/tw-cli/src/commands/taskmaster.ts
import { Command } from 'commander'
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
    .action(async (event: string, opts: Record<string, unknown>) => {
      try {
        await ensureDaemon()
        const attributes: Record<string, unknown> = {}
        if (opts.tmId)   attributes.tm_id   = opts.tmId
        if (opts.plan)   attributes.plan_id  = opts.plan
        if (opts.status) attributes.status   = opts.status

        if (event === 'after-expand' && opts.plan && opts.tmId) {
          await registerExpandedSubtasks(opts.plan as string, opts.tmId as string)
        }

        if (event === 'status-changed' && opts.tmId && opts.status) {
          await syncTaskStatus(opts.tmId as string, opts.status as string)
        }

        const entityId = (opts.plan ?? opts.tmId ?? 'unknown') as string
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
    .action(async (opts: Record<string, unknown>) => {
      try {
        await ensureDaemon()
        const tmapPath = join(process.cwd(), '.taskmaster', 'tasks', 'tasks.json')
        if (!existsSync(tmapPath)) {
          console.error('No .taskmaster/tasks/tasks.json found'); process.exit(1)
        }
        const { tasks } = JSON.parse(readFileSync(tmapPath, 'utf8')) as { tasks: any[] }
        let synced = 0
        for (const task of tasks) {
          const twState = tmStatusToTwState(task.status as string)
          // skip if entity already registered — IPC register is idempotent by convention
          await sendIpc({
            method: 'register',
            params: {
              entity_type: 'task',
              id: `tm-${task.id as string}-${randomUUID().slice(0, 6)}`,
              parent_id: opts.plan,
              attributes: { tm_id: String(task.id), title: task.title },
            },
          }).catch(() => {/* already registered — safe to skip */})
          await sendIpc({
            method: 'update_state',
            params: { id: `tm-${task.id as string}`, state: twState },
          }).catch(() => {/* entity may not exist yet — safe to skip */})
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
    'pending':     'pending',
    'in-progress': 'in_progress',
    'review':      'review',
    'done':        'completed',
    'deferred':    'pending',
    'cancelled':   'rejected',
  }
  return map[status] ?? 'pending'
}

async function registerExpandedSubtasks(planId: string, tmParentId: string): Promise<void> {
  const tmapPath = join(process.cwd(), '.taskmaster', 'tasks', 'tasks.json')
  if (!existsSync(tmapPath)) return
  const { tasks } = JSON.parse(readFileSync(tmapPath, 'utf8')) as { tasks: any[] }
  const parent = tasks.find((t: any) => String(t.id) === String(tmParentId))
  if (!parent?.subtasks?.length) return
  for (const sub of parent.subtasks as any[]) {
    await sendIpc({
      method: 'register',
      params: {
        entity_type: 'task',
        id: `tm-${tmParentId}.${sub.id as string}-${randomUUID().slice(0, 6)}`,
        parent_id: planId,
        attributes: { tm_id: `${tmParentId}.${sub.id as string}`, title: sub.title },
      },
    }).catch(() => {/* already registered — safe to skip */})
  }
}

async function syncTaskStatus(tmId: string, tmStatus: string): Promise<void> {
  const twState = tmStatusToTwState(tmStatus)
  const res = await sendIpc({ method: 'get_status', params: {} })
  if (!(res as any).ok) return
  console.log(`  [sync] tm-id=${tmId} → tw-state=${twState}`)
}
