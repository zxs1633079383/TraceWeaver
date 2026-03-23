// packages/tw-daemon/src/core/fs-store/wal.ts
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { WalEntry } from '@traceweaver/types'

type AppendInput = Pick<WalEntry, 'op' | 'idempotency_key' | 'payload'>

export class Wal {
  private seq = 0
  private opened = false

  constructor(private readonly path: string) {}

  /**
   * MUST be called before any append(). Syncs the in-memory seq counter
   * with the highest seq found in the WAL file, preventing seq collisions
   * after a process restart.
   */
  async open(): Promise<void> {
    if (this.opened) return
    if (existsSync(this.path)) {
      const raw = await readFile(this.path, 'utf8')
      for (const line of raw.trim().split('\n').filter(Boolean)) {
        try {
          const entry = JSON.parse(line) as WalEntry
          if (entry.seq > this.seq) this.seq = entry.seq
        } catch {
          // skip malformed line (e.g., incomplete write at crash)
        }
      }
    }
    this.opened = true
  }

  async append(input: AppendInput): Promise<WalEntry> {
    if (!this.opened) await this.open()
    this.seq++
    const entry: WalEntry = {
      seq: this.seq,
      op: input.op,
      idempotency_key: input.idempotency_key,
      payload: input.payload,
      ts: new Date().toISOString(),
    }
    await appendFile(this.path, JSON.stringify(entry) + '\n', 'utf8')
    return entry
  }

  async replay(): Promise<WalEntry[]> {
    if (!existsSync(this.path)) return []
    const raw = await readFile(this.path, 'utf8')
    const lines = raw.trim().split('\n').filter(Boolean)
    const seen = new Set<string>()
    const entries: WalEntry[] = []
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as WalEntry
        if (!seen.has(entry.idempotency_key)) {
          seen.add(entry.idempotency_key)
          entries.push(entry)
        }
      } catch {
        // skip malformed line
      }
    }
    return entries
  }

  async truncate(upToSeq: number): Promise<void> {
    const entries = await this.replay()
    const remaining = entries.filter(e => e.seq > upToSeq)
    await writeFile(
      this.path,
      remaining.map(e => JSON.stringify(e)).join('\n') + (remaining.length ? '\n' : ''),
      'utf8',
    )
    // Re-sync seq after truncation
    this.seq = remaining.length > 0 ? remaining[remaining.length - 1].seq : 0
  }
}
