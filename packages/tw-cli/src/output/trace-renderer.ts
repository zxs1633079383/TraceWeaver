// packages/tw-cli/src/output/trace-renderer.ts
import type { SpanTreeNode } from '@traceweaver/types'
import { colorState } from './formatter.js'

const STATE_ICON: Record<string, string> = {
  completed:   '✅',
  in_progress: '🔄',
  rejected:    '✗ ',
  review:      '👁 ',
  pending:     '⏳',
}

function fmtDuration(ms?: number): string {
  if (ms === undefined) return ''
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return ` (${h > 0 ? `${h}h ${m}m` : `${m}m`})`
}

function renderNode(node: SpanTreeNode, prefix = '', isLast = true): string[] {
  const icon = STATE_ICON[node.state] ?? '  '
  const dur = node.duration_ms !== undefined ? fmtDuration(node.duration_ms) : ''
  const src = node.source === 'reconstructed' ? ' [reconstructed]' : ''
  const connector = prefix ? (isLast ? '└─ ' : '├─ ') : ''
  const stateStr = colorState(node.state).padEnd(11)
  const line = `${prefix}${connector}${icon} ${stateStr} [${node.entity_type}] ${node.entity_id}  span:${node.span_id.slice(0, 6)}${dur}${src}`
  const childPrefix = prefix + (isLast ? '   ' : '│  ')
  return [
    line,
    ...node.children.flatMap((c, i) => renderNode(c, childPrefix, i === node.children.length - 1)),
  ]
}

export function renderSpanTree(traceId: string, root: SpanTreeNode): string {
  return [`trace_id: ${traceId}`, ...renderNode(root)].join('\n')
}

export function renderTraceInfo(traceId: string, root: SpanTreeNode): string {
  const pad = '═'.repeat(52)
  const box = `╔${pad}╗\n║  TraceWeaver Trace Info  │  trace_id: ${traceId.slice(0, 12)}...  ║\n╚${pad}╝`
  return [box, '', ...renderNode(root)].join('\n')
}
