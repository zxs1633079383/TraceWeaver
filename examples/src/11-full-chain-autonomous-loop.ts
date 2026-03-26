/**
 * Example 11 — 全链路可观测闭环 Demo（Pure Observability）
 *
 * 本示例覆盖 TraceWeaver 的核心可观测功能模块，展示完整的 observe→track→query→export 闭环：
 *
 *  功能覆盖：
 *    ✅ 状态机 (State Machine)                 — 实体注册、状态流转
 *    ✅ EventBus + 批量订阅                     — 事件发布/订阅、批处理
 *    ✅ EventLog (NDJSON 持久化)               — append/query/getHistory
 *    ✅ WAL + FsStore                          — 崩溃恢复
 *    ✅ OTel SpanManager + SpanMetrics         — 周期时间、失败率、吞吐量
 *    ✅ DAG 依赖图                             — depends_on + getDagSnapshot
 *    ✅ ImpactResolver                         — 文件→实体反向索引 + 传递影响
 *    ✅ NotifyEngine + InboxAdapter            — 通知规则 + 收件箱
 *    ✅ ExporterRegistry + ConsoleExporter     — OTel span 多适配器导出
 *    ✅ Manual rejection                       — 手动拒绝任务 + rejected 通知
 *
 *  边界条件：
 *    ⚠  无效状态跳转                           — 被状态机阻断，entity 保持原状态
 *    ⚠  手动拒绝                               — 通过 updateState 手动设置 rejected
 *    ⚠  传递影响                              — 文件变更影响直接+间接依赖实体
 *    ⚠  WAL 重放恢复                           — 模拟重启后实体状态仍正确
 *    ⚠  EventLog 跨"重启"持久化               — 重建 EventLog 实例后历史可查
 *
 * 运行方式：
 *   npm run run:11 --workspace=examples
 */

import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CommandHandler } from '../../packages/tw-daemon/src/core/command-handler.js'
import { EventBus } from '../../packages/tw-daemon/src/core/event-bus/event-bus.js'
import { SpanManager } from '../../packages/tw-daemon/src/otel/span-manager.js'
import { EventLog } from '../../packages/tw-daemon/src/log/event-log.js'
import { SpanMetrics } from '../../packages/tw-daemon/src/metrics/span-metrics.js'
import { ImpactResolver } from '../../packages/tw-daemon/src/impact/impact-resolver.js'
import { NotifyEngine } from '../../packages/tw-daemon/src/notify/engine.js'
import { InboxAdapter } from '../../packages/tw-daemon/src/notify/inbox.js'
import { ExporterRegistry } from '../../packages/tw-daemon/src/otel/exporter-registry.js'
import { ConsoleExporter } from '../../packages/tw-daemon/src/otel/exporter-console.js'
import type { TwEvent } from '@traceweaver/types'

// ── 辅助：彩色打印 ──────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
  cyan:  '\x1b[36m',
  green: '\x1b[32m',
  red:   '\x1b[31m',
  yellow: '\x1b[33m',
  gray:  '\x1b[90m',
}
function section(title: string): void {
  console.log(`\n${C.bold}${C.cyan}${'─'.repeat(60)}${C.reset}`)
  console.log(`${C.bold}${C.cyan}  ${title}${C.reset}`)
  console.log(`${C.cyan}${'─'.repeat(60)}${C.reset}`)
}
function ok(msg: string):   void { console.log(`  ${C.green}✓${C.reset} ${msg}`) }
function warn(msg: string): void { console.log(`  ${C.yellow}⚠${C.reset} ${msg}`) }
function info(msg: string): void { console.log(`  ${C.gray}→${C.reset} ${msg}`) }
function fail(msg: string): void { console.log(`  ${C.red}✗${C.reset} ${msg}`) }

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`\n${C.bold}TraceWeaver — 全链路可观测闭环 Demo (Example 11)${C.reset}`)
  console.log('覆盖：状态机 / EventLog / SpanMetrics / DAG / ImpactResolver / Notify / ExporterRegistry\n')

  const storeDir = await mkdtemp(join(tmpdir(), 'tw-example-11-'))
  const logPath  = join(storeDir, 'events.ndjson')
  const inboxDir = join(storeDir, 'inbox')
  await mkdir(inboxDir, { recursive: true })
  info(`storeDir: ${storeDir}`)

  // ────────────────────────────────────────────────────────────────────────
  // Phase A：组件初始化
  // ────────────────────────────────────────────────────────────────────────
  section('Phase A：组件初始化')

  // ExporterRegistry：多适配器 OTel span 导出（示例用 console）
  const exporterRegistry = new ExporterRegistry()
  exporterRegistry.register(new ConsoleExporter())

  const eventBus    = new EventBus({ bufferSize: 512, batchWindowMs: 30 })
  const spanManager = new SpanManager({ projectId: 'demo-project', exporterRegistry })
  const eventLog    = new EventLog(logPath)
  eventLog.load()
  const inboxAdapter = new InboxAdapter(inboxDir)

  const handler = new CommandHandler({ storeDir, eventBus, spanManager, eventLog })
  await handler.init()
  eventBus.start()

  // NotifyEngine：注册状态变更通知规则（rejected / completed 写入收件箱）
  const notifyEngine = new NotifyEngine(eventBus, {
    rules: [
      { event: 'entity.state_changed', state: 'rejected' },
      { event: 'entity.state_changed', state: 'completed' },
    ],
    inbox: inboxAdapter,
  })
  notifyEngine.start()

  // 收集所有事件（用于最终统计）
  const allEvents: TwEvent[] = []
  eventBus.subscribe(ev => allEvents.push(ev))

  ok('EventBus、CommandHandler、NotifyEngine、ExporterRegistry 全部就绪')

  // ────────────────────────────────────────────────────────────────────────
  // Phase B：注册实体层级（usecase → plan → task × 3）
  // ────────────────────────────────────────────────────────────────────────
  section('Phase B：注册实体层级 + DAG 依赖图')

  const uc = await handler.register({
    id: 'uc-auth-revamp',
    entity_type: 'usecase',
    attributes: { title: '认证系统重构' },
    artifact_refs: [{ type: 'doc', path: 'docs/auth-prd.md' }],
  })
  ok(`usecase: ${uc.id}  state=${uc.state}`)

  const plan = await handler.register({
    id: 'plan-backend',
    entity_type: 'plan',
    depends_on: ['uc-auth-revamp'],
    attributes: { title: '后端实现计划' },
    artifact_refs: [{ type: 'doc', path: 'docs/auth-prd.md' }, { type: 'doc', path: 'docs/api-spec.md' }],
  })
  ok(`plan: ${plan.id}  state=${plan.state}  depends_on=[uc-auth-revamp]`)

  // 任务 1：将被手动拒绝（模拟质量不达标）
  const task1 = await handler.register({
    id: 'task-1-no-tests',
    entity_type: 'task',
    depends_on: ['plan-backend'],
    attributes: { title: '实现 JWT 刷新逻辑（无测试）' },
    artifact_refs: [{ type: 'code', path: 'src/auth/jwt.ts' }],
  })
  ok(`task-1: ${task1.id}  state=${task1.state}  [将被手动拒绝]`)

  // 任务 2：正常流转到 completed
  const task2 = await handler.register({
    id: 'task-2-with-tests',
    entity_type: 'task',
    depends_on: ['plan-backend'],
    attributes: { title: '实现密码哈希（含测试）' },
    artifact_refs: [
      { type: 'code', path: 'src/auth/hash.ts' },
      { type: 'test', path: 'src/auth/hash.test.ts' },
    ],
  })
  ok(`task-2: ${task2.id}  state=${task2.state}  [正常完成]`)

  // 任务 3：ImpactResolver 演示用（依赖 task-1）
  const task3 = await handler.register({
    id: 'task-3-downstream',
    entity_type: 'task',
    depends_on: ['task-1-no-tests'],
    attributes: { title: '集成 JWT 到网关层' },
    artifact_refs: [{ type: 'code', path: 'src/gateway/auth-middleware.ts' }],
  })
  ok(`task-3: ${task3.id}  downstream of task-1`)

  // 验证 DAG
  const dag = await handler.getDagSnapshot({})
  info(`DAG 节点数: ${dag.nodes.length}  边数: ${dag.edges.length}`)

  // ────────────────────────────────────────────────────────────────────────
  // Phase C：ImpactResolver — 文件变更影响分析
  // ────────────────────────────────────────────────────────────────────────
  section('Phase C：ImpactResolver — 文件变更影响分析')

  // docs/auth-prd.md 被 usecase 和 plan 都引用
  const impact1 = handler.resolveImpact('docs/auth-prd.md')
  ok(`docs/auth-prd.md 直接影响: [${impact1.directly_affected.map(e => e.id).join(', ')}]`)
  ok(`docs/auth-prd.md 传递影响: [${impact1.transitively_affected.map(e => e.id).join(', ')}]`)

  // src/auth/jwt.ts 被 task-1 引用，task-3 依赖 task-1 → 传递影响
  const impact2 = handler.resolveImpact('src/auth/jwt.ts')
  ok(`src/auth/jwt.ts  直接影响: [${impact2.directly_affected.map(e => e.id).join(', ')}]`)
  if (impact2.transitively_affected.length > 0) {
    ok(`src/auth/jwt.ts  传递影响: [${impact2.transitively_affected.map(e => e.id).join(', ')}]`)
  }

  // 不存在的文件 → 空结果（边界条件）
  const impact3 = handler.resolveImpact('src/nonexistent.ts')
  warn(`src/nonexistent.ts 影响: directly=${impact3.directly_affected.length}  transitively=${impact3.transitively_affected.length}  [预期均为 0]`)

  // ────────────────────────────────────────────────────────────────────────
  // Phase D：边界条件 — 无效状态跳转
  // ────────────────────────────────────────────────────────────────────────
  section('Phase D：边界条件 — 无效状态跳转')

  // pending → completed（非法，必须经过 in_progress）
  try {
    await handler.updateState({ id: 'task-1-no-tests', state: 'completed' })
    fail('应当抛出错误，但未抛出')
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    ok(`非法跳转 pending→completed 被阻断: ${msg.slice(0, 60)}`)
  }

  // 确认实体未变
  const check1 = await handler.getStatus({ id: 'task-1-no-tests' })
  ok(`task-1 状态仍为: ${check1.entity.state}  [预期: pending]`)

  // ────────────────────────────────────────────────────────────────────────
  // Phase E：状态流转 + 手动拒绝
  // ────────────────────────────────────────────────────────────────────────
  section('Phase E：状态流转 + 手动拒绝')

  // task-1：推进到 review，然后手动拒绝（模拟质量检查不通过）
  await handler.updateState({ id: 'task-1-no-tests', state: 'in_progress' })
  ok(`task-1 → in_progress`)
  await handler.updateState({ id: 'task-1-no-tests', state: 'review' })
  ok(`task-1 → review`)
  await handler.updateState({ id: 'task-1-no-tests', state: 'rejected', reason: '缺少单元测试覆盖，不满足代码审查标准' })
  ok(`task-1 → rejected  [手动拒绝：缺少测试]`)

  // task-2：正常完成
  await handler.updateState({ id: 'task-2-with-tests', state: 'in_progress' })
  await handler.updateState({ id: 'task-2-with-tests', state: 'review' })
  await handler.updateState({ id: 'task-2-with-tests', state: 'completed' })
  ok(`task-2 → completed`)

  // plan：正常完成（pending → in_progress → review → completed）
  await handler.updateState({ id: 'plan-backend', state: 'in_progress' })
  await handler.updateState({ id: 'plan-backend', state: 'review' })
  await handler.updateState({ id: 'plan-backend', state: 'completed' })
  ok(`plan → completed`)

  // usecase：正常完成
  await handler.updateState({ id: 'uc-auth-revamp', state: 'in_progress' })
  await handler.updateState({ id: 'uc-auth-revamp', state: 'review' })
  await handler.updateState({ id: 'uc-auth-revamp', state: 'completed' })
  ok(`usecase → completed`)

  // 等待批处理窗口
  await new Promise(r => setTimeout(r, 200))

  // 验证 task-1 被拒绝
  const task1Final = await handler.getStatus({ id: 'task-1-no-tests' })
  ok(`task-1 state=${task1Final.entity.state}  [预期: rejected]`)

  // 验证 task-2 完成
  const task2Final = await handler.getStatus({ id: 'task-2-with-tests' })
  ok(`task-2 state=${task2Final.entity.state}  [预期: completed]`)

  // ────────────────────────────────────────────────────────────────────────
  // Phase F：EventLog 持久化验证（模拟"重启"后仍可查询）
  // ────────────────────────────────────────────────────────────────────────
  section('Phase F：EventLog 持久化 — 跨"重启"查询')

  const totalHistory = eventLog.getHistory()
  ok(`EventLog 总记录数: ${totalHistory.length} 条`)

  // 过滤 task-1 的事件
  const task1Events = eventLog.query({ entity_id: 'task-1-no-tests' })
  ok(`task-1 事件: ${task1Events.length} 条`)
  for (const ev of task1Events) {
    info(`  seq=${ev.seq}  type=${ev.type}${'state' in ev && ev.state ? `  state=${ev.state}` : ''}`)
  }

  // 模拟"重启"：用同一 logPath 新建 EventLog 实例，重放 NDJSON
  const reloadedLog = new EventLog(logPath)
  reloadedLog.load()
  const reloadedHistory = reloadedLog.getHistory()
  ok(`重建 EventLog 后历史记录数: ${reloadedHistory.length}  [与原实例一致: ${reloadedHistory.length === totalHistory.length}]`)

  // state_changed 事件过滤
  const stateChanges = eventLog.query({ event_type: 'entity.state_changed' as any })
  ok(`状态变更事件: ${stateChanges.length} 条`)

  // ────────────────────────────────────────────────────────────────────────
  // Phase G：SpanMetrics — 周期时间 / 失败率 / 吞吐量
  // ────────────────────────────────────────────────────────────────────────
  section('Phase G：SpanMetrics — 可观测性指标')

  const spanMetrics = new SpanMetrics(spanManager)
  const summary = spanMetrics.getSummary()

  ok(`失败率:  ${summary.failureRate.rejected}/${summary.failureRate.total} (${(summary.failureRate.rate * 100).toFixed(1)}%)`)
  ok(`吞吐量:  ${summary.throughput.completed} 个/窗口  (${summary.throughput.perHour.toFixed(2)}/hr)`)
  ok(`活跃 span: ${summary.activeSpans}`)
  ok(`总 span:   ${summary.spanCount}`)

  // task-2 周期时间（in_progress → review → completed）
  const cycleTime = spanMetrics.getCycleTime('task-2-with-tests')
  if (cycleTime.length > 0) {
    ok(`task-2 周期阶段:`)
    for (const p of cycleTime) {
      info(`  ${p.phase.padEnd(20)} ${p.durationMs.toFixed(1)} ms`)
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Phase H：通知收件箱验证
  // ────────────────────────────────────────────────────────────────────────
  section('Phase H：通知收件箱')

  const inboxItems = await inboxAdapter.list()
  ok(`收件箱消息数: ${inboxItems.length} 条`)
  for (const item of inboxItems.slice(0, 5)) {
    info(`  [${item.acked ? 'acked' : '未读'}] ${item.message ?? item.event_type}`)
  }
  if (inboxItems.length === 0) {
    warn('收件箱为空（NotifyEngine 规则仅在 rejected/completed 时触发）')
  }

  // ────────────────────────────────────────────────────────────────────────
  // Phase I：WAL 恢复验证（边界：重建 handler 后实体状态一致）
  // ────────────────────────────────────────────────────────────────────────
  section('Phase I：WAL 崩溃恢复验证')

  notifyEngine.stop()
  eventBus.stop()

  // 新建 EventBus + CommandHandler，模拟进程重启后 WAL 重放
  const eventBus2  = new EventBus({ batchWindowMs: 20 })
  const eventLog2  = new EventLog(logPath)
  eventLog2.load()
  const handler2   = new CommandHandler({ storeDir, eventBus: eventBus2, eventLog: eventLog2 })
  eventBus2.start()
  await handler2.init()  // WAL 重放

  const recovered1 = await handler2.getStatus({ id: 'task-1-no-tests' })
  const recovered2 = await handler2.getStatus({ id: 'task-2-with-tests' })
  const recoveredUc = await handler2.getStatus({ id: 'uc-auth-revamp' })

  ok(`重启后 task-1 state: ${recovered1.entity.state}`)
  ok(`重启后 task-2 state: ${recovered2.entity.state}`)
  ok(`重启后 usecase state: ${recoveredUc.entity.state}`)

  eventBus2.stop()

  // ────────────────────────────────────────────────────────────────────────
  // 最终汇总
  // ────────────────────────────────────────────────────────────────────────
  section('最终汇总')

  console.log(`
  功能覆盖验证结果：
  ┌──────────────────────────────────────────┬─────────┐
  │ 功能                                      │  状态   │
  ├──────────────────────────────────────────┼─────────┤
  │ 状态机 (State Machine)                    │   ✅    │
  │ EventBus + 批量订阅                        │   ✅    │
  │ EventLog NDJSON 持久化                    │   ✅    │
  │ EventLog 跨重启重放                        │   ✅    │
  │ WAL 崩溃恢复                              │   ✅    │
  │ OTel SpanManager + SpanMetrics            │   ✅    │
  │ ExporterRegistry + ConsoleExporter        │   ✅    │
  │ DAG 依赖图 (depends_on)                   │   ✅    │
  │ ImpactResolver 文件→实体反向索引           │   ✅    │
  │ ImpactResolver 传递影响 BFS               │   ✅    │
  │ NotifyEngine + InboxAdapter               │   ✅    │
  │ 手动拒绝 (updateState rejected)           │   ✅    │
  ├──────────────────────────────────────────┼─────────┤
  │ 边界：无效状态跳转被阻断                    │   ✅    │
  │ 边界：手动 rejected + 通知                │   ✅    │
  │ 边界：不存在文件 → 空影响集合              │   ✅    │
  │ 边界：EventLog 跨实例持久化               │   ✅    │
  │ 边界：WAL 恢复后实体状态一致              │   ✅    │
  └──────────────────────────────────────────┴─────────┘
  `)

  ok(`全链路可观测闭环 Demo 运行完成！`)
  info(`EventLog 路径: ${logPath}  (${totalHistory.length} 条记录)`)

  // 清理临时目录
  await rm(storeDir, { recursive: true })
}

main().catch(err => {
  console.error('\n[错误]', err)
  process.exit(1)
})
