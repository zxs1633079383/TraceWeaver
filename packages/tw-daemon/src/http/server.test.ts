// packages/tw-daemon/src/http/server.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildHttpServer } from './server.js'
import { CommandHandler } from '../core/command-handler.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

async function makeTestServer() {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'tw-http-'))
  const handler = new CommandHandler({ storeDir: tmpDir })
  await handler.init()
  const app = buildHttpServer(handler, { inboundToken: 'test-token' })
  await app.ready()
  return { app, tmpDir }
}

describe('HTTP API', () => {
  let app: Awaited<ReturnType<typeof makeTestServer>>['app']
  let tmpDir: string

  beforeEach(async () => {
    const s = await makeTestServer()
    app = s.app
    tmpDir = s.tmpDir
  })

  afterEach(async () => {
    await app.close()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('POST /api/v1/entities registers entity', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/entities',
      payload: { entity_type: 'usecase', id: 'UC-001' }
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.id).toBe('UC-001')
  })

  it('PATCH /api/v1/entities/:id transitions state', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/entities', payload: { entity_type: 'usecase', id: 'UC-001' } })
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/entities/UC-001',
      payload: { state: 'in_progress' }
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.current_state).toBe('in_progress')
  })

  it('GET /api/v1/entities/:id returns entity', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/entities', payload: { entity_type: 'usecase', id: 'UC-001' } })
    const res = await app.inject({ method: 'GET', url: '/api/v1/entities/UC-001' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.data.id).toBe('UC-001')
  })

  it('DELETE /api/v1/entities/:id removes entity', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/entities', payload: { entity_type: 'usecase', id: 'UC-001' } })
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/entities/UC-001' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).ok).toBe(true)
  })

  it('GET /api/v1/status returns project status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/status' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).ok).toBe(true)
  })

  it('PATCH /api/v1/entities/:id updates attributes', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/entities', payload: { entity_type: 'task', id: 'T-ATTR' } })
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/entities/T-ATTR',
      payload: { attributes: { priority: 'high' } }
    })
    expect(res.statusCode).toBe(200)
  })

  it('POST /api/v1/webhooks/inbound requires Bearer token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/inbound',
      payload: { source: 'test', type: 'usecase.create', usecase: { id: 'UC-W1', mutation: 'new' } }
    })
    expect(res.statusCode).toBe(401)
  })

  it('POST /api/v1/webhooks/inbound with valid token registers entity', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/inbound',
      headers: { Authorization: 'Bearer test-token' },
      payload: { source: 'req-system', type: 'usecase.create', usecase: { id: 'UC-W1', mutation: 'new' } }
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
  })

  it('POST /api/v1/events emits event', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/entities', payload: { entity_type: 'task', id: 'T-EV' } })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      payload: { entity_id: 'T-EV', event: 'code_generated' }
    })
    expect(res.statusCode).toBe(201)
  })
})
