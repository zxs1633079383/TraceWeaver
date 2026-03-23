// packages/tw-cli/src/daemon-manager.ts
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { readFile, rm, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function getStorePath(): string {
  return process.env.TW_STORE ?? join(process.cwd(), '.traceweaver')
}

export function getSocketPath(): string {
  return process.env.TW_SOCKET ?? join(getStorePath(), 'tw.sock')
}

export function getPidPath(): string {
  return join(getStorePath(), 'daemon.pid')
}

export async function isDaemonRunning(): Promise<boolean> {
  try {
    const pid = parseInt(await readFile(getPidPath(), 'utf8'), 10)
    if (isNaN(pid)) return false
    process.kill(pid, 0)   // throws if process not running
    return true
  } catch {
    return false
  }
}

export async function ensureDaemonRunning(): Promise<void> {
  if (await isDaemonRunning()) return

  // Ensure store directory exists before spawning daemon
  await mkdir(getStorePath(), { recursive: true })

  // Resolve daemon bin: prefer compiled dist/index.js, fall back to tsx for dev
  const daemonPkg  = join(__dirname, '../../tw-daemon')
  const daemonDist = join(daemonPkg, 'dist/index.js')
  const daemonSrc  = join(daemonPkg, 'src/index.ts')
  const tsxBin     = join(__dirname, '../../../node_modules/.bin/tsx')

  let spawnArgs: string[]
  try {
    // Check if dist exists — use readFile as async alternative to existsSync
    await readFile(daemonDist)
    spawnArgs = [daemonDist]
  } catch {
    // Fall back to tsx for dev
    spawnArgs = [tsxBin, daemonSrc]
  }

  const child = spawn(process.execPath, spawnArgs, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, TW_STORE: getStorePath() },
  })
  child.unref()

  // Wait for socket to become connectable (up to 5s)
  const socketPath = getSocketPath()
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>(resolve => {
      const sock = createConnection(socketPath)
      sock.on('connect', () => { sock.destroy(); resolve(true) })
      sock.on('error', () => resolve(false))
    })
    if (connected) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('Daemon failed to start within 5s')
}

export async function stopDaemon(): Promise<void> {
  try {
    const pid = parseInt(await readFile(getPidPath(), 'utf8'), 10)
    if (isNaN(pid)) return
    try { process.kill(pid, 'SIGTERM') } catch {}
    try { await rm(getPidPath()) } catch {}
  } catch {
    // PID file missing — daemon not running
  }
}

/** Alias for ensureDaemonRunning — used by CLI commands. */
export const ensureDaemon = ensureDaemonRunning
