import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ReportGenerator } from './report-generator.js'
import type { SpanTreeNode } from '@traceweaver/types'

function makeTree(): SpanTreeNode {
  return {
    entity_id: 'uc-1', entity_type: 'usecase', state: 'completed',
    span_id: 'span-1', trace_id: 'trace-abc',
    start_time: '2026-03-25T07:00:00Z', end_time: '2026-03-25T09:30:00Z',
    duration_ms: undefined, status: 'OK', source: 'live', events: [],
    children: [
      {
        entity_id: 'task-1', entity_type: 'task', state: 'completed',
        span_id: 'span-2', trace_id: 'trace-abc', parent_span_id: 'span-1',
        start_time: '2026-03-25T07:00:00Z', end_time: '2026-03-25T08:00:00Z',
        duration_ms: undefined, status: 'OK', source: 'live', events: [], children: [],
      },
      {
        entity_id: 'task-2', entity_type: 'task', state: 'rejected',
        span_id: 'span-3', trace_id: 'trace-abc', parent_span_id: 'span-1',
        start_time: '2026-03-25T08:00:00Z', status: 'ERROR', source: 'live',
        events: [], children: [],
        harness_results: [{ harness_id: 'task-needs-test', result: 'fail', reason: '未发现测试文件引用' }],
      },
    ],
  }
}

describe('ReportGenerator', () => {
  let tmpDir: string
  let appendedEvents: any[]

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tw-report-test-'))
    appendedEvents = []
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  function makeGenerator() {
    const tree = makeTree()
    return new ReportGenerator({
      traceQuery: {
        buildSpanTree: (id: string) => id === 'trace-abc' ? tree : null,
        getAllTraceIds: () => ['trace-abc'],
        buildTraceInfo: (id: string) => id === 'trace-abc' ? {
          trace_id: 'trace-abc',
          root: tree,
          summary: { total: 3, completed: 2, in_progress: 0, pending: 0, rejected: 1, blocked: [], harness_failures: [] },
          _ai_context: { one_line: '3 实体中 2 完成', next_actions: [], error_refs: [] },
        } : null,
      } as any,
      eventLog: {
        append: (e: any) => { appendedEvents.push(e) },
        query: () => [],
      } as any,
      feedbackLog: { getAllSummaries: () => [] } as any,
      outputDir: tmpDir,
    })
  }

  it('generates .md file and returns path', async () => {
    const paths = await makeGenerator().generate({ traceId: 'trace-abc', date: '2026-03-25' })
    expect(paths).toHaveLength(1)
    expect(paths[0]).toContain('2026-03-25')
    expect(paths[0]).toContain('trace-ab')
  })

  it('generated .md contains entity info', async () => {
    const [path] = await makeGenerator().generate({ traceId: 'trace-abc', date: '2026-03-25' })
    const content = await readFile(path, 'utf-8')
    expect(content).toContain('uc-1')
    expect(content).toContain('task-2')
    expect(content).toContain('rejected')
  })

  it('appends report.generated event with file-ref only (no content)', async () => {
    const [path] = await makeGenerator().generate({ traceId: 'trace-abc', date: '2026-03-25' })
    expect(appendedEvents).toHaveLength(1)
    const ev = appendedEvents[0]
    expect(ev.type).toBe('report.generated')
    expect(ev.attributes.report_path).toBe(path)
    expect(ev.attributes.trace_id).toBe('trace-abc')
    expect(ev.attributes.content).toBeUndefined()   // only file-ref, not content
  })

  it('atomic write: .tmp file absent after generate', async () => {
    const [path] = await makeGenerator().generate({ traceId: 'trace-abc', date: '2026-03-25' })
    expect(existsSync(path + '.tmp')).toBe(false)
    expect(existsSync(path)).toBe(true)
  })

  it('throws trace_not_found for unknown trace_id', async () => {
    await expect(makeGenerator().generate({ traceId: 'unknown', date: '2026-03-25' }))
      .rejects.toMatchObject({ code: 'trace_not_found' })
  })

  it('throws missing_trace_id_or_all when no params', async () => {
    await expect(makeGenerator().generate({}))
      .rejects.toMatchObject({ code: 'missing_trace_id_or_all' })
  })

  it('listReports returns metadata for generated reports', async () => {
    await makeGenerator().generate({ traceId: 'trace-abc', date: '2026-03-25' })
    // re-create generator to simulate fresh instance listing existing files
    const gen3 = new ReportGenerator({
      traceQuery: {
        buildSpanTree: (id: string) => id === 'trace-abc' ? makeTree() : null,
        getAllTraceIds: () => ['trace-abc'],
        buildTraceInfo: () => null,
      } as any,
      eventLog: { append: () => {}, query: () => [] } as any,
      feedbackLog: { getAllSummaries: () => [] } as any,
      outputDir: tmpDir,
    })
    const listed = await gen3.listReports('2026-03-25')
    expect(listed).toHaveLength(1)
    expect(listed[0].date).toBe('2026-03-25')
    expect(listed[0].trace_id).toContain('trace-ab')
    expect(listed[0].path).toContain(tmpDir)
  })
})
