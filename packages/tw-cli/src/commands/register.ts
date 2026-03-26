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
    .action(async (id: string, opts: any) => {
      await ensureDaemonRunning()
      const client = new IpcClient(getSocketPath())
      const res = await client.send({
        method: 'register',
        params: { entity_type: 'plan', id, parent_id: opts.parent, domain: opts.domain },
      })
      if (res.ok) console.log(formatEntity(res.data as any))
      else        { console.error(res.error.message); process.exit(1) }
    })

  cmd.command('task <id>')
    .requiredOption('--parent <id>',       'Parent Plan id')
    .option('--depends-on <ids...>',       'Dependency task ids')
    .action(async (id: string, opts: any) => {
      await ensureDaemonRunning()
      const client = new IpcClient(getSocketPath())
      const res = await client.send({
        method: 'register',
        params: { entity_type: 'task', id, parent_id: opts.parent,
                  depends_on: opts.dependsOn },
      })
      if (res.ok) console.log(formatEntity(res.data as any))
      else        { console.error(res.error.message); process.exit(1) }
    })
}

function collect(val: string, prev: string[]) { prev.push(val); return prev }
