// packages/tw-cli/src/commands/watch.ts
import { Command } from 'commander'
import { sendIpc } from '../ipc-client.js'
import { ensureDaemon } from '../daemon-manager.js'

export function watchCommand(): Command {
  return new Command('watch')
    .description('Stream live events from the daemon (Ctrl+C to stop)')
    .option('--entity <id>', 'Filter by entity ID')
    .option('--json', 'Output raw JSON lines')
    .action(async (opts) => {
      try {
        await ensureDaemon()
        console.log('Watching events (Ctrl+C to stop)...\n')
        let lastSince = new Date().toISOString()
        const poll = async () => {
          const res = await sendIpc({
            method: 'log_query',
            params: { entity_id: opts.entity, since: lastSince, limit: 100 },
          })
          if (!res.ok) return
          const events = (res as any).data as any[]
          for (const ev of events) {
            if ((ev.ts as string) > lastSince) lastSince = ev.ts as string
            if (opts.json) { console.log(JSON.stringify(ev)); continue }
            const entity = ev.entity_id ? ` [${ev.entity_id as string}]` : ''
            const state = ev.state ? ` → ${ev.state as string}` : ''
            console.log(`${(ev.ts as string).slice(0, 19)}  ${ev.type as string}${entity}${state}`)
          }
        }
        const timer = setInterval(() => void poll().catch(() => {}), 500)
        process.on('SIGINT', () => { clearInterval(timer); process.exit(0) })
      } catch (err: any) { console.error(`Error: ${err.message}`); process.exit(1) }
    })
}
