import { and, eq } from 'drizzle-orm'
import { Type } from '@sinclair/typebox'
import type { AnyMessageContent, WAMessageKey } from 'baileys'

import { db, schema } from '../../db/index.js'
import type { ApiDeps, TypedFastify } from '../types.js'

const { messages } = schema

/**
 * Resolves `seq` → the chat/wa_id pair we need to address WhatsApp. Throws
 * 404 if not found. Returns extra `fromMe` so callers can enforce edit/delete
 * rules (WA only allows editing/deleting your OWN messages).
 */
const resolveSeq = async (
	accountId: string,
	seq: number
): Promise<{ chatJid: string; messageId: string; fromMe: boolean; participant: string | null } | null> => {
	const [row] = await db
		.select({
			chatJid: messages.chatJid,
			id: messages.id,
			fromMe: messages.fromMe,
			participant: messages.participant
		})
		.from(messages)
		.where(and(eq(messages.accountId, accountId), eq(messages.seq, seq)))
		.limit(1)
	if (!row) return null
	return { chatJid: row.chatJid, messageId: row.id, fromMe: row.fromMe, participant: row.participant }
}

export const registerActionRoutes = async (
	app: TypedFastify,
	deps: ApiDeps
): Promise<void> => {
	// ─────────── POST /v1/messages/:seq/react ───────────
	app.post(
		'/v1/messages/:seq/react',
		{
			schema: {
				params: Type.Object({ seq: Type.Integer({ minimum: 1 }) }),
				body: Type.Object({ emoji: Type.String() })
			}
		},
		async (req, reply) => {
			const sock = deps.getSock()
			if (!sock) throw app.httpErrors.serviceUnavailable('socket not connected')

			const target = await resolveSeq(deps.store.accountId, req.params.seq)
			if (!target) throw app.httpErrors.notFound(`message seq=${req.params.seq} not found`)

			const key: WAMessageKey = {
				remoteJid: target.chatJid,
				id: target.messageId,
				fromMe: target.fromMe,
				participant: target.participant ?? undefined
			}

			// Empty string = remove the reaction. WA requires the exact emoji
			// or empty string in `text`.
			const content: AnyMessageContent = {
				react: { key, text: req.body.emoji }
			}
			await sock.sendMessage(target.chatJid, content)

			reply.code(204).send()
			return reply
		}
	)

	// ─────────── POST /v1/messages/:seq/edit ───────────
	app.post(
		'/v1/messages/:seq/edit',
		{
			schema: {
				params: Type.Object({ seq: Type.Integer({ minimum: 1 }) }),
				body: Type.Object({ text: Type.String({ minLength: 1 }) })
			}
		},
		async req => {
			const sock = deps.getSock()
			if (!sock) throw app.httpErrors.serviceUnavailable('socket not connected')

			const target = await resolveSeq(deps.store.accountId, req.params.seq)
			if (!target) throw app.httpErrors.notFound(`message seq=${req.params.seq} not found`)
			if (!target.fromMe) {
				throw app.httpErrors.forbidden(
					'cannot edit a message you did not send (from_me=false)'
				)
			}

			const key: WAMessageKey = {
				remoteJid: target.chatJid,
				id: target.messageId,
				fromMe: true,
				participant: target.participant ?? undefined
			}

			// Baileys' "edit by key" surface: send a new text content with
			// `edit: <key>` set. The server pushes a `protocolMessage` of type
			// MESSAGE_EDIT under the hood.
			const content: AnyMessageContent = { text: req.body.text, edit: key } as AnyMessageContent
			const sent = await sock.sendMessage(target.chatJid, content)

			return {
				seq: req.params.seq,
				wa_message_id: target.messageId,
				edit_wa_message_id: sent?.key?.id ?? null
			}
		}
	)

	// ─────────── POST /v1/messages/:seq/delete ───────────
	app.post(
		'/v1/messages/:seq/delete',
		{
			schema: {
				params: Type.Object({ seq: Type.Integer({ minimum: 1 }) })
			}
		},
		async (req, reply) => {
			const sock = deps.getSock()
			if (!sock) throw app.httpErrors.serviceUnavailable('socket not connected')

			const target = await resolveSeq(deps.store.accountId, req.params.seq)
			if (!target) throw app.httpErrors.notFound(`message seq=${req.params.seq} not found`)
			if (!target.fromMe) {
				throw app.httpErrors.forbidden(
					'cannot delete-for-everyone a message you did not send (from_me=false)'
				)
			}

			const key: WAMessageKey = {
				remoteJid: target.chatJid,
				id: target.messageId,
				fromMe: true,
				participant: target.participant ?? undefined
			}

			await sock.sendMessage(target.chatJid, { delete: key })

			reply.code(204).send()
			return reply
		}
	)
}
