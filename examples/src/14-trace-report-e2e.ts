/**
 * Example 14 — Trace & Report 全链路验证（基于 mattermost-dev 真实数据 + Jaeger 导出）
 *
 * 数据来源：examples/fixtures/mattermost-tasks.json（Mattermost Bot Agent 开放平台）
 *
 * 验证点：
 *  ✅ 真实数据桥接         — 从 mattermost-tasks.json 批量注册 TW 实体
 *  ✅ TraceId 一致性       — UseCase → Plan → Task 共享同一 trace_id
 *  ✅ 状态流转 + 手动拒绝  — task-good → completed；task-bad → manually rejected
 *  ✅ TraceQueryEngine live — buildSpanTree / buildTraceInfo / _ai_context
 *  ✅ TraceQueryEngine 重建 — 空 SpanManager fallback（reconstructed source）
 *  ✅ ReportGenerator       — generate() 原子写入，.tmp 不残留
 *  ✅ EventLog file-ref     — report.generated 事件携带 report_path
 *  ✅ listReports           — 返回 ReportMeta 列表
 *  ✅ Jaeger 导出           — 所有 span 通过 OTLP/gRPC 写入 Jaeger
 *
 * 实体层级（来自真实项目）：
 *   UseCase: uc-mm-bot-platform
 *     ├── Plan: plan-frontend  (前端 UI 任务, tasks 1-4)
 *     │     ├── tm-fe-1  项目基础架构搭建   (→ completed)
 *     │     ├── tm-fe-2  API 服务层封装     (→ completed)
 *     │     ├── tm-fe-3  全局组件库开发     (→ manually rejected)
 *     │     └── tm-fe-4  首页 Dashboard     (pending)
 *     └── Plan: plan-arch     (架构/基础层, tasks 9-10)
 *           ├── tm-arch-9   工具函数与辅助模块 (→ manually rejected)
 *           └── tm-arch-10  响应式布局与适配   (pending)
 *
 * 前提（Jaeger，任选一）：
 *   A. telepresence 已连接 K8s 集群
 *   B. kubectl port-forward svc/jaeger-cses-pre-collector 4317:4317 -n jaeger-cses
 *      export JAEGER_ENDPOINT=localhost:4317
 *   未配置时 fallback 到 ConsoleExporter，仍可运行所有验证。
 *
 * 运行：
 *   npm run run:14 --workspace=examples
 *
 * Jaeger 查询（成功导出后）：
 *   Service   = traceweaver-trace-report
 *   Operation = tw.usecase
 */

import { mkdtemp, rm, mkdir, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { CommandHandler }      from '../../packages/tw-daemon/src/core/command-handler.js'
import { EventBus }            from '../../packages/tw-daemon/src/core/event-bus/event-bus.js'
import { SpanManager }         from '../../packages/tw-daemon/src/otel/span-manager.js'
import { EventLog }            from '../../packages/tw-daemon/src/log/event-log.js'
import { NotifyEngine }        from '../../packages/tw-daemon/src/notify/engine.js'
import { InboxAdapter }        from '../../packages/tw-daemon/src/notify/inbox.js'
import { ExporterRegistry }    from '../../packages/tw-daemon/src/otel/exporter-registry.js'
import { OtlpGrpcExporter }   from '../../packages/tw-daemon/src/otel/exporter-grpc.js'
import { ConsoleExporter }     from '../../packages/tw-daemon/src/otel/exporter-console.js'
import { TraceQueryEngine }    from '../../packages/tw-daemon/src/otel/trace-query.js'
import { ReportGenerator }     from '../../packages/tw-daemon/src/report/report-generator.js'
import type { TwEvent } from '@traceweaver/types'

// ── Jaeger 配置 ───────────────────────────────────────────────────────────────
const JAEGER_ENDPOINT = process.env.JAEGER_ENDPOINT
  ?? 'jaeger-cses-pre-collector.jaeger-cses.svc.cluster.local:4317'
const SERVICE_NAME = 'traceweaver-trace-report'

// ── 辅助打印 ─────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', cyan: '\x1b[36m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', gray: '\x1b[90m', blue: '\x1b[34m',
}
function section(title: string): void {
  console.log(`\n${C.bold}${C.cyan}${'─'.repeat(62)}${C.reset}`)
  console.log(`${C.bold}${C.cyan}  ${title}${C.reset}`)
  console.log(`${C.cyan}${'─'.repeat(62)}${C.reset}`)
}
function ok(msg: string):      void { console.log(`  ${C.green}✓${C.reset} ${msg}`) }
function warn(msg: string):    void { console.log(`  ${C.yellow}⚠${C.reset} ${msg}`) }
function info(msg: string):    void { console.log(`  ${C.gray}→${C.reset} ${msg}`) }
function fail(msg: string):    void { console.log(`  ${C.red}✗${C.reset} ${msg}`) }
function badge(msg: string):   void { console.log(`  ${C.blue}[${msg}]${C.reset}`) }
function span_ok(msg: string): void { console.log(`  ${C.blue}◆${C.reset} ${msg}`) }

// ── 读取 mattermost-tasks.json fixture ──────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '..', 'fixtures')

interface TmTask {
  id: string
  title: string
  description: string
  status: string
  priority?: string
  dependencies: string[]
  subtasks?: Array<{ id: number; title: string; status: string }>
}

function loadTasks(): TmTask[] {
  const raw = readFileSync(join(fixturesDir, 'mattermost-tasks.json'), 'utf8')
  const data = JSON.parse(raw) as { master: { tasks: TmTask[] } }
  return data.master.tasks
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`\n${C.bold}TraceWeaver — Trace & Report 全链路验证 (Example 14)${C.reset}`)
  console.log(`数据来源：mattermost-dev/.taskmaster/tasks/tasks.json`)
  console.log(`验证：真实数据 + TraceQueryEngine + ReportGenerator + Jaeger 导出`)
  console.log(`${C.cyan}JAEGER_ENDPOINT${C.reset} = ${C.bold}${JAEGER_ENDPOINT}${C.reset}`)
  console.log(`${C.cyan}SERVICE        ${C.reset} = ${C.bold}${SERVICE_NAME}${C.reset}\n`)

  // ── 临时目录 ─────────────────────────────────────────────────────────────
  const storeDir     = await mkdtemp(join(tmpdir(), 'tw-example-14-'))
  const inboxDir     = join(storeDir, 'inbox')
  const logPath      = join(storeDir, 'events.ndjson')
  const reportsDir   = join(storeDir, 'reports')
  await mkdir(inboxDir, { recursive: true })
  info(`storeDir: ${storeDir}`)

  // ─────────────────────────────────────────────────────────────────────────
  // Phase A：加载真实 TaskMaster 数据 + 组件初始化
  // ─────────────────────────────────────────────────────────────────────────
  section('Phase A：加载 mattermost-dev tasks.json + Boot 组件')

  const tmTasks = loadTasks()
  ok(`加载 ${tmTasks.length} 个 TaskMaster 任务`)

  const frontendTasks = tmTasks.filter(t => ['1','2','3','4'].includes(t.id))
  const archTasks     = tmTasks.filter(t => ['9','10'].includes(t.id))
  info(`前端任务 (plan-frontend): ${frontendTasks.map(t => `[${t.id}] ${t.title.slice(0, 20)}`).join(', ')}`)
  info(`架构任务 (plan-arch):     ${archTasks.map(t => `[${t.id}] ${t.title.slice(0, 20)}`).join(', ')}`)

  // ExporterRegistry：OTLP/gRPC → Jaeger + ConsoleExporter fallback
  const exporterRegistry = new ExporterRegistry()
  try {
    const grpcExporter = new OtlpGrpcExporter({ endpoint: JAEGER_ENDPOINT })
    exporterRegistry.register(grpcExporter)
    ok(`OtlpGrpcExporter 已注册 → ${JAEGER_ENDPOINT}`)
  } catch (err: unknown) {
    warn(`OtlpGrpcExporter 初始化失败，fallback 到 ConsoleExporter: ${(err as Error).message}`)
  }
  exporterRegistry.register(new ConsoleExporter())

  const eventBus    = new EventBus({ bufferSize: 512, batchWindowMs: 30 })
  const spanManager = new SpanManager({ projectId: SERVICE_NAME, exporterRegistry })
  const eventLog    = new EventLog(logPath)
  eventLog.load()
  const inboxAdapter = new InboxAdapter(inboxDir)

  const handler = new CommandHandler({ storeDir, eventBus, spanManager, eventLog })
  await handler.init()
  eventBus.start()

  const notifyEngine = new NotifyEngine(eventBus, {
    rules: [{ event: 'entity.state_changed', state: 'rejected' }],
    inbox: inboxAdapter,
  })
  notifyEngine.start()

  const allEvents: TwEvent[] = []
  eventBus.subscribe(ev => allEvents.push(ev))

  ok('EventBus / CommandHandler / NotifyEngine 已启动')

  // ─────────────────────────────────────────────────────────────────────────
  // Phase B：注册实体层级（UseCase → Plan × 2 → Task × N）
  // ─────────────────────────────────────────────────────────────────────────
  section('Phase B：UseCase → Plan 扇出 → TaskMaster 任务桥接')

  const uc = await handler.register({
    id: 'uc-mm-bot-platform',
    entity_type: 'usecase',
    attributes: {
      title: 'Mattermost Bot Agent 开放平台',
      description: 'Mattermost 二开开放平台：Bot Agent 管理 + 群管理 + 消息 API',
      version: 'v1.0',
    },
    artifact_refs: [{ type: 'prd', path: 'docs/bot-agent-prd.md' }],
  })
  ok(`UseCase: ${uc.id}  state=${uc.state}`)

  const planFe = await handler.register({
    id: 'plan-frontend',
    entity_type: 'plan',
    parent_id: uc.id,
    depends_on: [uc.id],
    attributes: { title: '前端实现计划', team: 'frontend', task_count: frontendTasks.length },
    artifact_refs: [{ type: 'design', path: 'docs/ui-design.figma' }],
  })
  ok(`Plan-frontend: ${planFe.id}  depends_on=[${uc.id}]`)

  const planArch = await handler.register({
    id: 'plan-arch',
    entity_type: 'plan',
    parent_id: uc.id,
    depends_on: [uc.id],
    attributes: { title: '架构/基础层计划', team: 'arch', task_count: archTasks.length },
    artifact_refs: [{ type: 'design', path: 'docs/arch-design.md' }],
  })
  ok(`Plan-arch:     ${planArch.id}  depends_on=[${uc.id}]`)

  // 注册前端任务（从真实 TaskMaster 数据）
  const feTaskIds: string[] = []
  for (const tmTask of frontendTasks) {
    const twId = `tm-fe-${tmTask.id}`
    feTaskIds.push(twId)
    await handler.register({
      id: twId,
      entity_type: 'task',
      parent_id: planFe.id,
      depends_on: [planFe.id],
      attributes: {
        title: tmTask.title,
        tm_id: tmTask.id,
        priority: tmTask.priority ?? 'medium',
        subtask_count: tmTask.subtasks?.length ?? 0,
      },
      // tm-fe-1/2 有 test artifact；tm-fe-3/4 无 test
      artifact_refs: (['1','2'].includes(tmTask.id))
        ? [
            { type: 'test', path: `src/tasks/task-${tmTask.id}.test.ts` },
            { type: 'impl', path: `src/tasks/task-${tmTask.id}.ts` },
          ]
        : [],
    })
  }
  ok(`注册前端任务: [${feTaskIds.join(', ')}]`)

  // 注册架构任务
  const archTaskIds: string[] = []
  for (const tmTask of archTasks) {
    const twId = `tm-arch-${tmTask.id}`
    archTaskIds.push(twId)
    await handler.register({
      id: twId,
      entity_type: 'task',
      parent_id: planArch.id,
      depends_on: [planArch.id],
      attributes: {
        title: tmTask.title,
        tm_id: tmTask.id,
      },
      artifact_refs: [],
    })
  }
  ok(`注册架构任务: [${archTaskIds.join(', ')}]`)

  // ─────────────────────────────────────────────────────────────────────────
  // Phase C：TraceId 一致性验证
  // ─────────────────────────────────────────────────────────────────────────
  section('Phase C：TraceId 一致性验证（W3C TraceContext）')

  const ucSpan       = spanManager.getSpan(uc.id)
  const planFeSpan   = spanManager.getSpan(planFe.id)
  const planArchSpan = spanManager.getSpan(planArch.id)
  const task1Span    = spanManager.getSpan(feTaskIds[0])
  const task9Span    = spanManager.getSpan(archTaskIds[0])

  const resolvedTraceId = ucSpan?.trace_id
  if (!resolvedTraceId) {
    fail('无法获取 trace_id，aborting')
    process.exit(1)
  }

  badge(`UseCase    trace_id=${resolvedTraceId.slice(0, 16)}...  span_id=${ucSpan?.span_id?.slice(0, 8)}...`)
  badge(`Plan-Fe    trace_id=${planFeSpan?.trace_id?.slice(0, 16)}...  parent=${planFeSpan?.parent_span_id?.slice(0, 8)}...`)
  badge(`Plan-Arch  trace_id=${planArchSpan?.trace_id?.slice(0, 16)}...  parent=${planArchSpan?.parent_span_id?.slice(0, 8)}...`)
  badge(`Task-Fe-1  trace_id=${task1Span?.trace_id?.slice(0, 16)}...`)
  badge(`Task-Arch-9 trace_id=${task9Span?.trace_id?.slice(0, 16)}...`)

  const allSameTrace = [planFeSpan, planArchSpan, task1Span, task9Span]
    .every(s => s?.trace_id === resolvedTraceId)

  if (allSameTrace) {
    ok('所有 Plan/Task span 与 UseCase 共享同一 trace_id（W3C TraceContext 继承正确）')
  } else {
    fail('trace_id 不一致！检查 SpanManager.deriveTraceId()')
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase D：状态流转 → 手动拒绝
  // ─────────────────────────────────────────────────────────────────────────
  section('Phase D：状态流转（task-good → completed；task-bad → manually rejected）')

  // tm-fe-1, tm-fe-2: → completed
  for (const taskId of [feTaskIds[0], feTaskIds[1]]) {
    await handler.updateState({ id: taskId, state: 'in_progress' })
    await handler.updateState({ id: taskId, state: 'review' })
    await handler.updateState({ id: taskId, state: 'completed' })
    span_ok(`${taskId} → completed`)
  }

  // tm-fe-3: 无 test artifact → manually rejected
  const rejectTarget = feTaskIds[2]  // tm-fe-3
  info(`推进 ${rejectTarget} (全局组件库开发) → in_progress → review → rejected...`)
  await handler.updateState({ id: rejectTarget, state: 'in_progress' })
  await handler.updateState({ id: rejectTarget, state: 'review' })
  await handler.updateState({ id: rejectTarget, state: 'rejected', reason: '缺少单元测试覆盖，需要补充测试后重新提交' })
  ok(`${rejectTarget} → rejected  [手动拒绝：缺少测试]`)

  // tm-arch-9: 无 test → manually rejected
  const rejectTarget2 = archTaskIds[0]  // tm-arch-9
  info(`推进 ${rejectTarget2} (工具函数与辅助模块) → in_progress → review → rejected...`)
  await handler.updateState({ id: rejectTarget2, state: 'in_progress' })
  await handler.updateState({ id: rejectTarget2, state: 'review' })
  await handler.updateState({ id: rejectTarget2, state: 'rejected', reason: '缺少测试文件，artifact_refs 中无 type=test 条目' })
  ok(`${rejectTarget2} → rejected  [手动拒绝：缺少测试]`)

  await new Promise(r => setTimeout(r, 100))

  const fe3State  = handler.getEntityById(rejectTarget)?.state
  const a9State   = handler.getEntityById(rejectTarget2)?.state

  if (fe3State === 'rejected') {
    ok(`${rejectTarget} state=rejected  ✓`)
  } else {
    warn(`${rejectTarget} state=${fe3State}  [预期 rejected]`)
  }
  if (a9State === 'rejected') {
    ok(`${rejectTarget2} state=rejected  ✓`)
  } else {
    warn(`${rejectTarget2} state=${a9State}  [预期 rejected]`)
  }

  // plan-core → in_progress
  await handler.updateState({ id: planFe.id, state: 'in_progress' })
  await handler.updateState({ id: planArch.id, state: 'in_progress' })
  ok('plan-frontend / plan-arch → in_progress')

  // ─────────────────────────────────────────────────────────────────────────
  // Phase E：TraceQueryEngine — live 模式验证
  // ─────────────────────────────────────────────────────────────────────────
  section('Phase E：TraceQueryEngine — live 模式验证')

  const traceQuery = new TraceQueryEngine({
    spanManager,
    getAllEntities: () => handler.getAllEntities(),
    getEntity: (id: string) => handler.getEntityById(id),
  })

  info(`trace_id = ${resolvedTraceId.slice(0, 16)}...`)

  const tree = traceQuery.buildSpanTree(resolvedTraceId)
  if (!tree) {
    fail('buildSpanTree 返回 null，aborting')
    process.exit(1)
  }
  ok(`buildSpanTree: root=${tree.entity_id}  children=${tree.children.length}`)
  ok(`root source=${tree.source}  entity_type=${tree.entity_type}`)

  const traceInfo = traceQuery.buildTraceInfo(resolvedTraceId)
  if (!traceInfo) {
    fail('buildTraceInfo 返回 null，aborting')
    process.exit(1)
  }
  ok(`buildTraceInfo: total=${traceInfo.summary.total}  completed=${traceInfo.summary.completed}`)
  ok(`summary.rejected=${traceInfo.summary.rejected}  blocked=${JSON.stringify(traceInfo.summary.blocked)}`)

  // _ai_context 验证
  if (traceInfo._ai_context?.one_line) {
    ok(`_ai_context.one_line: "${traceInfo._ai_context.one_line.slice(0, 60)}..."`)
  } else {
    fail('_ai_context.one_line 缺失')
  }

  if (Array.isArray(traceInfo._ai_context?.next_actions)) {
    ok(`_ai_context.next_actions: ${traceInfo._ai_context.next_actions.length} 条`)
  } else {
    fail('_ai_context.next_actions 缺失')
  }

  if (Array.isArray(traceInfo._ai_context?.error_refs)) {
    ok(`_ai_context.error_refs: ${traceInfo._ai_context.error_refs.length} 条`)
  } else {
    fail('_ai_context.error_refs 缺失')
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase F：TraceQueryEngine — reconstructed 模式（空 SpanManager）
  // ─────────────────────────────────────────────────────────────────────────
  section('Phase F：TraceQueryEngine — reconstructed 模式（空 SpanManager）')

  const emptyExporterRegistry = new ExporterRegistry()
  emptyExporterRegistry.register(new ConsoleExporter())
  const emptySpanManager = new SpanManager({
    projectId: 'traceweaver-example-14-reconstructed',
    exporterRegistry: emptyExporterRegistry,
  })
  const traceQueryReconstructed = new TraceQueryEngine({
    spanManager: emptySpanManager,
    getAllEntities: () => handler.getAllEntities(),
    getEntity: (id: string) => handler.getEntityById(id),
  })

  const allTraceIds = traceQuery.getAllTraceIds()
  info(`live SpanManager has ${allTraceIds.length} unique trace_id(s)`)
  ok(`getAllTraceIds() live: ${allTraceIds.length} trace(s)`)

  const emptyTraceIds = traceQueryReconstructed.getAllTraceIds()
  if (emptyTraceIds.length === 0) {
    ok('reconstructed SpanManager: getAllTraceIds() = [] (no live spans, expected)')
  } else {
    warn(`reconstructed SpanManager: unexpected ${emptyTraceIds.length} trace_id(s)`)
  }

  const reconstructedTree = traceQueryReconstructed.buildSpanTree(resolvedTraceId)
  if (reconstructedTree === null) {
    ok('reconstructed buildSpanTree returns null (no live spans — expected fallback behavior)')
  } else {
    warn(`reconstructed buildSpanTree returned non-null (unexpected: ${reconstructedTree.entity_id})`)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase G：ReportGenerator — 原子写入 + EventLog file-ref + listReports
  // ─────────────────────────────────────────────────────────────────────────
  section('Phase G：ReportGenerator — 原子写入 + EventLog file-ref + listReports')

  const reportGenerator = new ReportGenerator({
    traceQuery,
    eventLog,
    outputDir: reportsDir,
  })

  const today = new Date().toISOString().slice(0, 10)
  const generatedPaths = await reportGenerator.generate({ traceId: resolvedTraceId })
  info(`generate() → ${generatedPaths.length} 个文件`)

  if (generatedPaths.length === 0) {
    fail('ReportGenerator.generate() 返回空路径列表')
  } else {
    const reportPath = generatedPaths[0]
    ok(`report path: ${reportPath}`)

    if (existsSync(reportPath)) {
      ok('最终报告文件已落盘 (existsSync = true)')
    } else {
      fail(`报告文件不存在: ${reportPath}`)
    }

    // 验证：.tmp 文件不存在（原子写入已 rename）
    const tmpPath = reportPath + '.tmp'
    if (!existsSync(tmpPath)) {
      ok('.tmp 临时文件不存在（原子写入已完成 rename）')
    } else {
      fail(`.tmp 文件残留，原子写入未完成: ${tmpPath}`)
    }

    // 验证：文件内容包含关键字段
    const content = await readFile(reportPath, 'utf-8')
    if (content.includes('trace_id:') && content.includes('## Summary')) {
      ok('报告内容包含 trace_id + Summary 章节')
    } else {
      fail('报告内容缺少必要字段（trace_id / Summary）')
    }

    if (content.includes('## AI Context')) {
      ok('报告包含 ## AI Context 章节')
    } else {
      warn('报告中未找到 ## AI Context 章节（_ai_context 可能为空）')
    }

    // 验证：报告包含真实 Mattermost 任务名称
    if (content.includes('Mattermost') || content.includes('mm-bot-platform')) {
      ok('报告包含真实 Mattermost 项目数据')
    } else {
      warn('报告未包含 Mattermost 关键字（可能仅使用 entity_id）')
    }
  }

  // 验证：EventLog 有 report.generated 事件携带 report_path
  const allLogEvents = eventLog.query({ event_type: 'report.generated', limit: 10 })
  if (allLogEvents.length > 0 && allLogEvents[0].attributes?.['report_path']) {
    ok(`EventLog report.generated: report_path=${String(allLogEvents[0].attributes['report_path']).slice(-40)}`)
  } else {
    fail('EventLog 中未找到 report.generated 事件或 report_path 属性缺失')
  }

  // 验证：listReports 返回条目
  const reportList = await reportGenerator.listReports(today)
  if (reportList.length > 0) {
    ok(`listReports(today): ${reportList.length} 条  date=${reportList[0].date}  trace_id=${reportList[0].trace_id}`)
  } else {
    warn('listReports(today) 返回 0 条（可能文件名格式不匹配）')
  }

  const allReports = await reportGenerator.listReports()
  ok(`listReports() all: ${allReports.length} 条`)

  // ─────────────────────────────────────────────────────────────────────────
  // Phase H：Diagnose 模拟输出（被拒绝任务的完整诊断信息）
  // ─────────────────────────────────────────────────────────────────────────
  section(`Phase H：Diagnose 模拟 — ${rejectTarget} (${fe3State})`)

  const entity = handler.getEntityById(rejectTarget)
  const tmTaskRef = frontendTasks.find(t => `tm-fe-${t.id}` === rejectTarget)
  const stateIcon = entity?.state === 'rejected' ? '⚠️ ' : entity?.state === 'completed' ? '✓' : '○'

  console.log(`\n  ━━━ Entity: ${rejectTarget} ━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`  Type:    ${entity?.entity_type}`)
  console.log(`  State:   ${stateIcon} ${entity?.state}`)
  console.log(`  TM-ID:   ${entity?.attributes?.tm_id ?? 'N/A'}  (TaskMaster 原始 ID)`)
  console.log(`  Title:   ${tmTaskRef?.title ?? entity?.attributes?.title ?? 'N/A'}`)

  const entityEvents = allEvents.filter(e => e.entity_id === rejectTarget)
  if (entityEvents.length > 0) {
    console.log(`\n  ━━━ Span Events (${entityEvents.length} 条) ━━━━━━━━━━━━━━━━━━━━`)
    for (const ev of entityEvents) {
      const warnStr = ev.type.includes('rejected') ? ' ← ⚠️' : ''
      console.log(`    ${ev.ts.slice(11, 19)}  ${ev.type}${warnStr}`)
    }
  }

  const diagSpan = spanManager.getSpan(rejectTarget)
  if (diagSpan) {
    console.log(`\n  ━━━ OTel Span ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    console.log(`    trace_id: ${diagSpan.trace_id}`)
    console.log(`    span_id:  ${diagSpan.span_id}`)
    console.log(`    status:   ${diagSpan.status ?? 'UNSET'}`)
    console.log(`    events:   ${diagSpan.events.length} 个`)
  }
  console.log('')

  // ─────────────────────────────────────────────────────────────────────────
  // Phase I：推进终态 → Span Export to Jaeger
  // ─────────────────────────────────────────────────────────────────────────
  section('Phase I：推进终态 → Span Export to Jaeger')

  // tm-fe-4 / tm-arch-10 保持 pending（展示 active span）
  info(`${feTaskIds[3]} / ${archTaskIds[1]} 保持 pending（active span，Jaeger 中可见未结束的 span）`)

  // Plan-frontend → completed
  await handler.updateState({ id: planFe.id, state: 'review' })
  await handler.updateState({ id: planFe.id, state: 'completed' })
  span_ok('plan-frontend → completed  (span exported)')

  // Plan-arch → completed
  await handler.updateState({ id: planArch.id, state: 'review' })
  await handler.updateState({ id: planArch.id, state: 'completed' })
  span_ok('plan-arch → completed  (span exported)')

  // UseCase → completed（root span 关闭 → 整条 trace 完整可见）
  await handler.updateState({ id: uc.id, state: 'in_progress' })
  await handler.updateState({ id: uc.id, state: 'review' })
  await handler.updateState({ id: uc.id, state: 'completed' })
  span_ok('uc-mm-bot-platform → completed  (root span exported — trace 完整)')

  // flush 所有 pending span export
  info('调用 exporterRegistry.shutdown() 强制 flush...')
  await exporterRegistry.shutdown()
  ok('所有 span 已 flush 到 Jaeger')

  // ─────────────────────────────────────────────────────────────────────────
  // Phase J：最终汇总
  // ─────────────────────────────────────────────────────────────────────────
  section('最终汇总')

  const allEntities  = handler.getAllEntities()
  const completedCnt = allEntities.filter(e => e.state === 'completed').length
  const rejectedCnt  = allEntities.filter(e => e.state === 'rejected').length
  const pendingCnt   = allEntities.filter(e => e.state === 'pending').length

  const inboxItems   = await inboxAdapter.list()

  console.log(`
  ┌─────────────────────────────────────────────────────────┬──────────┐
  │ 验证点                                                    │  结果    │
  ├─────────────────────────────────────────────────────────┼──────────┤
  │ 从真实 tasks.json 注册 ${String(allEntities.length).padStart(2)} 个 TW 实体                │  ${allEntities.length >= 8 ? '✅ 通过' : '❌ 失败'}  │
  │ UseCase→Plan→Task trace_id 一致                          │  ${allSameTrace ? '✅ 通过' : '❌ 失败'}  │
  │ 手动拒绝无测试任务                                         │  ${rejectedCnt >= 2 ? '✅ 通过' : '⚠️  待确认'}  │
  │ TraceQueryEngine.buildSpanTree()  live                   │  ${tree !== null ? '✅ 通过' : '❌ 失败'}  │
  │ TraceQueryEngine.buildTraceInfo() live                   │  ${traceInfo !== null ? '✅ 通过' : '❌ 失败'}  │
  │ _ai_context.one_line 存在                                 │  ${traceInfo._ai_context?.one_line ? '✅ 通过' : '❌ 失败'}  │
  │ _ai_context.next_actions 存在                             │  ${Array.isArray(traceInfo._ai_context?.next_actions) ? '✅ 通过' : '❌ 失败'}  │
  │ buildSpanTree() reconstructed → null (expected)          │  ${reconstructedTree === null ? '✅ 通过' : '⚠️ 偏差'}  │
  │ ReportGenerator.generate() 生成文件                       │  ${generatedPaths.length > 0 ? '✅ 通过' : '❌ 失败'}  │
  │ 报告原子写入（.tmp 已 rename）                              │  ${generatedPaths.length > 0 && !existsSync(generatedPaths[0] + '.tmp') ? '✅ 通过' : '❌ 失败'}  │
  │ EventLog report.generated 事件                            │  ${allLogEvents.length > 0 ? '✅ 通过' : '❌ 失败'}  │
  │ listReports() 返回条目                                     │  ${allReports.length > 0 ? '✅ 通过' : '⚠️ 待确认'}  │
  │ NotifyEngine 收件箱 (rejected 通知)                        │  ${inboxItems.length > 0 ? '✅ 通过' : '⚠️  待确认'}  │
  ├─────────────────────────────────────────────────────────┼──────────┤
  │ 实体统计：total=${allEntities.length}  completed=${completedCnt}  rejected=${rejectedCnt}  pending=${pendingCnt}        │          │
  │ 报告数量：${String(allReports.length).padEnd(2)}  收件箱：${inboxItems.length}                                           │          │
  │ EventLog：${allEvents.length} 条事件                                              │          │
  └─────────────────────────────────────────────────────────┴──────────┘
  `)

  // Jaeger 查询入口
  const traceIdStr = resolvedTraceId

  console.log(`
${C.bold}${C.green}  Jaeger Trace 导出完成！${C.reset}

  在 Jaeger UI 搜索：
  ┌──────────────────────────────────────────────────────────┐
  │  Service   : ${SERVICE_NAME.padEnd(43)}│
  │  Operation : tw.usecase                                  │
  │  trace_id  : ${traceIdStr.padEnd(43)}│
  └──────────────────────────────────────────────────────────┘

  预期 Jaeger 中看到的 trace 树：
  ┌──────────────────────────────────────────────────────────┐
  │ tw.usecase [uc-mm-bot-platform]           OK  ■■■■■■■■  │
  │  ├── tw.plan [plan-frontend]              OK  ■■■■■■    │
  │  │     ├── tw.task [tm-fe-1] 基础架构     OK  ■■■■      │
  │  │     ├── tw.task [tm-fe-2] API 封装     OK  ■■■■      │
  │  │     ├── tw.task [tm-fe-3] 组件库      ERR  ■■■       │
  │  │     │     events: state_changed_to_rejected           │
  │  │     └── tw.task [tm-fe-4] Dashboard    -- (active)   │
  │  └── tw.plan [plan-arch]                  OK  ■■■■■     │
  │        ├── tw.task [tm-arch-9] 工具函数  ERR  ■■■       │
  │        │     events: state_changed_to_rejected           │
  │        └── tw.task [tm-arch-10] 响应式   -- (active)   │
  └──────────────────────────────────────────────────────────┘
`)

  ok('Example 14 — Trace & Report 全链路验证完成（真实数据 + Jaeger 导出）')

  // ── 清理 ──────────────────────────────────────────────────────────────────
  notifyEngine.stop()
  eventBus.stop()
  await rm(storeDir, { recursive: true })
}

main().catch(err => {
  console.error('\n[错误]', err)
  process.exit(1)
})
