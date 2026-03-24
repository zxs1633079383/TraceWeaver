# examples CLAUDE.md

> 上级索引：[← 根 CLAUDE.md](../CLAUDE.md)

## 职责

`examples/` 是**活的文档**：每个示例必须是可独立运行的完整演示，
覆盖特定功能点或边界条件。示例直接 import daemon src（不走 IPC），
便于在无 daemon 进程的环境下运行。

---

## 一、系统性约束

### 示例命名与分类

```
01-09  basic-*       基础功能演示（单一功能点）
10-19  full-flow-*   全流程演示（多模块协作）
20-29  edge-*        边界条件演示（错误路径、极端值）
```

### 每个示例必须满足

1. **独立可运行**：`npm run run:NN` 零依赖（不需要 daemon 已启动）
2. **有明确输出**：每个验证点打印 `✓` / `⚠` / `✗`，最终打印汇总表
3. **使用临时目录**：`mkdtemp()` 创建，结束时 `rm()` 清理
4. **不依赖网络**：LLM 调用必须使用 mock，不发真实 API 请求

### 新增示例 checklist

- [ ] 文件名符合命名规范
- [ ] `package.json` 中添加 `run:NN` 脚本
- [ ] `run:all` 脚本包含新示例
- [ ] 示例顶部注释说明覆盖的功能点和边界条件
- [ ] `npm run run:NN` 执行成功（exit 0）

---

## 二、可观测性与验证

### 基础验证

```bash
npm run run:11 --workspace=examples    # 全链路闭环 Demo 必须通过
npm run run:all --workspace=examples   # 所有示例必须通过
```

### 示例 11 是最终验收标准

`11-full-chain-autonomous-loop.ts` 覆盖所有功能模块和边界条件。
如果 Example 11 失败，定位是哪个 Phase：

```
Phase A  Harness 加载
Phase B  组件初始化
Phase C  实体注册 + DAG
Phase D  ImpactResolver
Phase E  边界：无效跳转
Phase F  状态流转 + TriggerExecutor
Phase G  EventLog 持久化
Phase H  SpanMetrics
Phase I  通知收件箱
Phase J  WAL 恢复
```

---

## 三、持续熵管理

### 禁止事项

```
✗ 禁止示例依赖真实网络（LLM、webhook 等）
✗ 禁止示例产生持久化副作用（必须使用临时目录）
✗ 禁止 console.error 后不 process.exit(1)（静默失败）
✗ 禁止注释掉的死代码提交
```

### 当前示例清单

| 编号 | 文件 | 覆盖功能 |
|------|------|---------|
| 01 | basic-entity-lifecycle | 注册、状态流转、getStatus |
| 02 | basic-events | EventBus、订阅、批处理 |
| 03 | basic-dag-dependencies | depends_on、DAG 快照 |
| 04 | full-flow-research-project | 多实体协作全流程 |
| 05 | full-flow-notify-engine | NotifyEngine + InboxAdapter |
| 06 | full-flow-constraint-validation | ConstraintEvaluator mock |
| 07 | edge-invalid-transitions | 非法状态跳转被阻断 |
| 08 | edge-propagation-bubble-up | 传递影响冒泡 |
| 09 | edge-ring-buffer-overflow | RingBuffer 溢出保护 |
| 10 | edge-wal-recovery | WAL 崩溃恢复 |
| 11 | full-chain-autonomous-loop | **全链路闭环（验收标准）** |
