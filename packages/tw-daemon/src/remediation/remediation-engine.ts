import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { EventBus } from '../core/event-bus/event-bus.js'
import type { CommandHandler } from '../core/command-handler.js'
import type { FeedbackLog } from '../feedback/feedback-log.js'

export interface RemediationEngineOptions {
  eventBus: EventBus
  handler: CommandHandler
  feedbackLog: FeedbackLog
  queueDir: string
  maxAttempts?: number
  /** Only trigger from specific previous states. Empty = all rejected events trigger. */
  triggerFromStates?: string[]
}

export interface RemediationQueueItem {
  id: string
  entity_id: string
  entity_type: string
  attempt: number
  rejection_reason: string
  harness_id: string
  artifact_refs: Array<{ type: string; path: string }>
  ts: string
}

export class RemediationEngine {
  private unsub: (() => void) | null = null
  private readonly dedupSeen = new Set<string>()
  private readonly maxAttempts: number

  constructor(private readonly opts: RemediationEngineOptions) {
    this.maxAttempts = opts.maxAttempts ?? 3
  }

  start(): void {
    if (this.unsub) return
    this.unsub = this.opts.eventBus.subscribeBatch(
      batch => void this.handleBatch(batch).catch(() => { /* errors logged externally */ })
    )
  }

  stop(): void {
    this.unsub?.()
    this.unsub = null
  }

  private async handleBatch(events: unknown[]): Promise<void> {
    const rejections = (events as Array<Record<string, unknown>>).filter(e =>
      e['type'] === 'entity.state_changed' &&
      e['state'] === 'rejected' &&
      typeof e['entity_id'] === 'string'
    )
    for (const event of rejections) {
      const entityId = event['entity_id'] as string
      const ts = (event['ts'] as string | undefined) ?? ''
      const dedupKey = `${entityId}|${ts}`
      if (this.dedupSeen.has(dedupKey)) continue
      this.dedupSeen.add(dedupKey)
      await this.handleRejection(event).catch(() => { /* per-item errors must not abort batch */ })
    }
  }

  private async handleRejection(event: Record<string, unknown>): Promise<void> {
    const entityId = event['entity_id'] as string

    if (this.opts.triggerFromStates?.length && event['previous_state']) {
      if (!this.opts.triggerFromStates.includes(event['previous_state'] as string)) return
    }

    const entityResult = await this.opts.handler.get({ id: entityId }) as {
      ok: boolean
      data?: Record<string, unknown>
    }
    if (!entityResult.ok) return

    const attempt = await this.countAttempts(entityId) + 1
    if (attempt > this.maxAttempts) return

    const feedbackEntries = this.opts.feedbackLog.query({ entity_id: entityId, result: 'fail', limit: 1 })
    const lastFeedback = feedbackEntries[0]

    const entity = entityResult.data ?? {}
    const item: RemediationQueueItem = {
      id: `rem-${randomUUID().slice(0, 8)}`,
      entity_id: entityId,
      entity_type: (entity['entity_type'] as string | undefined) ?? 'task',
      attempt,
      rejection_reason: lastFeedback?.reason ?? 'unknown',
      harness_id: lastFeedback?.harness_id ?? 'unknown',
      artifact_refs: (entity['artifact_refs'] as Array<{ type: string; path: string }> | undefined) ?? [],
      ts: new Date().toISOString(),
    }

    await this.enqueue(item)
  }

  private async countAttempts(entityId: string): Promise<number> {
    const dirs = ['done', 'in-progress']
    let count = 0
    for (const dir of dirs) {
      try {
        const files = await readdir(join(this.opts.queueDir, dir))
        count += files.filter(f => f.includes(entityId)).length
      } catch { /* ENOENT: dir may not exist yet */ }
    }
    return count
  }

  private async enqueue(item: RemediationQueueItem): Promise<void> {
    const pendingDir = join(this.opts.queueDir, 'pending')
    await mkdir(pendingDir, { recursive: true })
    const filename = `${item.id}-${item.entity_id}.json`
    await writeFile(join(pendingDir, filename), JSON.stringify(item, null, 2), 'utf8')
  }
}
