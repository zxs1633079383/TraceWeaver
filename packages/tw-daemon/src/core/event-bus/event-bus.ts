import { RingBuffer } from './ring-buffer.js'
import type { TwEvent, EventRecord } from '@traceweaver/types'

export interface EventBusOptions {
  bufferSize?: number      // default 1024
  batchWindowMs?: number   // default 50
}

type Subscriber = (event: TwEvent) => void
type BatchSubscriber = (events: TwEvent[]) => void

export class EventBus {
  private readonly buffer: RingBuffer<TwEvent>
  private readonly batchWindowMs: number
  private readonly subscribers: Set<Subscriber> = new Set()
  private readonly batchSubscribers: Set<BatchSubscriber> = new Set()
  private readonly history: EventRecord[] = []
  private seq = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false

  constructor(options: EventBusOptions = {}) {
    this.buffer = new RingBuffer(options.bufferSize ?? 1024)
    this.batchWindowMs = options.batchWindowMs ?? 50
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.scheduleDrain()
  }

  stop(): void {
    this.running = false
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }

  publish(event: TwEvent): void {
    if (!this.running) return
    this.buffer.push(event)
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  subscribeBatch(fn: BatchSubscriber): () => void {
    this.batchSubscribers.add(fn)
    return () => this.batchSubscribers.delete(fn)
  }

  getHistory(since?: string): EventRecord[] {
    if (!since) return [...this.history]
    return this.history.filter(e => e.ts >= since)
  }

  private scheduleDrain(): void {
    if (!this.running) return
    this.timer = setTimeout(() => {
      this.drain()
      this.scheduleDrain()
    }, this.batchWindowMs)
    if (typeof (this.timer as any).unref === 'function') (this.timer as any).unref()
  }

  private drain(): void {
    const batch = this.buffer.drainAll()
    if (batch.length === 0) return

    for (const event of batch) {
      this.seq++
      const record: EventRecord = { ...event, seq: this.seq }
      this.history.push(record)
      for (const fn of this.subscribers) fn(event)
    }
    for (const fn of this.batchSubscribers) fn(batch)
  }
}
