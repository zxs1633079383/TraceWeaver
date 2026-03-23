// packages/tw-cli/src/commands/metrics.ts
import { Command } from 'commander'
import { sendIpc } from '../ipc-client.js'
import { ensureDaemon } from '../daemon-manager.js'

export function metricsCommand(): Command {
  return new Command('metrics')
    .description('Show span-derived metrics (cycle time, failure rate, throughput)')
    .option('--type <entityType>', 'Filter by entity type (task, usecase, plan, milestone)')
    .option('--window <hours>', 'Throughput window in hours (default: 24)', '24')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        await ensureDaemon()
        const params: Record<string, unknown> = {}
        if (opts.type) params.entity_type = opts.type
        if (opts.window) params.window_ms = parseFloat(opts.window) * 3_600_000
        const res = await sendIpc({ method: 'get_metrics', params })
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
