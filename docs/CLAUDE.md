# docs CLAUDE.md

> 上级索引：[← 根 CLAUDE.md](../CLAUDE.md)

## 职责

`docs/` 存放面向用户和开发者的文档。文档是可执行的：
所有命令示例必须与实际 CLI 输出一致，代码示例必须可运行。

---

## 一、系统性约束

### 文档变更"完成"定义

| 变更类型 | 必须满足 |
|----------|---------|
| 新增 CLI 命令 | CLI-COMMANDS.md 同步更新 |
| 修改 CLI 输出格式 | QUICKSTART.md 中的示例同步更新 |
| 新增功能模块 | README.md 功能列表 + 架构图同步更新 |
| 新增 example | examples/CLAUDE.md 示例清单同步更新 |

### 文档文件职责分工

| 文件 | 职责 | 受众 |
|------|------|------|
| `README.md` | 项目主页：功能、架构、安装、快速开始 | 新用户、GitHub 浏览者 |
| `QUICKSTART.md` | 8 步上手教程，含所有核心命令 | 初次使用者 |
| `CLI-COMMANDS.md` | 全命令语法、选项、示例、状态机图 | 日常使用者、AI Agent |
| `REPORT.md` | 版本完成报告：设计决策、测试数据、后续规划 | 项目评审者 |

---

## 二、可观测性与验证

### 命令示例验证（文档变更后必跑）

```bash
tw daemon start

# 逐条验证 QUICKSTART.md / CLI-COMMANDS.md 中的命令示例
tw status --json
tw log query --since 1h
tw metrics --json
tw harness list --json

tw daemon stop
```

### 中文一致性

所有文档使用**简体中文**，技术术语保留英文原文：
- 正确：`EventLog（NDJSON 持久化日志）`
- 错误：`事件日志（...）`（丢失英文名）

---

## 三、持续熵管理

### 禁止事项

```
✗ 禁止文档中出现无法运行的命令示例
✗ 禁止过时的 API 路径（与 ipc-server.ts dispatch 不一致）
✗ 禁止架构图与 index.ts 实际初始化顺序不一致
✗ 禁止 REPORT.md 中的测试数量与实际 npm test 输出不一致
```

### 版本更新时的文档 checklist

- [ ] README.md 架构图与 `packages/tw-daemon/src/index.ts` 一致
- [ ] CLI-COMMANDS.md 的 IPC 方法列表与 `ipc-server.ts` dispatch 一致
- [ ] QUICKSTART.md 命令示例已在本地跑通
- [ ] REPORT.md 测试数量已更新为最新 `npm test` 结果
