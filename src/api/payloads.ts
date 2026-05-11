import { and, desc, eq, inArray, sql } from 'drizzle-orm'

import { db, schema } from '../db/index.js'
import { childLogger } from '../logger.js'

const log = childLogger('api:payloads')

const { messages, chats, media, mediaProcessing, reactions, accounts, groupParticipants } = schema

/**
 * Cache of (self_pn, self_lid) per account. Refreshed on demand; the bot
 * already invalidates this elsewhere via reactions.invalidateSelfCache, but
 * we keep our own copy because this module shouldn't import store internals.
 */
const selfCache = new Map<string, { pn: string | null; lid: string | null }>()

const loadSelf = async (accountId: string): Promise<{ pn: string | null; lid: string | null }> => {
	const hit = selfCache.get(accountId)
	if (hit) return hit
	const [row] = await db
		.select({ pn: accounts.selfPnJid, lid: accounts.selfLidJid })
		.from(accounts)
		.where(eq(accounts.id, accountId))
		.limit(1)
	const v = row ?? { pn: null, lid: null }
	selfCache.set(accountId, v)
	return v
}

export const invalidatePayloadSelfCache = (accountId?: string): void => {
	if (accountId) selfCache.delete(accountId)
	else selfCache.clear()
}

// ───────────────────────── public types ─────────────────────────

export interface PartyRef {
	jid: string
	pn: string | null
	lid: string | null
	push_name: string | null
}

export interface ChatRef {
	jid: string
	type: string
	subject: string | null
	participant_count: number | null
}

export interface QuotedRef {
	seq: number | null
	message_id: string
	from_jid: string | null
	text: string | null
}

export interface MediaPayload {
	media_type: string
	mime_type: string | null
	size_bytes: number | null
	width: number | null
	height: number | null
	duration_seconds: number | null
	page_count: number | null
	file_name: string | null
	caption: string | null
	is_voice_note: boolean | null
	download_status: string
	url: string | null
	processed: {
		text: string
		processor: string
		model: string
		completed_at: string
	} | null
}

export interface ReactionPayload {
	emoji: string | null
	actor_jid: string
	at: string
}

export interface MessagePayload {
	seq: number
	wa_id: string
	chat: ChatRef
	from: PartyRef
	from_me: boolean
	timestamp: string
	type: string | null
	text: string | null
	caption: string | null
	mentioned_self: boolean
	mentioned_jids: string[]
	addressing_mode: string | null
	forwarded: boolean | null
	forward_score: number | null
	edit_count: number
	last_edited_at: string | null
	deleted: boolean
	deleted_at: string | null
	deleted_by_jid: string | null
	deletion_reason: string | null
	tombstone: boolean
	quoted: QuotedRef | null
	media: MediaPayload | null
	reactions: ReactionPayload[]
}

// ───────────────────────── helpers ─────────────────────────

const isObj = (x: unknown): x is Record<string, unknown> =>
	typeof x === 'object' && x !== null && !Array.isArray(x)

/**
 * Recursively gathers every `mentionedJid` array found anywhere under a
 * `contextInfo` object inside the raw_message proto. Robust against the
 * various wrappers (ephemeralMessage / viewOnceMessage / editedMessage /
 * documentWithCaptionMessage) without requiring us to know them upfront.
 */
const collectMentionedJids = (raw: unknown): string[] => {
	if (!raw || typeof raw !== 'object') return []
	const out = new Set<string>()
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const v of node) walk(v)
			return
		}
		if (!isObj(node)) return
		const ctx = node.contextInfo
		if (isObj(ctx) && Array.isArray(ctx.mentionedJid)) {
			for (const j of ctx.mentionedJid) {
				if (typeof j === 'string' && j.length > 0) out.add(j)
			}
		}
		for (const k of Object.keys(node)) walk(node[k])
	}
	walk(raw)
	return [...out]
}

const detectMentionedSelf = (mentioned: string[], self: { pn: string | null; lid: string | null }): boolean => {
	if (mentioned.length === 0) return false
	for (const m of mentioned) {
		if (self.pn && m === self.pn) return true
		if (self.lid && m === self.lid) return true
	}
	return false
}

const partyForSender = (row: {
	fromMe: boolean
	chatJid: string
	participant: string | null
	senderPn: string | null
	remoteJidAlt: string | null
	pushName: string | null
}, chatType: string, self: { pn: string | null; lid: string | null }): PartyRef => {
	if (row.fromMe) {
		const jid = row.participant ?? self.lid ?? self.pn ?? ''
		return {
			jid,
			pn: self.pn,
			lid: jid.endsWith('@lid') ? jid : self.lid,
			push_name: row.pushName
		}
	}
	const inGroup = chatType === 'group'
	const jid = inGroup
		? (row.participant ?? row.senderPn ?? row.chatJid)
		: row.chatJid
	const pn = row.senderPn ?? (jid.endsWith('@s.whatsapp.net') ? jid : null)
	const lid = jid.endsWith('@lid') ? jid : row.remoteJidAlt && row.remoteJidAlt.endsWith('@lid') ? row.remoteJidAlt : null
	return { jid, pn, lid, push_name: row.pushName }
}

// ───────────────────────── main builder ─────────────────────────

export interface BuildMessageOpts {
	/** When true, include reactions array. Default true. */
	includeReactions?: boolean
	/** When true, include the latest media + processed text. Default true. */
	includeMedia?: boolean
}

/**
 * Single-message rich payload — shared by `GET /v1/messages/:seq` and the
 * webhook delivery payload. Resolves: chat metadata, sender identity,
 * quoted reference (seq if known), media + processed text, reactions, and
 * `mentioned_self`. Returns null if no row exists.
 */
export const buildMessagePayload = async (
	accountId: string,
	key: { chatJid: string; messageId: string } | { seq: number },
	opts: BuildMessageOpts = {}
): Promise<MessagePayload | null> => {
	const includeReactions = opts.includeReactions !== false
	const includeMedia = opts.includeMedia !== false

	const [msgRow] = await db
		.select()
		.from(messages)
		.where(
			'seq' in key
				? and(eq(messages.accountId, accountId), eq(messages.seq, key.seq))
				: and(
						eq(messages.accountId, accountId),
						eq(messages.chatJid, key.chatJid),
						eq(messages.id, key.messageId)
					)
		)
		.limit(1)

	if (!msgRow) return null

	const self = await loadSelf(accountId)

	const [chatRow] = await db
		.select({ jid: chats.jid, type: chats.type, subject: chats.subject })
		.from(chats)
		.where(and(eq(chats.accountId, accountId), eq(chats.jid, msgRow.chatJid)))
		.limit(1)

	const chatType = chatRow?.type ?? (msgRow.chatJid.endsWith('@g.us') ? 'group' : 'dm')

	let participantCount: number | null = null
	if (chatType === 'group') {
		const countRows = await db
			.select({ n: sql<number>`COUNT(*)::int` })
			.from(groupParticipants)
			.where(
				and(
					eq(groupParticipants.accountId, accountId),
					eq(groupParticipants.groupJid, msgRow.chatJid)
				)
			)
		participantCount = countRows[0]?.n ?? null
	}

	// Resolve quoted.seq if we recognise the quoted msg id.
	let quoted: QuotedRef | null = null
	if (msgRow.quotedMsgId) {
		const [q] = await db
			.select({ seq: messages.seq })
			.from(messages)
			.where(
				and(
					eq(messages.accountId, accountId),
					eq(messages.chatJid, msgRow.chatJid),
					eq(messages.id, msgRow.quotedMsgId)
				)
			)
			.limit(1)
		quoted = {
			seq: q?.seq ?? null,
			message_id: msgRow.quotedMsgId,
			from_jid: msgRow.quotedParticipant,
			text: msgRow.quotedText
		}
	}

	let mediaPayload: MediaPayload | null = null
	if (includeMedia) {
		const [mediaRow] = await db
			.select()
			.from(media)
			.where(
				and(
					eq(media.accountId, accountId),
					eq(media.chatJid, msgRow.chatJid),
					eq(media.messageId, msgRow.id)
				)
			)
			.limit(1)
		if (mediaRow) {
			const processedRows = await db
				.select({
					resultText: mediaProcessing.resultText,
					processor: mediaProcessing.processor,
					model: mediaProcessing.model,
					completedAt: mediaProcessing.completedAt,
					status: mediaProcessing.status
				})
				.from(mediaProcessing)
				.where(eq(mediaProcessing.mediaId, mediaRow.id))
				.orderBy(desc(mediaProcessing.completedAt))
				.limit(1)
			const proc = processedRows[0]
			mediaPayload = {
				media_type: mediaRow.mediaType,
				mime_type: mediaRow.mimeType,
				size_bytes: mediaRow.sizeBytes ?? mediaRow.fileLength,
				width: mediaRow.width,
				height: mediaRow.height,
				duration_seconds: mediaRow.durationSeconds,
				page_count: mediaRow.pageCount,
				file_name: mediaRow.fileName,
				caption: mediaRow.caption,
				is_voice_note: mediaRow.isVoiceNote,
				download_status: mediaRow.downloadStatus,
				url: mediaRow.gcsUrl,
				processed:
					proc && proc.status === 'done' && proc.resultText
						? {
								text: proc.resultText,
								processor: proc.processor,
								model: proc.model,
								completed_at: (proc.completedAt ?? new Date()).toISOString()
							}
						: null
			}
		}
	}

	let reactionsList: ReactionPayload[] = []
	if (includeReactions) {
		const rxRows = await db
			.select({ actorJid: reactions.actorJid, emoji: reactions.emoji, ts: reactions.ts })
			.from(reactions)
			.where(
				and(
					eq(reactions.accountId, accountId),
					eq(reactions.chatJid, msgRow.chatJid),
					eq(reactions.messageId, msgRow.id)
				)
			)
		reactionsList = rxRows
			.filter(r => r.emoji != null)
			.map(r => ({ emoji: r.emoji, actor_jid: r.actorJid, at: r.ts.toISOString() }))
	}

	const mentionedJids = collectMentionedJids(msgRow.rawMessage)
	const mentionedSelf = detectMentionedSelf(mentionedJids, self)

	const from = partyForSender(
		{
			fromMe: msgRow.fromMe,
			chatJid: msgRow.chatJid,
			participant: msgRow.participant,
			senderPn: msgRow.senderPn,
			remoteJidAlt: msgRow.remoteJidAlt,
			pushName: msgRow.pushName
		},
		chatType,
		self
	)

	return {
		seq: msgRow.seq,
		wa_id: msgRow.id,
		chat: {
			jid: msgRow.chatJid,
			type: chatType,
			subject: chatRow?.subject ?? null,
			participant_count: participantCount
		},
		from,
		from_me: msgRow.fromMe,
		timestamp: msgRow.ts.toISOString(),
		type: msgRow.messageType,
		text: msgRow.text,
		caption: msgRow.caption,
		mentioned_self: mentionedSelf,
		mentioned_jids: mentionedJids,
		addressing_mode: msgRow.messageAddressingMode,
		forwarded: msgRow.forwarded,
		forward_score: msgRow.forwardScore,
		edit_count: msgRow.editCount,
		last_edited_at: msgRow.lastEditedAt?.toISOString() ?? null,
		deleted: !!msgRow.deletedAt,
		deleted_at: msgRow.deletedAt?.toISOString() ?? null,
		deleted_by_jid: msgRow.deletedByJid,
		deletion_reason: msgRow.deletionReason,
		tombstone: msgRow.tombstone,
		quoted,
		media: mediaPayload,
		reactions: reactionsList
	}
}

/**
 * Bulk variant for paginated reads (`/v1/chats/:jid/messages`). Single
 * round-trip per dependent table rather than N — keeps history endpoint
 * fast even at limit=50.
 */
// Per-message payload build runs ~5 sequential queries (msg / chat / media /
// processing / reactions). With a 50-message page that's ~250 in-flight queries
// if we fire them all at once, which trivially exhausts the default
// postgres-js pool when the media/processing workers are also busy. Cap the
// concurrency to keep the pool healthy under load.
const BULK_CONCURRENCY = 6

export const buildMessagePayloadsBulk = async (
	accountId: string,
	rows: Array<{ chatJid: string; messageId: string; seq: number }>,
	opts: BuildMessageOpts = {}
): Promise<MessagePayload[]> => {
	const out: Array<MessagePayload | null> = new Array(rows.length).fill(null)
	let cursor = 0
	const workers = Array.from({ length: Math.min(BULK_CONCURRENCY, rows.length) }, async () => {
		while (true) {
			const i = cursor++
			if (i >= rows.length) return
			const r = rows[i]!
			try {
				out[i] = await buildMessagePayload(
					accountId,
					{ chatJid: r.chatJid, messageId: r.messageId },
					opts
				)
			} catch (err) {
				log.warn({ err, seq: r.seq }, 'failed to build message payload (skipped)')
				out[i] = null
			}
		}
	})
	await Promise.all(workers)
	return out.filter((p): p is MessagePayload => p != null)
}

// Re-export the schema-imports used by tests / future hooks.
export { messages as _messagesTbl, inArray as _inArray }
