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
