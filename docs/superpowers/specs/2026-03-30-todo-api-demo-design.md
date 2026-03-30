# Todo API Demo — TraceWeaver 全流程验证

> 在 `/Users/mac28/workspace/temp/todo-api-demo/` 创建真实 Todo REST API 项目，
> 由 Claude Code 作为 AI Agent 全流程开发，TraceWeaver 自动采集可观测数据，
> 验证 UseCase→Plan→Task 生命周期、错误冒泡、进度追踪、drain+replace 闭环。

Date: 2026-03-30

---

## 1. 项目概况

| 维度 | 内容 |
|------|------|
| 项目 | Express + TypeScript Todo REST API |
| 位置 | `/Users/mac28/workspace/temp/todo-api-demo/` |
| 规模 | 5 UseCase × 3-4 Plan × 4 Task = 72 个 Task |
| Jaeger | telepresence 直连 K8s，endpoint: `jaeger-cses-pre-collector.jaeger-cses.svc.cluster.local:4317` |
| 验证方式 | 关键节点查 + 最终汇总 |

---

## 2. 实体层级

### UC1: `uc-crud` — Todo CRUD 基础 API

```
├─ Plan: plan-setup          "项目初始化"
│   ├─ task-init-pkg          "npm init + tsconfig + express 依赖"
│   ├─ task-dev-scripts       "build/dev/test scripts 配置"
│   ├─ task-app-skeleton      "Express app 骨架 + 健康检查 /health"
│   └─ task-tw-config         "TraceWeaver config.yaml + Jaeger 配置"
├─ Plan: plan-model           "数据模型"
│   ├─ task-todo-type         "Todo interface 定义"
│   ├─ task-store             "内存 TodoStore（Map）"
│   ├─ task-store-test        "TodoStore 单元测试"
│   └─ task-id-gen            "ID 生成器 (nanoid)"
├─ Plan: plan-endpoints       "CRUD Endpoints"
│   ├─ task-get-all           "GET /todos"
│   ├─ task-get-by-id         "GET /todos/:id"
│   ├─ task-create            "POST /todos ← 故意写错类型"
│   └─ task-delete            "DELETE /todos/:id"
└─ Plan: plan-crud-test       "CRUD 集成测试"
    ├─ task-test-get           "GET 测试"
    ├─ task-test-create        "POST 测试"
    ├─ task-test-delete        "DELETE 测试"
    └─ task-test-404           "404 测试"
```

### UC2: `uc-update` — Todo 更新与状态管理

```
├─ Plan: plan-patch            "PATCH 更新"
│   ├─ task-patch-endpoint     "PATCH /todos/:id"
│   ├─ task-patch-partial      "支持部分更新 (partial)"
│   ├─ task-patch-test         "PATCH 单元测试"
│   └─ task-patch-toggle       "PUT /todos/:id/toggle"
├─ Plan: plan-bulk             "批量操作"
│   ├─ task-bulk-complete      "POST /todos/bulk-complete"
│   ├─ task-bulk-delete        "DELETE /todos/bulk"
│   ├─ task-bulk-test          "批量操作测试"
│   └─ task-bulk-validate      "批量参数校验"
└─ Plan: plan-status           "状态流转"
    ├─ task-status-enum        "TodoStatus enum (pending/done/archived)"
    ├─ task-status-transition  "状态转换规则"
    ├─ task-status-filter      "GET /todos?status=done"
    └─ task-status-test        "状态流转测试"
```

### UC3: `uc-validation` — 输入验证与错误处理

```
├─ Plan: plan-schema           "Schema 验证"
│   ├─ task-zod-setup          "安装 zod + 定义 TodoSchema"
│   ├─ task-create-schema      "CreateTodoSchema 验证"
│   ├─ task-update-schema      "UpdateTodoSchema 验证"
│   └─ task-schema-test        "Schema 单元测试 ← 故意写错测试断言"
├─ Plan: plan-middleware        "错误中间件"
│   ├─ task-error-handler      "全局 errorHandler 中间件"
│   ├─ task-not-found          "404 fallback"
│   ├─ task-validation-mid     "validationMiddleware (zod → 400)"
│   └─ task-middleware-test    "中间件测试"
└─ Plan: plan-response          "统一响应格式"
    ├─ task-success-format     "{ ok: true, data: T }"
    ├─ task-error-format       "{ ok: false, error: { code, message } }"
    ├─ task-wrapper-fn         "wrapResponse 工具函数"
    └─ task-format-test        "响应格式测试"
```

### UC4: `uc-category` — Todo 分类系统

```
├─ Plan: plan-tag-model         "标签数据模型"
│   ├─ task-tag-type            "Tag interface"
│   ├─ task-tag-store           "TagStore（内存 Map）"
│   ├─ task-tag-relation        "Todo ↔ Tag 多对多关系"
│   └─ task-tag-test            "标签模型测试"
├─ Plan: plan-tag-api            "标签 API"
│   ├─ task-tag-crud            "CRUD /tags"
│   ├─ task-todo-tag            "POST /todos/:id/tags"
│   ├─ task-filter-by-tag      "GET /todos?tag=xxx"
│   └─ task-tag-api-test       "标签 API 测试"
├─ Plan: plan-priority           "优先级系统"
│   ├─ task-priority-enum       "Priority enum (low/medium/high/urgent)"
│   ├─ task-priority-sort       "GET /todos?sort=priority"
│   ├─ task-priority-default    "默认优先级 = medium"
│   └─ task-priority-test       "优先级测试"
```

### UC5: `uc-search` — 搜索与分页

```
├─ Plan: plan-pagination         "分页"
│   ├─ task-page-params         "page/limit 查询参数解析"
│   ├─ task-page-response       "分页响应 { data, meta: { total, page, limit } }"
│   ├─ task-page-default        "默认 page=1, limit=20"
│   └─ task-page-test           "分页测试"
├─ Plan: plan-search             "搜索"
│   ├─ task-search-title        "GET /todos?q=xxx 标题搜索"
│   ├─ task-search-combined     "组合搜索 q + status + tag"
│   ├─ task-search-empty        "空结果处理"
│   └─ task-search-test         "搜索测试 ← 故意运行时错误"
├─ Plan: plan-sort                "排序"
│   ├─ task-sort-fields         "sort=createdAt/-priority"
│   ├─ task-sort-multi          "多字段排序"
│   ├─ task-sort-invalid        "非法排序字段 → 400"
│   └─ task-sort-test           "排序测试"
└─ Plan: plan-export              "数据导出"（← UC insert 新增此 Plan）
    ├─ task-export-json         "GET /todos/export?format=json"
    ├─ task-export-csv          "GET /todos/export?format=csv"
    ├─ task-export-test         "导出测试"
    └─ task-export-headers      "Content-Type + Content-Disposition headers"
```

---

## 3. 错误修复闭环（核心流程）

错误发生后，Agent 不直接看 stderr 修复，而是通过 TraceWeaver 查询结构化错误信息：

```
1. CC Hook PostToolUse 捕获错误 → error.captured 事件
2. ErrorBubbler 自动冒泡到 Plan + UseCase span
3. Agent 发现构建/测试失败
4. Agent 执行: tw trace info --entity-id=<task-id> --json
   → 读取 _ai_context.error_refs（结构化错误引用列表）
   → 读取 span events 中的 error.captured 详情（source、message）
   → 加载到 Agent 上下文中
5. Agent 基于 trace info 中的结构化信息定位问题根因
6. Agent 修复代码
7. 重新构建/测试 → tool.completed 事件确认修复
```

### 三次故意错误

| 错误 | 位置 | 类型 | error.captured source |
|------|------|------|----------------------|
| TypeScript 类型错误 | UC1 task-create | `completed: 'false'` (string≠boolean) | `build` |
| 测试断言错误 | UC3 task-schema-test | `expect(result).toBe(wrong_value)` | `test` |
| 运行时错误 | UC5 task-search-test | `undefined.length` 访问 | `runtime` |

每次错误后的修复流程：
1. `tw trace info --entity-id=<task-id> --json` 获取错误上下文
2. 解析 `_ai_context.error_refs` 和 span events
3. 基于结构化信息修复
4. 验证修复成功

---

## 4. UseCase 变更场景

### UC4 — update(drain + replace)

```
触发时机：plan-tag-model 和 plan-tag-api 完成，plan-priority 开发中
变更内容："标签改为层级分类（Category 树形结构，不再是扁平 Tag）"

流程：
1. tw usecase mutate --id=uc-category --type=update --context='标签改为层级分类 Category 树形结构'
2. UsecaseMutationHandler drain：
   - plan-priority 中 in_progress 的 task → paused
   - plan-tag-api (completed) → 不动
3. 验证点：tw trace info 确认 paused 状态
4. Agent 决定：
   - task-priority-enum/sort/default/test → supersede（不再需要独立优先级，合并到 Category）
   - 新建 plan-category-tree 替代
5. tw usecase replace --id=uc-category --supersede=[...] --new-entities=[...]
```

### UC5 — insert(新增 Plan)

```
触发时机：plan-pagination + plan-search + plan-sort 完成
变更内容："追加数据导出功能"

流程：
1. tw usecase mutate --id=uc-search --type=insert --entities='[plan-export + 4 tasks]'
2. ProgressTracker 更新 uc-search.progress.total（从 3 Plan 变成 4 Plan）
3. 正常开发 plan-export 下的 4 个 task
```

---

## 5. 全流程编排

| Phase | UseCase | 核心场景 | 关键验证 |
|-------|---------|---------|---------|
| 1 | uc-crud | session-start → rebind → **构建错误** → tw trace info 查错 → 修复 | 验证 1：error 冒泡 + trace info 可用 |
| 2 | uc-update | 正常开发全流程 12 tasks | 验证 2：progress 逐级 100% |
| 3 | uc-validation | **测试错误** → tw trace info 查错 → 修复 | 验证 3：test 类型错误冒泡 |
| 4 | uc-category | 正常开发 → **UC update(drain+replace)** | 验证 4：drain paused + supersede + 新 Plan |
| 5 | uc-search | **运行时错误** → tw trace info 查错 → 修复 → **UC insert** | 验证 5：完整 trace 链路 + Jaeger |

---

## 6. 验证点详情

### 验证 1（Phase 1 后）— 错误冒泡 + trace info 自修复

```bash
tw trace info --entity-id=uc-crud --json
# 预期：
# - span events 包含 child_error（origin: task-create, source: build）
# - _ai_context.error_refs 非空
# - 修复后 task-create 状态 = completed
```

### 验证 2（Phase 2 后）— 进度完整

```bash
tw get --id=uc-update --json
# 预期：
# - attributes.progress.done = 3 (plans)
# - attributes.progress.percent = 100

tw get --id=plan-patch --json
# 预期：
# - attributes.progress.done = 4, total = 4, percent = 100
```

### 验证 3（Phase 3 后）— 测试错误冒泡

```bash
tw trace info --entity-id=task-schema-test --json
# 预期：
# - span events 包含 error.captured（source: test）
# - 修复后 status = OK
```

### 验证 4（Phase 4 后）— drain + replace

```bash
tw trace info --entity-id=uc-category --json
# 预期：
# - task-priority-* 状态 = superseded
# - plan-category-tree 存在且下属 task 为 pending
# - uc-category attributes 包含 mutation_context
```

### 验证 5（Phase 5 后）— 完整 trace + insert

```bash
tw trace info --entity-id=uc-search --json
# 预期：
# - plan-export 存在（insert 新增）
# - uc-search.progress.total = 4（含新增 Plan）
# - 完整 span 树包含所有事件

# Jaeger 查询
# 在 Jaeger UI 搜索 service=traceweaver-daemon project=todo-api-demo
# 预期：5 条 trace，每条包含完整 span 层级
```

---

## 7. Jaeger 配置

`.traceweaver/config.yaml`：

```yaml
otel:
  exporter: otlp-grpc
  endpoint: jaeger-cses-pre-collector.jaeger-cses.svc.cluster.local:4317
  project_id: todo-api-demo

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

---

## 8. 不做的事

- 不构建真实数据库（内存 Map 即可）
- 不做前端
- 不做 Docker 化
- 不做 CI/CD
- 不做用户认证（减少复杂度）
