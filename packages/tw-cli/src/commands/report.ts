// packages/tw-cli/src/commands/report.ts
import { Command } from 'commander'
import { readFile } from 'node:fs/promises'
import { ensureDaemon } from '../daemon-manager.js'
import { sendIpc } from '../ipc-client.js'

export function reportCommand(): Command {
  const cmd = new Command('report').description('日报生成与查看')

  cmd
    .command('daily')
    .description('生成日报')
    .option('--trace-id <id>', '指定 Trace ID')
    .option('--all', '为所有 trace 生成报告')
    .option('--output-dir <dir>', '输出目录（覆盖配置）')
    .option('--json', '输出 JSON')
    .action(async (opts) => {
      try {
        await ensureDaemon()
        const res = await sendIpc({ method: 'report_generate', params: {
          trace_id: opts.traceId, all: opts.all,
        }})
        if (!res.ok) { console.error(res.error); process.exit(1) }
        if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); return }
        console.log('报告已生成：')
        for (const p of (res.data as { paths: string[] }).paths) console.log(' ', p)
      } catch (err) { console.error(String(err)); process.exit(1) }
    })

  cmd
    .command('list')
    .description('列出已生成的报告')
    .option('--date <date>', '按日期过滤 (YYYY-MM-DD)')
    .option('--json', '输出 JSON')
    .action(async (opts) => {
      try {
        await ensureDaemon()
        const res = await sendIpc({ method: 'report_list', params: { date: opts.date }})
        if (!res.ok) { console.error(res.error); process.exit(1) }
        if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); return }
        const reports = (res.data as { reports: Array<{ date: string; trace_id?: string; path: string }> }).reports
        if (reports.length === 0) { console.log('无报告'); return }
        for (const r of reports) {
          console.log(`${r.date}  ${(r.trace_id ?? '').padEnd(10)}  ${r.path}`)
        }
      } catch (err) { console.error(String(err)); process.exit(1) }
    })

  cmd
    .command('show')
    .description('查看报告内容')
    .option('--trace-id <id>', 'Trace ID（前 8 位匹配）')
    .option('--date <date>', '日期 (YYYY-MM-DD，默认今天)')
    .option('--json', '输出 JSON')
    .action(async (opts) => {
      try {
        await ensureDaemon()
        const date = opts.date ?? new Date().toISOString().slice(0, 10)
        const res = await sendIpc({ method: 'report_list', params: { date }})
        if (!res.ok) { console.error(res.error); process.exit(1) }
        const prefix = opts.traceId?.slice(0, 8)
        const reports = (res.data as { reports: Array<{ trace_id: string; path: string }> }).reports
        const match = prefix ? reports.find(r => r.trace_id.startsWith(prefix)) : reports[0]
        if (!match) { console.log('未找到报告'); return }
        if (opts.json) { console.log(JSON.stringify(match, null, 2)); return }
        const content = await readFile(match.path, 'utf-8')
        console.log(content)
      } catch (err) { console.error(String(err)); process.exit(1) }
    })

  return cmd
}
