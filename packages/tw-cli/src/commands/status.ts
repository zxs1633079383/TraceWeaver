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
