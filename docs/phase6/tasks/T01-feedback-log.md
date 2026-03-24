# T01 — FeedbackLog: 评估经验持久化

**状态：** pending
**依赖：** 无
**预计影响文件：** 2 个（新建）

---

## 目标

每次 harness 约束评估后，将结果（pass/fail/skipped、原因、耗时）写入 `feedback.ndjson`，供系统自身积累经验、检测趋势、触发改进建议。

## 接口规范

```typescript
// src/feedback/feedback-log.ts

export interface FeedbackRecordInput {
  harness_id: string
  entity_id: string
  entity_type: string
  trigger_state: string
  result: 'pass' | 'fail' | 'skipped'
  reason: string       // refs_checked[0].note 或空串
  duration_ms: number
}

export interface FeedbackEntry extends FeedbackRecordInput {
  id: string    // UUID
  ts: string    // ISO 8601
  seq: number   // 全局自增
}

export interface FeedbackQuery {
  harness_id?: string
  entity_id?: string
  result?: 'pass' | 'fail' | 'skipped'
  since?: string
  limit?: number
}

export interface HarnessFeedbackSummary {
  harness_id: string
  total: number
  pass: number
  fail: number
  skipped: number
  failure_rate: number
  consecutive_failures: number
  recent_reasons: string[]   // 最近 3 次失败原因
  trend: 'improving' | 'degrading' | 'stable' | 'unknown'
  last_evaluated: string
}

export class FeedbackLog {
  constructor(logPath: string)
  load(): void
  record(input: FeedbackRecordInput): FeedbackEntry
  getHistory(since?: string): FeedbackEntry[]
  query(params: FeedbackQuery): FeedbackEntry[]
  getSummary(harness_id: string): HarnessFeedbackSummary
  getAllSummaries(): HarnessFeedbackSummary[]
}
```

## 实现要点

1. NDJSON 格式（每行一个 JSON），与 EventLog 一致
2. `load()` 幂等（`private loaded = false` 守卫）
3. `ensureDir()` 只在首次 `record()` 时调用（`private dirReady = false`）
4. 趋势算法：将历史均分两半，比较前后失败率差 > 0.1 判定 degrading/improving
5. `consecutive_failures`：从尾部往前数，遇到非 fail 即停

## 测试清单（12 个）

- [ ] record + getHistory 返回正确条目，seq=1
- [ ] seq 多条自增
- [ ] query by harness_id
- [ ] query by result
- [ ] query by limit（取最后 N 条）
- [ ] 持久化：重建实例后 load() 历史一致
- [ ] getSummary：total/pass/fail/failure_rate
- [ ] getSummary：consecutive_failures 连续尾部计算
- [ ] getSummary：pass 打断连续，consecutive=0
- [ ] getSummary trend=degrading（前好后坏）
- [ ] getSummary trend=improving（前坏后好）
- [ ] getAllSummaries 按 harness_id 分组
