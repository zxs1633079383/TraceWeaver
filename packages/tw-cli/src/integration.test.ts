// packages/tw-cli/src/integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IpcServer } from '../../tw-daemon/src/ipc-server.js'
import { CommandHandler } from '../../tw-daemon/src/core/command-handler.js'
import { IpcClient } from './ipc-client.js'

let tmpDir: string
let server: IpcServer
let client: IpcClient

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'tw-e2e-test-'))
  const socketPath = join(tmpDir, 'tw.sock')
  const handler = new CommandHandler(tmpDir)
  await handler.init()
  server = new IpcServer(socketPath, handler)
  await server.start()
  client = new IpcClient(socketPath)
})

afterAll(async () => {
  await server.stop()
  await rm(tmpDir, { recursive: true })
})

describe('Full UseCase → Plan → Task lifecycle', () => {
  it('registers UseCase, Plan, Task', async () => {
    const uc = await client.send({ method: 'register', params: { entity_type: 'usecase', id: 'UC-E2E' } })
    expect((uc.data as any).state).toBe('pending')

    const plan = await client.send({
      method: 'register',
      params: { entity_type: 'plan', id: 'BE-PLAN-E2E', parent_id: 'UC-E2E', domain: 'backend' },
    })
    expect((plan.data as any).parent_id).toBe('UC-E2E')

    const task = await client.send({
      method: 'register',
      params: { entity_type: 'task', id: 'BE-TASK-001', parent_id: 'BE-PLAN-E2E' },
    })
    expect((task.data as any).state).toBe('pending')
  })

  it('progresses Task through lifecycle', async () => {
    let res = await client.send({ method: 'update_state', params: { id: 'BE-TASK-001', state: 'in_progress' } })
    expect((res.data as any).state).toBe('in_progress')

    res = await client.send({ method: 'update_state', params: { id: 'BE-TASK-001', state: 'review' } })
    expect((res.data as any).state).toBe('review')

    res = await client.send({ method: 'update_state', params: { id: 'BE-TASK-001', state: 'completed' } })
    expect((res.data as any).state).toBe('completed')
  })

  it('rejects illegal transition', async () => {
    const res = await client.send({ method: 'update_state', params: { id: 'UC-E2E', state: 'completed' } })
    expect(res.ok).toBe(false)
    expect((res as any).error.code).toBe('INVALID_TRANSITION')
  })

  it('simulates post-hoc rejection', async () => {
    const res = await client.send({
      method: 'update_state',
      params: { id: 'BE-TASK-001', state: 'rejected', reason: 'missing tests' },
    })
    expect((res.data as any).state).toBe('rejected')
  })

  it('queries project status', async () => {
    const res = await client.send({ method: 'get_status', params: {} })
    expect(res.ok).toBe(true)
    expect((res.data as any).total).toBeGreaterThan(0)
  })

  it('queries entity status with children', async () => {
    const res = await client.send({ method: 'get_status', params: { id: 'UC-E2E' } })
    expect(res.ok).toBe(true)
    expect((res.data as any).entity.id).toBe('UC-E2E')
    expect((res.data as any).children.length).toBeGreaterThan(0)
  })
})
