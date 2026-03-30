# Constraint Harness — 稳定版本文档

> **版本**: v1.0-stable | **日期**: 2026-03-30 | **分支**: feat-constraintHarness-0330 (20 commits)
> **状态**: 功能完成，292 测试通过，Jaeger 100% 场景覆盖验证

---

## 一、架构概览

```
┌──────────────────────────────────────────────────────────┐
│                    tw-daemon                              │
│                                                          │
│  ConstraintHarness (Runtime 层)                          │
│  ├─ 创建 constraint:<entity_id> span                     │
│  ├─ 关联父 task span (parent_span_id → 同一 trace)       │
│  ├─ Promise.race 30s 超时保护                            │
│  ├─ 最小 1ms span duration (Jaeger 兼容)                 │
│  ├─ 写入 ref 详情到 span attributes                      │
│  ├─ 发布 constraint.evaluated 事件到 EventBus            │
│  └─ 永远不抛异常 (最差返回 skipped)                       │
│       ↓                                                  │
│  ConstraintEvaluator (Eval 层)                           │
│  ├─ 读取约束文件 (projectRoot + ref path)                │
│  ├─ 调用 LLM (llmFn → claude --print → skipped)         │
│  ├─ 解析结果 (RESULT: pass|fail 正则)                    │
│  └─ 聚合 (any fail → fail, all skipped → skipped)       │
│                                                          │
│  关键原则: Harness 知道 Evaluator, Evaluator 不知道 Harness │
└──────────────────────────────────────────────────────────┘
         ↓ IPC
┌────────────────────────────────────────────────────────┐
│  tw constraint evaluate <id> --json                    │
│  tw constraint history <id> --limit N                  │
│  tw constraint show <id> --json                        │
└────────────────────────────────────────────────────────┘
```

## 二、文件清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `tw-types/src/index.ts` | +15 | `ConstraintValidationResult` + `ConstraintHarnessResult` 类型 |
| `tw-daemon/src/constraint/evaluator.ts` | 115 | 纯评估：读约束文件 → 调 LLM → 返回 pass/fail |
| `tw-daemon/src/constraint/evaluator.test.ts` | 85 | 7 单元测试 |
| `tw-daemon/src/constraint/harness.ts` | 162 | Runtime 编排：span + event + timeout + fault isolation |
| `tw-daemon/src/constraint/harness.test.ts` | 100 | 5 单元测试 |
| `tw-daemon/src/constraint/integration.test.ts` | 120 | 5 集成测试 |
| `tw-daemon/src/index.ts` | +20 | daemon 启动时注入 ConstraintEvaluator + Harness |
| `tw-daemon/src/ipc-server.ts` | +25 | `constraint.evaluate` + `constraint.history` IPC 分发 |
| `tw-cli/src/commands/constraint.ts` | 134 | CLI: evaluate / history / show |

## 三、类型定义

```typescript
// Evaluator 返回（纯评估结果）
interface ConstraintValidationResult {
  result: 'pass' | 'fail' | 'skipped'
  checked_at: string
  refs_checked: Array<{ ref: string; result: string; note?: string }>
}

// Harness 返回（增加 span/duration/error 信息）
interface ConstraintHarnessResult {
  entity_id: string
  result: 'pass' | 'fail' | 'skipped'
  checked_at: string
  duration_ms: number
  span_id?: string
  refs_checked: Array<{ ref: string; result: string; note?: string }>
  error?: string
}
```

## 四、constraint_refs 传递方式

**决策 B: 存在 entity.attributes 中**

```javascript
// 注册时
await register('task', 'task-create', 'plan-endpoints', {
  attributes: { constraint_refs: ['docs/coding-rules.md'] }
})

// Harness 读取 (向后兼容两种方式)
const constraintRefs =
  entity.attributes?.constraint_refs  // 优先从 attributes 读
  ?? (entity as any).constraint_refs  // 向后兼容直接属性
  ?? []
```

## 五、LLM 调用策略

```
优先级链:
1. opts.llmFn         → 测试注入 / demo mock
2. claude --print     → 生产环境 (setup-token 认证)
   --model claude-opus-4-6
3. 降级为 skipped     → LLM 不可用时
```

**Smart Mock 模式** (`TW_CONSTRAINT_MOCK=smart`):
- 读取真实代码文件，检查是否符合约束
- 用于 demo/CI，不需要真实 LLM

## 六、Jaeger Span 属性

每个 constraint span 写入以下 attributes:

| Attribute | 示例值 | 说明 |
|-----------|-------|------|
| `constraint.result` | `fail` | 总体评估结果 |
| `constraint.duration_ms` | `1` | 评估耗时 |
| `constraint.refs_count` | `1` | 检查的约束文件数 |
| `constraint.error` | `LLM error: ...` | 仅错误时填充 |
| `constraint.ref.0.name` | `docs/coding-rules.md` | 第 N 个约束文件 |
| `constraint.ref.0.result` | `fail` | 该文件的评估结果 |
| `constraint.ref.0.note` | `Test file has no assertion...` | 失败原因 |

## 七、容错隔离

| 故障场景 | 行为 | 影响主 runtime |
|---------|------|---------------|
| claude CLI 不可用 | result: skipped + error | 无 |
| LLM 响应超时 (30s) | result: skipped + "evaluation timed out" | 无 |
| 约束文件不存在 | 该 ref skipped，继续其他 | 无 |
| LLM 返回格式异常 | parse 失败 → skipped | 无 |
| EventBus 发布失败 | 静默降级 | 无 |
| SpanManager 异常 | 静默降级 | 无 |

## 八、环境变量

| 变量 | 用途 | 默认值 |
|------|------|--------|
| `TW_PROJECT_ROOT` | 约束文件的根目录 | 无 |
| `TW_CONSTRAINT_MOCK` | 设为 `smart` 启用 demo LLM | 无（用真实 LLM） |
| `TW_STORE` | TraceWeaver 存储目录 | `.traceweaver` |

## 九、场景覆盖验证 (Jaeger)

**5 traces, 102 spans, 12 场景 100% 覆盖:**

| 场景 | Count | 验证方式 |
|------|-------|---------|
| 正常任务完成 | 90 | `state_changed_to_completed` events |
| 约束评估 pass | 6 | constraint span OK + ref note |
| 约束评估 fail | 1 | constraint span ERROR + 失败原因 |
| error.captured (build/runtime/constraint) | 3 | task span events |
| child_error 错误冒泡 | 6 | parent span events (ErrorBubbler) |
| usecase.mutated | 1 | UC span event |
| usecase.replaced | 1 | UC span event |
| superseded spans 导出 | 5 | plan-priority + 4 task-priority |
| drain.paused | 2 | task span events |
| tool.invoked | 71 | task span events |
| tool.completed | 68 | task span events |

## 十、Demo 运行

### Example 16 (TraceWeaver 内部, 直接 API)
```bash
JAEGER_ENDPOINT=localhost:4317 npm run example:16
```

### run-demo.js (todo-api-demo 项目, IPC 通信)
```bash
# 1. Jaeger
docker run -d --name jaeger -p 4317:4317 -p 16686:16686 jaegertracing/all-in-one:latest

# 2. Daemon
TW_STORE=$(pwd)/.traceweaver TW_PROJECT_ROOT=$(pwd) TW_CONSTRAINT_MOCK=smart \
node /path/to/TraceWeaver/packages/tw-daemon/dist/index.js &

# 3. Demo
node run-demo.js

# 4. Jaeger UI
open http://localhost:16686
```

**Demo 结果: 5 UC, 95 entities, 7 constraint pass + 1 fail, 真实文件修复**

## 十一、修复记录

| 问题 | 修复 | Commit |
|------|------|--------|
| constraint span 散落为独立 trace | 通过 `parent_span_id` 关联父 task | `1f2f32d` |
| Jaeger negative-duration warning | 确保最小 1ms span duration | `1510643` |
| Jaeger 看不到失败原因 | 写入 `constraint.ref.N.*` attributes | `559c3fc` |
| superseded spans 不导出 | `endSpan` on superseded state | `9b8e0a7` |
| mutation 事件不在 span 上 | `addEvent` for usecase.mutated/replaced | `4673c27` |
| ErrorBubbler 不冒泡 IPC error | `emitEvent` 同时发布 `error.captured` TwEvent | `57f2718` |
| EMFILE watch 错误 | `watch.enabled: false` 跳过 FsWatcher | `0e1b14e` |

## 十二、已知限制

1. `constraint_refs` 不在 Entity 接口上（存在 attributes 中，类型不安全）
2. Smart mock LLM 只检查 `todo.test.ts` 的 empty string edge case（真实 LLM 更通用）
3. 约束评估结果不持久化（仅在 EventLog 中，daemon 重启后 span 丢失）
4. 多个 constraint_refs 并行评估（Promise.all），一个超时会等 30s
