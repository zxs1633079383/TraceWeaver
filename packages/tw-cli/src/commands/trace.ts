// packages/tw-cli/src/commands/trace.ts
import { Command } from 'commander'
import { sendIpc } from '../ipc-client.js'
import { ensureDaemon } from '../daemon-manager.js'
import { renderSpanTree, renderTraceInfo } from '../output/trace-renderer.js'
import type { SpanTreeNode, TraceInfo } from '@traceweaver/types'

interface SpansResponse {
  trace_id: string
  tree: SpanTreeNode
}

export function traceCommand(): Command {
  const cmd = new Command('trace').description('Trace 链路查询与详情')

  cmd
    .command('spans')
    .description('展示 Trace Span 树')
    .option('--trace-id <id>', 'Trace ID')
    .option('--entity-id <id>', '实体 ID（自动推断 trace_id）')
    .option('--json', '输出 JSON')
    .action(async (opts) => {
      try {
        await ensureDaemon()
        const res = await sendIpc<SpansResponse>({ method: 'trace_spans', params: {
          trace_id: opts.traceId, entity_id: opts.entityId,
        }})
        if (!res.ok) { console.error((res as { ok: false; error: { message: string } }).error.message); process.exit(1) }
        if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); return }
        console.log(renderSpanTree(res.data.trace_id, res.data.tree))
      } catch (err: unknown) { console.error(String(err)); process.exit(1) }
    })

  cmd
    .command('info')
    .description('完整链路详情（含 _ai_context，AI Agent 可消费）')
    .option('--trace-id <id>', 'Trace ID')
    .option('--entity-id <id>', '实体 ID（自动推断 trace_id）')
    .option('--json', '输出 JSON')
    .action(async (opts) => {
      try {
        await ensureDaemon()
        const res = await sendIpc<TraceInfo>({ method: 'trace_info', params: {
          trace_id: opts.traceId, entity_id: opts.entityId,
        }})
        if (!res.ok) { console.error((res as { ok: false; error: { message: string } }).error.message); process.exit(1) }
        if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); return }
        console.log(renderTraceInfo(res.data.trace_id, res.data.root))
      } catch (err: unknown) { console.error(String(err)); process.exit(1) }
    })

  return cmd
}
