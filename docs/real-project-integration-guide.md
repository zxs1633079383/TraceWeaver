# TraceWeaver 真实项目接入指南

> 从 Todo API Demo（5 UC × 72 Task）全流程验证中沉淀的实战经验。
> 适用于任何需要 AI Agent 可观测性的真实项目。

---

## 一、架构定位

TraceWeaver 是**纯可观测层**，不做决策、不触发修复、不干预业务流程。

```
你的项目代码  ←→  AI Agent (Claude Code / Codex / ...)
                      ↓ CC Hook 自动采集
                  TraceWeaver Daemon
                      ↓ OTLP/gRPC
                    Jaeger (可视化)
```

核心原则：**Agent 负责做事，TraceWeaver 负责看见。**

---

## 二、接入步骤

### 2.1 项目内初始化

```bash
# 在你的项目根目录
mkdir -p .traceweaver
```

创建 `.traceweaver/config.yaml`：

```yaml
otel:
  exporter: otlp-grpc
  endpoint: localhost:4317        # 本地开发用 port-forward
  project_id: your-project-name   # 会出现在 Jaeger span attributes 中

watch:
  dirs: [.]
  ignored: ["**/node_modules/**", "**/dist/**"]

notify:
  rules:
    - event: entity.state_changed
      state: rejected
    - event: entity.state_changed
      state: completed
    - event: error.captured
```

### 2.2 Jaeger 连接

```bash
# 方式 1：K8s port-forward（推荐本地开发）
kubectl port-forward svc/jaeger-collector 4317:4317 -n your-namespace &

# 方式 2：Docker 本地运行
docker run -d --name jaeger \
  -p 4317:4317 -p 16686:16686 \
  jaegertracing/all-in-one:latest

# 验证连通性
nc -z localhost 4317 && echo "OK"
```

**踩坑经验**：telepresence VPN IP 对 Node.js gRPC 不可用（`nc` 能通但 `@grpc/grpc-js` 连不上），务必用 `localhost` + port-forward。

### 2.3 启动 Daemon

```bash
TW_STORE=$(pwd)/.traceweaver tw daemon start
```

### 2.4 Proto 文件检查

如果使用 `otlp-grpc` exporter，确认 proto 文件存在于 daemon 的 dist 目录：

```bash
ls $(dirname $(which tw))/../tw-daemon/dist/otel/proto/opentelemetry/proto/collector/trace/v1/trace_service.proto
```

如果不存在（TypeScript 编译不会复制 `.proto` 文件）：

```bash
cp -r packages/tw-daemon/src/otel/proto packages/tw-daemon/dist/otel/proto
```

---

## 三、实体规划（最重要的一步）

### 3.1 三级层级设计

```
UseCase  = 一个完整的业务需求（如"构建用户认证系统"）
  Plan   = 一个技术方向/模块（如"JWT Token 管理"）
    Task = 一个具体的开发动作（如"实现 token 生成函数"）
```

**原则**：
- UseCase 粒度 = 一个 PRD 或一个 Epic
- Plan 粒度 = 一个开发者可以独立完成的模块
- Task 粒度 = 一次 commit 或一个 TDD 周期

### 3.2 实体注册

```bash
# 先注册 UseCase
tw register usecase uc-auth

# 再注册 Plan（必须指定 parent）
tw register plan plan-jwt --parent uc-auth

# 最后注册 Task（必须指定 parent）
tw register task task-token-gen --parent plan-jwt
tw register task task-token-verify --parent plan-jwt
```

**注册顺序不可颠倒**：parent 必须先存在。

### 3.3 推荐的命名规范

```
UseCase:  uc-<业务领域>        例: uc-auth, uc-payment, uc-search
Plan:     plan-<模块名>        例: plan-jwt, plan-oauth, plan-session
Task:     task-<具体动作>       例: task-token-gen, task-login-api, task-auth-test
```

---

## 四、CC Hook 集成（自动采集）

### 4.1 Hook 配置

在**项目根目录**的 `.claude/settings.json`（项目级配置，非全局 `~/.claude/settings.json`）中添加：

```bash
# 项目级配置（推荐）
your-project/.claude/settings.json   ← 这里

# 不要放在全局
~/.claude/settings.json              ← 不要放这里
```

原因：不同项目的 TW_STORE 路径不同，hook 配置应跟随项目走，团队成员 clone 即可用。

```jsonc
// your-project/.claude/settings.json
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

### 4.2 会话绑定流程

```
SessionStart hook
  → 自动创建匿名实体 session-<uuid>
  → 写入 .traceweaver/.tw-session

Agent 明确任务后
  → tw register task task-xxx --parent plan-xxx
  → tw hook rebind --entity-id task-xxx
  → 之前采集的事件自动迁移到正式实体

Agent 完成任务后
  → tw update task-xxx --state completed
  → Span 结束并导出到 Jaeger
```

### 4.3 CLAUDE.md 约束（让 Agent 自动注册）

在项目的 `CLAUDE.md` 中添加：

```markdown
## TraceWeaver 集成

收到任务后，执行以下步骤：
1. 确认当前任务属于哪个 UseCase/Plan
2. 执行 `tw register task <task-id> --parent <plan-id>`
3. 执行 `tw hook rebind --entity-id <task-id>`
4. 开始开发
5. 完成后执行 `tw update <task-id> --state completed`

遇到构建/测试错误时：
1. 先执行 `tw trace info --entity-id <task-id> --json`
2. 从 `_ai_context.error_refs` 和 span events 中获取结构化错误信息
3. 基于 trace info 定位问题并修复
4. 不要直接看 stderr 修复，要通过可观测系统查询
```

---

## 五、状态生命周期

### 5.1 正常流程

```
pending → in_progress → review → completed
```

每次状态变更都会：
- 在 Span 上打 `state_changed_to_xxx` event
- ProgressTracker 自动更新父级进度
- 终态（completed/rejected/superseded）触发 Span 导出到 Jaeger

### 5.2 错误处理流程

```
Agent 操作失败
  → CC Hook PostToolUse 捕获 exit_code≠0
  → tw hook post-tool 发送 error.captured 事件
  → ErrorBubbler 自动冒泡到 Plan → UseCase 的 Span
  → NotifyEngine 通知
  → Agent 查询 tw trace info 获取结构化错误
  → Agent 修复代码
  → 重新构建/测试通过
  → tw update completed
```

**错误来源自动分类**：

| 命令模式 | source 值 |
|---------|-----------|
| `npm run build` / `tsc` | `build` |
| `npm test` / `vitest` | `test` |
| `node` / `ts-node` | `runtime` |
| Edit/Write 工具失败 | `tool` |
| 其他 Bash 失败 | `command` |

### 5.3 UseCase 变更（需求变了）

**Update（drain 旧链路）**：

```bash
tw usecase mutate --id uc-auth --type update --context '改为 OAuth2 代替自研 JWT'
```

效果：
- 所有 `in_progress` / `review` 的下游实体 → `paused`
- UseCase attributes 写入 `mutation_context`
- Agent 收到通知后自行决定每个 paused 实体的命运

**Replace（替代旧实体）**：

```bash
tw usecase replace --id uc-auth \
  --supersede task-token-gen task-token-verify \
  --new-entities '[{"entity_type":"task","id":"task-oauth-flow","parent_id":"plan-jwt"}]'
```

**Insert（追加新 Plan/Task）**：

```bash
tw usecase mutate --id uc-auth --type insert \
  --entities '[{"entity_type":"plan","id":"plan-oauth","parent_id":"uc-auth"},...]'
```

---

## 六、查询与验证

### 6.1 进度查看

```bash
# 全局进度
tw status --json

# 单个实体详情（含 progress）
tw status plan-jwt --json

# 输出示例:
# "progress": { "done": 3, "total": 4, "percent": 75, "paused": 0, "rejected": 0 }
```

### 6.2 Trace 查询

```bash
# 查完整链路（含 span 树 + AI 上下文）
tw trace info --entity-id uc-auth --json

# 输出: trace_id, root(span tree), summary, _ai_context
# _ai_context.error_refs = 结构化错误引用列表
```

### 6.3 Jaeger UI 查看

打开 `http://localhost:16686`：
- Service 选 `traceweaver-daemon`
- 每条 Trace 以 `usecase/<uc-id>` 命名
- 展开看 `plan/<plan-id>` → `task/<task-id>` 层级
- 点击 task span 看 events（tool.invoked / error.captured / state_changed）

---

## 七、踩坑记录

### 7.1 gRPC 导出无数据

**症状**：Daemon 运行正常，tw trace info 有数据，但 Jaeger 中看不到 service。

**排查路径**：

```bash
# 1. 检查连通性
nc -z localhost 4317

# 2. 测试 gRPC 真实连接（nc 能通不代表 gRPC 能通）
node -e "
const grpc = require('@grpc/grpc-js')
const c = new grpc.Client('localhost:4317', grpc.credentials.createInsecure())
c.waitForReady(Date.now()+5000, e => { console.log(e ? 'FAIL' : 'OK'); c.close() })
"

# 3. 检查 proto 文件是否存在
ls packages/tw-daemon/dist/otel/proto/
```

**常见原因**：
- `.proto` 文件未复制到 `dist/`（tsc 不处理非 .ts 文件）
- telepresence VPN IP 不支持 Node.js gRPC（用 port-forward 替代）
- Daemon 启动时 config.yaml 中 exporter 配置被忽略（检查 TW_STORE 是否正确传递）

### 7.2 Span events 丢失

**症状**：通过 `emit_event` IPC 添加的 events（tool.invoked / error.captured）在 Jaeger 中看不到。

**原因**：emit 和 updateState 之间有竞态——如果 `updateState(completed)` 在 `emit_event` 处理完之前执行，`endSpan` 导出的 span 快照不含新 events。

**解决**：所有 IPC 调用必须串行等待响应。使用 Node.js 的 `await` 或 shell 中确保 `nc` 返回后再执行下一条命令。

### 7.3 Daemon 重启丢失 Span

**症状**：Daemon 重启后，之前未 endSpan 的实体在 Jaeger 中没有 trace。

**原因**：SpanManager 是纯内存的，重启后 spans 丢失。WAL 恢复的是实体状态，不是 OTel spans。

**影响**：只有在 daemon 同一生命周期内从注册到终态的 span 才能导出到 Jaeger。

**建议**：生产环境不要在实体生命周期中间重启 daemon。如果必须重启，先 `tw daemon stop`（触发 exporterRegistry.shutdown() flush），再重启。

### 7.4 UseCase Replace 产生独立 Trace

**症状**：通过 `usecase replace` 新建的 Plan/Task 出现在独立的 Jaeger trace 中，而不是和 UseCase 同一个 trace。

**原因**：新 Plan 注册时，SpanManager 通过 parent_span_id 查找 trace_id。如果 parent（UseCase）的 span 已经 endSpan 了，新 Plan 会生成新的 trace_id。

**建议**：在 replace 之前不要 complete UseCase。按顺序：先 drain → replace → 完成新实体 → 最后 complete UseCase。

---

## 八、推荐的开发工作流

### 8.1 Sprint 开始时

```bash
# 1. 启动 daemon + Jaeger
kubectl port-forward svc/jaeger-collector 4317:4317 -n xxx &
TW_STORE=$(pwd)/.traceweaver tw daemon start

# 2. 注册 UseCase 和 Plan（从 PRD / Epic 拆解）
tw register usecase uc-sprint-42-auth
tw register plan plan-login --parent uc-sprint-42-auth
tw register plan plan-session --parent uc-sprint-42-auth
tw register plan plan-rbac --parent uc-sprint-42-auth

# 3. 注册 Task（从 Plan 细分）
tw register task task-login-form --parent plan-login
tw register task task-login-api --parent plan-login
...
```

### 8.2 开发过程中

```bash
# Agent 自动通过 CC Hook 采集（无需手动操作）
# 状态变更通过 CLAUDE.md 约束让 Agent 自行管理

# 随时查看进度
tw status uc-sprint-42-auth --json

# 遇到阻塞时查看完整链路
tw trace info --entity-id uc-sprint-42-auth --json
```

### 8.3 需求变更时

```bash
# 1. 触发 drain
tw usecase mutate --id uc-sprint-42-auth --type update --context '产品要求改为 SSO 登录'

# 2. 检查哪些实体被暂停
tw trace info --entity-id uc-sprint-42-auth --json | jq '.root' | grep paused

# 3. 决定每个 paused 实体的命运
tw update task-login-form --state in_progress    # 恢复
tw usecase replace --id uc-sprint-42-auth \
  --supersede task-login-api \
  --new-entities '[...]'                          # 替代
```

### 8.4 Sprint 结束时

```bash
# 查看 Jaeger 中的完整 trace
# http://localhost:16686 → service=traceweaver-daemon

# 生成日报
tw report daily --all

# 停止 daemon
tw daemon stop
```

---

## 九、实体数量参考

| 项目规模 | UseCase 数 | Plan / UC | Task / Plan | 总 Task 数 |
|---------|-----------|-----------|-------------|-----------|
| 小型 Demo | 1-2 | 2-3 | 3-4 | 10-20 |
| 中型项目 (本次 Demo) | 5 | 3-4 | 4 | 68 |
| 大型 Sprint | 3-5 | 4-6 | 5-8 | 100-200 |

---

## 十、技术参考

| 组件 | 说明 |
|------|------|
| Daemon | Unix Socket IPC，自动 30 分钟空闲超时 |
| SpanManager | 内存级 OTel span 管理，endSpan 触发导出 |
| EventBus | 内存 ring buffer，50ms batch drain |
| ErrorBubbler | 监听 error.captured，沿 parent_id 链冒泡 |
| ProgressTracker | 监听 state_changed/registered/removed，递归更新进度 |
| UsecaseMutationHandler | 监听 usecase.mutated，drain in_progress/review → paused |
| ExporterRegistry | 支持 console / otlp-http / otlp-grpc 三种模式 |
