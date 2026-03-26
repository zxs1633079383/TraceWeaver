/**
 * Example 12 — Jaeger 全链路 Trace 验证
 *
 * 本示例通过真实 OTLP/gRPC 将完整 trace 数据导出到 Jaeger，覆盖：
 *
 *  Trace 链路：
 *    ✅ usecase span (root)
 *       └── plan span (child)
 *               ├── task-pass span (child) — completed → status=OK
 *               └── task-fail span (child) — manually rejected → status=ERROR
 *
 *  每个 span 上的 events：
 *    ✅ state_changed_to_in_progress
 *    ✅ artifact.modified  (tw.file.path, tw.impact.type)
 *    ✅ state_changed_to_review
 *    ✅ state_changed_to_completed / state_changed_to_rejected
 *
 *  配套系统：
 *    ✅ EventLog    — 全流程事件持久化
 *    ✅ InboxAdapter — 拒绝/通过通知
 *
 * 前提（任选一）：
 *   A. 本机已通过 telepresence 连接 K8s 集群（直接可达 K8s service）
 *   B. 手动 port-forward:
 *        kubectl port-forward svc/jaeger-cses-pre-collector 4317:4317 -n jaeger-cses
 *      然后设置环境变量: JAEGER_ENDPOINT=localhost:4317
 *
 * 运行：
 *   npm run run:12 --workspace=examples
 *
 * 成功后在 Jaeger UI 搜索：
 *   Service = traceweaver-daemon
 *   Operation = tw.usecase
 */

import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { CommandHandler } from '../../packages/tw-daemon/src/core/command-handler.js'
import { EventBus } from '../../packages/tw-daemon/src/core/event-bus/event-bus.js'
import { SpanManager } from '../../packages/tw-daemon/src/otel/span-manager.js'
import { EventLog } from '../../packages/tw-daemon/src/log/event-log.js'
import { InboxAdapter } from '../../packages/tw-daemon/src/notify/inbox.js'
import { NotifyEngine } from '../../packages/tw-daemon/src/notify/engine.js'
import { ExporterRegistry } from '../../packages/tw-daemon/src/otel/exporter-registry.js'
import { OtlpGrpcExporter } from '../../packages/tw-daemon/src/otel/exporter-grpc.js'

// ── 配置 ────────────────────────────────────────────────────────────────────
const JAEGER_ENDPOINT = process.env.JAEGER_ENDPOINT
  ?? 'jaeger-cses-pre-collector.jaeger-cses.svc.cluster.local:4317'
const SERVICE_NAME = 'traceweaver-daemon'
const PROJECT_ID   = `tw-demo-${new Date().toISOString().slice(0, 10)}`

// ── 彩色输出 ────────────────────────────────────────────────────────────────
const C = { reset: '\x1b[0m', bold: '\x1b[1m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', gray: '\x1b[90m', blue: '\x1b[34m' }
const section = (t: string) => { console.log(`\n${C.bold}${C.cyan}${'─'.repeat(60)}${C.reset}\n${C.bold}${C.cyan}  ${t}${C.reset}\n${C.cyan}${'─'.repeat(60)}${C.reset}`) }
const ok      = (m: string) => console.log(`  ${C.green}✓${C.reset} ${m}`)
const warn    = (m: string) => console.log(`  ${C.yellow}⚠${C.reset} ${m}`)
const info    = (m: string) => console.log(`  ${C.gray}→${C.reset} ${m}`)
const span_ok = (m: string) => console.log(`  ${C.blue}◆${C.reset} ${m}`)

// ── 模拟文件变更事件（代替真实 FsWatcher）──────────────────────────────────
function simulateFileChange(eventBus: EventBus, filePath: string): void {
  eventBus.publish({
    id: randomUUID(),
    type: 'file.changed' as any,
    ts: new Date().toISOString(),
    attributes: { path: filePath },
  })
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`\n${C.bold}TraceWeaver — Example 12: Jaeger 全链路 Trace 验证${C.reset}`)
  console.log(`${C.cyan}JAEGER_ENDPOINT${C.reset} = ${C.bold}${JAEGER_ENDPOINT}${C.reset}`)
  console.log(`${C.cyan}SERVICE        ${C.reset} = ${C.bold}${SERVICE_NAME}${C.reset}`)
  console.log(`${C.cyan}PROJECT_ID     ${C.reset} = ${C.bold}${PROJECT_ID}${C.reset}\n`)

  const storeDir   = await mkdtemp(join(tmpdir(), 'tw-example-12-'))
  const inboxDir   = join(storeDir, 'inbox')
  await mkdir(inboxDir, { recursive: true })

  // ── Phase A：ExporterRegistry → 真实 Jaeger ──────────────────────────────
  section('Phase A：OtlpGrpcExporter → Jaeger')

  const exporterRegistry = new ExporterRegistry()
  const grpcExporter = new OtlpGrpcExporter({ endpoint: JAEGER_ENDPOINT })
  exporterRegistry.register(grpcExporter)

  ok(`ExporterRegistry 已注册 otlp-grpc exporter`)
  info(`endpoint: ${JAEGER_ENDPOINT}`)

  // ── Phase B：组件初始化 ───────────────────────────────────────────────────
  section('Phase B：组件初始化')

  const spanManager = new SpanManager({ projectId: PROJECT_ID, exporterRegistry })
  const eventBus    = new EventBus({ batchWindowMs: 30 })
  const eventLog    = new EventLog(join(storeDir, 'events.ndjson'))
  eventLog.load()
  const inboxAdapter = new InboxAdapter(inboxDir)

  const handler = new CommandHandler({ storeDir, eventBus, spanManager, eventLog })
  await handler.init()
  eventBus.start()

  const notifyEngine = new NotifyEngine(eventBus, {
    rules: [
      { event: 'entity.state_changed', state: 'rejected' },
      { event: 'entity.state_changed', state: 'completed' },
    ],
    inbox: inboxAdapter,
  })
  notifyEngine.start()

  // 文件变更管道：file.changed → artifact.modified + spanEvent
  eventBus.subscribe(event => {
    if (event.type !== ('file.changed' as any)) return
    const filePath = event.attributes?.path as string | undefined
    if (!filePath) return
    const impact = handler.resolveImpact(filePath)
    for (const entity of impact.directly_affected) {
      eventBus.publish({
        id: randomUUID(), type: 'artifact.modified',
        entity_id: entity.id, entity_type: entity.entity_type,
        ts: new Date().toISOString(),
        attributes: { trigger_file: filePath, impact_type: 'direct' },
      })
      spanManager.addEvent(entity.id, 'artifact.modified', {
        'tw.file.path': filePath, 'tw.impact.type': 'direct',
      })
    }
    for (const entity of impact.transitively_affected) {
      spanManager.addEvent(entity.id, 'artifact.modified', {
        'tw.file.path': filePath, 'tw.impact.type': 'transitive',
      })
    }
  })

  ok('SpanManager(otlp-grpc)、EventBus、CommandHandler、NotifyEngine 已就绪')

  // ── Phase C：注册实体层级（parent_id 建立 span 父子关系）────────────────
  section('Phase C：注册实体层级 → Jaeger span 父子关系')

  // UseCase（root span）
  const uc = await handler.register({
    id: 'uc-jaeger-demo',
    entity_type: 'usecase',
    attributes: { title: 'Jaeger Trace 验证用例' },
    artifact_refs: [{ type: 'doc', path: 'docs/jaeger-prd.md' }],
  })
  ok(`usecase: ${uc.id}  → root span`)

  // Plan（child of usecase）
  const plan = await handler.register({
    id: 'plan-impl',
    entity_type: 'plan',
    parent_id: 'uc-jaeger-demo',
    depends_on: ['uc-jaeger-demo'],
    attributes: { title: '实现计划' },
    artifact_refs: [
      { type: 'doc', path: 'docs/jaeger-prd.md' },
      { type: 'design', path: 'docs/design.md' },
    ],
  })
  ok(`plan:    ${plan.id}  → child of usecase`)

  // Task-pass（child of plan，will complete normally）
  const taskPass = await handler.register({
    id: 'task-grpc-client',
    entity_type: 'task',
    parent_id: 'plan-impl',
    depends_on: ['plan-impl'],
    attributes: { title: 'gRPC 客户端实现' },
    artifact_refs: [{ type: 'code', path: 'src/otel/exporter-grpc.ts' }],
  })
  ok(`task:    ${taskPass.id}  → will complete normally`)

  // Task-fail（child of plan，will be manually rejected）
  const taskFail = await handler.register({
    id: 'task-no-tests',
    entity_type: 'task',
    parent_id: 'plan-impl',
    depends_on: ['plan-impl'],
    attributes: { title: '集成测试（缺测试）' },
    artifact_refs: [{ type: 'code', path: 'src/otel/exporter-grpc.ts' }],
  })
  ok(`task:    ${taskFail.id}  → will be manually rejected`)

  const dag = await handler.getDagSnapshot({})
  info(`DAG: ${dag.nodes.length} 节点, ${dag.edges.length} 条边`)

  // ── Phase D：模拟文件变更 → span events ──────────────────────────────────
  section('Phase D：模拟文件变更 → artifact.modified span events')

  // docs/jaeger-prd.md 影响 usecase + plan（直接），tasks（传递）
  simulateFileChange(eventBus, 'docs/jaeger-prd.md')
  await new Promise(r => setTimeout(r, 80))  // 等待批处理窗口
  ok('docs/jaeger-prd.md 变更 → artifact.modified events 写入受影响实体 span')

  // src/otel/exporter-grpc.ts 直接影响两个 task
  simulateFileChange(eventBus, 'src/otel/exporter-grpc.ts')
  await new Promise(r => setTimeout(r, 80))
  ok('src/otel/exporter-grpc.ts 变更 → artifact.modified events 写入两个 task span')

  // ── Phase E：完整状态流转 → span events + Jaeger 导出 ───────────────────
  section('Phase E：完整状态流转 → span export to Jaeger')

  // task-pass: pending → in_progress → review → completed
  await handler.updateState({ id: 'task-grpc-client', state: 'in_progress' })
  span_ok('task-grpc-client → in_progress  (span event)')
  await handler.updateState({ id: 'task-grpc-client', state: 'review' })
  span_ok('task-grpc-client → review')
  await handler.updateState({ id: 'task-grpc-client', state: 'completed' })
  span_ok('task-grpc-client → completed  (span exported to Jaeger)')

  // task-fail: pending → in_progress → review → manually rejected
  await handler.updateState({ id: 'task-no-tests', state: 'in_progress' })
  span_ok('task-no-tests → in_progress  (span event)')
  await handler.updateState({ id: 'task-no-tests', state: 'review' })
  span_ok('task-no-tests → review')
  await handler.updateState({ id: 'task-no-tests', state: 'rejected', reason: 'Missing tests' })
  span_ok('task-no-tests → rejected  (manually rejected — ERROR span)')

  // plan & usecase
  await handler.updateState({ id: 'plan-impl', state: 'in_progress' })
  await handler.updateState({ id: 'plan-impl', state: 'review' })
  await handler.updateState({ id: 'plan-impl', state: 'completed' })
  span_ok('plan-impl → completed  (span exported to Jaeger)')

  await handler.updateState({ id: 'uc-jaeger-demo', state: 'in_progress' })
  await handler.updateState({ id: 'uc-jaeger-demo', state: 'review' })
  await handler.updateState({ id: 'uc-jaeger-demo', state: 'completed' })
  span_ok('uc-jaeger-demo → completed  (span exported to Jaeger)')

  await new Promise(r => setTimeout(r, 200))

  notifyEngine.stop()
  eventBus.stop()

  // ── Phase F：验证结果 ─────────────────────────────────────────────────────
  section('Phase F：本地验证结果')

  const taskPassFinal = await handler.getStatus({ id: 'task-grpc-client' })
  const taskFailFinal = await handler.getStatus({ id: 'task-no-tests' })
  const planFinal     = await handler.getStatus({ id: 'plan-impl' })
  const ucFinal       = await handler.getStatus({ id: 'uc-jaeger-demo' })

  ok(`usecase   state = ${ucFinal.entity.state}  [预期: completed]`)
  ok(`plan      state = ${planFinal.entity.state}  [预期: completed]`)
  ok(`task-pass state = ${taskPassFinal.entity.state}  [预期: completed]`)
  ok(`task-fail state = ${taskFailFinal.entity.state}  [预期: rejected]`)

  // ── Phase G：Inbox 通知 ────────────────────────────────────────────────────
  section('Phase G：Inbox 通知')

  const inboxItems = await inboxAdapter.list()
  ok(`收件箱消息: ${inboxItems.length} 条`)
  for (const item of inboxItems) {
    info(`  [${item.acked ? 'acked' : '未读'}] ${item.message ?? item.event_type}`)
  }

  // ── Phase H：获取 trace_id，给出 Jaeger 查询入口 ─────────────────────────
  section('Phase H：Jaeger Trace 查询')

  const ucSpan = spanManager.getSpan('uc-jaeger-demo')
  const traceId = ucSpan?.trace_id ?? '未知'

  await exporterRegistry.shutdown()

  console.log(`
${C.bold}${C.green}  Trace 导出完成！${C.reset}

  在 Jaeger UI 中搜索：
  ┌─────────────────────────────────────────────────────────┐
  │  Service   : traceweaver-daemon                         │
  │  Operation : tw.usecase                                 │
  │  trace_id  : ${traceId.padEnd(41)}│
  └─────────────────────────────────────────────────────────┘

  Jaeger UI 地址（示例）：
  http://jaeger-cses-pre.<your-domain>/search?service=traceweaver-daemon

  预期 Jaeger 中看到：
  ┌──────────────────────────────────────────────────────────┐
  │ tw.usecase [uc-jaeger-demo]                OK  ■■■■■■■■  │
  │  └── tw.plan [plan-impl]                   OK  ■■■■■■    │
  │       ├── tw.task [task-grpc-client]        OK  ■■■■      │
  │       │     events: artifact.modified(x2)              │
  │       │             state_changed_to_review            │
  │       │             state_changed_to_completed         │
  │       └── tw.task [task-no-tests]          ERR ■■■       │
  │             events: artifact.modified(x2)              │
  │             state_changed_to_review                    │
  │             state_changed_to_rejected                  │
  └──────────────────────────────────────────────────────────┘
`)

  await rm(storeDir, { recursive: true })
}

main().catch(err => {
  console.error(`\n${C.red}[错误]${C.reset}`, err.message)
  console.error(err)
  process.exit(1)
})
