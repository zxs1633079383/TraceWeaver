# ConstraintEvaluator 职责分离设计

**日期:** 2026-03-30
**状态:** implemented ✅ (已实现，以 CONSTRAINT-HARNESS-STABLE.md 为准)
**范围:** tw-daemon / tw-cli / tw-types
**稳定版文档:** [../CONSTRAINT-HARNESS-STABLE.md](../CONSTRAINT-HARNESS-STABLE.md)

## 问题

现有 ConstraintEvaluator 将约束读取、LLM 调用、结果判定、后续决策全部耦合在一个类中。业界共识是 runtime harness 只负责 trace 记录和约束执行，评估结果输出给上游 Agent，由上游决定后续动作。

## 决策

采用**双层分离**方案，两层都在 tw-daemon 内部：

- **ConstraintHarness**（Runtime 层）：编排流程、创建 span、发布事件、注册 IPC command
- **ConstraintEvaluator**（Eval 层）：纯评估函数，不碰 span/event

关键原则：**Harness 知道 Evaluator，Evaluator 不知道 Harness。**

## 使用场景

优先级排序：
1. **单 Agent 自检**（首先跑通）：一个 Agent 执行任务时调用 TraceWeaver trace 自己的执行过程
2. **多 Agent 编排**：Orchestrator 统一管理子 Agent 的 trace 和评估
3. **CI/CD 管线**：构建流程中评估 Agent 产出物是否符合质量门槛

上游 Agent 通过 CLI 获取评估结果。

## 架构

```
┌──────────────────────────────────────────────────────────┐
│                    tw-daemon                              │
│                                                          │
│  ┌─────────────────────┐    ┌──────────────────────┐     │
│  │  ConstraintHarness  │───>│ ConstraintEvaluator  │     │
│  │  (Runtime层)         │    │ (Eval层)              │     │
│  │                     │    │                      │     │
│  │  - 编排流程          │    │  - 纯评估函数         │     │
│  │  - 创建/管理span    │    │  - 读约束文件         │     │
│  │  - 发布EventBus事件  │    │  - 调LLM打分         │     │
│  │  - 注册IPC command  │    │  - 返回EvalResult    │     │
│  │  - 输出结构化结果    │    │  - 不碰span/event    │     │
│  └─────────────────────┘    └──────────────────────┘     │
│           │                                              │
│           ├──> SpanManager (已有)                         │
│           ├──> EventBus (已有)                            │
│           └──> IpcServer (已有)                           │
└──────────────────────────────────────────────────────────┘
         │
         │ IPC
         ▼
┌────────────────────┐
│  tw constraint     │
│  evaluate <id>     │  ← 上游Agent调用
│  --json            │  ← 返回结构化结果
└────────────────────┘
```

## LLM 调用策略

没有 API key，通过 `claude` CLI 子进程调用：

```typescript
// 优先级链
1. opts.llmFn       → 测试用（注入 mock）
2. claude --print   → 生产用（用 setup-token 认证）
3. 降级为 skipped   → 都不可用时
```

生产模式：
```typescript
const result = await execFile('claude', [
  '--print',
  '--model', 'claude-opus-4-6',
  prompt
]);
```

## 容错隔离

原则：**评估是旁路，不是主路。评估挂了，trace 继续跑。**

```
ConstraintHarness.run(entity_id)
  ├─ 1. 创建 span（总会成功）
  ├─ 2. try { evaluator.evaluate() }
  │     catch → span.setStatus('error')
  │           → 返回 { result: 'skipped', error: '...' }
  │           → 不抛异常，不影响调用方
  ├─ 3. 发布事件（总会成功）
  └─ 4. 返回结果（总会返回，最差是 skipped）
```

超时保护：`Promise.race` + 30s timeout。

| 故障场景 | 行为 | 对主 runtime 影响 |
|---------|------|-----------------|
| claude CLI 不可用 | result: skipped + error 记录 | 无 |
| LLM 响应超时 | 30s timeout → skipped | 无 |
| 约束文件不存在 | 该 ref skipped，继续其他 | 无 |
| LLM 返回格式异常 | parse 失败 → skipped | 无 |
| EventBus 发布失败 | 静默降级，span 已记录 | 无 |

**ConstraintHarness 永远不抛异常。**

## 数据流

```
上游 Agent
    │  tw constraint evaluate task-001 --json
    ▼
tw-cli (constraint.ts)
    │  IPC: { type: 'constraint.evaluate', entity_id: 'task-001' }
    ▼
CommandHandler
    │  1. EntityRegistry.get(entity_id)
    │  2. 提取 constraint_refs + artifact_refs
    ▼
ConstraintHarness.run(entity, refs)
    ├─ 3. SpanManager.createSpan('constraint.evaluate')
    ├─ 4. ConstraintEvaluator.evaluate(input)  ← 30s timeout
    ├─ 5. span.setAttributes(result)
    ├─ 6. EventBus.publish('constraint.evaluated', result)
    └─ 7. return ConstraintHarnessResult
              ▼
         IPC → CLI → stdout JSON
```

## CLI 命令

```bash
tw constraint evaluate <entity_id> --json   # 评估约束
tw constraint history <entity_id> --json    # 查询历史（复用 EventLog）
tw constraint show <eval_id> --json         # 评估详情（关联 span）
```

### CLI 输出格式

```json
{
  "entity_id": "task-001",
  "result": "fail",
  "checked_at": "2026-03-30T14:30:00Z",
  "duration_ms": 4200,
  "span_id": "abc123",
  "refs_checked": [
    {
      "ref": "docs/harness/daemon/constraints.md",
      "result": "pass",
      "note": "All function size constraints satisfied"
    },
    {
      "ref": "docs/harness/daemon/patterns.md",
      "result": "fail",
      "note": "EventBus subscriber missing error handling"
    }
  ],
  "error": null
}
```

## 类型定义

### ConstraintHarnessResult（tw-types 新增）

```typescript
interface ConstraintHarnessResult {
  entity_id: string;
  result: 'pass' | 'fail' | 'skipped';
  checked_at: string;
  duration_ms: number;
  span_id?: string;
  refs_checked: Array<{ ref: string; result: string; note?: string }>;
  error?: string;
}
```

### ConstraintHarness 接口

```typescript
interface ConstraintHarnessOptions {
  evaluator: ConstraintEvaluator;
  spanManager: SpanManager;
  eventBus: EventBus;
  timeoutMs?: number;  // 默认 30000
}

class ConstraintHarness {
  constructor(opts: ConstraintHarnessOptions);
  run(entity: Entity): Promise<ConstraintHarnessResult>;
}
```

### ConstraintEvaluator 接口（重构）

```typescript
interface ConstraintEvaluatorOptions {
  enabled: boolean;
  projectRoot?: string;
  llmFn?: (prompt: string) => Promise<string>;
  model?: string;  // 默认 'claude-opus-4-6'
}

class ConstraintEvaluator {
  constructor(opts: ConstraintEvaluatorOptions);
  evaluate(input: EvaluateInput): Promise<ConstraintValidationResult>;
}
```

与现有实现的区别：
- 去掉 `apiKey` 字段
- `callLlm` 默认实现改为 `claude --print` 子进程
- `model` 默认值改为 `claude-opus-4-6`
- 其余逻辑保留（checkRef, 聚合结果）

### EventBus 事件

```typescript
{
  type: 'constraint.evaluated',
  entity_id: 'task-001',
  payload: {
    result: 'fail',
    span_id: 'abc123',
    refs_checked: [...],
    duration_ms: 4200
  }
}
```

## 文件结构

```
packages/tw-daemon/src/constraint/
├── harness.ts        ← 新增：ConstraintHarness
└── evaluator.ts      ← 重建：基于 dist 重构

packages/tw-cli/src/commands/
└── constraint.ts     ← 新增：evaluate/history/show

packages/tw-types/src/
└── index.ts          ← 扩展：ConstraintHarnessResult
```

### CommandHandler 集成

```typescript
case 'constraint.evaluate':
  return this.constraintHarness.run(
    this.registry.get(msg.entity_id)
  );

case 'constraint.history':
  return this.eventLog.query({
    event_type: 'constraint.evaluated',
    entity_id: msg.entity_id
  });
```

历史查询复用现有 EventLog，不需要额外存储。

## 保留的现有逻辑

从 `dist/constraint/evaluator.js` 保留：
- `checkRef()` — 约束文件读取 + prompt 构建 + 结果解析
- `callLlm()` — LLM 调用（改为 claude CLI 子进程）
- 聚合逻辑 — any fail → fail, all skipped → skipped, else pass
- `constraintContents` 注入 — 允许直接传入约束内容
- `llmFn` 注入 — 测试可控

去掉：
- `@anthropic-ai/sdk` 直接调用
- `apiKey` 配置项
