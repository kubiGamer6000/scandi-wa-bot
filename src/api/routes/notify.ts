import { and, eq, sql } from 'drizzle-orm'
import { Type } from '@sinclair/typebox'

import { config } from '../../config.js'
import { db, schema } from '../../db/index.js'
import { markdownToWhatsapp, parseRecipient } from '../format.js'
import type { ApiDeps, TypedFastify } from '../types.js'
import { waitForSeq } from './send.js'

/**
 * POST /v1/notify — send a WhatsApp text message to one person.
 *
 * Built for external apps (e.g. the editor app) holding a scoped `notify`
 * key: they can send, and see the status of their own sends, nothing else.
 * Every request is written to wa.notifications (audit, idempotency, limits).
 *
 * Safety rails, because WhatsApp bans accounts that look like spam:
 *   - individual chats only (no groups / broadcasts);
 *   - the number must exist on WhatsApp (checked before sending);
 *   - per-key limits (per minute in memory, per day from the DB) and a
 *     per-recipient hourly cap shared by all keys;
 *   - an idempotency key makes retries safe: the same key never sends twice.
 */

const MAX_TEXT_CHARS = 4096

const NotifyBody = Type.Object({
	to: Type.String({
		minLength: 3,
		maxLength: 64,
		description: 'Phone number in international format (+46 70 123 45 67) or a WhatsApp JID'
	}),
	text: Type.String({ minLength: 1, maxLength: MAX_TEXT_CHARS * 2 }),
	format: Type.Optional(Type.Union([Type.Literal('whatsapp'), Type.Literal('markdown')])),
	idempotency_key: Type.Optional(Type.String({ minLength: 1, maxLength: 200 }))
})

const NotifyReply = Type.Object({
	id: Type.Number(),
	status: Type.String(),
	to: Type.String(),
	wa_message_id: Type.Union([Type.String(), Type.Null()]),
	seq: Type.Union([Type.Number(), Type.Null()]),
	deduplicated: Type.Boolean(),
	created_at: Type.String()
})

const StatusReply = Type.Object({
	id: Type.Number(),
	status: Type.String(),
	to: Type.Union([Type.String(), Type.Null()]),
	wa_message_id: Type.Union([Type.String(), Type.Null()]),
	error: Type.Union([Type.String(), Type.Null()]),
	created_at: Type.String(),
	delivered_at: Type.Union([Type.String(), Type.Null()]),
	read_at: Type.Union([Type.String(), Type.Null()])
})

// Number → JID lookups are cached: they cost a round trip to WhatsApp, and
// asking about the same numbers repeatedly is itself a pattern worth avoiding.
const RESOLVE_TTL_MS = 6 * 60 * 60 * 1000
const resolved = new Map<string, { jid: string | null; at: number }>()

// Per-key per-minute counters (sliding window of timestamps).
const recentByKey = new Map<string, number[]>()

const takeMinuteSlot = (keyId: string, limit: number): number | null => {
	const now = Date.now()
	const recent = (recentByKey.get(keyId) ?? []).filter(t => now - t < 60_000)
	if (recent.length >= limit) {
		recentByKey.set(keyId, recent)
		return Math.ceil((60_000 - (now - recent[0]!)) / 1000)
	}
	recent.push(now)
	recentByKey.set(keyId, recent)
	return null
}

interface NotificationRow extends Record<string, unknown> {
	id: string
	status: string
	to_jid: string | null
	wa_message_id: string | null
	seq: string | null
	created_at: Date
}

export const registerNotifyRoutes = async (app: TypedFastify, deps: ApiDeps): Promise<void> => {
	const accountId = deps.store.accountId

	app.post(
		'/v1/notify',
		{ schema: { body: NotifyBody, response: { 200: NotifyReply } } },
		async (req, reply) => {
			const key = req.apiKey
			if (!key) {
				// The master token has /v1/send; notify is for scoped keys so that
				// every notification is attributable to an app.
				throw app.httpErrors.forbidden('use a scoped API key (npm run api-key) for /v1/notify')
			}
			const body = req.body
			const idempotencyKey =
				body.idempotency_key ??
				(typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined)

			const text = (body.format === 'markdown' ? markdownToWhatsapp(body.text) : body.text).trim()
			if (!text) throw app.httpErrors.badRequest('`text` is empty')
			if (text.length > MAX_TEXT_CHARS) {
				throw app.httpErrors.badRequest(`\`text\` is longer than ${MAX_TEXT_CHARS} characters`)
			}

			const recipient = parseRecipient(body.to)
			if (!recipient) {
				throw app.httpErrors.badRequest(
					'`to` must be a phone number in international format (e.g. +46701234567) or an individual WhatsApp JID'
				)
			}

			// Idempotent replay: return the earlier result without sending again.
			if (idempotencyKey) {
				const [prior] = await db
					.select()
					.from(schema.notifications)
					.where(
						and(
							eq(schema.notifications.apiKeyId, key.id),
							eq(schema.notifications.idempotencyKey, idempotencyKey)
						)
					)
					.limit(1)
				if (prior && prior.status !== 'failed') {
					if (prior.status === 'pending') {
						throw app.httpErrors.conflict('a request with this idempotency key is still in progress')
					}
					return {
						id: Number(prior.id),
						status: prior.status,
						to: prior.toJid ?? prior.toInput,
						wa_message_id: prior.waMessageId,
						seq: prior.seq,
						deduplicated: true,
						created_at: prior.createdAt.toISOString()
					}
				}
			}

			// Rate limits.
			const retryMinute = takeMinuteSlot(key.id, key.ratePerMinute)
			if (retryMinute !== null) {
				reply.header('retry-after', String(retryMinute))
				throw app.httpErrors.tooManyRequests(`rate limit: ${key.ratePerMinute} notifications per minute`)
			}
			const [{ count: today = 0 } = { count: 0 }] = await db
				.select({ count: sql<number>`count(*)::int` })
				.from(schema.notifications)
				.where(
					and(
						eq(schema.notifications.apiKeyId, key.id),
						sql`${schema.notifications.createdAt} > now() - interval '24 hours'`
					)
				)
			if (today >= key.ratePerDay) {
				reply.header('retry-after', '3600')
				throw app.httpErrors.tooManyRequests(`rate limit: ${key.ratePerDay} notifications per 24 hours`)
			}

			const sock = deps.getSock()
			if (!sock) throw app.httpErrors.serviceUnavailable('WhatsApp is not connected right now; retry shortly')

			// Resolve the recipient (and confirm the number is on WhatsApp).
			let toJid: string
			if (recipient.kind === 'jid') {
				toJid = recipient.jid
			} else {
				const cached = resolved.get(recipient.digits)
				let jid: string | null
				if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) {
					jid = cached.jid
				} else {
					const [hit] = (await sock.onWhatsApp(recipient.digits)) ?? []
					jid = hit?.exists ? hit.jid : null
					resolved.set(recipient.digits, { jid, at: Date.now() })
				}
				if (!jid) {
					throw app.httpErrors.unprocessableEntity(
						`+${recipient.digits} is not a WhatsApp number (check the country code)`
					)
				}
				toJid = jid
			}

			const [{ count: toRecipient = 0 } = { count: 0 }] = await db
				.select({ count: sql<number>`count(*)::int` })
				.from(schema.notifications)
				.where(
					and(
						eq(schema.notifications.toJid, toJid),
						eq(schema.notifications.status, 'sent'),
						sql`${schema.notifications.createdAt} > now() - interval '1 hour'`
					)
				)
			if (toRecipient >= config.api.notifyPerRecipientPerHour) {
				reply.header('retry-after', '600')
				throw app.httpErrors.tooManyRequests(
					`rate limit: ${config.api.notifyPerRecipientPerHour} notifications per recipient per hour`
				)
			}

			// Claim the idempotency key before sending: a concurrent duplicate
			// conflicts here instead of sending a second message. A previously
			// failed attempt is reclaimed so the caller can retry.
			const claimed = await db.execute<NotificationRow>(sql`
				INSERT INTO wa.notifications
					(account_id, api_key_id, idempotency_key, to_input, to_jid, text_chars, status)
				VALUES
					(${accountId}, ${key.id}, ${idempotencyKey ?? null}, ${body.to}, ${toJid}, ${text.length}, 'pending')
				ON CONFLICT (api_key_id, idempotency_key) WHERE idempotency_key IS NOT NULL
				DO UPDATE SET status = 'pending', error = NULL, to_input = EXCLUDED.to_input,
				              to_jid = EXCLUDED.to_jid, text_chars = EXCLUDED.text_chars, created_at = NOW()
				WHERE wa.notifications.status = 'failed'
				RETURNING id::text, status, to_jid, wa_message_id, seq::text, created_at
			`)
			const row = (claimed as unknown as NotificationRow[])[0]
			if (!row) {
				throw app.httpErrors.conflict('a request with this idempotency key is already in progress or sent')
			}

			try {
				const sent = await sock.sendMessage(toJid, { text })
				const waId = sent?.key?.id
				if (!waId) throw new Error('sendMessage returned no message id')
				deps.typing.noteOutboundMessage(toJid)
				const seq = await waitForSeq(accountId, sent.key.remoteJid ?? toJid, waId, 8_000)

				await db
					.update(schema.notifications)
					.set({ status: 'sent', waMessageId: waId, seq })
					.where(eq(schema.notifications.id, BigInt(row.id)))

				req.log.info({ key: key.keyPrefix, id: row.id, to: toJid, chars: text.length }, 'notification sent')
				return {
					id: Number(row.id),
					status: 'sent',
					to: toJid,
					wa_message_id: waId,
					seq,
					deduplicated: false,
					created_at: new Date(row.created_at).toISOString()
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err)
				await db
					.update(schema.notifications)
					.set({ status: 'failed', error: message.slice(0, 500) })
					.where(eq(schema.notifications.id, BigInt(row.id)))
					.catch(() => undefined)
				req.log.warn({ key: key.keyPrefix, id: row.id, to: toJid, err: message }, 'notification failed')
				throw app.httpErrors.badGateway(`WhatsApp send failed: ${message}`)
			}
		}
	)

	app.get(
		'/v1/notify/:id',
		{
			schema: {
				params: Type.Object({ id: Type.String({ pattern: '^[0-9]+$' }) }),
				response: { 200: StatusReply }
			}
		},
		async req => {
			const conditions = [eq(schema.notifications.id, BigInt(req.params.id))]
			// A scoped key only sees its own notifications.
			if (req.apiKey) conditions.push(eq(schema.notifications.apiKeyId, req.apiKey.id))
			const [n] = await db
				.select()
				.from(schema.notifications)
				.where(and(...conditions))
				.limit(1)
			if (!n) throw app.httpErrors.notFound('notification not found')

			let deliveredAt: string | null = null
			let readAt: string | null = null
			if (n.waMessageId && n.toJid) {
				const receipts = await db
					.select({ type: schema.messageReceipts.receiptType, ts: schema.messageReceipts.ts })
					.from(schema.messageReceipts)
					.where(
						and(
							eq(schema.messageReceipts.accountId, accountId),
							eq(schema.messageReceipts.messageId, n.waMessageId)
						)
					)
				for (const r of receipts) {
					const iso = r.ts.toISOString()
					if (r.type === 'delivery') deliveredAt = iso
					if (r.type === 'read' || r.type === 'played') readAt = iso
				}
				// A read message was necessarily delivered.
				deliveredAt ??= readAt
			}

			return {
				id: Number(n.id),
				status: n.status,
				to: n.toJid,
				wa_message_id: n.waMessageId,
				error: n.error,
				created_at: n.createdAt.toISOString(),
				delivered_at: deliveredAt,
				read_at: readAt
			}
		}
	)
}
