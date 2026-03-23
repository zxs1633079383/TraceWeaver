// packages/tw-daemon/src/http/routes.ts
import type { FastifyInstance } from 'fastify'
import type { CommandHandler } from '../core/command-handler.js'

export function registerRoutes(app: FastifyInstance, handler: CommandHandler) {
  app.post('/api/v1/entities', async (req, reply) => {
    try {
      const entity = await handler.register(req.body as any)
      reply.status(201).send({ ok: true, data: entity })
    } catch (err: any) {
      reply.status(400).send({ ok: false, error: { code: err.code ?? 'BAD_REQUEST', message: err.message } })
    }
  })

  app.patch('/api/v1/entities/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as any
    try {
      if (body.state !== undefined) {
        const entity = await handler.updateState({ id, state: body.state, reason: body.reason })
        // Expose current_state alias for consumers that prefer it
        reply.status(200).send({ ok: true, data: { ...entity, current_state: entity.state } })
      } else if (body.attributes !== undefined) {
        const entity = await handler.updateAttributes({ id, attributes: body.attributes })
        reply.status(200).send({ ok: true, data: { ...entity, current_state: entity.state } })
      } else {
        reply.status(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: 'Provide state or attributes' } })
      }
    } catch (err: any) {
      reply.status(400).send({ ok: false, error: { code: err.code ?? 'BAD_REQUEST', message: err.message } })
    }
  })

  app.get('/api/v1/entities/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const result = await handler.get({ id })
    reply.status(result.ok ? 200 : 404).send(result)
  })

  app.delete('/api/v1/entities/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      await handler.remove(id)
      reply.send({ ok: true, data: { id } })
    } catch (err: any) {
      reply.status(404).send({ ok: false, error: { code: err.code ?? 'NOT_FOUND', message: err.message } })
    }
  })

  app.get('/api/v1/entities/:id/dag', async (_req, reply) => {
    const dag = handler.getDagSnapshot()
    reply.send({ ok: true, data: dag })
  })

  app.post('/api/v1/entities/:id/artifacts', async (req, reply) => {
    const { id } = req.params as { id: string }
    const result = await handler.linkArtifact({ entity_id: id, artifact: req.body as any })
    reply.status(result.ok ? 200 : 400).send(result)
  })

  app.get('/api/v1/status', async (_req, reply) => {
    try {
      const data = await handler.getStatus({})
      reply.send({ ok: true, data })
    } catch (err: any) {
      reply.status(500).send({ ok: false, error: { code: err.code ?? 'INTERNAL_ERROR', message: err.message } })
    }
  })

  app.post('/api/v1/events', async (req, reply) => {
    const result = await handler.emitEvent(req.body as any)
    reply.status(result.ok ? 201 : 400).send(result)
  })

  app.get('/api/v1/events', async (req, reply) => {
    const query = req.query as any
    const result = await handler.queryEvents(query)
    reply.send(result)
  })
}
