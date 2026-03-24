# TraceWeaver

**AI 原生研发流程可观测引擎**

TraceWeaver 追踪研发实体（实验、假设、任务、制品）的完整生命周期，为 AI Agent 和工程师提供研发过程的实时可查询视图。

---

## 功能特性

- **状态机追踪** — 注册实体并推进其经历明确定义的生命周期状态（`pending`、`in_progress`、`completed`、`rejected`、`blocked`）
- **OpenTelemetry 集成** — 每个实体映射到一个 OTel Span；状态变更自动触发事件和 Span 注解
- **MCP Server** — 通过 stdio transport 为 AI Agent 提供一等公民的 Model Context Protocol 支持
- **HTTP API** — 支持 Webhook 的 REST API，提供基于 Token 的鉴权，适用于 CI/CD 和外部集成
- **通知引擎** — 可配置的收件箱和 Webhook 规则，在状态转换时触发（例如 `rejected`、`completed`）
- **文件系统监听器** — 当被追踪的制品文件在磁盘上发生变更时，自动触发事件
- **依赖 DAG** — 声明 `depends_on` 关系并查询实时实体图
- **影响分析** — 解析当制品或文档某节内容变更时，哪些实体会受到影响
- **持久化事件日志** — 基于 NDJSON 的事件日志在 Daemon 重启后仍然存活；支持按实体、类型、时间范围进行完整查询
- **Span 指标** — 直接从 OTel Span 历史中推导出周期时间、失败率和吞吐量
- **Harness 工程化** — 以代码形式管理约束文件（`.traceweaver/harness/*.md`）；在状态变更时自动验证实体，失败时自动拒绝
- **自主 Agent 闭环** — AI Agent 可通过 CLI 或 MCP 实现 observe → detect → diagnose → validate → fix 的完整闭环

---

## 架构图

```
  tw (CLI)
     |
     | Unix socket (IPC)
     v
 tw-daemon
     |
     +---> CommandHandler
     |          |
     |          +---> EntityRegistry + DAG        # 实体注册表与依赖图
     |          +---> WAL + FsStore               # 预写日志与文件存储
     |          +---> EventBus                    # 事件总线
     |          +---> ImpactResolver              # 文件 → 实体反向索引 + DAG 传播
     |                    |
     |                    +---> EventLog          # NDJSON 持久化日志
     |                    +---> NotifyEngine --> InboxAdapter    # 本地收件箱
     |                    |                 --> WebhookAdapter   # 外部 Webhook
     |                    +---> FsWatcher         # 文件系统监听器
     |                    +---> SpanManager (OTel) --> SpanMetrics  # OTel Span 与指标
     |                    +---> HarnessLoader     # 加载 .traceweaver/harness/*.md
     |                    +---> TriggerExecutor   # 自动验证 → 自动拒绝
     |                              └─> ConstraintEvaluator (LLM 驱动)
     |
     +---> McpServer  (stdio，可选)
     +---> HttpServer (端口，可选)
```

---

## 安装

```bash
npm install
npm run build
```

全局安装 `tw` CLI：

```bash
npm install -g .
```

---

## 快速开始

```bash
# 注册一个新的实验实体
tw register exp-001 --type experiment --title "基线性能基准"

# 更新实体状态
tw update exp-001 --state in_progress

# 查看所有实体状态
tw status

# 查看通知收件箱
tw inbox

# 查询最近事件历史（持久化日志，Daemon 重启后仍可查询）
tw log query --since 1h --entity exp-001 --type state_changed

# 实时流式监听事件
tw watch

# 查看 Span 推导的指标数据
tw metrics --type task --window 24

# 查看依赖关系图
tw dag

# 分析文档变更的影响范围
tw impact ./docs/prd.md

# Harness 工程化 —— 约束文件即代码
tw harness list
tw harness show test-coverage
tw harness run exp-001 --harness-id test-coverage

# 所有命令均支持 --json 输出机器可读格式
tw status --json
tw metrics --json
tw harness list --json
```

---

## 配置说明

在项目根目录创建 `.traceweaver/config.yaml`：

```yaml
# .traceweaver/config.yaml

store_dir: .traceweaver        # 实体和 WAL 的持久化目录
socket_path: .traceweaver/tw.sock

notify:
  rules:
    - event: entity.state_changed
      state: rejected
    - event: entity.state_changed
      state: completed
  webhook:
    url: https://hooks.example.com/tw
    token: ${TW_WEBHOOK_TOKEN}

otel:
  project_id: my-project
  exporter: console            # console | otlp

http:
  port: 4321
  inbound_token: ${TW_INBOUND_TOKEN}
```

环境变量覆盖配置：

| 变量名 | 说明 |
|---|---|
| `TW_STORE` | 覆盖存储目录路径 |
| `TW_SOCKET` | 覆盖 Socket 路径 |
| `TW_HTTP_PORT` | 在指定端口启用 HTTP API |
| `TW_INBOUND_TOKEN` | HTTP API 的 Bearer Token 鉴权 |
| `TW_MCP_STDIO` | 设为 `1` 以启用 MCP stdio transport |
| `TW_WEBHOOK_TOKEN` | 在 Webhook `Authorization` 请求头中发送的 Token |
| `ANTHROPIC_API_KEY` | 启用 Harness 约束的 LLM 驱动评估 |

---

## Agent 集成

### MCP Server

TraceWeaver 为 AI Agent（Claude、GPT-4 等）暴露完整的 MCP Server：

```json
{
  "mcpServers": {
    "traceweaver": {
      "command": "tw",
      "args": ["daemon", "--mcp"],
      "env": {
        "TW_MCP_STDIO": "1",
        "TW_STORE": "/path/to/your/project/.traceweaver"
      }
    }
  }
}
```

暴露的 MCP 工具：`register_entity`、`update_state`、`update_attributes`、`get_status`、`query_events`、`get_dag`、`link_artifact`、`emit_event`

### HTTP API

设置 `TW_HTTP_PORT` 后，Daemon 将暴露 REST API：

```
Base URL: http://127.0.0.1:<TW_HTTP_PORT>

POST   /entities              注册实体
PATCH  /entities/:id/state    更新状态
PATCH  /entities/:id/attrs    更新属性
GET    /entities/:id          获取实体及子节点
GET    /status                汇总统计
POST   /events                触发自定义事件
GET    /events                查询事件历史
GET    /dag                   获取依赖关系图
```

当设置了 `TW_INBOUND_TOKEN` 时，所有请求需携带 `Authorization: Bearer <TW_INBOUND_TOKEN>`。

---

## Harness 工程化

Harness 是与项目代码一同存放的约束文件，采用带 YAML frontmatter 的 Markdown 格式。它们定义了每类实体"完成"的标准，Daemon 会自动执行这些约束。

### Harness 文件格式

在 `.traceweaver/harness/<id>.md` 创建约束文件：

```markdown
---
id: test-coverage
applies_to:
  - task
trigger_on:
  - review
  - completed
---
# 测试覆盖率约束

所有任务必须包含测试文件。检查 artifact_refs 中是否至少有一项
type 为 "test" 的条目。

RESULT: 测试存在则通过，否则失败。
```

### 自动执行机制

当实体到达 `trigger_on` 中列出的状态时，TriggerExecutor 会自动：

1. 通过 ConstraintEvaluator 评估 Harness 约束（设置 `ANTHROPIC_API_KEY` 后由 LLM 驱动）
2. **失败** → 自动将实体转换为 `rejected` 状态，并写入收件箱通知
3. **通过** → 记录结果；实体继续其生命周期

启用 AI 驱动评估：

```bash
export ANTHROPIC_API_KEY=sk-...
```

未设置该密钥时，评估器以禁用模式运行（不自动拒绝）。

### 相关环境变量

| 变量名 | 说明 |
|---|---|
| `ANTHROPIC_API_KEY` | 在 TriggerExecutor 中启用 LLM 驱动的约束评估 |

---

## 自主 Agent 闭环

Phase 5 完成了完整的 observe → detect → diagnose → validate → fix 闭环：

```
AI Agent
  │
  ├── tw log query --since 1h          # observe：发生了什么？
  ├── tw metrics --type task           # detect：是否存在失败？
  ├── tw impact src/auth.ts            # diagnose：哪些实体受影响？
  ├── tw harness run <id> --harness-id # validate：是否满足约束条件？
  └── tw update <id> --state completed # fix：条件满足时推进状态
```

所有命令均支持 `--json` 以供程序化使用。MCP Server 以工具形式暴露相同的操作（`tw_query_log`、`tw_get_metrics`、`tw_resolve_impact`、`tw_harness_run`）。

---

## License

MIT
