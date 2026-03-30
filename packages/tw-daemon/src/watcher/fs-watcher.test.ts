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
    // Use polling in tests — macOS FSEvents doesn't work in /var/folders tmp dirs
    process.env.TW_FS_POLL = '1'
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

    // Write file and poll for event arrival (chokidar awaitWriteFinish adds latency)
    await writeFile(path.join(tmpDir, 'usecase.yaml'), 'id: UC-1', 'utf8')
    const deadline = Date.now() + 4000
    while (Date.now() < deadline) {
      if (events.some(e => (e.attributes as any)?.path?.includes('usecase.yaml'))) break
      await new Promise(r => setTimeout(r, 100))
    }
    expect(events.some(e => (e.attributes as any)?.path?.includes('usecase.yaml'))).toBe(true)
  }, 8000)

  it('start/stop lifecycle completes without error', async () => {
    await watcher.start()
    await watcher.stop()
    // No throw = pass
  })

  it('stop before start does not throw', async () => {
    await expect(watcher.stop()).resolves.toBeUndefined()
  })
})
