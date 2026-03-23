import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { FsWatcher } from './fs-watcher.js'
import { EventBus } from '../core/event-bus/event-bus.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TwEvent } from '@traceweaver/types'

describe('FsWatcher', () => {
  let tmpDir: string
  let bus: EventBus
  let watcher: FsWatcher

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'tw-watch-'))
    bus = new EventBus({ batchWindowMs: 10 })
    bus.start()
    watcher = new FsWatcher(tmpDir, bus)
  })

  afterEach(async () => {
    await watcher.stop()
    bus.stop()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('emits file.changed event when file is created', async () => {
    const events: TwEvent[] = []
    bus.subscribe(ev => { if (ev.type === 'file.changed') events.push(ev) })
    await watcher.start()

    await writeFile(path.join(tmpDir, 'usecase.yaml'), 'id: UC-1', 'utf8')
    await new Promise(r => setTimeout(r, 500))
    expect(events.some(e => (e.attributes as any)?.path?.includes('usecase.yaml'))).toBe(true)
  }, 5000)

  it('start/stop lifecycle completes without error', async () => {
    await watcher.start()
    await watcher.stop()
    // No throw = pass
  })

  it('stop before start does not throw', async () => {
    await expect(watcher.stop()).resolves.toBeUndefined()
  })
})
