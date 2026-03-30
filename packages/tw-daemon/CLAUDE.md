# tw-daemon CLAUDE.md

> 上级索引：[← 根 CLAUDE.md](../../CLAUDE.md)

## 职责

Daemon 是 TraceWeaver 的核心进程。通过 Unix Socket 提供 IPC 服务，
管理实体生命周期、文件监听、约束评估、事件持久化和指标采集。

---

## 一、系统性约束（Constraint as Code）

### 标准事件管道

```
FsWatcher（config.watch.dirs）
    ↓ file.changed
ImpactResolver.resolve(filePath)
    ↓ artifact.modified（per entity，direct / transitive）
EventBus → Subscribers（ErrorBubbler / ProgressTracker / UsecaseMutationHandler）
    ↓ NotifyEngine → InboxAdapter（通知收件箱）
EventLog（NDJSON append）
SpanManager → OtlpGrpcExporter → Jaeger（OTLP/gRPC，exporterRegistry.shutdown() flush）
```

不允许绕过此管道直接修改实体状态（除测试代码外）。

### Real Project Integration（CC Hook 采集）

外部项目通过 CC Hook 接入，事件自动采集到 span：
- `SessionStart` → `tw hook session-start`（匿名会话实体）
- `PostToolUse` → `tw hook post-tool`（error.captured / tool.completed）
- `Stop` → `tw hook stop`（session.ended）
- `tw emit-event` → 自定义 span event（harness.evolution / harness.signal）

详见 `docs/superpowers/specs/2026-03-30-real-project-integration-design.md`

---

## 二、可观测性与验证

### 构建验证

```bash
npm run build --workspace=packages/tw-daemon   # 目标：零 TypeScript 错误
```

### 测试验证

```bash
npm test --workspace=packages/tw-daemon        # 目标：≥ 275 tests passing
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
tw emit-event --entity-id=<id> --event=test --json  # emit-event 正常
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
// 1. EventBus + EventLog 必须先启动
const eventBus = new EventBus()
eventBus.start()
const eventLog = new EventLog(path)
eventLog.load()                      // ← 必须：否则 WAL append 失败

// 2. CommandHandler 必须 init（WAL replay + ImpactResolver 索引构建）
const handler = new CommandHandler({ storeDir, eventBus, spanManager, eventLog })
await handler.init()                 // ← 必须：跳过则 cascadeUpdate 找不到下游实体

// 3. Subscribers 挂载到 EventBus
eventBus.subscribe(event => errorBubbler.handle(event))
eventBus.subscribe(event => progressTracker.handle(event))
eventBus.subscribe(event => usecaseMutationHandler.handle(event))

// 4. 关闭顺序（确保所有 Span flush 到 Jaeger）
reportScheduler?.stop()
notifyEngine.stop()
await fsWatcher.stop()
eventBus.stop()
await ipcServer.stop()
await exporterRegistry.shutdown()    // ← 最后：flush OtlpGrpcExporter → Jaeger
```

### 子模块职责边界

| 子模块 | 职责 | 禁止 |
|--------|------|------|
| `core/` | 状态机、WAL、Registry、EventBus、CommandHandler、Propagator | 不能 import watcher/notify |
| `watcher/` | FsWatcher，仅发 file.changed | 不能直接修改实体 |
| `log/` | EventLog NDJSON | 只追加，不修改历史 |
| `config/` | 读 config.yaml | 不能写配置 |
| `otel/` | SpanManager + Exporters + TraceQueryEngine（双来源查询层） | 不能 import notify |
| `notify/` | NotifyEngine + InboxAdapter + WebhookAdapter | 不能直接读磁盘实体 |
| `mcp/` | MCP Server（AI Agent 接口） | 只读 daemon 状态，不改实体 |
| `http/` | Fastify HTTP API（webhook inbound） | 只通过 CommandHandler 操作 |
| `report/` | ReportGenerator（日报生成）+ ReportScheduler（cron）| 不能 import notify |
| `subscribers/` | ErrorBubbler / ProgressTracker / UsecaseMutationHandler | 不直接改磁盘实体，只通过 CommandHandler |
| `impact/` | ImpactResolver（文件→实体反向索引） | 不能直接修改实体 |
| `metrics/` | SpanMetrics（失败率、吞吐量、周期） | 只读 SpanManager |
| `workers/` | WorkerPool（并行任务执行） | 通过回调返回结果 |

## 沉淀规则

- [决策规则](../../docs/harness/daemon/decisions.md) — 为什么这样做
- [约束规则](../../docs/harness/daemon/constraints.md) — 不能这样做
- [模式规则](../../docs/harness/daemon/patterns.md) — 遇到 X 用 Y
