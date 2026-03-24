// packages/tw-cli/src/commands/harness.ts
import { Command } from 'commander'
import { sendIpc } from '../ipc-client.js'
import { ensureDaemon } from '../daemon-manager.js'

export function harnessCommand(): Command {
  const cmd = new Command('harness').description('Manage and run constraint harnesses')

  cmd.command('list')
    .description('List all loaded harness files')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        await ensureDaemon()
        const res = await sendIpc({ method: 'harness_list', params: {} })
        if (!res.ok) { console.error(`Error: ${(res as any).error.message}`); process.exit(1) }
        const entries = (res as any).data as any[]
        if (opts.json) { console.log(JSON.stringify(entries, null, 2)); return }
        if (entries.length === 0) {
          console.log('No harness files loaded  (create .traceweaver/harness/*.md)')
          return
        }
        for (const e of entries) {
          console.log(`${(e.id as string).padEnd(24)}  applies_to=${(e.applies_to as string[]).join(',')}  trigger_on=${(e.trigger_on as string[]).join(',')}`)
        }
      } catch (err: any) { console.error(`Error: ${err.message}`); process.exit(1) }
    })

  cmd.command('show <id>')
    .description('Show harness content')
    .option('--json', 'Output as JSON')
    .action(async (id: string, opts) => {
      try {
        await ensureDaemon()
        const res = await sendIpc({ method: 'harness_show', params: { id } })
        if (!res.ok) { console.error(`Error: ${(res as any).error.message}`); process.exit(1) }
        const entry = (res as any).data as any
        if (opts.json) { console.log(JSON.stringify(entry, null, 2)); return }
        console.log(`# ${entry.id as string}\n`)
        console.log(`applies_to:  ${(entry.applies_to as string[]).join(', ')}`)
        console.log(`trigger_on:  ${(entry.trigger_on as string[]).join(', ')}`)
        console.log(`\n${entry.content as string}`)
      } catch (err: any) { console.error(`Error: ${err.message}`); process.exit(1) }
    })

  cmd.command('run <entity-id>')
    .description('Manually run a harness against an entity')
    .requiredOption('--harness-id <id>', 'Harness ID to run')
    .option('--json', 'Output as JSON')
    .action(async (entityId: string, opts) => {
      try {
        await ensureDaemon()
        const res = await sendIpc({ method: 'harness_run', params: { entity_id: entityId, harness_id: opts.harnessId } })
        if (!res.ok) { console.error(`Error: ${(res as any).error.message}`); process.exit(1) }
        const result = (res as any).data as any
        if (opts.json) { console.log(JSON.stringify(result, null, 2)); return }
        const icon = result.result === 'pass' ? '✓' : result.result === 'fail' ? '✗' : '–'
        console.log(`${icon} ${(result.result as string).toUpperCase()}  (checked at ${result.checked_at as string})`)
        for (const ref of (result.refs_checked ?? []) as any[]) {
          const r = ref.result === 'pass' ? '✓' : ref.result === 'fail' ? '✗' : '–'
          console.log(`  ${r} ${ref.ref as string}: ${ref.note as string}`)
        }
      } catch (err: any) { console.error(`Error: ${err.message}`); process.exit(1) }
    })

  cmd.command('validate')
    .description('Validate harness-entity alignment (orphaned refs, dead harnesses, persistent failures)')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        await ensureDaemon()
        const res = await sendIpc({ method: 'harness_validate', params: {} })
        if (!res.ok) { console.error(`Error: ${(res as any).error.message}`); process.exit(1) }
        const issues = (res as any).data as any[]
        if (opts.json) { console.log(JSON.stringify(issues, null, 2)); return }
        if (issues.length === 0) { console.log('✓ No alignment issues found'); return }
        for (const issue of issues) {
          const prefix = issue.severity === 'error' ? '✗' : '⚠'
          const target = issue.entity_id ? `entity=${issue.entity_id as string}` : `harness=${issue.harness_id as string}`
          console.log(`${prefix} [${issue.type as string}] ${target}: ${issue.message as string}`)
          if (issue.suggestion) console.log(`    → ${issue.suggestion as string}`)
        }
        const errors = (issues as any[]).filter(i => i.severity === 'error').length
        if (errors > 0) process.exit(1)
      } catch (err: any) { console.error(`Error: ${err.message}`); process.exit(1) }
    })

  return cmd
}
