# Real Project Integration Design

> UseCase → Plan → Task 生命周期接入、反向回溯、错误采集、UseCase 变更处理、旧链路中断

Date: 2026-03-30

---

## 1. 需求总结

| 维度 | 决策 |
|------|------|
| 接入方式 | CC Hook 驱动（PreToolUse / PostToolUse / Stop） |
| UseCase 变更 | 混合型：insert → 自动生成下游；update → drain 旧链路 + 通知调用方 |
| 中断语义 | 优雅降级（drain + replace），评估必须基于新 UseCase 上下文 |
| 错误采集 | 全来源（构建/测试/运行时/Agent 自身），统一打 span event |
| 决策权 | TraceWeaver 纯可观测层，不做修复决策，通知调用方自行处理 |
| 状态回溯 | 进度 + 错误双冒泡到上层 span |
| 实体创建 | 显式声明（调用方 `tw register`），Hook 只采集事件 |

---

## 2. 状态机扩展

### 新增状态

```
paused      — 旧链路 drain 时，in_progress/review 的实体暂停等待
superseded  — 旧链路被新链路替代，终态，span 结束
```

### 新增转换规则

```
in_progress → paused       # drain：上游 UseCase 变更时暂停
paused      → in_progress  # resume：调用方决定恢复
paused      → superseded   # replace：新链路接管
paused      → rejected     # 调用方评估后拒绝
review      → paused       # drain：正在评估的也要暂停
pending     → superseded   # 调用方决定未开始的实体不再需要
```

### 终态集合

`completed | rejected | superseded`

### SpanManager 映射

| EntityState | Span Status |
|-------------|-------------|
| completed | OK |
| rejected | ERROR |
| superseded | UNSET |

---

## 3. CC Hook 采集层

### Hook 配置

`.claude/settings.json`:

```jsonc
{
  "hooks": {
    "SessionStart": [{
      "command": "tw hook session-start"
    }],
    "PreToolUse": [{
      "matcher": "*",
      "command": "tw hook pre-tool --tool=$TOOL_NAME"
    }],
    "PostToolUse": [{
      "matcher": "*",
      "command": "tw hook post-tool --tool=$TOOL_NAME --exit-code=$EXIT_CODE"
    }],
    "Stop": [{
      "matcher": "",
      "command": "tw hook stop"
    }]
  }
}
```

### 实体注册：混合模式（人类零操作）

**两层机制：SessionStart hook 兜底 + Agent 主动注册补全。**

#### 层 1：SessionStart Hook — 匿名会话实体

会话启动时 `tw hook session-start` 自动执行：

1. 生成匿名实体 `session-<uuid>`，类型 `task`，无 parent
2. 将 entity_id 写入 `.traceweaver/.tw-session`（临时文件）
3. 后续 PreToolUse/PostToolUse/Stop hook 从 `.tw-session` 读取 entity_id
4. 所有工具调用事件立即开始采集到这个匿名实体上

```bash
# tw hook session-start 内部逻辑（伪代码）
SESSION_ID="session-$(uuidgen | tr '[:upper:]' '[:lower:]')"
tw register --id=$SESSION_ID --type=task
echo $SESSION_ID > .traceweaver/.tw-session
```

#### 层 2：Agent 主动注册 — 补全或替换

Agent（Claude Code）在 CLAUDE.md 约束下，明确任务后主动补全：

```markdown
# CLAUDE.md 约束
收到任务后，判断当前任务属于哪个 UseCase/Plan，执行：
1. tw register --id=<task-id> --type=task --parent-id=<plan-id>
2. tw hook rebind --entity-id=<task-id>
   → 将 .tw-session 更新为正式实体 id
   → 匿名实体上已采集的事件迁移到正式实体的 span 上
```

#### rebind 语义

`tw hook rebind --entity-id=<new-id>` 是关键操作：

1. 读取 `.tw-session` 中的旧 entity_id（匿名）
2. 将 SpanManager 中旧实体的所有 events 迁移到新实体的 span
3. 更新 `.tw-session` 为新 entity_id
4. 后续 hook 事件自动打到新实体上
5. 旧匿名实体标记为 `superseded`

**如果 Agent 始终没有 rebind**（比如简单问答会话），匿名实体在 Stop hook 时自动结束，不影响任何 Plan/UseCase。

#### entity_id 读取顺序

所有 hook 按以下优先级获取 entity_id：

```
1. 环境变量 TW_ENTITY_ID（调用方显式设定，最高优先）
2. .traceweaver/.tw-session 文件内容（SessionStart 或 rebind 写入）
3. 缺失 → hook 静默跳过，不阻塞 Claude Code
```

### Hook → Daemon 事件映射

| Hook 类型 | 采集内容 | Daemon 调用 |
|-----------|---------|-------------|
| PreToolUse | 工具名、参数摘要 | `emitEvent(entity_id, 'tool.invoked', { tool, params_summary })` |
| PostToolUse(成功) | 工具名、耗时 | `emitEvent(entity_id, 'tool.completed', { tool, duration_ms })` |
| PostToolUse(失败) | 工具名、exit_code、stderr | `emitEvent(entity_id, 'error.captured', { source, tool, exit_code, stderr })` |
| Stop | 会话结束 | `emitEvent(entity_id, 'session.ended', {})` |

### 错误来源分类

PostToolUse 中的 Bash 命令通过命令前缀自动分类 `source`：

| 命令模式 | source |
|---------|--------|
| `npm run build` / `tsc` | `build` |
| `npm test` / `vitest` | `test` |
| `node` / `ts-node` | `runtime` |
| 其他 Bash 失败 | `command` |
| Edit/Write 失败 | `tool` |

### CLI 子命令约束

`tw hook pre-tool` / `tw hook post-tool` / `tw hook stop`：

- 快速返回（< 100ms），不阻塞 Claude Code
- 失败静默（daemon 未启动时不报错，仅 stderr 提示）
- 幂等（同一 tool invocation 重复调用不产生重复事件）

---

## 4. ErrorBubbler（新 EventBus Subscriber）

### 职责

监听 `error.captured` 事件，沿 parent_id chain 冒泡到 Plan 和 UseCase 的 span。

### 行为

1. 收到 `error.captured` 事件
2. 沿 `parent_id` 链向上遍历
3. 对每一级父实体：
   - `spanManager.addEvent(parentId, 'child_error', { ... })`
   - 追加到父实体 `attributes.errors[]`
4. 发出 `entity.updated` 事件（NotifyEngine 可通知调用方）

### 冒泡 Attribute 内容

```typescript
{
  origin_entity_id: string
  origin_entity_type: EntityType
  source: 'build' | 'test' | 'runtime' | 'tool' | 'command'
  message: string             // stderr 摘要，截断到 500 字符
  ts: string
}
```

### 不做的事

- 不改变父实体 state
- 不做去重

---

## 5. ProgressTracker（新 EventBus Subscriber）

### 职责

监听状态变更事件，实时重算父级进度。

### 触发事件

- `entity.state_changed`
- `entity.registered`
- `entity.removed`

### 行为

1. 找到实体的 `parent_id`
2. 查询父实体的所有子实体状态
3. 更新父实体 attributes：

```typescript
{
  progress: {
    done: number       // completed 的子实体数
    total: number
    percent: number    // Math.round(done / total * 100)
    in_progress: number
    paused: number
    rejected: number
    blocked_by: string[]
  }
}
```

4. 递归向上：更新完 Plan 的 progress 后，继续更新 UseCase 的 progress
5. UseCase 级别的 `total` 是 Plan 数，不是展平后的 Task 数

---

## 6. UseCase 变更处理（UsecaseMutationHandler）

### 6.1 触发入口

```bash
# insert：批量注册新下游实体
tw usecase mutate --id=uc-1 --type=insert --entities='[{id,type,parent_id,...}]'

# update：UseCase 内容变了，drain 旧链路
tw usecase mutate --id=uc-1 --type=update --context='新的需求描述或PRD路径'
```

### 6.2 Insert 路径

```
CommandHandler.usecaseMutate(insert)
    ↓ 遍历 entities
    ├─ register(plan-new, parent_id=uc-1)
    ├─ register(task-new-1, parent_id=plan-new)
    └─ register(task-new-2, parent_id=plan-new)
    ↓
ProgressTracker: 更新 uc-1 的 progress.total
```

### 6.3 Update 路径（drain + replace）

**阶段 1：Drain（暂停旧链路）**

```
UsecaseMutationHandler 收到 usecase.mutated 事件
    ↓ 查询 uc-1 的所有下游实体
    ↓ 按状态分类处理：
    ├─ in_progress → updateState(paused)
    ├─ review      → updateState(paused)
    ├─ pending     → 保持 pending（未开始，由调用方在阶段 2 决定恢复或 supersede）
    └─ completed/rejected/superseded → 不动（已终结）
    ↓
更新 UseCase attributes:
  mutation_context: '新需求内容'
  mutation_ts: ISO8601
  mutation_type: 'update'
    ↓
NotifyEngine → 通知调用方
```

**阶段 2：等待调用方决策**

TraceWeaver 在 drain 后停住。调用方有三种选择：

```bash
# 恢复
tw update-state --id=task-42 --state=in_progress --reason='reviewed with new context'

# 替代
tw usecase replace --id=uc-1 --supersede=[task-42,task-43] --new-entities=[...]

# 拒绝
tw update-state --id=task-42 --state=rejected --reason='no longer needed'
```

**阶段 3：Replace（调用方显式触发）**

```
CommandHandler.usecaseReplace()
    ├─ 批量 updateState(superseded) → endSpan(UNSET)
    ├─ 批量 register(new entities)
    └─ ProgressTracker 更新 progress
```

### 6.4 新上下文获取

`mutation_context` 存在 UseCase 的 attributes 上，调用方通过 `tw get --id=uc-1 --json` 获取。

---

## 7. 类型扩展汇总

### EntityState

```typescript
export type EntityState =
  | 'pending'
  | 'in_progress'
  | 'review'
  | 'completed'
  | 'rejected'
  | 'paused'
  | 'superseded'
```

### TwEventType

```typescript
// 新增
| 'error.captured'
| 'usecase.mutated'
| 'entity.paused'
| 'entity.superseded'
| 'tool.invoked'
| 'tool.completed'
| 'session.started'
| 'session.ended'
| 'session.rebound'
```

### IPC 方法

```typescript
// 新增
'usecase_mutate'    // insert / update 入口
'usecase_replace'   // supersede + 新建
'session_rebind'    // 匿名实体 → 正式实体迁移
```

---

## 8. 模块边界

### 新增模块

| 模块 | 位置 | 职责 | 禁止 |
|------|------|------|------|
| `error-bubbler.ts` | `tw-daemon/src/subscribers/` | 监听 error.captured，沿 parent chain 冒泡 | 不改实体 state |
| `progress-tracker.ts` | `tw-daemon/src/subscribers/` | 监听 state_changed/registered/removed，重算进度 | 不做决策 |
| `usecase-mutation-handler.ts` | `tw-daemon/src/subscribers/` | 监听 usecase.mutated，执行 drain | 不创建新实体 |
| `hooks/session-start.ts` | `tw-cli/src/hooks/` | SessionStart: 创建匿名实体 + 写 .tw-session | 快速返回，失败静默 |
| `hooks/pre-tool.ts` | `tw-cli/src/hooks/` | PreToolUse: 从 .tw-session 读 id + 采集 | 快速返回，失败静默 |
| `hooks/post-tool.ts` | `tw-cli/src/hooks/` | PostToolUse: 错误分类 + 采集 | 快速返回，失败静默 |
| `hooks/stop.ts` | `tw-cli/src/hooks/` | Stop: 结束会话 | 快速返回，失败静默 |
| `hooks/rebind.ts` | `tw-cli/src/hooks/` | rebind: 事件迁移 + 更新 .tw-session | 快速返回，失败静默 |

### 变更模块

| 模块 | 变更内容 |
|------|---------|
| `tw-types/src/index.ts` | 新增 EntityState、TwEventType、IPC 方法类型 |
| `core/engine/state-machine.ts` | 新增 paused/superseded 转换规则 |
| `core/command-handler.ts` | 新增 usecaseMutate / usecaseReplace 方法 |
| `otel/span-manager.ts` | superseded → UNSET 映射 |
| `ipc-server.ts` | 新增 dispatch 方法 |
| `index.ts` (daemon) | 初始化 3 个新 subscriber |

### 不变模块

`core/propagator/`, `core/event-bus/`, `log/event-log.ts`, `notify/`, `watcher/`, `impact/`

---

## 9. 典型场景走读

### 场景 A：Task 编码出错 → 调用方自修复

```
1. CC Hook PostToolUse(Bash, exit=1, stderr="tsc error TS2345...")
2. tw hook post-tool --entity-id=task-1 --tool=Bash --exit-code=1
3. → emitEvent(task-1, 'error.captured', { source:'build', stderr:'...' })
4. → SpanManager: addEvent(task-1, 'error.captured', {...})
5. → EventBus → ErrorBubbler:
     addEvent(plan-1, 'child_error', { origin: task-1 })
     addEvent(uc-1, 'child_error', { origin: task-1 })
6. → NotifyEngine: 通知调用方 "task-1 构建错误"
7. 调用方: tw trace info --trace-id=<id>
   → uc-1 span 上有 child_error event，origin 指向 task-1
8. 调用方决定修复，继续在 task-1 上工作
```

### 场景 B：UseCase 需求变更 → drain + replace

```
1. tw usecase mutate --id=uc-1 --type=update --context='新增登录功能'
2. → updateAttributes(uc-1, { mutation_context, mutation_ts })
3. → EventBus → UsecaseMutationHandler:
     task-1(in_progress) → paused
     task-2(review) → paused
     plan-1(in_progress) → paused
4. → NotifyEngine: 通知 "uc-1 已更新，3 个实体已暂停"
5. 调用方查看: tw get --id=uc-1
6. 调用方决定:
   tw update-state --id=task-1 --state=in_progress  # 恢复
   tw update-state --id=task-2 --state=superseded    # 替代
   tw usecase mutate --id=uc-1 --type=insert --entities=[{task-3}]  # 新增
```

### 场景 C：完整生命周期

```
1. tw register --id=uc-1 --type=usecase
2. tw register --id=plan-1 --type=plan --parent-id=uc-1
3. tw register --id=task-1 --type=task --parent-id=plan-1
4. export TW_ENTITY_ID=task-1 && 启动 Claude Code
5. CC Hook 自动采集工具调用 → span events
6. task-1 完成 → tw update-state --id=task-1 --state=completed
7. ProgressTracker: plan-1.progress = { done:1, total:1, percent:100 }
8. Propagator: plan-1 → completed
9. ProgressTracker: uc-1.progress = { done:1, total:1, percent:100 }
10. Propagator: uc-1 → completed
11. 全链路 spans 结束，导出到 Jaeger
```
