import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ReportScheduler } from './report-scheduler.js'

describe('ReportScheduler', () => {
  let generateCalls: number
  let hasReportResult: boolean
  let scheduler: ReportScheduler

  beforeEach(() => {
    generateCalls = 0
    hasReportResult = false
    vi.useFakeTimers()
  })

  afterEach(() => {
    scheduler?.stop()
    vi.useRealTimers()
  })

  function makeScheduler(scheduleTime = '09:00') {
    scheduler = new ReportScheduler({
      scheduleTime,
      generate: async () => { generateCalls++ },
      hasReportTodayInEventLog: async () => hasReportResult,
      pollIntervalMs: 60_000,
    })
    return scheduler
  }

  /**
   * Build a Date whose local HH:MM matches the given time string,
   * so tests are timezone-independent when using local-time comparisons.
   * Uses a fixed millisecond base to avoid relying on `new Date()` under fake timers.
   */
  function localTime(hh: number, mm: number): Date {
    // Start from a known UTC epoch (midnight UTC 2026-03-25 = local time varies by TZ)
    // We use setHours on a real Date created from a string to set LOCAL hours
    const d = new Date(2026, 2, 25, hh, mm, 0, 0)
    return d
  }

  it('does not generate report before schedule time', async () => {
    // Start at 08:58; after one 60s tick it will be 08:59 — before 09:00
    vi.setSystemTime(localTime(8, 58))
    const s = makeScheduler('09:00')
    s.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(generateCalls).toBe(0)
  })

  it('generates report at schedule time when not already done', async () => {
    // Start at 08:59; after one 60s tick it will be 09:00 — matches schedule
    vi.setSystemTime(localTime(8, 59))
    hasReportResult = false
    const s = makeScheduler('09:00')
    s.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(generateCalls).toBe(1)
  })

  it('skips generation if report already exists in EventLog', async () => {
    // Start at 08:59; after one 60s tick it will be 09:00
    vi.setSystemTime(localTime(8, 59))
    hasReportResult = true
    const s = makeScheduler('09:00')
    s.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(generateCalls).toBe(0)
  })

  it('stop() prevents further generation', async () => {
    // Start at 08:59; stop() before tick fires — no generation expected
    vi.setSystemTime(localTime(8, 59))
    hasReportResult = false
    const s = makeScheduler('09:00')
    s.start()
    s.stop()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(generateCalls).toBe(0)
  })
})
