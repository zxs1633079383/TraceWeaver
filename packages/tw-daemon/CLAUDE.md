# tw-daemon CLAUDE.md

> 上级索引：[← 根 CLAUDE.md](../../CLAUDE.md)

## 职责

Daemon 是 TraceWeaver 的核心进程。通过 Unix Socket 提供 IPC 服务，
管理实体生命周期、文件监听、约束评估、事件持久化和指标采集。

---

## 一、系统性约束（Constraint as Code）

### 实体约束机制（Harness + constraint_refs）

实体进入 `review` 状态时，TriggerExecutor 自动触发约束评估：

1. **harness 匹配**：从 `.traceweaver/harness/*.md` 加载 `trigger_on: [review]` 的 harness
2. **constraint_refs 过滤**：若实体有 `constraint_refs`，只评估清单内的 harness（子集）；否则评估全部匹配 harness
3. **LLM 评估**：ConstraintEvaluator 将实体上下文 + harness 内容发给 LLM，判定 pass / fail
4. **auto-reject**：fail → `updateState(entity, rejected)`；结果写入 FeedbackLog

注册实体时通过 `constraint_refs` 选择 harness 子集：

```typescript
handler.register({
  id: 'tm-1',
  entity_type: 'task',
  constraint_refs: ['task-needs-test'],  // 只运行此 harness
  artifact_refs: [...],
})
```

### Harness 文件规范

约束文件位于 `.traceweaver/harness/*.md`：

```markdown
---
id: <kebab-case>
applies_to: [task | plan | usecase]
trigger_on: [review | completed]
---
# 约束标题

约束内容（LLM 评估器读取）。

RESULT: pass/fail 条件。
```

新增 Harness 文件必须有对应的 `loader.test.ts` 覆盖。

### 标准事件管道

```
FsWatcher（config.watch.dirs）
    ↓ file.changed
ImpactResolver.resolve(filePath)
    ↓ artifact.modified（per entity，direct / transitive）
TriggerExecutor（匹配 harness trigger_on + constraint_refs 过滤）
    ↓ ConstraintEvaluator（LLM）
    ↓ auto-reject → RemediationEngine（修复队列，queueDir/pending/）
    ↓ FeedbackLog（评估历史，NDJSON append）
    ↓ NotifyEngine → InboxAdapter（通知收件箱）
EventLog（NDJSON append）
SpanManager → OtlpGrpcExporter → Jaeger（OTLP/gRPC，exporterRegistry.shutdown() flush）
```

不允许绕过此管道直接修改实体状态（除测试代码外）。

---

## 二、可观测性与验证

### 构建验证

```bash
npm run build --workspace=packages/tw-daemon   # 目标：零 TypeScript 错误
```

### 测试验证

```bash
npm test --workspace=packages/tw-daemon        # 目标：≥ 258 tests passing
```

TDD 规则：**先写失败测试，再写实现**。不允许先写实现后补测试。

测试失败处理：
- 构建错误 → 立即修复，禁止 `// @ts-ignore`
- 测试失败 → 写复现用例，再修实现
- 集成测试失败 → 定位最小复现，隔离到单元测试

### 运行时验证（新功能开发后必跑）

```bash
tw daemon start
tw status --json          # IPC 正常
tw log query --since 1h   # EventLog 可查
tw metrics                # SpanMetrics 正常
tw harness list           # HarnessLoader 正常
tw trace spans --entity-id=<id>  # TraceQueryEngine live 模式
tw trace info  --trace-id=<id> --json  # _ai_context 字段存在
tw report daily --all     # ReportGenerator 生成日报
tw daemon stop
```

### 影响分析验证

```bash
tw impact <变更的文件路径>
# 确认 directly_affected + transitively_affected 在预期范围内
```

---

## 三、持续熵管理

### 复杂度预算

| 指标 | 上限 |
|------|------|
| 单文件行数 | 500 行 |
| 单函数行数 | 50 行 |
| 嵌套深度 | 4 层 |
| Runtime 依赖 | 仅限清单内 + 经审批 |

### Runtime 依赖清单（不经审批禁止新增）

| 依赖 | 用途 |
|------|------|
| `@anthropic-ai/sdk` | LLM 约束评估 |
| `@grpc/grpc-js`    | gRPC client for OTLP/gRPC export |
| `@grpc/proto-loader` | Proto file loader for gRPC       |
| `@modelcontextprotocol/sdk` | MCP Server |
| `chokidar` | 跨平台文件监听 |
| `fastify` | HTTP API |
| `js-yaml` | config.yaml 解析 |
| `uuid` | UUID 生成 |

新增依赖前必须回答：
1. Node.js 内置模块（fs/net/crypto）能否解决？
2. 包大小 < 100 KB？
3. 近 6 个月有活跃维护？

### 熵检查（每个 milestone 后执行）

```bash
# 超过 400 行的源文件
find src -name "*.ts" ! -name "*.test.ts" | xargs wc -l | sort -rn | head -10

# 无对应测试的源文件
for f in src/**/*.ts; do
  [[ $f == *.test.ts ]] && continue
  [ ! -f "${f%.ts}.test.ts" ] && echo "无测试: $f"
done

# dist/ 不应被 git 追踪
git ls-files dist/
```

### 关键初始化顺序（违反导致 ImpactResolver 为空或 WAL 丢失）

```typescript
// 1. Log 组件必须先 load（在 CommandHandler 之前）
const eventLog = new EventLog(path)
eventLog.load()                      // ← 必须：否则 WAL append 失败

const feedbackLog = new FeedbackLog(path)
feedbackLog.load()                   // ← 必须：否则 getAllSummaries() 返回空

// 2. CommandHandler 必须 init（WAL replay + ImpactResolver 索引构建）
const handler = new CommandHandler({ storeDir, eventBus, spanManager, eventLog })
await handler.init()                 // ← 必须：跳过则 cascadeUpdate 找不到下游实体

// 3. 关闭顺序（确保所有 Span flush 到 Jaeger）
triggerExecutor.stop()
notifyEngine.stop()
eventBus.stop()
await exporterRegistry.shutdown()    // ← 最后：flush OtlpGrpcExporter → Jaeger
```

### 子模块职责边界

| 子模块 | 职责 | 禁止 |
|--------|------|------|
| `core/` | 状态机、WAL、Registry、EventBus | 不能 import watcher/harness/trigger |
| `watcher/` | FsWatcher，仅发 file.changed | 不能直接修改实体 |
| `harness/` | HarnessLoader，只读 .md 文件 | 不能直接评估或拒绝实体 |
| `trigger/` | TriggerExecutor，协调评估与拒绝 | 不能直接读磁盘 |
| `log/` | EventLog NDJSON | 只追加，不修改历史 |
| `config/` | 读 config.yaml | 不能写配置 |
| `otel/` | SpanManager + OtlpGrpcExporter + TraceQueryEngine（双来源查询层） | 不能 import trigger/harness |
| `feedback/` | FeedbackLog（harness 评估历史） | 只追加，不修改历史 |
| `remediation/` | RemediationEngine（修复队列） | 只通过 EventBus 订阅，不直接改实体 |
| `notify/` | NotifyEngine + InboxAdapter | 不能直接读磁盘实体 |
| `mcp/` | MCP Server（AI Agent 接口） | 只读 daemon 状态，不改实体 |
| `report/` | ReportGenerator（日报生成）+ ReportScheduler（cron）| 不能 import trigger/ 或 harness/ |
| `subscribers/` | ErrorBubbler / ProgressTracker / UsecaseMutationHandler | 不直接改磁盘实体，只通过 CommandHandler |

## 沉淀规则

- [决策规则](../../docs/harness/daemon/decisions.md) — 为什么这样做
- [约束规则](../../docs/harness/daemon/constraints.md) — 不能这样做
- [模式规则](../../docs/harness/daemon/patterns.md) — 遇到 X 用 Y
