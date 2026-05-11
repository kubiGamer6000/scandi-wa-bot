import { sql } from 'drizzle-orm'
import { proto, type WAMessage, type WAMessageKey, type WAMessageUpdate } from 'baileys'

import { schema } from '../../db/index.js'
import type { MessageCache } from '../cache.js'
import { classifyJid, isIngestibleJid } from '../jids.js'
import { extractContent, extractMedia, extractReaction } from '../extract.js'
import { serializeForJsonb } from '../serialize.js'
import type { StoreContext } from '../types.js'

import { ensureChatsExist } from './chats.js'
import { recordInlineReaction, type InlineReactionInput } from './reactions.js'

const nullIfEmpty = (s: string | null | undefined): string | null => {
	if (s == null) return null
	return s.length === 0 ? null : s
}

const { messages: messagesTbl, message_edits: _msgEditsType } = schema as unknown as {
	messages: typeof schema.messages
	message_edits: typeof schema.messageEdits
}
const { messageEdits, media: mediaTbl } = schema

const toDate = (v: number | Long | null | undefined): Date => {
	if (v == null) return new Date()
	const n = typeof v === 'number' ? v : Number(v)
	if (!Number.isFinite(n) || n <= 0) return new Date()
	return new Date(n * 1000)
}

const statusToString = (s: number | null | undefined): string | null => {
	if (s == null) return null
	const e = proto.WebMessageInfo.Status
	switch (s) {
		case e.PENDING:
			return 'pending'
		case e.SERVER_ACK:
			return 'server_ack'
		case e.DELIVERY_ACK:
			return 'delivery_ack'
		case e.READ:
			return 'read'
		case e.PLAYED:
			return 'played'
		case e.ERROR:
			return 'error'
		default:
			return null
	}
}

interface PreparedMessage {
	chatJid: string
	row: typeof messagesTbl.$inferInsert
	rawMessage: proto.IMessage | null
	mediaInsert: typeof mediaTbl.$inferInsert | null
	revokeTarget: { chatJid: string; id: string; revokerJid: string | null } | null
	reaction: InlineReactionInput | null
}

const prepareMessage = (accountId: string, msg: WAMessage): PreparedMessage | null => {
	const chatJid = msg.key.remoteJid
	const id = msg.key.id
	if (!chatJid || !id) return null
	if (!isIngestibleJid(chatJid) && chatJid !== 'status@broadcast' && chatJid !== '0@s.whatsapp.net')
		return null

	const rawMessage = msg.message ?? null
	const content = extractContent(rawMessage)
	const ts = toDate(msg.messageTimestamp ?? null)

	const envelope: Record<string, unknown> = { ...msg }
	delete envelope.message
	const rawEnvelope = serializeForJsonb(envelope) as object

	const participant = nullIfEmpty(msg.key.participant)
	const senderPn = nullIfEmpty(msg.key.participantAlt)
	const remoteJidAlt = nullIfEmpty(msg.key.remoteJidAlt)
	const fromMe = !!msg.key.fromMe

	// REVOKE handling: WhatsApp packs the original message's key inside protocolMessage.key.
	// Critically, in DMs that inner key.remoteJid is the SENDER's perspective (= the bot's
	// own LID/PN when the revoker was the contact, or the contact's JID when we revoked
	// our own message). We must apply the tombstone to the OUTER chat — the one we received
	// the REVOKE in — which is always the conversation it belongs to.
	let revokeTarget: PreparedMessage['revokeTarget'] = null
	const protocolMsg = rawMessage?.protocolMessage
	const protoType = protocolMsg?.type as unknown
	const isRevoke =
		protoType === proto.Message.ProtocolMessage.Type.REVOKE || protoType === 'REVOKE'
	if (protocolMsg && isRevoke && protocolMsg.key?.id) {
		const revokerJid = participant ?? (fromMe ? null : chatJid)
		revokeTarget = { chatJid, id: protocolMsg.key.id, revokerJid }
	}

	// reactionMessage path: modern WA delivers reactions as ordinary messages.upsert
	// payloads carrying a `reactionMessage` body. Route these to wa.reactions and
	// don't treat them as conversation messages.
	let reaction: InlineReactionInput | null = null
	const r = extractReaction(rawMessage)
	if (r) {
		reaction = {
			chatJid,
			targetId: r.targetId,
			emoji: r.emoji,
			ts: r.senderTimestampMs ? new Date(r.senderTimestampMs) : ts,
			fromMe,
			participant,
			senderPn,
			senderRemoteJid: chatJid
		}
	}

	const row: typeof messagesTbl.$inferInsert = {
		accountId,
		chatJid,
		id,
		fromMe,
		participant,
		senderPn,
		remoteJidAlt,
		ts,
		status: statusToString(msg.status as number | null | undefined),
		messageAddressingMode: msg.key.addressingMode ?? null,
		pushName: msg.pushName ?? null,
		broadcast: msg.broadcast ?? null,
		messageType: content.messageType,
		isProtocol: content.isProtocol,
		text: content.text,
		caption: content.caption,
		forwarded: content.forwarded,
		forwardScore: content.forwardScore,
		quotedMsgId: content.quotedMsgId,
		quotedParticipant: content.quotedParticipant,
		quotedText: content.quotedText,
		rawMessage: rawMessage ? (serializeForJsonb(rawMessage) as object) : null,
		rawEnvelope
	}

	const mediaProj = extractMedia(rawMessage)
	const mediaInsert = mediaProj
		? ({
				accountId,
				chatJid,
				messageId: id,
				...mediaProj,
				raw: serializeForJsonb({ media: rawMessage }) as object
			} as typeof mediaTbl.$inferInsert)
		: null

	return { chatJid, row, rawMessage, mediaInsert, revokeTarget, reaction }
}

/**
 * Bulk insert/upsert path used by both real-time `messages.upsert` and the
 * history sync chunk handler.
 *
 *   - Existing rows with a body are NOT overwritten (history-sync re-runs are no-ops).
 *   - Tombstone rows (raw_message IS NULL) get backfilled when we finally see the body.
 *   - Edits are NOT handled here; they arrive via `messages.update`.
 */
export const upsertMessages = async (
	ctx: StoreContext,
	rawMessages: WAMessage[],
	cache: MessageCache | null = null
): Promise<void> => {
	if (!rawMessages.length) return
	const { accountId, db, log } = ctx

	const dedup = new Map<string, PreparedMessage>()
	for (const m of rawMessages) {
		const prepared = prepareMessage(accountId, m)
		if (!prepared) continue
		dedup.set(`${prepared.chatJid}|${prepared.row.id}`, prepared)
	}
	if (!dedup.size) return

	const all = [...dedup.values()]
	await ensureChatsExist(ctx, all.map(p => p.chatJid))

	await db
		.insert(messagesTbl)
		.values(all.map(p => p.row))
		.onConflictDoUpdate({
			target: [messagesTbl.accountId, messagesTbl.chatJid, messagesTbl.id],
			set: {
				rawMessage: sql`COALESCE(${messagesTbl.rawMessage}, EXCLUDED.raw_message)`,
				rawEnvelope: sql`COALESCE(${messagesTbl.rawEnvelope}, EXCLUDED.raw_envelope)`,
				text: sql`COALESCE(${messagesTbl.text}, EXCLUDED.text)`,
				caption: sql`COALESCE(${messagesTbl.caption}, EXCLUDED.caption)`,
				messageType: sql`COALESCE(${messagesTbl.messageType}, EXCLUDED.message_type)`,
				pushName: sql`COALESCE(${messagesTbl.pushName}, EXCLUDED.push_name)`,
				status: sql`COALESCE(EXCLUDED.status, ${messagesTbl.status})`,
				ts: sql`LEAST(EXCLUDED.ts, ${messagesTbl.ts})`,
				participant: sql`COALESCE(${messagesTbl.participant}, EXCLUDED.participant)`,
				senderPn: sql`COALESCE(${messagesTbl.senderPn}, EXCLUDED.sender_pn)`,
				remoteJidAlt: sql`COALESCE(${messagesTbl.remoteJidAlt}, EXCLUDED.remote_jid_alt)`,
				messageAddressingMode: sql`COALESCE(${messagesTbl.messageAddressingMode}, EXCLUDED.message_addressing_mode)`,
				forwarded: sql`COALESCE(${messagesTbl.forwarded}, EXCLUDED.forwarded)`,
				forwardScore: sql`COALESCE(${messagesTbl.forwardScore}, EXCLUDED.forward_score)`,
				quotedMsgId: sql`COALESCE(${messagesTbl.quotedMsgId}, EXCLUDED.quoted_msg_id)`,
				quotedParticipant: sql`COALESCE(${messagesTbl.quotedParticipant}, EXCLUDED.quoted_participant)`,
				quotedText: sql`COALESCE(${messagesTbl.quotedText}, EXCLUDED.quoted_text)`,
				broadcast: sql`COALESCE(${messagesTbl.broadcast}, EXCLUDED.broadcast)`,
				isProtocol: sql`${messagesTbl.isProtocol} OR EXCLUDED.is_protocol`
			}
		})

	const mediaRows = all.map(p => p.mediaInsert).filter((m): m is NonNullable<typeof m> => m !== null)
	if (mediaRows.length) {
		await db
			.insert(mediaTbl)
			.values(mediaRows)
			.onConflictDoNothing({ target: [mediaTbl.accountId, mediaTbl.chatJid, mediaTbl.messageId] })
	}

	if (cache) {
		for (const p of all) {
			if (p.rawMessage) cache.set({ ...p.row, fromMe: p.row.fromMe } as WAMessageKey, p.rawMessage)
		}
	}

	for (const p of all) {
		if (p.revokeTarget) {
			await applyRevoke(ctx, p.revokeTarget)
		}
		if (p.reaction) {
			await recordInlineReaction(ctx, p.reaction)
		}
	}

	// Publish to the in-process bus AFTER all writes complete. We only emit
	// `message.received` for rows that carry real content (raw_message != null);
	// pure tombstones / pure reactionMessages have already triggered their
	// own bus events from the revoke / reaction code paths.
	for (const p of all) {
		if (!p.rawMessage) continue
		if (p.reaction) continue
		ctx.bus.emit({
			type: 'message.received',
			chatJid: p.chatJid,
			messageId: p.row.id,
			fromMe: !!p.row.fromMe
		})
	}

	log.debug(
		{
			n: all.length,
			media: mediaRows.length,
			revokes: all.filter(p => p.revokeTarget).length,
			reactions: all.filter(p => p.reaction).length
		},
		'messages upserted'
	)
}

/**
 * Soft-deletes the target of a protocolMessage REVOKE. If we haven't seen
 * the original yet, we still create a tombstone row (raw_message=NULL) so
 * later history sync chunks can backfill the body.
 */
const applyRevoke = async (
	ctx: StoreContext,
	target: { chatJid: string; id: string; revokerJid: string | null }
): Promise<void> => {
	const { accountId, db, log } = ctx
	await ensureChatsExist(ctx, [target.chatJid])
	await db
		.insert(messagesTbl)
		.values({
			accountId,
			chatJid: target.chatJid,
			id: target.id,
			fromMe: false,
			ts: new Date(),
			deletedAt: sql`NOW()` as unknown as Date,
			deletedByJid: target.revokerJid,
			deletionReason: target.revokerJid && target.revokerJid !== '' ? 'sender_revoke' : 'admin_revoke',
			tombstone: true,
			rawEnvelope: { _tombstone: true, revokerJid: target.revokerJid }
		})
		.onConflictDoUpdate({
			target: [messagesTbl.accountId, messagesTbl.chatJid, messagesTbl.id],
			set: {
				deletedAt: sql`COALESCE(${messagesTbl.deletedAt}, NOW())`,
				deletedByJid: sql`COALESCE(${messagesTbl.deletedByJid}, EXCLUDED.deleted_by_jid)`,
				deletionReason: sql`COALESCE(${messagesTbl.deletionReason}, EXCLUDED.deletion_reason)`,
				tombstone: sql`TRUE`
			}
		})
	ctx.bus.emit({ type: 'message.deleted', chatJid: target.chatJid, messageId: target.id })
	log.debug({ chatJid: target.chatJid, id: target.id }, 'message revoked')
}

/**
 * Handles `messages.update`. Detects content edits by comparing the new
 * `update.message` against what we have in DB; on edit, the existing version
 * is snapshotted into `wa.message_edits` and the live row is overwritten.
 */
export const handleMessageUpdates = async (
	ctx: StoreContext,
	updates: WAMessageUpdate[]
): Promise<void> => {
	const { accountId, db, log } = ctx
	for (const u of updates) {
		const chatJid = u.key.remoteJid
		const id = u.key.id
		if (!chatJid || !id) continue

		const existing = await db
			.select()
			.from(messagesTbl)
			.where(
				sql`${messagesTbl.accountId} = ${accountId} AND ${messagesTbl.chatJid} = ${chatJid} AND ${messagesTbl.id} = ${id}`
			)
			.limit(1)
		const row = existing[0]

		const updateRaw = u.update.message ?? null
		const isContentEdit = updateRaw && row && row.rawMessage
		const updatedFields: Record<string, unknown> = {}

		if (u.update.status != null) {
			const s = statusToString(u.update.status as number)
			if (s) updatedFields.status = s
		}

		if (isContentEdit) {
			const newProj = extractContent(updateRaw)
			const oldProj = extractContent(row.rawMessage as proto.IMessage)
			const changed =
				newProj.text !== oldProj.text ||
				newProj.caption !== oldProj.caption ||
				newProj.messageType !== oldProj.messageType

			if (changed) {
				const nextVersion = row.editCount + 1
				await db.insert(messageEdits).values({
					accountId,
					chatJid,
					messageId: id,
					version: nextVersion,
					text: oldProj.text,
					caption: oldProj.caption,
					messageType: oldProj.messageType,
					rawMessage: row.rawMessage as object
				})
				updatedFields.rawMessage = serializeForJsonb(updateRaw) as object
				updatedFields.text = newProj.text
				updatedFields.caption = newProj.caption
				updatedFields.messageType = newProj.messageType
				updatedFields.editCount = nextVersion
				updatedFields.lastEditedAt = sql`NOW()`
			}
		}

		if (Object.keys(updatedFields).length) {
			await db
				.update(messagesTbl)
				.set(updatedFields as Partial<typeof messagesTbl.$inferInsert>)
				.where(
					sql`${messagesTbl.accountId} = ${accountId} AND ${messagesTbl.chatJid} = ${chatJid} AND ${messagesTbl.id} = ${id}`
				)
			if (isContentEdit && 'editCount' in updatedFields) {
				ctx.bus.emit({ type: 'message.edited', chatJid, messageId: id })
			}
			log.debug({ chatJid, id, fields: Object.keys(updatedFields) }, 'message updated')
		}
	}
}

/** `messages.delete`: explicit "delete for me" or "clear chat" actions. */
export const handleMessageDeletes = async (
	ctx: StoreContext,
	payload: { keys: WAMessageKey[] } | { jid: string; all: true }
): Promise<void> => {
	const { accountId, db, log } = ctx
	if ('all' in payload) {
		await db
			.update(messagesTbl)
			.set({
				deletedAt: sql`NOW()`,
				deletionReason: 'client_delete',
				tombstone: sql`TRUE` as unknown as boolean
			})
			.where(
				sql`${messagesTbl.accountId} = ${accountId} AND ${messagesTbl.chatJid} = ${payload.jid} AND ${messagesTbl.deletedAt} IS NULL`
			)
		log.info({ jid: payload.jid }, 'chat-wide delete-for-me')
		return
	}

	for (const k of payload.keys) {
		if (!k.remoteJid || !k.id) continue
		await ensureChatsExist(ctx, [k.remoteJid])
		await db
			.insert(messagesTbl)
			.values({
				accountId,
				chatJid: k.remoteJid,
				id: k.id,
				fromMe: !!k.fromMe,
				ts: new Date(),
				deletedAt: sql`NOW()` as unknown as Date,
				deletionReason: 'client_delete',
				tombstone: true,
				rawEnvelope: { _tombstone: true, source: 'messages.delete' }
			})
			.onConflictDoUpdate({
				target: [messagesTbl.accountId, messagesTbl.chatJid, messagesTbl.id],
				set: {
					deletedAt: sql`COALESCE(${messagesTbl.deletedAt}, NOW())`,
					deletionReason: sql`COALESCE(${messagesTbl.deletionReason}, 'client_delete')`,
					tombstone: sql`TRUE`
				}
			})
		ctx.bus.emit({ type: 'message.deleted', chatJid: k.remoteJid, messageId: k.id })
	}
	log.debug({ n: payload.keys.length }, 'messages deleted')
}
