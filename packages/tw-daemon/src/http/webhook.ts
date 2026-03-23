// packages/tw-daemon/src/http/webhook.ts
import type { FastifyInstance } from 'fastify'
import type { CommandHandler } from '../core/command-handler.js'

export function registerWebhook(
  app: FastifyInstance,
  handler: CommandHandler,
  inboundToken?: string
) {
  app.post('/api/v1/webhooks/inbound', async (req, reply) => {
    if (inboundToken) {
      const auth = (req.headers.authorization ?? '')
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      if (token !== inboundToken) {
        return reply.status(401).send({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } })
      }
    }

    const body = req.body as any
    const results: unknown[] = []

    if (body.type === 'usecase.create' && body.usecase) {
      try {
        const entity = await handler.register({
          entity_type: 'usecase',
          id: body.usecase.id,
          attributes: { mutation: body.usecase.mutation, source: body.source },
          artifact_refs: body.usecase.artifact_refs,
        })
        results.push({ ok: true, data: entity })
      } catch (err: any) {
        results.push({ ok: false, error: { code: err.code ?? 'BAD_REQUEST', message: err.message } })
      }

      for (const plan of body.plans ?? []) {
        try {
          const entity = await handler.register({
            entity_type: 'plan',
            id: plan.id,
            parent_id: body.usecase.id,
            domain: plan.domain,
            depends_on: plan.depends_on,
            constraint_refs: plan.constraint_refs,
          })
          results.push({ ok: true, data: entity })
        } catch (err: any) {
          results.push({ ok: false, error: { code: err.code ?? 'BAD_REQUEST', message: err.message } })
        }
      }
    }

    if (body.type === 'task.rejected' && body.entity_id) {
      try {
        const entity = await handler.updateState({
          id: body.entity_id,
          state: 'rejected',
          reason: body.reason,
        })
        results.push({ ok: true, data: entity })
      } catch (err: any) {
        results.push({ ok: false, error: { code: err.code ?? 'BAD_REQUEST', message: err.message } })
      }
    }

    reply.send({ ok: true, data: results })
  })
}
