# T08 — 验收标准：全流程闭环 + Jaeger 链路

**状态：** pending
**依赖：** T01-T07 全部完成

---

## 验收矩阵

### A. 测试覆盖

```bash
npm test --workspace=packages/tw-daemon --workspace=packages/tw-cli
```

| 指标 | 目标 |
|------|------|
| Test Files | ≥ 34 个 |
| Tests passing | ≥ 205 个 |
| Failed | 0 |

---

### B. 构建验证

```bash
npm run build
```

- [ ] 0 TypeScript 编译错误
- [ ] `packages/tw-cli/dist/index.js` 存在
- [ ] `packages/tw-daemon/dist/index.js` 存在

---

### C. Harness 经验与反馈（本地验证）

```bash
tw daemon start

# 创建 harness 文件触发失败场景
mkdir -p .traceweaver/harness
cat > .traceweaver/harness/need-tests.md << 'EOF'
---
id: need-tests
applies_to:
  - task
trigger_on:
  - review
---
任务必须包含测试文件。
EOF

tw register task t-test --parent plan-x  # 注册任务（略去完整流程）
# 推进状态触发评估...
tw feedback summary --json               # 查看评估统计
tw harness validate --json               # 查看对齐报告
```

- [ ] `feedback.ndjson` 存在于 `.traceweaver/`
- [ ] `tw feedback summary` 显示 harness 统计数据
- [ ] `tw harness validate` 返回 `AlignmentIssue[]`（或空数组）
- [ ] 连续失败 3 次后收件箱出现 `[FEEDBACK]` 消息

---

### D. OTLP/gRPC → Jaeger 验证

#### 本地 Jaeger（开发测试）

```bash
# 启动本地 Jaeger all-in-one
docker run -d --name jaeger \
  -p 16686:16686 \
  -p 4317:4317 \
  -p 4318:4318 \
  jaegertracing/all-in-one:latest

# 配置 gRPC 导出
export TW_OTEL_EXPORTER=otlp-grpc
export TW_OTEL_ENDPOINT=http://localhost:4317

tw daemon start
tw register usecase uc-verify --attr title="Jaeger验证"
tw update uc-verify --state in_progress
tw update uc-verify --state review
tw update uc-verify --state completed
tw daemon stop
```

访问 http://localhost:16686 → Service: `traceweaver-daemon` → 确认 trace 可见。

#### 集群 Jaeger（生产环境）

```bash
export TW_OTEL_EXPORTER=otlp-grpc
export TW_OTEL_ENDPOINT=http://jaeger-cses-pre-collector.jaeger-cses.svc.cluster.local:4317
tw daemon start
# ... 执行流转 ...
```

---

### E. Span 数据质量检查

在 Jaeger UI 中选择一条 trace，验证：

| 字段 | 期望值 |
|------|--------|
| `service.name` | `traceweaver-daemon` |
| `tw.entity.id` | 实体 id（如 `uc-verify`）|
| `tw.entity.type` | `usecase` / `task` / `plan` |
| `tw.project.id` | `default` |
| Span events | 每次状态变更对应一个 event（`state_changed_to_in_progress` 等）|
| Span duration | 从创建到 completed/rejected 的实际时间 |

---

### F. Example 11 更新

在 `examples/src/11-full-chain-autonomous-loop.ts` 中新增：
- Phase K：FeedbackLog 统计展示
- Phase L：HarnessValidator 对齐报告

```bash
npm run run:11 --workspace=examples
# 全部 ✅ 通过
```
