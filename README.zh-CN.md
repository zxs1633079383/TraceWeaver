# TraceWeaver

**AI 原生研发流程可观测引擎**

[English](./README.md)

TraceWeaver 追踪 UseCase -> Plan -> Task 的完整生命周期，为 AI Agent 和工程师提供实时可查询的研发过程视图，并通过 OpenTelemetry 将 Trace 导出到 Jaeger。

---

## 功能特性

- **实体生命周期追踪** — 注册实体并通过状态机驱动（`pending` -> `in_progress` -> `review` -> `completed` | `rejected`）
- **OpenTelemetry 集成** — 每个实体映射为 OTel Span，状态变更生成 span 事件，通过 OTLP/gRPC 导出到 Jaeger
- **链路查询 + `_ai_context`** — `tw trace info --json` 返回确定性的 `_ai_context` 字段，直接告诉 AI Agent 下一步该做什么
- **日报生成** — `tw report daily` 生成结构化 Markdown 报告，聚合实体状态、Span 树和 AI 上下文
- **MCP Server** — 为 AI Agent（Claude 等）提供 Model Context Protocol 支持（stdio 传输）
- **HTTP API** — Token 鉴权的 REST API，用于 CI/CD 和外部集成
- **通知引擎** — 可配置的收件箱和 Webhook 规则，在状态变更时触发
- **文件监听** — 当被追踪的制品文件发生变更时自动触发事件
- **DAG 依赖图** — 声明 `depends_on` 关系，查询实时实体图，检测阻塞实体
- **影响分析** — 解析文件变更时哪些实体受到直接和传递影响
- **持久化事件日志** — 基于 NDJSON 的事件日志，daemon 重启后仍可查询
- **Span 指标** — 从 OTel Span 历史推导周期时间、失败率和吞吐量

---

## 架构

```
tw (CLI)
   |
   | Unix socket (IPC)
   v
tw-daemon
   |
   +---> CommandHandler
   |          |
   |          +---> EntityRegistry + DAG        # 实体注册表 + 依赖图
   |          +---> WAL + FsStore               # 预写日志 + 文件存储
   |          +---> EventBus                    # 事件总线
   |          +---> ImpactResolver              # 文件 -> 实体反向索引
   |                    |
   |                    +---> EventLog (NDJSON)  # 持久化日志
   |                    +---> NotifyEngine       # 通知引擎
   |                    +---> FsWatcher          # 文件监听
   |                    +---> SpanManager (OTel) # Span 管理 + 指标
   |                    +---> TraceQueryEngine   # 链路查询 + _ai_context
   |                    +---> ReportGenerator    # 日报生成
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

全局安装 CLI（可选但推荐）：

```bash
npm install -g .
```

---

## 快速开始

```bash
# 启动守护进程
tw daemon start

# 注册实体
tw register usecase blog-v2 --prd docs/prd.md
tw register plan plan-frontend --parent blog-v2 --domain frontend
tw register task task-hero --parent plan-frontend

# 推进状态
tw update task-hero --state in_progress
tw update task-hero --state review
tw update task-hero --state completed

# 查询链路（含 AI 上下文）
tw trace info --entity-id blog-v2 --json

# 生成日报
tw report daily --all

# 查看指标
tw metrics --type task --window 24

# 影响分析
tw impact src/auth.ts --json

# 所有命令支持 --json
tw status --json
tw log query --since 1h --json
tw inbox --json
```

完整分步教程请参阅 [QUICKSTART.zh-CN.md](./QUICKSTART.zh-CN.md)。

---

## 配置

在项目根目录创建 `.traceweaver/config.yaml`：

```yaml
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
  exporter: otlp-grpc          # console | otlp-http | otlp-grpc
  endpoint: localhost:4317

report:
  schedule: "09:00"             # 每天 9 点自动生成日报
  output_dir: ~/.traceweaver/reports

watch:
  dirs: ["."]
```

### 环境变量

| 变量 | 说明 |
|------|------|
| `TW_STORE` | 存储目录（默认 `.traceweaver`） |
| `TW_SOCKET` | Unix socket 路径 |
| `TW_HTTP_PORT` | 启用 HTTP API |
| `TW_INBOUND_TOKEN` | HTTP Bearer Token |
| `TW_MCP_STDIO` | 设为 `1` 启用 MCP stdio |
| `TW_WEBHOOK_TOKEN` | Webhook Authorization Token |

---

## AI Agent 集成

### MCP Server

```json
{
  "mcpServers": {
    "traceweaver": {
      "command": "tw",
      "args": ["daemon", "--mcp"],
      "env": { "TW_MCP_STDIO": "1" }
    }
  }
}
```

工具：`register_entity`、`update_state`、`get_status`、`query_events`、`get_dag`、`emit_event`

### `_ai_context` — AI Agent 行动指南

`tw trace info --json` 返回确定性的 `_ai_context` 字段：

```json
{
  "one_line": "5 实体中 2 完成，task-bad 被拒绝，task-blocked 等待解锁",
  "next_actions": ["task-bad: 已拒绝 -> 修复后重试", "task-blocked: 等待上游完成"],
  "error_refs": ["events.ndjson -> entity_id=task-bad, state=rejected"]
}
```

AI Agent 无需理解 TraceWeaver 内部机制，只需读取 `_ai_context.next_actions`。

### HTTP API

```
POST   /entities              注册实体
PATCH  /entities/:id/state    更新状态
GET    /entities/:id          获取实体详情
GET    /status                汇总统计
GET    /dag                   依赖图
```

配置 `TW_INBOUND_TOKEN` 后所有请求需携带 `Authorization: Bearer <token>`。

---

## 可观测闭环

```
AI Agent
  |
  +-- tw log query --since 1h        # observe：发生了什么？
  +-- tw metrics --type task          # detect：有没有失败？
  +-- tw impact src/auth.ts           # diagnose：哪些实体受影响？
  +-- tw trace info --json            # decide：下一步做什么？
  +-- tw update <id> --state ...      # fix：推进状态
```

---

## 示例

```bash
npm run run:11 --workspace=examples   # 全链路可观测闭环
npm run run:12 --workspace=examples   # Jaeger OTLP/gRPC 导出
npm run run:13 --workspace=examples   # TaskMaster 联动
npm run run:14 --workspace=examples   # 链路 + 日报端到端
```

---

## License

MIT
