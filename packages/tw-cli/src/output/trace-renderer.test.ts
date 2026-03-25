import { describe, it, expect } from 'vitest'
import { renderSpanTree, renderTraceInfo } from './trace-renderer.js'
import type { SpanTreeNode } from '@traceweaver/types'

function makeNode(overrides: Partial<SpanTreeNode> & { entity_id: string }): SpanTreeNode {
  return {
    entity_type: 'task', state: 'completed',
    span_id: 'span-1', trace_id: 'trace-abc', start_time: '2026-03-25T09:00:00Z',
    status: 'OK', source: 'live', events: [], children: [],
    ...overrides,
  }
}

describe('renderSpanTree', () => {
  it('includes trace_id header', () => {
    const node = makeNode({ entity_id: 'uc-1', entity_type: 'usecase', state: 'completed' })
    const output = renderSpanTree('trace-abc', node)
    expect(output).toContain('trace_id: trace-abc')
  })

  it('renders nested children with tree connectors', () => {
    const root = makeNode({
      entity_id: 'uc-1', entity_type: 'usecase', state: 'in_progress',
      children: [
        makeNode({ entity_id: 'task-1', state: 'completed' }),
        makeNode({ entity_id: 'task-2', state: 'rejected' }),
      ],
    })
    const output = renderSpanTree('trace-abc', root)
    expect(output).toContain('uc-1')
    expect(output).toContain('task-1')
    expect(output).toContain('task-2')
    expect(output).toContain('└─')   // tree connector
  })

  it('marks reconstructed nodes', () => {
    const node = makeNode({ entity_id: 'uc-1', source: 'reconstructed' })
    const output = renderSpanTree('trace-abc', node)
    expect(output).toContain('reconstructed')
  })
})

describe('renderTraceInfo', () => {
  it('renders box header with trace_id', () => {
    const node = makeNode({ entity_id: 'uc-1', entity_type: 'usecase' })
    const output = renderTraceInfo('trace-abc', node)
    expect(output).toContain('TraceWeaver Trace Info')
    expect(output).toContain('trace-abc')
  })
})
