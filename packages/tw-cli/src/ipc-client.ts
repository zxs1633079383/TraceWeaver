// packages/tw-cli/src/ipc-client.ts
import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import type { TwRequest, TwResponse } from '@traceweaver/types'

type SendInput = Pick<TwRequest, 'method' | 'params'>

export class IpcClient {
  // NOTE: Phase 1 uses a simple request-per-connection model (one socket per send()).
  // This means request_id matching is not needed — each connection gets exactly one response.
  // Phase 3 will upgrade to a persistent multiplexed connection with request_id correlation
  // when concurrent MCP + HTTP callers share the same daemon connection.
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async send<T = unknown>(input: SendInput): Promise<TwResponse<T>> {
    const request_id = randomUUID()
    const req: TwRequest = { request_id, ...input }

    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath)
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('timeout'))
      }, this.timeoutMs)

      let buf = ''
      socket.on('data', (chunk) => {
        buf += chunk.toString()
        if (buf.includes('\n')) {
          clearTimeout(timer)
          try {
            resolve(JSON.parse(buf.trim()) as TwResponse<T>)
          } catch (e) {
            reject(e)
          } finally {
            socket.destroy()
          }
        }
      })
      socket.on('error', (e) => { clearTimeout(timer); socket.destroy(); reject(e) })
      socket.on('connect', () => socket.write(JSON.stringify(req) + '\n'))
    })
  }
}
