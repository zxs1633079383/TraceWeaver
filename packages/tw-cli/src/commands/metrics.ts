// packages/tw-cli/src/commands/metrics.ts
import { Command } from 'commander'
import { sendIpc } from '../ipc-client.js'
import { ensureDaemon } from '../daemon-manager.js'

export function metricsCommand(): Command {
  return new Command('metrics')
    .description('Show span-derived metrics (cycle time, failure rate, throughput)')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        await ensureDaemon()
        const res = await sendIpc({ method: 'get_metrics', params: {} })
        if (!res.ok) { console.error(`Error: ${(res as any).error.message}`); process.exit(1) }
        const m = (res as any).data as any
        if (opts.json) { console.log(JSON.stringify(m, null, 2)); return }
        const fr = m.failureRate as { rejected: number; total: number; rate: number }
        const tp = m.throughput as { completed: number; perHour: number }
        console.log(`Failure rate:  ${fr.rejected}/${fr.total} (${(fr.rate * 100).toFixed(1)}%)`)
        console.log(`Throughput:    ${tp.completed} completed in window  (${tp.perHour.toFixed(2)}/hr)`)
        console.log(`Active spans:  ${m.activeSpans}`)
        console.log(`Total spans:   ${m.spanCount}`)
      } catch (err: any) { console.error(`Error: ${err.message}`); process.exit(1) }
    })
}
