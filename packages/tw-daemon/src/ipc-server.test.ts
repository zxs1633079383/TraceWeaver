// packages/tw-daemon/src/ipc-server.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { createConnection } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IpcServer } from './ipc-server.js'
import { CommandHandler } from './core/command-handler.js'

let tmpDir: string
let server: IpcServer

async function startServer() {
  tmpDir = await mkdtemp(join(tmpdir(), 'tw-ipc-test-'))
  const handler = new CommandHandler(tmpDir)
  await handler.init()
  const socketPath = join(tmpDir, 'tw.sock')
  server = new IpcServer(socketPath, handler)
  await server.start()
  return { socketPath, handler }
}

async function sendRequest(socketPath: string, req: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath)
    let buf = ''
    client.on('data', (d) => {
      buf += d.toString()
      if (buf.includes('\n')) {
        resolve(JSON.parse(buf.trim()))
        client.destroy()
      }
    })
    client.on('error', reject)
    client.on('connect', () => {
      client.write(JSON.stringify(req) + '\n')
    })
  })
}

afterEach(async () => {
  await server?.stop()
  if (tmpDir) await rm(tmpDir, { recursive: true })
})

describe('IpcServer', () => {
  it('responds to register command', async () => {
    const { socketPath } = await startServer()
    const res = await sendRequest(socketPath, {
      request_id: 'r1',
      method: 'register',
      params: { entity_type: 'usecase', id: 'UC-001' },
    })
    expect(res.ok).toBe(true)
    expect(res.data.id).toBe('UC-001')
  })

  it('responds with error on invalid transition', async () => {
    const { socketPath } = await startServer()
    await sendRequest(socketPath, {
      request_id: 'r1', method: 'register', params: { entity_type: 'usecase', id: 'UC-001' },
    })
    const res = await sendRequest(socketPath, {
      request_id: 'r2', method: 'update_state', params: { id: 'UC-001', state: 'completed' },
    })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('INVALID_TRANSITION')
  })

  it('responds to unknown method with error', async () => {
    const { socketPath } = await startServer()
    const res = await sendRequest(socketPath, {
      request_id: 'r1', method: 'unknown_method', params: {},
    })
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('UNKNOWN_METHOD')
  })
})
