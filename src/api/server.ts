import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import sensible from '@fastify/sensible'
import multipart from '@fastify/multipart'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'

import { config } from '../config.js'
import { logger } from '../logger.js'
import { registerBearerAuth } from './auth.js'
import { registerHealthRoutes } from './routes/health.js'
import { registerChatRoutes } from './routes/chats.js'
import { registerMessageRoutes } from './routes/messages.js'
import { registerSendRoute } from './routes/send.js'
import { registerActionRoutes } from './routes/actions.js'
import { registerPresenceRoutes } from './routes/presence.js'
import { registerWebhookRoutes } from './routes/webhooks.js'
import type { ApiDeps, TypedFastify } from './types.js'

/**
 * Build (but do not start) the Fastify server. Pass it to `app.listen()`
 * once the host bot is ready to expose endpoints.
 *
 *   const app = await buildServer({ getSock, store, storage })
 *   await app.listen({ host: '127.0.0.1', port: 8787 })
 */
export const buildServer = async (deps: ApiDeps): Promise<FastifyInstance> => {
	const authToken = config.api.authToken
	if (!authToken) {
		// Defensive: config.ts already throws when enabled=true && no token, but
		// the buildServer() callsite is the last line of defense if someone
		// constructs the server outside the normal config path.
		throw new Error('buildServer: config.api.authToken is required')
	}

	const app = Fastify({
		loggerInstance: logger.child({ module: 'api' }),
		bodyLimit: config.api.maxBodyBytes,
		disableRequestLogging: false,
		trustProxy: true
	}).withTypeProvider<TypeBoxTypeProvider>() as unknown as TypedFastify

	await app.register(sensible)
	await app.register(multipart, {
		limits: {
			fileSize: config.api.maxBodyBytes,
			// One file per request is enough for current send semantics.
			files: 1
		}
	})

	registerBearerAuth(app, authToken)

	// Mount domain routes. Each route module is self-contained and only
	// touches its own URL prefix; the order here is purely cosmetic.
	await registerHealthRoutes(app, deps)
	await registerChatRoutes(app, deps)
	await registerMessageRoutes(app, deps)
	await registerSendRoute(app, deps)
	await registerActionRoutes(app, deps)
	await registerPresenceRoutes(app, deps)
	await registerWebhookRoutes(app, deps)

	// Catchall error handler. Fastify defaults are fine, but we want every
	// error to flow through pino with structured context for observability.
	app.setErrorHandler((err: FastifyError, req, reply) => {
		if (err.validation) {
			req.log.warn({ err, url: req.url, validation: err.validation }, 'request validation failed')
			reply.code(400).send({
				error: 'bad_request',
				message: err.message,
				details: err.validation
			})
			return
		}
		const status = err.statusCode ?? 500
		if (status >= 500) {
			req.log.error({ err, url: req.url }, 'unhandled api error')
		} else {
			req.log.warn({ err, url: req.url, status }, 'api error')
		}
		reply.code(status).send({
			error: status === 500 ? 'internal_error' : 'error',
			message: err.message || 'unknown error'
		})
	})

	return app
}
