import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { and, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { db, schema } from '../db/index.js'

/**
 * API authentication.
 *
 * Two kinds of credential:
 *
 *   - The master token (`API_AUTH_TOKEN`): full access to every route, for
 *     Jarvis and other services on this droplet. Accepted only from a direct
 *     loopback connection — requests that came through the public reverse
 *     proxy (Caddy adds X-Forwarded-For) are refused, so a leaked master token
 *     is useless from the internet. `API_MASTER_TOKEN_REMOTE=true` lifts this.
 *
 *   - Scoped keys (`wak_…`, table wa.api_keys): for external apps. A key may
 *     only call the routes its scopes grant (see SCOPE_ROUTES). Created and
 *     revoked with `npm run api-key`.
 */

/** Routes (path startsWith) that bypass auth. Keep this minimal. */
const UNAUTHENTICATED_PATHS = ['/v1/health'] as const

/** What each scope may call: [method, path pattern]. */
const SCOPE_ROUTES: Record<string, Array<[string, RegExp]>> = {
	// Send-only: notify someone, and look up the status of your own sends.
	notify: [
		['POST', /^\/v1\/notify\/?$/],
		['GET', /^\/v1\/notify\/[0-9]+\/?$/]
	]
}

export const KEY_PREFIX = 'wak_'

export interface ApiKeyContext {
	id: string
	label: string
	keyPrefix: string
	scopes: string[]
	ratePerMinute: number
	ratePerDay: number
}

declare module 'fastify' {
	interface FastifyRequest {
		/** Set when the request authenticated with a scoped key; null for the master token. */
		apiKey: ApiKeyContext | null
	}
}

const isUnauthenticated = (path: string): boolean =>
	UNAUTHENTICATED_PATHS.some(p => path === p || path.startsWith(`${p}/`))

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

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * True for a request made directly on this machine. Uses the raw socket
 * address (not `req.ip`, which trusts X-Forwarded-For) and requires that no
 * proxy header is present, because Caddy itself connects from loopback.
 */
const isDirectLoopback = (req: FastifyRequest): boolean =>
	LOOPBACK.has(req.raw.socket.remoteAddress ?? '') &&
	req.headers['x-forwarded-for'] === undefined &&
	req.headers['x-forwarded-host'] === undefined

export const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex')

/** A new scoped key: `wak_` + 43 chars of base64url (256 bits). */
export const generateKey = (): string => `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`

// Small cache so every request doesn't hit the DB. Revocations apply within TTL.
const KEY_CACHE_TTL_MS = 30_000
const keyCache = new Map<string, { value: ApiKeyContext | null; at: number }>()

const lookupKey = async (accountId: string, key: string): Promise<ApiKeyContext | null> => {
	const hash = hashKey(key)
	const cached = keyCache.get(hash)
	if (cached && Date.now() - cached.at < KEY_CACHE_TTL_MS) return cached.value

	const [row] = await db
		.select()
		.from(schema.apiKeys)
		.where(
			and(
				eq(schema.apiKeys.keyHash, hash),
				eq(schema.apiKeys.accountId, accountId),
				isNull(schema.apiKeys.revokedAt)
			)
		)
		.limit(1)

	const value: ApiKeyContext | null = row
		? {
				id: row.id,
				label: row.label,
				keyPrefix: row.keyPrefix,
				scopes: row.scopes,
				ratePerMinute: row.ratePerMinute,
				ratePerDay: row.ratePerDay
			}
		: null
	keyCache.set(hash, { value, at: Date.now() })
	if (row) {
		void db
			.update(schema.apiKeys)
			.set({ lastUsedAt: new Date() })
			.where(eq(schema.apiKeys.id, row.id))
			.catch(() => undefined)
	}
	return value
}

const scopeAllows = (scopes: string[], method: string, path: string): boolean =>
	scopes.some(scope =>
		(SCOPE_ROUTES[scope] ?? []).some(([m, pattern]) => m === method && pattern.test(path))
	)

/**
 * Registers an `onRequest` hook that authenticates every route except
 * `/v1/health`. 401 = missing credential, 403 = invalid / not allowed.
 */
export const registerAuth = (
	app: FastifyInstance,
	opts: { masterToken: string; accountId: string; allowRemoteMaster: boolean }
): void => {
	app.decorateRequest('apiKey', null)

	app.addHook('onRequest', async (req, reply) => {
		const path = req.url.split('?')[0] ?? req.url
		if (isUnauthenticated(path)) return

		const token = extractBearer(req)
		if (!token) {
			reply.code(401).send({
				error: 'unauthorized',
				message: 'missing Authorization: Bearer <token> header'
			})
			return reply
		}

		if (token.startsWith(KEY_PREFIX)) {
			const key = await lookupKey(opts.accountId, token)
			if (!key) {
				reply.code(403).send({ error: 'forbidden', message: 'invalid or revoked API key' })
				return reply
			}
			if (!scopeAllows(key.scopes, req.method, path)) {
				req.log.warn({ key: key.keyPrefix, method: req.method, path }, 'api key used outside its scopes')
				reply.code(403).send({
					error: 'forbidden',
					message: `this API key (scopes: ${key.scopes.join(', ')}) cannot call ${req.method} ${path}`
				})
				return reply
			}
			req.apiKey = key
			return
		}

		if (!constantTimeEqual(token, opts.masterToken)) {
			reply.code(403).send({ error: 'forbidden', message: 'invalid token' })
			return reply
		}
		if (!opts.allowRemoteMaster && !isDirectLoopback(req)) {
			req.log.warn({ ip: req.ip, path }, 'master token used from outside the droplet — refused')
			reply.code(403).send({
				error: 'forbidden',
				message: 'the master token only works from the bot host; use a scoped API key'
			})
			return reply
		}
	})
}
