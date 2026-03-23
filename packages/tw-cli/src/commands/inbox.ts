import { Command } from 'commander'
import { sendIpc } from '../ipc-client.js'
import { ensureDaemon } from '../daemon-manager.js'

export function inboxCommand(): Command {
  return new Command('inbox')
    .description('View and manage notification inbox')
    .option('--ack <id>', 'Acknowledge an inbox item by ID')
    .option('--unread', 'Show only unread items')
    .action(async (opts) => {
      try {
        await ensureDaemon()
        if (opts.ack) {
          const res = await sendIpc({ method: 'inbox_ack', params: { id: opts.ack } })
          if (res.ok) console.log(`Acknowledged: ${opts.ack}`)
          else { console.error(`Error: ${(res as any).error.message}`); process.exit(1) }
        } else {
          const res = await sendIpc({ method: 'inbox_list', params: { unackedOnly: !!opts.unread } })
          if (res.ok) {
            const items = (res as any).data as Array<{ id: string; ts: string; message: string; acked: boolean }>
            if (items.length === 0) { console.log('No notifications'); return }
            for (const item of items) {
              const ack = item.acked ? '[read] ' : '[NEW]  '
              console.log(`${ack} ${item.ts.slice(0, 19)} ${item.message} (id: ${item.id.slice(0, 8)})`)
            }
          } else { console.error(`Error: ${(res as any).error.message}`); process.exit(1) }
        }
      } catch (err: any) {
        console.error(`Error: ${err.message}`)
        process.exit(1)
      }
    })
}
