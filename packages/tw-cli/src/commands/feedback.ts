// packages/tw-cli/src/commands/feedback.ts
import { Command } from 'commander'
import { sendIpc } from '../ipc-client.js'
import { ensureDaemon } from '../daemon-manager.js'

export function feedbackCommand(): Command {
  const cmd = new Command('feedback').description('Query harness evaluation history and summaries')

  // tw feedback query [--harness-id <id>] [--entity-id <id>] [--result pass|fail|skipped]
  //                   [--since <iso>] [--limit <n>] [--json]
  cmd.command('query')
    .description('Query feedback log entries')
    .option('--harness-id <id>', 'Filter by harness ID')
    .option('--entity-id <id>', 'Filter by entity ID')
    .option('--result <r>', 'Filter by result (pass|fail|skipped)')
    .option('--since <iso>', 'Filter entries since ISO timestamp')
    .option('--limit <n>', 'Maximum number of entries', '20')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        await ensureDaemon()
        const params: Record<string, unknown> = {}
        if (opts.harnessId) params.harness_id = opts.harnessId
        if (opts.entityId)  params.entity_id  = opts.entityId
        if (opts.result)    params.result      = opts.result
        if (opts.since)     params.since       = opts.since
        if (opts.limit)     params.limit       = parseInt(opts.limit, 10)
        const res = await sendIpc({ method: 'feedback_query', params })
        if (!res.ok) { console.error(`Error: ${(res as any).error.message}`); process.exit(1) }
        const entries = (res as any).data as any[]
        if (opts.json) { console.log(JSON.stringify(entries, null, 2)); return }
        if (entries.length === 0) { console.log('No feedback entries found'); return }
        for (const e of entries) {
          const icon = e.result === 'pass' ? '✓' : e.result === 'fail' ? '✗' : '–'
          console.log(`${icon} [${e.ts as string}] ${e.harness_id as string}  entity=${e.entity_id as string}  ${(e.reason as string).slice(0, 60)}`)
        }
      } catch (err: any) { console.error(`Error: ${err.message}`); process.exit(1) }
    })

  // tw feedback summary [--harness-id <id>] [--json]
  cmd.command('summary')
    .description('Show harness evaluation summaries')
    .option('--harness-id <id>', 'Show summary for a specific harness')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        await ensureDaemon()
        const params: Record<string, unknown> = {}
        if (opts.harnessId) params.harness_id = opts.harnessId
        const res = await sendIpc({ method: 'feedback_summary', params })
        if (!res.ok) { console.error(`Error: ${(res as any).error.message}`); process.exit(1) }
        const data = (res as any).data
        if (opts.json) { console.log(JSON.stringify(data, null, 2)); return }
        const summaries = Array.isArray(data) ? data : [data]
        if (summaries.length === 0) { console.log('No feedback summaries available'); return }
        for (const s of summaries as any[]) {
          const trend = s.trend === 'improving' ? '↑' : s.trend === 'degrading' ? '↓' : '→'
          console.log(`${s.harness_id as string}  total=${s.total as number}  pass=${s.pass as number}  fail=${s.fail as number}  consecutive_failures=${s.consecutive_failures as number}  trend=${trend}`)
        }
      } catch (err: any) { console.error(`Error: ${err.message}`); process.exit(1) }
    })

  return cmd
}
