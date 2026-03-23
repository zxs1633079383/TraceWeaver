// packages/tw-cli/src/ipc-client.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IpcClient } from './ipc-client.js'

let tmpDir: string
let server: Server

async function startEchoServer(socketPath: string, response: object) {
  await new Promise<void>(resolve => {
    server = createServer(socket => {
      socket.on('data', () => {
        socket.write(JSON.stringify(response) + '\n')
      })
    })
    server.listen(socketPath, resolve)
  })
}

afterEach(async () => {
  server?.close()
  if (tmpDir) await rm(tmpDir, { recursive: true })
})

describe('IpcClient', () => {
  it('sends request and receives response', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tw-client-test-'))
    const socketPath = join(tmpDir, 'tw.sock')
    const expected = { request_id: 'r1', ok: true, data: { id: 'UC-001' } }
    await startEchoServer(socketPath, expected)

    const client = new IpcClient(socketPath)
    const res = await client.send({ method: 'register', params: { entity_type: 'usecase', id: 'UC-001' } })
    expect(res.ok).toBe(true)
  })

  it('times out when server does not respond', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tw-client-test-'))
    const socketPath = join(tmpDir, 'tw.sock')
    // server that never responds
    await new Promise<void>(resolve => {
      server = createServer(() => {})
      server.listen(socketPath, resolve)
    })
    const client = new IpcClient(socketPath, 100)
    await expect(client.send({ method: 'test', params: {} })).rejects.toThrow('timeout')
  })
})
