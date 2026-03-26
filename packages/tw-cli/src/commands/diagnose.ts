// packages/tw-cli/src/commands/diagnose.ts
import { Command } from 'commander'
import { readFileSync, existsSync } from 'node:fs'
import { sendIpc } from '../ipc-client.js'
import { ensureDaemon } from '../daemon-manager.js'

export function diagnoseCommand(): Command {
  const cmd = new Command('diagnose')
    .description('Fast problem localization for rejected or failed entities')
    .argument('[entity-id]', 'Entity ID to diagnose')
    .option('--trace',           'Show full trace tree from root entity')
    .option('--from-log <file>', 'Parse error.log and diagnose matching entities')
    .option('--json',            'Output as JSON')

  cmd.action(async (entityId: string | undefined, opts: Record<string, unknown>) => {
    try {
      await ensureDaemon()

      if (opts.fromLog) {
        await diagnoseFromLog(opts.fromLog as string, opts.json as boolean)
        return
      }
      if (!entityId) { console.error('Provide an entity-id or --from-log'); process.exit(1) }

      if (opts.trace) {
        await diagnoseTrace(entityId, opts.json as boolean)
      } else {
        await diagnoseSingle(entityId, opts.json as boolean)
      }
    } catch (err: any) { console.error(`Error: ${err.message}`); process.exit(1) }
  })

  return cmd
}

async function diagnoseSingle(entityId: string, asJson: boolean): Promise<void> {
  const [statusRes, eventsRes] = await Promise.all([
    sendIpc({ method: 'get_status', params: { id: entityId } }),
    sendIpc({ method: 'query_events', params: { entity_id: entityId, limit: 50 } }),
  ])

  const entity   = (statusRes  as any).ok ? (statusRes  as any).data?.entity : null
  const events   = (eventsRes  as any).ok ? (eventsRes  as any).data  ?? []  : []

  if (asJson) { console.log(JSON.stringify({ entity, events }, null, 2)); return }

  if (!entity) { console.error(`Entity ${entityId} not found`); process.exit(1) }

  const stateIcon = entity.state === 'rejected' ? '!' : entity.state === 'completed' ? 'v' : 'o'
  console.log(`\n--- Entity: ${entityId} ---`)
  console.log(`Type:   ${entity.entity_type as string}`)
  console.log(`State:  ${stateIcon} ${entity.state as string}`)

  if ((events as any[]).length) {
    console.log(`\n--- Span Events ---`)
    for (const e of events as any[]) {
      const warn = (e.type as string).includes('rejected') ? ' <- !' : ''
      console.log(`  ${(e.ts as string).slice(11, 19)}  ${e.type as string}${warn}`)
      if (e.attributes) {
        for (const [k, v] of Object.entries(e.attributes as Record<string, unknown>)) {
          console.log(`           ${k}=${JSON.stringify(v)}`)
        }
      }
    }
  }

  if (entity.artifact_refs?.length) {
    console.log(`\n--- Artifact Refs ---`)
    for (const ref of entity.artifact_refs as any[]) {
      const exists = existsSync(ref.path as string)
      console.log(`  ${exists ? 'v' : 'x'}  ${ref.type as string}  ${ref.path as string}`)
    }
  }
  console.log('')
}

async function diagnoseTrace(entityId: string, asJson: boolean): Promise<void> {
  const [dagRes, statusRes] = await Promise.all([
    sendIpc({ method: 'get_dag', params: {} }),
    sendIpc({ method: 'get_status', params: {} }),
  ])
  if (!(dagRes as any).ok || !(statusRes as any).ok) {
    console.error('Failed to fetch DAG or status'); process.exit(1)
  }
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
  const icon = entity.state === 'rejected' ? '!' : entity.state === 'completed' ? 'v' : 'o'
  console.log(`${prefix}${entity.entity_type as string}: ${entity.id as string}  ${icon} ${entity.state as string}`)
  const children = all.filter((e: any) => e.parent_id === entity.id)
  for (const child of children) printTree(child, all, prefix + '  |- ')
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
    console.log(`\n-- Diagnosing ${id} --`)
    await diagnoseSingle(id, asJson)
  }
}
