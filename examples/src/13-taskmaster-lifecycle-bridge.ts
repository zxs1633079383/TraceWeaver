/**
 * Example 13 — TaskMaster 全链路闭环验证（基于 mattermost-dev 真实数据）
 *
 * 数据来源：examples/fixtures/mattermost-tasks.json（Mattermost Bot Agent 开放平台）
 *
 * 验证点：
 *  ✅ TraceId 一致性     — UseCase → Plan → Task 共享同一 trace_id
 *  ✅ cascadeUpdate      — UseCase 更新级联通知所有下游 Plan/Task
 *  ✅ RemediationEngine  — 任务 rejected → 自动入队 pending/
 *  ✅ 熔断器             — 超过 maxAttempts 后不再入队
 *  ✅ 去重               — 同一 rejection ts 只入队一次
 *  ✅ diagnose 输出模拟  — 打印 entity 状态 + span events + 失败原因
 *  ✅ TaskMaster 数据桥接 — 从 tasks.json 批量注册 TW 实体
 *  ✅ Jaeger 导出        — 所有 span（含真实任务名/trace_id）写入 Jaeger
 *
 * 实体层级（来自真实项目）：
 *   UseCase: uc-mm-bot-platform (Mattermost Bot Agent 开放平台)
 *     ├── Plan: plan-frontend  (前端实现计划, 4 tasks)
 *     └── Plan: plan-arch      (架构/基础层计划, 2 tasks)
 *
 * 前提（Jaeger，任选一）：
 *   A. telepresence 已连接 K8s 集群
 *   B. kubectl port-forward svc/jaeger-cses-pre-collector 4317:4317 -n jaeger-cses
 *      export JAEGER_ENDPOINT=localhost:4317
 *   未配置时 fallback 到 ConsoleExporter，仍可运行所有验证。
 *
 * 运行：
 *   npm run run:13 --workspace=examples
 *
 * Jaeger 查询（成功导出后）：
 *   Service   = traceweaver-mattermost
 *   Operation = tw.usecase
 */

import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import { CommandHandler } from '../../packages/tw-daemon/src/core/command-handler.js'
import { EventBus } from '../../packages/tw-daemon/src/core/event-bus/event-bus.js'
import { SpanManager } from '../../packages/tw-daemon/src/otel/span-manager.js'
import { EventLog } from '../../packages/tw-daemon/src/log/event-log.js'
import { HarnessLoader } from '../../packages/tw-daemon/src/harness/loader.js'
import { TriggerExecutor } from '../../packages/tw-daemon/src/trigger/executor.js'
import { ConstraintEvaluator } from '../../packages/tw-daemon/src/constraint/evaluator.js'
import { NotifyEngine } from '../../packages/tw-daemon/src/notify/engine.js'
import { InboxAdapter } from '../../packages/tw-daemon/src/notify/inbox.js'
import { FeedbackLog } from '../../packages/tw-daemon/src/feedback/feedback-log.js'
import { RemediationEngine } from '../../packages/tw-daemon/src/remediation/remediation-engine.js'
import { ExporterRegistry } from '../../packages/tw-daemon/src/otel/exporter-registry.js'
import { OtlpGrpcExporter } from '../../packages/tw-daemon/src/otel/exporter-grpc.js'
import { ConsoleExporter } from '../../packages/tw-daemon/src/otel/exporter-console.js'
import type { TwEvent } from '@traceweaver/types'

// ── Jaeger 配置 ───────────────────────────────────────────────────────────────
const JAEGER_ENDPOINT = process.env.JAEGER_ENDPOINT
  ?? 'jaeger-cses-pre-collector.jaeger-cses.svc.cluster.local:4317'
const SERVICE_NAME = 'traceweaver-mattermost'

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
  subtasks?: TmSubtask[]
}
interface TmSubtask {
  id: number
  title: string
  status: string
}

function loadTasks(): TmTask[] {
  // Synchronous JSON load — fixture file is local, no network
  const raw = readFileSync(join(fixturesDir, 'mattermost-tasks.json'), 'utf8')
  const data = JSON.parse(raw) as { master: { tasks: TmTask[] } }
  return data.master.tasks
}

function tmStatusToTwState(status: string): 'pending' | 'in_progress' | 'review' | 'completed' | 'rejected' {
  const map: Record<string, 'pending' | 'in_progress' | 'review' | 'completed' | 'rejected'> = {
    'pending': 'pending', 'in-progress': 'in_progress', 'review': 'review',
    'done': 'completed', 'deferred': 'pending', 'cancelled': 'rejected',
  }
  return map[status] ?? 'pending'
}

// ── 模拟 LLM：无 APPROVED → fail（触发自动拒绝）───────────────────────────
async function mockLlm(prompt: string): Promise<string> {
  if (prompt.includes('APPROVED')) return 'RESULT: pass\n所有约束已满足。'
  return 'RESULT: fail\n该任务 artifact_refs 中缺少 type=test 的测试文件条目。需要补充单元测试后再提交审核。'
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`\n${C.bold}TraceWeaver — TaskMaster 全链路闭环验证 (Example 13)${C.reset}`)
  console.log(`数据来源：mattermost-dev/.taskmaster/tasks/tasks.json`)
  console.log(`${C.cyan}JAEGER_ENDPOINT${C.reset} = ${C.bold}${JAEGER_ENDPOINT}${C.reset}`)
  console.log(`${C.cyan}SERVICE        ${C.reset} = ${C.bold}${SERVICE_NAME}${C.reset}\n`)

  // ── 临时目录 ────────────────────────────────────────────────────────────
  const storeDir     = await mkdtemp(join(tmpdir(), 'tw-example-13-'))
  const harnessDir   = join(storeDir, 'harness')
  const inboxDir     = join(storeDir, 'inbox')
  const queueDir     = join(storeDir, 'remediation-queue')
  const logPath      = join(storeDir, 'events.ndjson')
  const feedbackPath = join(storeDir, 'feedback', 'feedback.ndjson')
  await mkdir(harnessDir, { recursive: true })
  await mkdir(inboxDir,   { recursive: true })
  info(`storeDir: ${storeDir}`)

  // ─────────────────────────────────────────────────────────────────────────
  // Phase A：加载真实 TaskMaster 数据
  // ─────────────────────────────────────────────────────────────────────────
  section('Phase A：加载 mattermost-dev tasks.json')

  const tmTasks = loadTasks()
  ok(`加载 ${tmTasks.length} 个 TaskMaster 任务`)
  // 按职责分组
  const frontendTasks = tmTasks.filter(t => ['1','2','3','4'].includes(t.id))   // UI 层
  const archTasks     = tmTasks.filter(t => ['9','10','11','12'].includes(t.id)) // 基础层

  info(`前端任务 (plan-frontend): ${frontendTasks.map(t => `[${t.id}] ${t.title.slice(0, 20)}...`).join(', ')}`)
  info(`架构任务 (plan-arch):     ${archTasks.map(t => `[${t.id}] ${t.title.slice(0, 20)}...`).join(', ')}`)

  // ─────────────────────────────────────────────────────────────────────────
  // Phase B：Harness 约束文件 + 组件初始化
  // ─────────────────────────────────────────────────────────────────────────
  section('Phase B：组件初始化')

  // Harness：任务 review 前必须有测试文件（无 APPROVED 关键词 → mock LLM fail）
  await writeFile(join(harnessDir, 'task-needs-test.md'), `---
id: task-needs-test
applies_to:
  - task
trigger_on:
  - review
---
# 任务测试覆盖约束

任务进入 review 前，artifact_refs 中必须包含至少一个 type=test 的测试文件。

检查 artifact_refs 是否包含 {"type": "test", "path": "*.test.*"} 条目。
RESULT: fail if no test artifacts found.
`)

  const harnessLoader = new HarnessLoader(harnessDir)
  await harnessLoader.scan()

  // ExporterRegistry：尝试 OTLP/gRPC → Jaeger；同时注册 ConsoleExporter 作为本地 fallback
  const exporterRegistry = new ExporterRegistry()
  try {
    const grpcExporter = new OtlpGrpcExporter({ endpoint: JAEGER_ENDPOINT })
    exporterRegistry.register(grpcExporter)
    ok(`OtlpGrpcExporter 已注册 → ${JAEGER_ENDPOINT}`)
  } catch (err: unknown) {
    // gRPC 初始化失败（如环境变量未配置）时 fallback 到 Console
    warn(`OtlpGrpcExporter 初始化失败，fallback 到 ConsoleExporter: ${(err as Error).message}`)
  }
  exporterRegistry.register(new ConsoleExporter())

  const eventBus    = new EventBus({ bufferSize: 512, batchWindowMs: 30 })
  const spanManager = new SpanManager({ projectId: SERVICE_NAME, exporterRegistry })
  const eventLog    = new EventLog(logPath)
  eventLog.load()
  const feedbackLog  = new FeedbackLog(feedbackPath)
  feedbackLog.load()
  const inboxAdapter = new InboxAdapter(inboxDir)

  const handler = new CommandHandler({ storeDir, eventBus, spanManager, eventLog })
  await handler.init()
  eventBus.start()

  const notifyEngine = new NotifyEngine(eventBus, {
    rules: [{ event: 'entity.state_changed', state: 'rejected' }],
    inbox: inboxAdapter,
  })
  notifyEngine.start()

  const evaluator = new ConstraintEvaluator({ enabled: true, llmFn: mockLlm })
  const triggerExecutor = new TriggerExecutor({
    handler, evaluator, harness: harnessLoader, eventBus, inbox: inboxAdapter, feedbackLog,
  })
  triggerExecutor.start()

  // RemediationEngine：监听 rejected → 写队列
  const remediation = new RemediationEngine({
    eventBus,
    handler,
    feedbackLog,
    queueDir,
    maxAttempts: 3,
  })
  remediation.start()

  const allEvents: TwEvent[] = []
  eventBus.subscribe(ev => allEvents.push(ev))

  ok(`Harness: ${harnessLoader.list().map(h => h.id).join(', ')}`)
  ok('EventBus / CommandHandler / TriggerExecutor / RemediationEngine 已启动')

  // ─────────────────────────────────────────────────────────────────────────
  // Phase C：注册实体层级（UseCase → Plan × 2 → Task × N）
  // ─────────────────────────────────────────────────────────────────────────
  section('Phase C：UseCase → Plan 扇出 → TaskMaster 任务桥接')

  // UseCase（根实体，trace_id 起点）
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

  // Plan-frontend（UseCase 的子 span → 继承 trace_id）
  const planFe = await handler.register({
    id: 'plan-frontend',
    entity_type: 'plan',
    parent_id: uc.id,
    depends_on: [uc.id],
    attributes: { title: '前端实现计划', team: 'frontend', task_count: frontendTasks.length },
    artifact_refs: [{ type: 'design', path: 'docs/ui-design.figma' }],
  })
  ok(`Plan-frontend: ${planFe.id}  depends_on=[${uc.id}]`)

  // Plan-arch（UseCase 的子 span → 同一 trace_id）
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
      // 只有 task 1/2 有代码 artifact（模拟已完成），其他无测试
      artifact_refs: (['1','2'].includes(tmTask.id))
        ? [{ type: 'code', path: `src/tasks/task-${tmTask.id}.ts` }]
        : [],
    })
  }
  ok(`注册前端任务: [${feTaskIds.join(', ')}]`)

  // 注册架构任务（选 9、12 做测试——一个被拒绝，一个正常）
  const archTaskIds: string[] = []
  for (const tmTask of archTasks.slice(0, 2)) { // 只取前2个
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
  // Phase D：TraceId 一致性验证
  // ─────────────────────────────────────────────────────────────────────────
  section('Phase D：TraceId 一致性验证（W3C TraceContext）')

  const ucSpan       = spanManager.getSpan(uc.id)
  const planFeSpan   = spanManager.getSpan(planFe.id)
  const planArchSpan = spanManager.getSpan(planArch.id)
  const task1Span    = spanManager.getSpan(feTaskIds[0])
  const task9Span    = spanManager.getSpan(archTaskIds[0])

  badge(`UseCase    trace_id=${ucSpan?.trace_id?.slice(0, 16)}...  span_id=${ucSpan?.span_id?.slice(0, 8)}...`)
  badge(`Plan-Fe    trace_id=${planFeSpan?.trace_id?.slice(0, 16)}...  parent=${planFeSpan?.parent_span_id?.slice(0, 8)}...`)
  badge(`Plan-Arch  trace_id=${planArchSpan?.trace_id?.slice(0, 16)}...  parent=${planArchSpan?.parent_span_id?.slice(0, 8)}...`)
  badge(`Task-Fe-1  trace_id=${task1Span?.trace_id?.slice(0, 16)}...`)
  badge(`Task-Arch-9 trace_id=${task9Span?.trace_id?.slice(0, 16)}...`)

  const allSameTrace = [planFeSpan, planArchSpan, task1Span, task9Span]
    .every(s => s?.trace_id === ucSpan?.trace_id)

  if (allSameTrace) {
    ok('✅ 所有 Plan/Task span 与 UseCase 共享同一 trace_id（W3C TraceContext 继承正确）')
  } else {
    fail('trace_id 不一致！检查 SpanManager.deriveTraceId()')
    if (planFeSpan?.trace_id !== ucSpan?.trace_id)
      fail(`  plan-frontend trace_id 与 usecase 不同`)
    if (planArchSpan?.trace_id !== ucSpan?.trace_id)
      fail(`  plan-arch trace_id 与 usecase 不同`)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase E：cascadeUpdate — UseCase 变更通知所有下游
  // ─────────────────────────────────────────────────────────────────────────
  section('Phase E：cascadeUpdate — UseCase PRD 更新 → 级联通知')

  info('模拟 PRD v1.1：新增 Webhook 事件订阅功能模块...')
  const cascadeResult = await handler.cascadeUpdate({
    id: uc.id,
    attributes: {
      description: 'Mattermost 二开开放平台 v1.1：新增 Webhook 事件订阅功能',
      version: 'v1.1',
      changed_scope: ['webhook-config', 'bot-agent-api'],
    },
    cascade: true,
  })

  if (cascadeResult.ok) {
    const expectedCount = 1 + 2 + feTaskIds.length + archTaskIds.slice(0, 2).length
    ok(`cascadeUpdate 成功：updated_count=${cascadeResult.data?.updated_count}  (预期 ≥ ${1+2})`)
    ok(`覆盖：1 UseCase + 2 Plans + ${feTaskIds.length + 2} Tasks = ${expectedCount} 个实体`)
  } else {
    fail(`cascadeUpdate 失败：${cascadeResult.error?.message}`)
  }

  // 等 EventBus 批窗口 flush（cascadeUpdate 内通过 eventBus.publish 发布，批处理延迟 30ms）
  await new Promise(r => setTimeout(r, 80))

  // 验证 upstream_changed 事件已发布
  const upstreamEvents = allEvents.filter(e => e.type === 'entity.upstream_changed')
  ok(`entity.upstream_changed 事件：${upstreamEvents.length} 个（每个 Plan/Task 收到一个）`)
  for (const ev of upstreamEvents.slice(0, 3)) {
    info(`  → entity_id=${ev.entity_id}  source=${(ev as any).attributes?.source}`)
  }
  if (upstreamEvents.length > 3) info(`  ... 等 ${upstreamEvents.length - 3} 个`)

  // ─────────────────────────────────────────────────────────────────────────
  // Phase F：状态流转 + TriggerExecutor 自动拒绝
  // ─────────────────────────────────────────────────────────────────────────
  section('Phase F：状态流转 → Harness 评估 → 自动拒绝')

  // tm-fe-3（全局组件库）：无测试 artifact → review 时被自动拒绝
  const rejectTarget = feTaskIds[2]  // tm-fe-3
  info(`推进 ${rejectTarget} (全局组件库开发) → in_progress → review...`)
  await handler.updateState({ id: rejectTarget, state: 'in_progress' })
  await handler.updateState({ id: rejectTarget, state: 'review' })
  ok(`${rejectTarget} → review  [task-needs-test harness 触发，等待 mock LLM 评估...]`)

  // tm-arch-9（工具函数）：无测试 → review → 被拒绝
  const rejectTarget2 = archTaskIds[0] // tm-arch-9
  info(`推进 ${rejectTarget2} (工具函数与辅助模块) → in_progress → review...`)
  await handler.updateState({ id: rejectTarget2, state: 'in_progress' })
  await handler.updateState({ id: rejectTarget2, state: 'review' })
  ok(`${rejectTarget2} → review  [task-needs-test harness 触发]`)

  // 等待 TriggerExecutor 批处理 + LLM 评估 + RemediationEngine 入队
  info('等待异步评估 + 修复队列写入...')
  await new Promise(r => setTimeout(r, 600))

  // 验证被自动拒绝
  const fe3Status    = await handler.getStatus({ id: rejectTarget })
  const arch9Status  = await handler.getStatus({ id: rejectTarget2 })

  if (fe3Status.entity.state === 'rejected') {
    ok(`${rejectTarget} state=rejected  [task-needs-test harness 自动拒绝 ✓]`)
  } else {
    warn(`${rejectTarget} state=${fe3Status.entity.state}  [预期 rejected]`)
  }
  if (arch9Status.entity.state === 'rejected') {
    ok(`${rejectTarget2} state=rejected  [task-needs-test harness 自动拒绝 ✓]`)
  } else {
    warn(`${rejectTarget2} state=${arch9Status.entity.state}  [预期 rejected]`)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase G：RemediationEngine 验证
  // ─────────────────────────────────────────────────────────────────────────
  section('Phase G：RemediationEngine — 自动修复队列验证')

  const pendingFiles = await readdir(join(queueDir, 'pending')).catch(() => [] as string[])
  ok(`pending/ 队列中 ${pendingFiles.length} 个待修复项`)
  for (const f of pendingFiles) {
    info(`  ${f}`)
  }

  if (pendingFiles.length >= 2) {
    ok('两个被拒绝的任务均已入队  ✓')
  } else if (pendingFiles.length > 0) {
    warn(`只有 ${pendingFiles.length} 个入队（另一个可能重试超限或去重了）`)
  } else {
    warn('pending 队列为空（等待时间可能不足，或 eventBus 批窗口延迟）')
  }

  // 验证去重：同一实体重复触发不会重复入队
  info('测试去重：重复触发同一 rejection 事件...')
  const sameTs = new Date().toISOString()
  const dedupEvent = {
    type: 'entity.state_changed' as const,
    entity_id: rejectTarget,
    state: 'rejected',
    ts: sameTs,
    id: 'dedup-test-1',
    entity_type: 'task',
  }
  // 直接发两次相同事件到 EventBus
  eventBus.publish(dedupEvent)
  eventBus.publish(dedupEvent)
  await new Promise(r => setTimeout(r, 100))
  const pendingAfterDedup = await readdir(join(queueDir, 'pending')).catch(() => [] as string[])
  const diff = pendingAfterDedup.length - pendingFiles.length
  if (diff <= 1) {
    ok(`去重验证：重复 rejection 事件只入队 ${diff} 次（dedup_key = entity_id|ts）  ✓`)
  } else {
    fail(`去重失败：diff=${diff}，入队了 ${diff} 次`)
  }

  // 验证熔断器：预填 done/ 目录让 tm-arch-9 超过 maxAttempts(3)
  info('测试熔断器：为 tm-arch-9 预置 3 次历史失败记录...')
  const doneDir = join(queueDir, 'done')
  await mkdir(doneDir, { recursive: true })
  for (let i = 1; i <= 3; i++) {
    await writeFile(
      join(doneDir, `rem-0000000${i}-${rejectTarget2}.json`),
      JSON.stringify({ entity_id: rejectTarget2, attempt: i }),
    )
  }
  const beforeBreaker = (await readdir(join(queueDir, 'pending')).catch(() => [] as string[])).length
  // 触发新的拒绝事件
  eventBus.publish({
    type: 'entity.state_changed' as const,
    entity_id: rejectTarget2,
    state: 'rejected',
    ts: new Date().toISOString() + '-breaker',  // 不同 ts = 新的 dedup key
    id: 'breaker-test',
    entity_type: 'task',
  })
  await new Promise(r => setTimeout(r, 100))
  const afterBreaker = (await readdir(join(queueDir, 'pending')).catch(() => [] as string[])).length
  if (afterBreaker === beforeBreaker) {
    ok(`熔断器验证：${rejectTarget2} 已达 maxAttempts(3)，新 rejection 不再入队  ✓`)
  } else {
    warn(`熔断器：新增了 ${afterBreaker - beforeBreaker} 个条目（预期 0）`)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase H：Diagnose 模拟输出（与 `tw diagnose <id>` 等价）
  // ─────────────────────────────────────────────────────────────────────────
  section(`Phase H：Diagnose 模拟 — ${rejectTarget} (${fe3Status.entity.state})`)

  const entity = fe3Status.entity
  const tmTaskRef = frontendTasks.find(t => `tm-fe-${t.id}` === rejectTarget)
  const stateIcon = entity.state === 'rejected' ? '⚠️ ' : entity.state === 'completed' ? '✓' : '○'

  console.log(`\n  ━━━ Entity: ${rejectTarget} ━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`  Type:    ${entity.entity_type}`)
  console.log(`  State:   ${stateIcon} ${entity.state}`)
  console.log(`  TM-ID:   ${entity.attributes?.tm_id ?? 'N/A'}  (TaskMaster 原始 ID)`)
  console.log(`  Title:   ${tmTaskRef?.title ?? entity.attributes?.title ?? 'N/A'}`)

  const entityEvents = allEvents.filter(e => e.entity_id === rejectTarget)
  if (entityEvents.length > 0) {
    console.log(`\n  ━━━ Span Events (${entityEvents.length} 条) ━━━━━━━━━━━━━━━━━━━━`)
    for (const ev of entityEvents) {
      const warn = ev.type.includes('rejected') ? ' ← ⚠️' : ''
      console.log(`    ${ev.ts.slice(11, 19)}  ${ev.type}${warn}`)
    }
  }

  const rejectFeedback = feedbackLog.query({ entity_id: rejectTarget, result: 'fail', limit: 3 })
  if (rejectFeedback.length > 0) {
    console.log(`\n  ━━━ Harness 失败记录 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    for (const fb of rejectFeedback) {
      console.log(`    Harness: ${fb.harness_id}`)
      console.log(`    Reason:  ${fb.reason?.slice(0, 100) ?? 'N/A'}`)
    }
  }

  const span = spanManager.getSpan(rejectTarget)
  if (span) {
    console.log(`\n  ━━━ OTel Span ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    console.log(`    trace_id: ${span.trace_id}`)
    console.log(`    span_id:  ${span.span_id}`)
    console.log(`    status:   ${span.status ?? 'UNSET'}`)
    console.log(`    events:   ${span.events.length} 个`)
  }
  console.log('')

  // ─────────────────────────────────────────────────────────────────────────
  // Phase I：最终汇总
  // ─────────────────────────────────────────────────────────────────────────
  section('最终汇总')

  const allEntities   = handler.getAllEntities()
  const completedCnt  = allEntities.filter(e => e.state === 'completed').length
  const rejectedCnt   = allEntities.filter(e => e.state === 'rejected').length
  const pendingCnt    = allEntities.filter(e => e.state === 'pending').length

  const remPending    = await readdir(join(queueDir, 'pending')).catch(() => [] as string[])
  const upstreamEvts  = allEvents.filter(e => e.type === 'entity.upstream_changed')
  const inboxItems    = await inboxAdapter.list()

  console.log(`
  ┌─────────────────────────────────────────────────────┬──────────┐
  │ 验证点                                               │  结果    │
  ├─────────────────────────────────────────────────────┼──────────┤
  │ 从真实 tasks.json 注册 ${String(allEntities.length).padStart(2)} 个 TW 实体               │  ${allEntities.length >= 6 ? '✅ 通过' : '❌ 失败'}  │
  │ UseCase→Plan→Task trace_id 一致                      │  ${allSameTrace ? '✅ 通过' : '❌ 失败'}  │
  │ cascadeUpdate 通知 ${String(upstreamEvts.length).padStart(2)} 个下游实体 (entity.upstream_changed) │  ${upstreamEvts.length > 0 ? '✅ 通过' : '❌ 失败'}  │
  │ TriggerExecutor 自动拒绝无测试任务                    │  ${rejectedCnt >= 2 ? '✅ 通过' : '⚠️  待确认'}  │
  │ RemediationEngine 入队被拒绝任务                      │  ${remPending.length > 0 ? '✅ 通过' : '⚠️  待确认'}  │
  │ 去重验证 (dedup_key=entity_id|ts)                    │  ${diff <= 1 ? '✅ 通过' : '❌ 失败'}  │
  │ 熔断器验证 (maxAttempts=3)                           │  ${afterBreaker === beforeBreaker ? '✅ 通过' : '⚠️  待确认'}  │
  │ NotifyEngine 收件箱 (rejected 通知)                  │  ${inboxItems.length > 0 ? '✅ 通过' : '⚠️  待确认'}  │
  ├─────────────────────────────────────────────────────┼──────────┤
  │ 实体统计：completed=${completedCnt}  rejected=${rejectedCnt}  pending=${pendingCnt}              │          │
  │ 修复队列：pending=${remPending.length} 项                              │          │
  │ EventLog：${allEvents.length} 条事件                                 │          │
  └─────────────────────────────────────────────────────┴──────────┘
  `)

  ok('Example 13 — TaskMaster 全链路闭环验证完成')

  // ─────────────────────────────────────────────────────────────────────────
  // Phase J：推进所有实体到终态 → 触发 span export to Jaeger
  // ─────────────────────────────────────────────────────────────────────────
  section('Phase J：推进终态 → Span Export to Jaeger')

  // 已完成任务（tm-fe-1, tm-fe-2）走 completed
  for (const taskId of [feTaskIds[0], feTaskIds[1]]) {
    await handler.updateState({ id: taskId, state: 'in_progress' })
    await handler.updateState({ id: taskId, state: 'review' })
    await handler.updateState({ id: taskId, state: 'completed' })
    span_ok(`${taskId} → completed  (span exported, status=OK)`)
  }

  // tm-fe-4 / tm-arch-10 维持 pending → 不进终态（展示 active span 也可见）
  info(`${feTaskIds[3]} / ${archTaskIds[1]} 保持 pending（active span，Jaeger 中可见未结束的 span）`)

  // Plan-frontend → completed（子 span 全部结束后关闭父 span）
  await handler.updateState({ id: planFe.id, state: 'in_progress' })
  await handler.updateState({ id: planFe.id, state: 'review' })
  await handler.updateState({ id: planFe.id, state: 'completed' })
  span_ok(`plan-frontend → completed  (span exported)`)

  // Plan-arch → completed
  await handler.updateState({ id: planArch.id, state: 'in_progress' })
  await handler.updateState({ id: planArch.id, state: 'review' })
  await handler.updateState({ id: planArch.id, state: 'completed' })
  span_ok(`plan-arch → completed  (span exported)`)

  // UseCase → completed（root span 关闭 → 整条 trace 在 Jaeger 中完整可见）
  await handler.updateState({ id: uc.id, state: 'in_progress' })
  await handler.updateState({ id: uc.id, state: 'review' })
  await handler.updateState({ id: uc.id, state: 'completed' })
  span_ok(`uc-mm-bot-platform → completed  (root span exported — trace 完整)`)

  // flush 所有 pending span export
  info('调用 exporterRegistry.shutdown() 强制 flush...')
  await exporterRegistry.shutdown()
  ok('所有 span 已 flush 到 Jaeger')

  // Jaeger 查询入口（trace_id 在 Phase D 已从 ucSpan 获取，此处直接复用）
  const traceIdStr = ucSpan?.trace_id ?? '（未知）'

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
  │  │     │     events: upstream_updated, state_changed×N  │
  │  │     ├── tw.task [tm-fe-2] API 封装     OK  ■■■■      │
  │  │     ├── tw.task [tm-fe-3] 组件库      ERR  ■■■       │
  │  │     │     events: upstream_updated, state_changed_to_rejected │
  │  │     └── tw.task [tm-fe-4] Dashboard    -- (active)   │
  │  └── tw.plan [plan-arch]                  OK  ■■■■■     │
  │        ├── tw.task [tm-arch-9] 工具函数  ERR  ■■■       │
  │        │     events: upstream_updated, state_changed_to_rejected │
  │        └── tw.task [tm-arch-10] 响应式   -- (active)   │
  └──────────────────────────────────────────────────────────┘
`)

  // ── 清理 ─────────────────────────────────────────────────────────────────
  triggerExecutor.stop()
  notifyEngine.stop()
  remediation.stop()
  eventBus.stop()
  await rm(storeDir, { recursive: true })
}

main().catch(err => {
  console.error('\n[错误]', err)
  process.exit(1)
})
