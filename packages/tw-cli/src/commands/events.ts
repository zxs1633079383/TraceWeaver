import { Command } from 'commander'
import { sendIpc } from '../ipc-client.js'
import { ensureDaemon } from '../daemon-manager.js'

export function eventsCommand(): Command {
  return new Command('events')
    .description('Query event history')
    .argument('[entity-id]', 'Filter by entity ID')
    .option('--since <iso>', 'Filter events since ISO timestamp')
    .option('--limit <n>', 'Maximum number of events', '50')
    .option('--json', 'Output as JSON')
    .action(async (entityId, opts) => {
      try {
        await ensureDaemon()
        const res = await sendIpc({
          method: 'query_events',
          params: {
            entity_id: entityId,
            since: opts.since,
            limit: parseInt(opts.limit, 10),
          }
        })
        if (res.ok) {
          const events = (res as any).data as any[]
          if (opts.json) { console.log(JSON.stringify(events, null, 2)); return }
          if (events.length === 0) { console.log('No events found'); return }
          for (const ev of events) {
            const entity = ev.entity_id ? ` [${ev.entity_id}]` : ''
            const state = ev.state ? ` → ${ev.state}` : ''
            console.log(`${ev.ts.slice(0, 19)} ${ev.type}${entity}${state}`)
          }
        } else { console.error(`Error: ${(res as any).error.message}`); process.exit(1) }
      } catch (err: any) { console.error(`Error: ${err.message}`); process.exit(1) }
    })
}
