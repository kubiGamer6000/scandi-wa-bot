import { timingSafeEqual } from 'node:crypto'

import type { FastifyInstance, FastifyRequest } from 'fastify'

/**
 * Routes (path startsWith) that bypass the bearer-token check. Keep this
 * minimal — every endpoint that touches data must require auth.
 */
const UNAUTHENTICATED_PATHS = ['/v1/health'] as const

const isUnauthenticated = (url: string): boolean => {
	// Strip query string before prefix matching.
	const path = url.split('?')[0] ?? url
	return UNAUTHENTICATED_PATHS.some(p => path === p || path.startsWith(`${p}/`))
}

const constantTimeEqual = (a: string, b: string): boolean => {
	const ab = Buffer.from(a)
	const bb = Buffer.from(b)
	if (ab.length !== bb.length) return false
	return timingSafeEqual(ab, bb)
}

const extractBearer = (req: FastifyRequest): string | null => {
	const h = req.headers.authorization
	if (typeof h !== 'string') return null
	const m = /^Bearer\s+(.+)$/i.exec(h.trim())
	return m ? m[1]!.trim() : null
}

/**
 * Registers an `onRequest` hook that enforces `Authorization: Bearer <token>`
 * on every route except `/v1/health`. Reject with 401 (missing) or 403
 * (mismatch). Constant-time compare to avoid token leakage via timing.
 */
export const registerBearerAuth = (app: FastifyInstance, expectedToken: string): void => {
	app.addHook('onRequest', async (req, reply) => {
		if (isUnauthenticated(req.url)) return

		const token = extractBearer(req)
		if (!token) {
			reply.code(401).send({
				error: 'unauthorized',
				message: 'missing Authorization: Bearer <token> header'
			})
			return reply
		}
		if (!constantTimeEqual(token, expectedToken)) {
			reply.code(403).send({ error: 'forbidden', message: 'invalid token' })
			return reply
		}
	})
}
