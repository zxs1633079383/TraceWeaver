import chokidar, { type FSWatcher } from 'chokidar'
import { randomUUID } from 'node:crypto'
import type { EventBus } from '../core/event-bus/event-bus.js'

export class FsWatcher {
  private watcher: FSWatcher | null = null

  constructor(
    private readonly watchDir: string,
    private readonly bus: EventBus
  ) {}

  async start(): Promise<void> {
    this.watcher = chokidar.watch(this.watchDir, {
      ignoreInitial: true,
      persistent: false,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    })

    this.watcher.on('change', (filePath) => this.emit(filePath, 'changed'))
    this.watcher.on('add', (filePath) => this.emit(filePath, 'added'))
    this.watcher.on('unlink', (filePath) => this.emit(filePath, 'removed'))

    await new Promise<void>((resolve) => this.watcher!.on('ready', resolve))
  }

  async stop(): Promise<void> {
    await this.watcher?.close()
    this.watcher = null
  }

  private emit(filePath: string, action: string): void {
    this.bus.publish({
      id: randomUUID(),
      type: 'file.changed',
      ts: new Date().toISOString(),
      attributes: { path: filePath, action },
    })
  }
}
