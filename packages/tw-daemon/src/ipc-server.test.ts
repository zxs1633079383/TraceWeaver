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

  it('emit_event adds span event and returns ok', async () => {
    const { socketPath } = await startServer()
    await sendRequest(socketPath, {
      request_id: 'ee-reg',
      method: 'register',
      params: { id: 'task-e1', entity_type: 'task' },
    })
    const res = await sendRequest(socketPath, {
      request_id: 'ee1',
      method: 'emit_event',
      params: { entity_id: 'task-e1', event: 'custom.hook', attributes: { source: 'test' } },
    })
    expect(res.ok).toBe(true)
  })

  it('cascade_update calls handler.cascadeUpdate and returns updated_count', async () => {
    const { socketPath } = await startServer()
    await sendRequest(socketPath, {
      request_id: 'cu-reg1',
      method: 'register',
      params: { id: 'uc-1', entity_type: 'usecase' },
    })
    await sendRequest(socketPath, {
      request_id: 'cu-reg2',
      method: 'register',
      params: { id: 'plan-1', entity_type: 'plan', depends_on: ['uc-1'] },
    })
    const res = await sendRequest(socketPath, {
      request_id: 'cu1',
      method: 'cascade_update',
      params: { id: 'uc-1', attributes: { description: 'v2' }, cascade: true },
    })
    expect(res.ok).toBe(true)
    expect((res as any).data.updated_count).toBeGreaterThanOrEqual(1)
  })

  it('cascade_update with unknown id returns error', async () => {
    const { socketPath } = await startServer()
    const res = await sendRequest(socketPath, {
      request_id: 'cu-bad',
      method: 'cascade_update',
      params: { id: 'nope', attributes: {}, cascade: true },
    })
    expect(res.ok).toBe(false)
  })
})
