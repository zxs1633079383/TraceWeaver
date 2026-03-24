# CLAUDE.md — TraceWeaver 开发约束

> 本文件本身就是一个 Harness：它定义了"完成"的标准、可观测的验证步骤，
> 以及持续对抗熵增的规则。每次向这个仓库贡献代码，都必须满足此处的约束。

---

## 一、项目概述

TraceWeaver 是一个 AI 原生研发流程可观测引擎。它追踪 UseCase → Plan → Task
的完整生命周期，给 AI Agent 和工程师提供实时可查询的研发过程视图。

**核心循环：observe → detect → diagnose → validate → fix**

```
FsWatcher（监听 config.watch.dirs）
    ↓ file.changed
ImpactResolver（file → entity 反向索引）
    ↓ artifact.modified（per entity）
TriggerExecutor（匹配 harness trigger_on 状态）
    ↓ ConstraintEvaluator（LLM 评估）
    ↓ auto-reject / inbox 通知
EventLog（NDJSON 持久化，可查询）
```

---

## 二、系统性约束文件（Constraint as Code）

### 2.1 每类工作的"完成"定义

| 工作类型 | 必须满足 |
|----------|---------|
| 新功能 | 单元测试覆盖核心路径；集成测试验证端到端；README/QUICKSTART 更新 |
| Bug 修复 | 复现测试（先写失败用例，再修复）；回归测试不退化 |
| 重构 | 测试数量不减少；`npm run build` 零错误；接口契约不变 |
| 文档 | 代码示例可运行；命令与实际 CLI 输出一致 |
| Harness 变更 | 新约束文件有对应测试；`tw harness list` 可见 |

### 2.2 实体层级约束（UseCase → Plan → Task）

每个实体进入 `review` 状态前，对应的 artifact_refs 必须存在且可访问：

```
UseCase  → artifact_refs 含 type=prd    （产品需求文档）
Plan     → artifact_refs 含 type=design  （设计文档或接口规范）
Task     → artifact_refs 含 type=code    （实现代码）
           artifact_refs 含 type=test    （测试文件）
```

违反以上规则的实体，TriggerExecutor 会在到达 `review` 时自动拒绝。

### 2.3 Harness 文件规范

所有约束文件存放在 `.traceweaver/harness/*.md`，格式：

```markdown
---
id: <唯一 ID，kebab-case>
applies_to:
  - task | plan | usecase
trigger_on:
  - review | completed
---
# 约束标题

约束描述（给 LLM 评估器看的自然语言规则）。

RESULT: pass / fail 条件说明。
```

---

## 三、可观测性与验证

### 3.1 构建验证（每次提交前必跑）

```bash
npm run build          # 零 TypeScript 错误
```

### 3.2 测试验证

```bash
npm test --workspace=packages/tw-daemon   # 目标：≥ 187 tests passing
npm test --workspace=packages/tw-cli      # 目标：≥ 8 tests passing
npm run run:11 --workspace=examples       # 全链路闭环 Demo 必须通过
```

失败时处理规则：
- 构建错误 → 立即修复，不允许 `// @ts-ignore` 绕过
- 测试失败 → 先写复现用例，再修实现（TDD）
- Example 11 失败 → 定位是哪个 Phase 失败，分离最小复现

### 3.3 运行时验证（功能开发后）

```bash
tw daemon start
tw status --json        # 验证 IPC 正常
tw log query --since 1h # 验证 EventLog
tw metrics              # 验证 SpanMetrics
tw daemon stop
```

### 3.4 影响分析（变更文件后）

```bash
tw impact <变更的文件路径>
# 输出 directly_affected + transitively_affected
# 确认影响范围在预期之内
```

---

## 四、持续熵管理

### 4.1 复杂度预算

| 指标 | 上限 | 工具 |
|------|------|------|
| 单个文件行数 | 500 行 | 人工检查 |
| 单个函数行数 | 50 行 | 人工检查 |
| 嵌套深度 | 4 层 | 人工检查 |
| 包依赖（runtime） | 现有 + 经审批 | `npm ls --depth=0` |

### 4.2 禁止事项

```
✗ 不允许在 packages/*/src/ 下提交 .js / .d.ts 编译产物
✗ 不允许 tsc 产物混入 git（已在 .gitignore 强制排除）
✗ 不允许硬编码路径或密钥（用环境变量或 config.yaml）
✗ 不允许静默吞掉错误（catch {} 必须有明确理由的注释）
✗ 不允许 as any 绕过类型系统（用 as unknown as T 或修正类型）
```

### 4.3 依赖引入原则

新增 runtime 依赖前必须回答：
1. 这个依赖解决的问题，能否用 Node.js 内置模块（fs/net/crypto）实现？
2. 包大小是否合理（< 100KB 优先）？
3. 是否有活跃维护（近 6 个月有提交）？

当前 runtime 依赖清单（daemon）：
- `@anthropic-ai/sdk` — LLM 约束评估
- `@modelcontextprotocol/sdk` — MCP Server
- `chokidar` — 跨平台文件监听
- `fastify` — HTTP API
- `js-yaml` — config.yaml 解析
- `uuid` — UUID 生成

### 4.4 熵检查清单（每月或每个 milestone 后）

```bash
# 找出超过 400 行的源文件
find packages/*/src -name "*.ts" ! -name "*.test.ts" | xargs wc -l | sort -rn | head -10

# 找出没有对应测试的源文件
for f in packages/tw-daemon/src/**/*.ts; do
  base="${f%.ts}"
  [ ! -f "${base}.test.ts" ] && echo "无测试: $f"
done

# 检查 dist/ 是否在 git 追踪中（应为空）
git ls-files packages/*/dist/

# 检查 src/ 下是否混入编译产物（应为空）
git ls-files packages/*/src/*.js
```

---

## 五、分支与提交规范

### 5.1 提交格式

```
<type>(<scope>): <subject>

type:   feat | fix | refactor | docs | test | chore | perf
scope:  daemon | cli | types | watcher | config | harness | examples
```

### 5.2 模块化提交原则

每个提交只做一件事。禁止"大杂烩"提交（同时改多个模块）。
按以下顺序提交：
1. `feat(types)` — 类型变更
2. `feat(daemon)` — 核心逻辑
3. `feat(cli)` — CLI 命令
4. `test` — 测试
5. `docs` — 文档

### 5.3 提交前 checklist

- [ ] `npm run build` 通过（零错误）
- [ ] `npm test --workspace=packages/tw-daemon` 通过
- [ ] `npm test --workspace=packages/tw-cli` 通过
- [ ] 新功能有对应测试
- [ ] 没有提交 dist/ 或 src/*.js 编译产物
- [ ] QUICKSTART / CLI-COMMANDS.md 如需更新已更新

---

## 六、架构边界（不可越界）

```
tw-types     ←  被所有包引用，不能反向依赖
tw-daemon    ←  不能 import tw-cli
tw-cli       ←  只能通过 IPC 与 daemon 通信，不能直接 import daemon 源码
examples     ←  可以 import daemon 源码用于演示（不走 IPC）
```

测试文件可跨包 import（通过 tsx 直接运行），但 `tsc` 构建不包含测试文件（tsconfig.json `exclude`）。

---

## 七、config.yaml 与 Harness 协作示例

典型项目配置（`.traceweaver/config.yaml`）：

```yaml
watch:
  dirs:
    - src/         # 监听源代码变更
    - docs/        # 监听文档变更（PRD、设计文档）
  ignored:
    - "**/*.log"
    - "**/__pycache__/**"

notify:
  rules:
    - event: entity.state_changed
      state: rejected
    - event: entity.state_changed
      state: completed
    - event: artifact.modified     # 文件变更影响到实体时也通知
```

典型 Harness 文件（`.traceweaver/harness/task-must-have-tests.md`）：

```markdown
---
id: task-must-have-tests
applies_to:
  - task
trigger_on:
  - review
---
# Task 测试覆盖约束

所有进入 review 状态的 Task，artifact_refs 中必须至少包含一个 type=test 的条目。

请检查实体的 artifact_refs 字段，确认存在 {"type": "test", "path": "...test.ts"} 形式的条目。

RESULT: 存在 type=test 则 pass，否则 fail。
```

---

*本文件遵循 Harness 哲学：约束即代码，可观测，可验证，持续演进。*
*修改此文件需要同时更新对应的验证步骤，确保约束始终可执行。*
