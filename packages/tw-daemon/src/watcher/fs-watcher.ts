import chokidar, { type FSWatcher } from 'chokidar'
import { randomUUID } from 'node:crypto'
import type { EventBus } from '../core/event-bus/event-bus.js'

export interface FsWatcherOptions {
  /** Additional glob/regex patterns to ignore (appended to built-in daemon exclusions). */
  extraIgnored?: Array<string | RegExp>
}

// Always exclude daemon-internal file types regardless of watch dirs
const DAEMON_INTERNAL: RegExp[] = [
  /\.sock$/,
  /\.pid$/,
  /\.wal$/,
  /\.ndjson$/,
  /\.json$/,
]

export class FsWatcher {
  private watcher: FSWatcher | null = null

  constructor(
    /** One or more directories to watch. Pass project dirs, NOT the store dir. */
    private readonly watchDirs: string | string[],
    private readonly bus: EventBus,
    private readonly opts: FsWatcherOptions = {},
  ) {}

  async start(): Promise<void> {
    const ignored: Array<string | RegExp> = [
      ...DAEMON_INTERNAL,
      ...(this.opts.extraIgnored ?? []),
    ]

    this.watcher = chokidar.watch(this.watchDirs, {
      ignoreInitial: true,
      persistent: false,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
      ignored,
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
