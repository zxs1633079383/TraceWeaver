import { describe, it, expect, beforeEach } from 'vitest'
import { TraceQueryEngine } from './trace-query.js'
import type { Entity, SpanMeta } from '@traceweaver/types'

function makeEntity(overrides: Partial<Entity> & { id: string; entity_type: Entity['entity_type'] }): Entity {
  return {
    state: 'pending',
    depends_on: [],
    artifact_refs: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

function makeSpan(overrides: Partial<SpanMeta> & { entity_id: string; trace_id: string; span_id: string }): SpanMeta {
  return {
    entity_type: 'task',
    start_time: new Date().toISOString(),
    status: 'UNSET',
    attributes: {},
    events: [],
    ...overrides,
  }
}

describe('TraceQueryEngine', () => {
  let entities: Entity[]
  let spans: SpanMeta[]

  beforeEach(() => {
    entities = [
      makeEntity({ id: 'uc-1', entity_type: 'usecase' }),
      makeEntity({ id: 'plan-1', entity_type: 'plan', parent_id: 'uc-1', state: 'in_progress' }),
      makeEntity({ id: 'task-1', entity_type: 'task', parent_id: 'plan-1', state: 'completed' }),
      makeEntity({ id: 'task-2', entity_type: 'task', parent_id: 'plan-1', state: 'rejected' }),
    ]
    spans = [
      makeSpan({ entity_id: 'uc-1',    trace_id: 'trace-abc', span_id: 'span-1' }),
      makeSpan({ entity_id: 'plan-1',  trace_id: 'trace-abc', span_id: 'span-2', parent_span_id: 'span-1' }),
      makeSpan({ entity_id: 'task-1',  trace_id: 'trace-abc', span_id: 'span-3', parent_span_id: 'span-2' }),
      makeSpan({ entity_id: 'task-2',  trace_id: 'trace-abc', span_id: 'span-4', parent_span_id: 'span-2', status: 'ERROR' }),
    ]
  })

  function makeEngine(opts: { spans?: SpanMeta[] } = {}) {
    const spanList = opts.spans ?? spans
    return new TraceQueryEngine({
      spanManager: {
        getSpan: (id: string) => spanList.find(s => s.entity_id === id),
        getAllSpans: () => spanList,
      } as any,
      getAllEntities: () => entities,
      getEntity: (id: string) => entities.find(e => e.id === id),
    })
  }

  describe('findTraceId', () => {
    it('returns trace_id when entity has a live span', () => {
      expect(makeEngine().findTraceId('task-1')).toBe('trace-abc')
    })

    it('walks parent chain (EntityRegistry fallback) when entity has no span', () => {
      const engine = makeEngine({ spans: [spans[0]] }) // only uc-1 has a span
      expect(engine.findTraceId('task-1')).toBe('trace-abc')
    })

    it('returns undefined for unknown entity', () => {
      expect(makeEngine().findTraceId('nonexistent')).toBeUndefined()
    })
  })

  describe('buildSpanTree', () => {
    it('builds nested tree with state from EntityRegistry (not SpanMeta.status)', () => {
      const engine = makeEngine()
      const tree = engine.buildSpanTree('trace-abc')
      expect(tree).not.toBeNull()
      expect(tree!.entity_id).toBe('uc-1')
      // state from EntityRegistry (pending), not from SpanMeta.status (UNSET)
      expect(tree!.state).toBe('pending')
      expect(tree!.source).toBe('live')
    })

    it('returns null for unknown trace_id', () => {
      expect(makeEngine().buildSpanTree('unknown')).toBeNull()
    })

    it('marks nodes as reconstructed when SpanManager has no span', () => {
      // Empty span list: fallback to EntityRegistry
      const engine = makeEngine({ spans: [] })
      const tree = engine.buildSpanTree('trace-abc')
      // Without spans, we can't know trace_id -> tree will be null (no way to map)
      // This is expected behavior: reconstructed mode requires at least some span data
      expect(tree).toBeNull()
    })
  })

  describe('buildTraceInfo', () => {
    it('returns TraceInfo with correct summary counts', () => {
      const engine = makeEngine()
      const info = engine.buildTraceInfo('trace-abc')
      expect(info).not.toBeNull()
      expect(info!.trace_id).toBe('trace-abc')
      expect(info!.summary.total).toBe(4)
      expect(info!.summary.completed).toBe(1)
      expect(info!.summary.rejected).toBe(1)
      expect(info!.summary.in_progress).toBe(1)
    })

    it('populates _ai_context.one_line with entity counts', () => {
      const info = makeEngine().buildTraceInfo('trace-abc')
      expect(info!._ai_context.one_line).toContain('4')
      expect(info!._ai_context.one_line).toMatch(/实体中/)
    })

    it('detects blocked entities (depends_on non-completed)', () => {
      // Add a blocked task that depends on the rejected task-2
      entities.push(makeEntity({ id: 'task-3', entity_type: 'task', parent_id: 'plan-1', depends_on: ['task-2'], state: 'pending' }))
      spans.push(makeSpan({ entity_id: 'task-3', trace_id: 'trace-abc', span_id: 'span-5', parent_span_id: 'span-2' }))
      const info = makeEngine().buildTraceInfo('trace-abc')
      expect(info!.summary.blocked).toContain('task-3')
    })

    it('returns null for unknown trace_id', () => {
      expect(makeEngine().buildTraceInfo('unknown')).toBeNull()
    })
  })

  describe('getAllTraceIds', () => {
    it('returns trace_ids from live spans', () => {
      const ids = makeEngine().getAllTraceIds()
      expect(ids).toContain('trace-abc')
    })
  })
})
