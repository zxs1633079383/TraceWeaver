import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { InboxItem, TwEventType } from '@traceweaver/types'

export interface WriteInput {
  event_type: TwEventType
  entity_id?: string
  message: string
}

export class InboxAdapter {
  constructor(private readonly dir: string) {}

  async write(input: WriteInput): Promise<InboxItem> {
    await mkdir(this.dir, { recursive: true })
    const item: InboxItem = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      event_type: input.event_type,
      entity_id: input.entity_id,
      message: input.message,
      acked: false,
    }
    await writeFile(path.join(this.dir, `${item.id}.json`), JSON.stringify(item), 'utf8')
    return item
  }

  async list(opts: { unackedOnly?: boolean } = {}): Promise<InboxItem[]> {
    try {
      const files = await readdir(this.dir)
      const items: InboxItem[] = []
      for (const file of files.filter(f => f.endsWith('.json'))) {
        try {
          const raw = await readFile(path.join(this.dir, file), 'utf8')
          const item = JSON.parse(raw) as InboxItem
          if (!opts.unackedOnly || !item.acked) items.push(item)
        } catch { /* skip malformed */ }
      }
      return items.sort((a, b) => a.ts.localeCompare(b.ts))
    } catch {
      return []
    }
  }

  async ack(id: string): Promise<void> {
    const file = path.join(this.dir, `${id}.json`)
    const raw = await readFile(file, 'utf8')
    const item = JSON.parse(raw) as InboxItem
    item.acked = true
    await writeFile(file, JSON.stringify(item), 'utf8')
  }
}
