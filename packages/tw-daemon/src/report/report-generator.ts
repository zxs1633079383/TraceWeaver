import { writeFile, rename, mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ReportMeta, SpanTreeNode } from '@traceweaver/types'
import type { TraceQueryEngine } from '../otel/trace-query.js'
import type { EventLog } from '../log/event-log.js'
import type { FeedbackLog } from '../feedback/feedback-log.js'

export interface ReportGeneratorOptions {
  traceQuery: TraceQueryEngine
  eventLog: EventLog
  feedbackLog: FeedbackLog
  outputDir: string
}

export interface GenerateOptions {
  traceId?: string
  all?: boolean
  date?: string
}

export class ReportGenerator {
  private readonly traceQuery: TraceQueryEngine
  private readonly eventLog: EventLog
  private readonly feedbackLog: FeedbackLog
  private readonly outputDir: string

  constructor(opts: ReportGeneratorOptions) {
    this.traceQuery = opts.traceQuery
    this.eventLog = opts.eventLog
    this.feedbackLog = opts.feedbackLog
    this.outputDir = opts.outputDir
  }

  async generate(opts: GenerateOptions): Promise<string[]> {
    const date = opts.date ?? new Date().toISOString().slice(0, 10)

    if (!opts.traceId && !opts.all) {
      const err = new Error('trace_id or all required') as NodeJS.ErrnoException & { code: string }
      err.code = 'missing_trace_id_or_all'
      throw err
    }

    const traceIds: string[] = opts.all
      ? this.traceQuery.getAllTraceIds()
      : [opts.traceId!]

    await mkdir(this.outputDir, { recursive: true })
    const paths: string[] = []

    for (const traceId of traceIds) {
      const tree = this.traceQuery.buildSpanTree(traceId)
      if (!tree) {
        if (!opts.all) {
          const err = new Error(`trace not found: ${traceId}`) as NodeJS.ErrnoException & { code: string }
          err.code = 'trace_not_found'
          throw err
        }
        continue
      }

      const info = this.traceQuery.buildTraceInfo(traceId)
      const content = this._renderReport(date, traceId, tree, info)
      const filename = `${date}-${traceId.slice(0, 8)}.md`
      const path = join(this.outputDir, filename)
      const tmp = path + '.tmp'

      await writeFile(tmp, content, 'utf-8')
      await rename(tmp, path)

      // Append EventLog event — file-ref only, NO content field
      this.eventLog.append({
        id: randomUUID(),
        type: 'report.generated',
        entity_id: traceId,
        attributes: { report_path: path, trace_id: traceId, date },
        ts: new Date().toISOString(),
      })

      paths.push(path)
    }

    return paths
  }

  async listReports(date?: string): Promise<ReportMeta[]> {
    let files: string[]
    try {
      files = await readdir(this.outputDir)
    } catch {
      // directory doesn't exist yet
      return []
    }

    const mdFiles = files.filter(f => f.endsWith('.md') && (!date || f.startsWith(date + '-')))
    const results: ReportMeta[] = []

    for (const file of mdFiles) {
      // Filename format: {YYYY}-{MM}-{DD}-{traceId8}.md
      // Split on '-': parts[0]=YYYY, parts[1]=MM, parts[2]=DD, parts[3..]=traceId8 segments
      const nameWithoutExt = file.slice(0, -3)  // remove .md
      const parts = nameWithoutExt.split('-')
      if (parts.length < 4) continue  // date has 3 parts: YYYY-MM-DD
      const fileDate = parts.slice(0, 3).join('-')
      const traceId = parts.slice(3).join('-')
      const path = join(this.outputDir, file)
      const fileStat = await stat(path)
      results.push({
        date: fileDate,
        trace_id: traceId,
        path,
        generated_at: fileStat.mtime.toISOString(),
      })
    }

    return results
  }

  private _renderReport(date: string, traceId: string, tree: SpanTreeNode, info: unknown): string {
    const typedInfo = info as {
      summary?: {
        total?: number
        completed?: number
        in_progress?: number
        pending?: number
        rejected?: number
        blocked?: string[]
        harness_failures?: Array<{ entity_id: string; harness_id: string; reason?: string }>
      }
      _ai_context?: {
        one_line: string
        next_actions: string[]
        error_refs: string[]
      }
    } | null

    const summary = typedInfo?.summary
    const lines: string[] = [
      `# TraceWeaver Daily Report — ${date}`,
      '',
      `trace_id: ${traceId}`,
      `generated_at: ${new Date().toISOString()}`,
      '',
      '## Summary',
      '',
      `- total: ${summary?.total ?? '?'}`,
      `- completed: ${summary?.completed ?? '?'}`,
      `- in_progress: ${summary?.in_progress ?? '?'}`,
      `- pending: ${summary?.pending ?? '?'}`,
      `- rejected: ${summary?.rejected ?? '?'}`,
      `- blocked: ${JSON.stringify(summary?.blocked ?? [])}`,
      '',
      '## Harness Failures',
      '',
    ]

    const failures = summary?.harness_failures ?? []
    if (failures.length === 0) {
      lines.push('None.')
    } else {
      for (const f of failures) {
        lines.push(`- ${f.entity_id}: ${f.harness_id} — ${f.reason ?? 'unknown'}`)
      }
    }

    lines.push('', '## Span Tree', '')
    const renderNode = (node: SpanTreeNode, indent = ''): void => {
      lines.push(`${indent}[${node.entity_type}] ${node.entity_id} (${node.state})`)
      for (const child of node.children) renderNode(child, indent + '  ')
    }
    renderNode(tree)

    const aiContext = typedInfo?._ai_context
    if (aiContext) {
      lines.push('', '## AI Context', '')
      lines.push(aiContext.one_line)
      if (aiContext.next_actions.length > 0) {
        lines.push('', '### Next Actions', '')
        for (const a of aiContext.next_actions) lines.push(`- ${a}`)
      }
    }

    return lines.join('\n')
  }
}
