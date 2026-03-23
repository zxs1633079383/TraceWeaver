// packages/tw-daemon/src/index.ts
import { join } from 'node:path'
import { writeFile, rm } from 'node:fs/promises'
import { IpcServer } from './ipc-server.js'
import { CommandHandler } from './core/command-handler.js'
import { EventBus } from './core/event-bus/event-bus.js'
import { SpanManager } from './otel/span-manager.js'

const STORE_DIR   = process.env.TW_STORE ?? join(process.cwd(), '.traceweaver')
const SOCKET_PATH = process.env.TW_SOCKET ?? join(STORE_DIR, 'tw.sock')
const PID_FILE    = join(STORE_DIR, 'daemon.pid')
const IDLE_MS     = 30 * 60 * 1000

let lastActivity = Date.now()

async function main() {
  const eventBus = new EventBus()
  const spanManager = new SpanManager({ projectId: 'default' })
  eventBus.start()

  const handler = new CommandHandler({ storeDir: STORE_DIR, eventBus, spanManager })
  await handler.init()

  const server = new IpcServer(SOCKET_PATH, handler, () => { lastActivity = Date.now() })
  await server.start()

  await writeFile(PID_FILE, String(process.pid), 'utf8')

  console.log(`tw-daemon started. socket=${SOCKET_PATH} pid=${process.pid}`)

  // Idle watchdog: shut down after 30 minutes of inactivity
  const watchdog = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_MS) {
      console.log('tw-daemon idle timeout — shutting down')
      cleanup(server, eventBus).catch(console.error)
    }
  }, 60_000)
  watchdog.unref()

  process.on('SIGTERM', () => cleanup(server, eventBus).catch(console.error))
  process.on('SIGINT',  () => cleanup(server, eventBus).catch(console.error))

  async function cleanup(s: IpcServer, eb: EventBus) {
    clearInterval(watchdog)
    eb.stop()
    await s.stop()
    try { await rm(PID_FILE) } catch {}
    process.exit(0)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
