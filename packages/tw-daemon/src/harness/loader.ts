// packages/tw-daemon/src/harness/loader.ts
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import yaml from 'js-yaml'
import type { EntityType, EntityState } from '@traceweaver/types'

export interface HarnessEntry {
  id: string
  path: string
  applies_to: EntityType[]
  trigger_on: EntityState[]
  content: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/

export class HarnessLoader {
  private readonly entries = new Map<string, HarnessEntry>()

  constructor(private readonly harnessDir: string) {}

  async scan(): Promise<HarnessEntry[]> {
    this.entries.clear()
    if (!existsSync(this.harnessDir)) return []
    let files: string[]
    try {
      files = await readdir(this.harnessDir)
    } catch {
      return []
    }
    for (const file of files.filter(f => f.endsWith('.md'))) {
      try {
        const raw = await readFile(join(this.harnessDir, file), 'utf8')
        const entry = this.parse(join(this.harnessDir, file), raw)
        if (entry) this.entries.set(entry.id, entry)
      } catch { /* skip unreadable file */ }
    }
    return [...this.entries.values()]
  }

  get(id: string): HarnessEntry | undefined {
    return this.entries.get(id)
  }

  list(): HarnessEntry[] {
    return [...this.entries.values()]
  }

  private parse(path: string, raw: string): HarnessEntry | null {
    const match = FRONTMATTER_RE.exec(raw)
    if (!match) return null
    let fm: Record<string, unknown>
    try {
      fm = yaml.load(match[1]) as Record<string, unknown>
    } catch {
      return null
    }
    if (!fm?.id || typeof fm.id !== 'string') return null
    const applies_to = Array.isArray(fm.applies_to)
      ? (fm.applies_to as string[]).filter(Boolean) as EntityType[]
      : []
    const trigger_on = Array.isArray(fm.trigger_on)
      ? (fm.trigger_on as string[]).filter(Boolean) as EntityState[]
      : []
    return { id: fm.id, path, applies_to, trigger_on, content: match[2].trim() }
  }
}
