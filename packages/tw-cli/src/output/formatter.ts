// packages/tw-cli/src/output/formatter.ts
import type { Entity } from '@traceweaver/types'

const STATE_COLORS: Record<string, string> = {
  pending:     '\x1b[90m',  // gray
  in_progress: '\x1b[33m',  // yellow
  review:      '\x1b[36m',  // cyan
  completed:   '\x1b[32m',  // green
  rejected:    '\x1b[31m',  // red
}
const RESET = '\x1b[0m'

export function colorState(state: string): string {
  return `${STATE_COLORS[state] ?? ''}${state}${RESET}`
}

export function formatEntity(entity: Entity): string {
  return `${entity.id}  [${colorState(entity.state)}]  type=${entity.entity_type}`
}

export function formatTree(entity: Entity, children: Entity[], indent = 0): string {
  const prefix = '  '.repeat(indent)
  const lines = [`${prefix}${formatEntity(entity)}`]
  for (const child of children) lines.push(`${prefix}  └─ ${formatEntity(child)}`)
  return lines.join('\n')
}

export function formatSummary(total: number, done: number, percent: number): string {
  const bar = '█'.repeat(Math.round(percent / 5)) + '░'.repeat(20 - Math.round(percent / 5))
  return `Progress  [${bar}] ${percent}%  (${done}/${total} completed)`
}
