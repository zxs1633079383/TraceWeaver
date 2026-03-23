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

  // Conditional MCP startup (when spawned by MCP client with TW_MCP_STDIO=1)
  if (process.env.TW_MCP_STDIO) {
    const { McpServer } = await import('./mcp/server.js')
    const mcp = new McpServer(handler)
    await mcp.startStdio()
  }

  // Conditional HTTP startup
  if (process.env.TW_HTTP_PORT) {
    const port = parseInt(process.env.TW_HTTP_PORT, 10)
    const { buildHttpServer } = await import('./http/server.js')
    const httpServer = buildHttpServer(handler, {
      inboundToken: process.env.TW_INBOUND_TOKEN,
    })
    await httpServer.listen({ port, host: '127.0.0.1' })
    console.error(`[tw-daemon] HTTP API listening on port ${port}`)
  }

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
