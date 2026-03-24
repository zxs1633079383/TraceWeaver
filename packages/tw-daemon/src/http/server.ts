// packages/tw-daemon/src/http/server.ts
import Fastify from 'fastify'
import type { CommandHandler } from '../core/command-handler.js'
import { registerRoutes } from './routes.js'
import { registerWebhook } from './webhook.js'

export interface HttpServerOptions {
  inboundToken?: string
  port?: number
  host?: string
}

export function buildHttpServer(handler: CommandHandler, opts: HttpServerOptions = {}) {
  const app = Fastify({ logger: false })

  app.setErrorHandler((err: Error & { code?: string }, _req, reply) => {
    const code = err.code ?? 'INTERNAL_ERROR'
    reply.status(500).send({ ok: false, error: { code, message: err.message } })
  })

  registerRoutes(app, handler)
  registerWebhook(app, handler, opts.inboundToken)

  return app
}
