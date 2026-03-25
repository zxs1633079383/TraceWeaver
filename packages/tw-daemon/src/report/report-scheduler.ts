export interface ReportSchedulerOptions {
  scheduleTime: string                    // "HH:MM" format
  generate: () => Promise<void>
  hasReportTodayInEventLog: () => Promise<boolean>
  pollIntervalMs?: number                 // default 60_000 (1 minute)
}

export class ReportScheduler {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly opts: ReportSchedulerOptions) {}

  start(): void {
    const interval = this.opts.pollIntervalMs ?? 60_000
    this.timer = setInterval(() => { void this._tick() }, interval)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  private async _tick(): Promise<void> {
    const now = new Date()
    const hh = String(now.getHours()).padStart(2, '0')
    const mm = String(now.getMinutes()).padStart(2, '0')
    if (`${hh}:${mm}` !== this.opts.scheduleTime) return

    const alreadyDone = await this.opts.hasReportTodayInEventLog()
    if (alreadyDone) return

    await this.opts.generate()
  }
}
