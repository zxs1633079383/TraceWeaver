# tw-daemon CLAUDE.md

> 上级索引：[← 根 CLAUDE.md](../../CLAUDE.md)

## 职责

Daemon 是 TraceWeaver 的核心进程。通过 Unix Socket 提供 IPC 服务，
管理实体生命周期、文件监听、约束评估、事件持久化和指标采集。

---

## 一、系统性约束（Constraint as Code）

### 实体层级规则（UseCase → Plan → Task）

每个实体进入 `review` 状态前，`artifact_refs` 必须满足：

```
UseCase  → type=prd    （产品需求文档）
Plan     → type=design  （设计文档）
Task     → type=code    （实现代码）
           type=test    （测试文件）
```

违反规则时，TriggerExecutor 到达 `review` 时自动拒绝（auto-reject）。

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
TriggerExecutor（匹配 harness trigger_on）
    ↓ ConstraintEvaluator
    ↓ auto-reject + inbox
EventLog（NDJSON append）
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
npm test --workspace=packages/tw-daemon        # 目标：≥ 234 tests passing
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

### 子模块职责边界

| 子模块 | 职责 | 禁止 |
|--------|------|------|
| `core/` | 状态机、WAL、Registry、EventBus | 不能 import watcher/harness/trigger |
| `watcher/` | FsWatcher，仅发 file.changed | 不能直接修改实体 |
| `harness/` | HarnessLoader，只读 .md 文件 | 不能直接评估或拒绝实体 |
| `trigger/` | TriggerExecutor，协调评估与拒绝 | 不能直接读磁盘 |
| `log/` | EventLog NDJSON | 只追加，不修改历史 |
| `config/` | 读 config.yaml | 不能写配置 |
