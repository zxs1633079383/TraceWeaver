// packages/tw-cli/src/commands/log.ts
import { Command } from 'commander'
import { sendIpc } from '../ipc-client.js'
import { ensureDaemon } from '../daemon-manager.js'

export function logCommand(): Command {
  const cmd = new Command('log').description('Query persisted event log')

  cmd.command('query')
    .description('Query event log with filters')
    .option('--entity <id>', 'Filter by entity ID')
    .option('--type <type>', 'Filter by event type')
    .option('--since <value>', 'Filter events since ISO timestamp or shorthand (e.g. 1h, 24h, 7d)')
    .option('--limit <n>', 'Maximum number of events to return', '50')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        await ensureDaemon()
        // Parse --since shorthand: '1h', '24h', '7d' → ISO timestamp
        let since = opts.since as string | undefined
        if (since && /^\d+[hmd]$/.test(since)) {
          const units: Record<string, number> = { h: 3600000, m: 60000, d: 86400000 }
          const unit = since.slice(-1)
          const n = parseInt(since.slice(0, -1), 10)
          since = new Date(Date.now() - n * (units[unit] ?? 3600000)).toISOString()
        }
        const res = await sendIpc({
          method: 'log_query',
          params: { entity_id: opts.entity, event_type: opts.type, since, limit: parseInt(opts.limit as string, 10) },
        })
        if (!res.ok) { console.error(`Error: ${(res as any).error.message}`); process.exit(1) }
        const events = (res as any).data as any[]
        if (opts.json) { console.log(JSON.stringify(events, null, 2)); return }
        if (events.length === 0) { console.log('No events found'); return }
        for (const ev of events) {
          const entity = ev.entity_id ? ` [${ev.entity_id}]` : ''
          const state = ev.state ? ` → ${ev.state}` : ''
          console.log(`${(ev.ts as string).slice(0, 19)}  seq=${ev.seq}  ${ev.type}${entity}${state}`)
        }
      } catch (err: any) { console.error(`Error: ${err.message}`); process.exit(1) }
    })

  return cmd
}
