# CLAUDE.md 熵管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 TraceWeaver 所有 CLAUDE.md 与代码现实对齐，消除过时约束、补充缺失组件描述、修正错误数字。

**Architecture:** 逐文件扫描实际代码 → 对比文档声明 → 最小化编辑，保持原有文档结构和中文风格，不引入新约束，只同步已存在的事实。

**Tech Stack:** Markdown 文档编辑；验证命令 `npm test`、`npm run build`、`ls examples/src/`

---

## 文件影响矩阵

| 文件 | 操作 | 变更量 |
|------|------|--------|
| `CLAUDE.md`（根） | 更新核心循环图；补充缺失组件；更新 scope 列表 | 中 |
| `packages/tw-daemon/CLAUDE.md` | 修正测试数量；重写 artifact_refs 规则；补子模块表；加初始化顺序约束 | 大 |
| `packages/tw-types/CLAUDE.md` | 关键类型清单加 constraint_refs | 小 |
| `packages/tw-cli/CLAUDE.md` | noun 列表加 taskmaster；IPC 清单加 remove | 小 |
| `examples/CLAUDE.md` | 示例清单补 12/13；更新验收标准 | 小 |
| `docs/CLAUDE.md` | 不变（无过时内容） | - |

---

## Task 1：根 CLAUDE.md — 核心循环图 + 缺失组件

**Files:**
- Modify: `CLAUDE.md`

**问题：**
- 核心循环图只有 FsWatcher → ImpactResolver → TriggerExecutor → ConstraintEvaluator → EventLog，缺少 RemediationEngine、FeedbackLog、SpanManager/OtlpGrpcExporter
- 提交规范 scope 缺少 `trigger`、`remediation`

- [ ] **Step 1: 更新核心循环图**

将现有循环：
```
FsWatcher（config.watch.dirs）
    ↓ file.changed
ImpactResolver（file → entity 反向索引）
    ↓ artifact.modified（per entity）
TriggerExecutor（harness trigger_on 匹配）
    ↓ ConstraintEvaluator（LLM）
    ↓ auto-reject / inbox
EventLog（NDJSON，可查询）
```
替换为：
```
FsWatcher（config.watch.dirs）
    ↓ file.changed
ImpactResolver（file → entity 反向索引）
    ↓ artifact.modified（per entity）
TriggerExecutor（harness trigger_on 匹配 + constraint_refs 过滤）
    ↓ ConstraintEvaluator（LLM）
    ↓ auto-reject → RemediationEngine（修复队列）
    ↓ FeedbackLog（harness 评估历史）
    ↓ NotifyEngine → InboxAdapter
EventLog（NDJSON，可查询）
SpanManager → OtlpGrpcExporter → Jaeger（OTLP/gRPC）
```

- [ ] **Step 2: 更新提交规范 scope 列表**

在 `scope:` 行加入 `trigger | remediation`：
```
scope:  daemon | cli | types | watcher | config | harness | trigger | remediation | examples | docs
```

- [ ] **Step 3: 验证文件语法正确（Markdown 可渲染）**

```bash
# 目测检查：无破损的代码块、表格对齐
cat CLAUDE.md
```
预期：文件结构完整，无截断代码块

---

## Task 2：tw-daemon CLAUDE.md — 测试数量 + artifact_refs 规则重写

**Files:**
- Modify: `packages/tw-daemon/CLAUDE.md`

**问题 A：测试数量**
文档写 `≥ 234 tests passing`，实际 `258 passed`。

- [ ] **Step 1: 修正测试数量**

```bash
npm test --workspace=packages/tw-daemon 2>&1 | grep "Tests "
# 预期输出：Tests  258 passed (258)
```

将 `≥ 234 tests passing` 改为 `≥ 258 tests passing`

**问题 B：artifact_refs 硬编码规则过时**

旧规则（一、系统性约束 → 实体层级规则）：
```
UseCase  → type=prd
Plan     → type=design
Task     → type=code + type=test
```
这是硬编码规则，但实际系统通过 `constraint_refs` 绑定 harness 文件来评估，harness 文件才定义具体约束。这段规则已被 harness 机制取代，且与实际代码行为不符。

- [ ] **Step 2: 重写"实体层级规则"小节**

删除旧的硬编码表格，改为描述 harness 机制和 constraint_refs：

```markdown
### 实体约束机制（Harness + constraint_refs）

实体进入 `review` 状态时，TriggerExecutor 自动触发约束评估：

1. **harness 匹配**：从 `.traceweaver/harness/*.md` 加载 `trigger_on: [review]` 的 harness
2. **constraint_refs 过滤**：若实体有 `constraint_refs`，只评估清单内的 harness（子集）；否则评估全部匹配 harness
3. **LLM 评估**：ConstraintEvaluator 将实体上下文 + harness 内容发给 LLM，判定 pass / fail
4. **auto-reject**：fail → `updateState(entity, rejected)`；同时写 FeedbackLog

注册实体时通过 `constraint_refs` 选择 harness 子集：
```typescript
handler.register({
  id: 'tm-1',
  entity_type: 'task',
  constraint_refs: ['task-needs-test'],  // 只运行此 harness
  artifact_refs: [...],
})
```
```

**问题 C：初始化顺序约束缺失**

- [ ] **Step 3: 在"二、可观测性与验证"小节后加"三、关键初始化顺序"**

```markdown
### 关键初始化顺序（违反导致 ImpactResolver 为空或 WAL 丢失）

```typescript
// 必须在 CommandHandler 之前 load
const eventLog = new EventLog(path)
eventLog.load()                    // ← 必须：否则 WAL append 失败

const feedbackLog = new FeedbackLog(path)
feedbackLog.load()                 // ← 必须：否则 FeedbackLog.getAllSummaries() 返回空

const handler = new CommandHandler({ storeDir, eventBus, spanManager, eventLog })
await handler.init()               // ← 必须：WAL replay + ImpactResolver 反向索引构建

// 关闭顺序（确保 Span 全部 flush 到 Jaeger）
triggerExecutor.stop()
notifyEngine.stop()
eventBus.stop()
await exporterRegistry.shutdown()  // ← 最后：flush OtlpGrpcExporter → Jaeger
```
```

**问题 D：子模块职责边界表缺失新模块**

- [ ] **Step 4: 补全子模块职责边界表**

在现有 core/watcher/harness/trigger/log/config 的基础上，追加：

```markdown
| `otel/` | SpanManager + OtlpGrpcExporter | 不能 import trigger/harness |
| `feedback/` | FeedbackLog（harness 评估历史） | 只追加，不修改历史 |
| `remediation/` | RemediationEngine（修复队列） | 只通过 EventBus 订阅，不直接改实体 |
| `notify/` | NotifyEngine + InboxAdapter | 不能直接读磁盘实体 |
| `mcp/` | MCP Server（AI Agent 接口） | 只读 daemon 状态，不改实体 |
```

---

## Task 3：tw-types CLAUDE.md — constraint_refs 加入关键类型清单

**Files:**
- Modify: `packages/tw-types/CLAUDE.md`

- [ ] **Step 1: 验证 constraint_refs 在 tw-types 中存在**

```bash
grep "constraint_refs" packages/tw-types/src/index.ts
# 预期：有两处 constraint_refs?: string[]
```

- [ ] **Step 2: 在关键类型清单中补充 constraint_refs**

（验证：`tw-types/src/index.ts` 第 33 行 `Entity` 和第 70 行 `RegisterParams` 均有此字段。）

在 `Entity` 行和 `TwRequest / TwResponse` 行分别加：

```markdown
| `Entity.constraint_refs` | `string[]`（可选）— 绑定的 harness id 子集；空时评估全部匹配 harness |
| `RegisterParams.constraint_refs` | `string[]`（可选）— 注册时声明，设置实体的 harness 子集 |
```

---

## Task 4：tw-cli CLAUDE.md — noun 列表 + IPC 清单补漏

**Files:**
- Modify: `packages/tw-cli/CLAUDE.md`

**问题 A：命令 noun 缺 taskmaster / diagnose / sync**

（验证：`src/index.ts` 中 `program.addCommand(taskmasterCommand())` / `program.addCommand(diagnoseCommand())` / `syncCommand(program)` 均已注册，`cascade` 是 IPC 方法名而非 CLI noun，不加入此列表。）

- [ ] **Step 1: 更新命令结构规范的 noun 列表**

现有：
```
noun:       daemon | status | register | update | events | dag
            impact | log | metrics | harness | watch | inbox
```
改为：
```
noun:       daemon | status | register | update | events | dag
            impact | log | metrics | harness | watch | inbox
            taskmaster | diagnose | sync
```

**问题 B：IPC 方法清单缺 remove**

- [ ] **Step 2: 在 IPC 方法清单中补充 remove**

在 `register` 和 `update_state` 之间加：

```markdown
| `remove` | `{id}` | 删除实体（慎用） |
```

---

## Task 5：examples CLAUDE.md — 示例清单 + 验收标准更新

**Files:**
- Modify: `examples/CLAUDE.md`

- [ ] **Step 1: 验证实际示例文件**

```bash
ls examples/src/ | grep -v test | sort
# 预期：01 到 13，共 13 个文件
```

- [ ] **Step 2: 在示例清单中补充 12 和 13**

在 `11 | full-chain-autonomous-loop` 后追加：

```markdown
| 12 | jaeger-full-trace | Jaeger OTLP/gRPC 全链路 Trace 导出验证 |
| 13 | taskmaster-lifecycle-bridge | TaskMaster × TraceWeaver 全链路闭环（含 hook 联动） |
```

- [ ] **Step 3: 更新验收标准描述**

现有仅提 Example 11，改为明确 11/12/13 各自的验收范围：

```markdown
### 示例验收标准

| 示例 | 验收范围 |
|------|---------|
| 11 | 全链路闭环：所有功能模块 + 边界条件（核心验收） |
| 12 | OTLP/gRPC 导出：OtlpGrpcExporter flush → Jaeger |
| 13 | TaskMaster 联动：hook 钩子 + constraint_refs + cascadeUpdate |
```

- [ ] **Step 4: 更新基础验证命令**

现有只有 `run:11`，补充：
```bash
npm run run:12 --workspace=examples    # Jaeger 导出验证
npm run run:13 --workspace=examples    # TaskMaster 联动验证
```

- [ ] **Step 5: 更新 examples/package.json 的 run:all 脚本**

（验证：`run:all` 目前只包含 01–11，12 和 13 已有独立脚本但未加入 all。）

将 `examples/package.json` 中 `run:all` 末尾追加 example 12 和 13：

```json
"run:all": "tsx src/01-... && tsx src/11-full-chain-autonomous-loop.ts && tsx src/12-jaeger-full-trace.ts && tsx src/13-taskmaster-lifecycle-bridge.ts"
```

注意：run:12 会尝试连接 Jaeger，若无 telepresence/port-forward 会报 ECONNREFUSED。
`run:all` 中可保留 12 和 13 但建议在 CI 中单独控制；至少文档应说明此依赖。

---

## Task 6：整体验证

- [ ] **Step 1: 运行 daemon 测试确认数量正确**

```bash
npm test --workspace=packages/tw-daemon 2>&1 | grep "Tests "
# 预期：Tests  258 passed (258)
```

- [ ] **Step 2: 运行 cli 测试**

```bash
npm test --workspace=packages/tw-cli 2>&1 | grep "Tests "
# 预期：Tests  8 passed (8)
```

- [ ] **Step 3: 检查所有 CLAUDE.md 无遗留过时数字**

```bash
grep -r "234\|design.*artifact\|type=prd\|type=design" \
  CLAUDE.md packages/*/CLAUDE.md examples/CLAUDE.md docs/CLAUDE.md
# 预期：零匹配（全部已清理）
```

- [ ] **Step 4: 确认示例清单与文件系统一致**

```bash
ls examples/src/ | grep "\.ts$" | grep -v test | wc -l
# 预期：13
grep "^| [0-9]" examples/CLAUDE.md | wc -l
# 预期：13
```

---

## 熵管理原则（本次执行）

1. **只删除、替换确实过时的内容**，不新增不存在于代码的约束
2. **保持原有文档结构和中文风格**
3. **每个 Task 是独立可验证的单元**
4. **不重构文档层级**，只做最小化更新

---

*计划版本：2026-03-25 | 验证基准：258 tests / 13 examples / ipc-server.ts dispatch*
