import { Type } from '@sinclair/typebox'

import { config } from '../../config.js'
import type { TypingState } from '../../presence/index.js'
import type { ApiDeps, TypedFastify } from '../types.js'

const TypingReply = Type.Object({
	jid: Type.String(),
	state: Type.Union([Type.Literal('composing'), Type.Literal('recording')]),
	expires_at: Type.String(),
	refresh_ms: Type.Number()
})

/**
 * Typing indicators and global presence.
 *
 * A consumer opens a typing session when it starts working on a reply and
 * closes it when it's done; the bot keeps the chatstate alive in between (see
 * `src/presence/typing.ts`). Sending a message to the chat also closes the
 * session, so the common case needs no explicit `DELETE`.
 */
export const registerPresenceRoutes = async (
	app: TypedFastify,
	deps: ApiDeps
): Promise<void> => {
	// ─────────── POST /v1/chats/:jid/typing ───────────
	app.post(
		'/v1/chats/:jid/typing',
		{
			schema: {
				params: Type.Object({ jid: Type.String() }),
				body: Type.Optional(
					Type.Object({
						state: Type.Optional(
							Type.Union([Type.Literal('composing'), Type.Literal('recording')])
						),
						ttl_ms: Type.Optional(Type.Integer({ minimum: 1_000 }))
					})
				),
				response: { 200: TypingReply }
			},
			// `POST …/typing` with no body at all is the most natural way to say
			// "just start typing"; without this, Fastify validates `undefined`
			// against the object schema and 400s.
			preValidation: async req => {
				if (req.body === undefined || req.body === null) {
					req.body = {} as typeof req.body
				}
			}
		},
		async req => {
			if (!deps.typing.enabled) {
				throw app.httpErrors.serviceUnavailable('typing indicators are disabled (TYPING_ENABLED=false)')
			}
			if (!deps.getSock()) throw app.httpErrors.serviceUnavailable('socket not connected')

			const jid = decodeURIComponent(req.params.jid)
			const body = req.body ?? {}
			const session = await deps.typing.start(jid, {
				state: (body.state ?? 'composing') as TypingState,
				ttlMs: body.ttl_ms
			})

			return {
				jid: session.jid,
				state: session.state,
				expires_at: session.expiresAt.toISOString(),
				refresh_ms: config.typing.refreshMs
			}
		}
	)

	// ─────────── DELETE /v1/chats/:jid/typing ───────────
	app.delete(
		'/v1/chats/:jid/typing',
		{
			schema: { params: Type.Object({ jid: Type.String() }) }
		},
		async (req, reply) => {
			// Idempotent: closing an unknown session is a no-op, so a consumer
			// can always call this in a `finally` without checking state first.
			await deps.typing.stop(decodeURIComponent(req.params.jid))
			reply.code(204).send()
			return reply
		}
	)

	// ─────────── PUT /v1/presence ───────────
	app.put(
		'/v1/presence',
		{
			schema: {
				body: Type.Object({
					state: Type.Union([Type.Literal('available'), Type.Literal('unavailable')])
				})
			}
		},
		async (req, reply) => {
			const sock = deps.getSock()
			if (!sock) throw app.httpErrors.serviceUnavailable('socket not connected')

			// `available` suppresses push notifications on the paired phone for
			// as long as it holds — that's WhatsApp's behaviour, not ours.
			await sock.sendPresenceUpdate(req.body.state)
			reply.code(204).send()
			return reply
		}
	)
}
