import { and, desc, eq, lt, gt, sql } from 'drizzle-orm'
import { Type } from '@sinclair/typebox'

import { db, schema } from '../../db/index.js'
import { buildMessagePayloadsBulk } from '../payloads.js'
import type { ApiDeps, TypedFastify } from '../types.js'

const { chats, messages, groupParticipants, contacts } = schema

const ChatSummary = Type.Object({
	jid: Type.String(),
	type: Type.String(),
	subject: Type.Union([Type.String(), Type.Null()]),
	description: Type.Union([Type.String(), Type.Null()]),
	unread_count: Type.Union([Type.Number(), Type.Null()]),
	unread_mention_count: Type.Union([Type.Number(), Type.Null()]),
	archived: Type.Union([Type.Boolean(), Type.Null()]),
	last_event_at: Type.Union([Type.String(), Type.Null()]),
	last_message_seq: Type.Union([Type.Number(), Type.Null()])
})

const ChatListReply = Type.Object({
	chats: Type.Array(ChatSummary),
	next_cursor: Type.Union([Type.String(), Type.Null()])
})

const ChatDetailReply = Type.Intersect([
	ChatSummary,
	Type.Object({
		owner_jid: Type.Union([Type.String(), Type.Null()]),
		history_complete: Type.Boolean(),
		participants: Type.Optional(
			Type.Array(
				Type.Object({
					jid: Type.String(),
					pn: Type.Union([Type.String(), Type.Null()]),
					role: Type.Union([Type.String(), Type.Null()]),
					name: Type.Union([Type.String(), Type.Null()]),
					push_name: Type.Union([Type.String(), Type.Null()])
				})
			)
		)
	})
])

const decodeCursor = (raw: string | undefined): number | null => {
	if (!raw) return null
	try {
		const decoded = Buffer.from(raw, 'base64url').toString('utf8')
		const parsed = JSON.parse(decoded) as { lastTs?: string }
		if (!parsed.lastTs) return null
		const t = new Date(parsed.lastTs).getTime()
		if (!Number.isFinite(t)) return null
		return t
	} catch {
		return null
	}
}

const encodeCursor = (lastTsMs: number): string =>
	Buffer.from(JSON.stringify({ lastTs: new Date(lastTsMs).toISOString() }), 'utf8').toString('base64url')

export const registerChatRoutes = async (
	app: TypedFastify,
	deps: ApiDeps
): Promise<void> => {
	// ─────────── GET /v1/chats ───────────
	app.get(
		'/v1/chats',
		{
			schema: {
				querystring: Type.Object({
					limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
					cursor: Type.Optional(Type.String()),
					type: Type.Optional(Type.Union([Type.Literal('dm'), Type.Literal('group')]))
				}),
				response: { 200: ChatListReply }
			}
		},
		async req => {
			const accountId = deps.store.accountId
			const limit = req.query.limit ?? 50
			const cursorTsMs = decodeCursor(req.query.cursor)

			const lastEventAtExpr = sql<Date | null>`COALESCE(${chats.conversationTs}, ${chats.updatedAt})`

			const whereParts = [eq(chats.accountId, accountId)]
			if (req.query.type) whereParts.push(eq(chats.type, req.query.type))
			if (cursorTsMs != null) {
				whereParts.push(sql`${lastEventAtExpr} < to_timestamp(${cursorTsMs / 1000})`)
			}

			const rows = await db
				.select({
					jid: chats.jid,
					type: chats.type,
					subject: chats.subject,
					description: chats.description,
					unreadCount: chats.unreadCount,
					unreadMentionCount: chats.unreadMentionCount,
					archived: chats.archived,
					lastEventAt: lastEventAtExpr,
					lastMessageSeq: sql<string | null>`(
						SELECT MAX(${messages.seq})
						FROM wa.messages
						WHERE ${messages.accountId} = ${chats.accountId}
						  AND ${messages.chatJid} = ${chats.jid}
					)`
				})
				.from(chats)
				.where(and(...whereParts))
				.orderBy(desc(lastEventAtExpr))
				.limit(limit + 1)

			const hasMore = rows.length > limit
			const page = hasMore ? rows.slice(0, limit) : rows
			const last = page[page.length - 1]
			const nextCursor =
				hasMore && last?.lastEventAt
					? encodeCursor(new Date(last.lastEventAt).getTime())
					: null

			return {
				chats: page.map(r => ({
					jid: r.jid,
					type: r.type,
					subject: r.subject,
					description: r.description,
					unread_count: r.unreadCount,
					unread_mention_count: r.unreadMentionCount,
					archived: r.archived,
					last_event_at: r.lastEventAt ? new Date(r.lastEventAt).toISOString() : null,
					last_message_seq: r.lastMessageSeq == null ? null : Number(r.lastMessageSeq)
				})),
				next_cursor: nextCursor
			}
		}
	)

	// ─────────── GET /v1/chats/:jid ───────────
	app.get(
		'/v1/chats/:jid',
		{
			schema: {
				params: Type.Object({ jid: Type.String() }),
				querystring: Type.Object({
					include_participants: Type.Optional(Type.Boolean())
				}),
				response: { 200: ChatDetailReply }
			}
		},
		async req => {
			const accountId = deps.store.accountId
			const jid = decodeURIComponent(req.params.jid)

			const [row] = await db
				.select()
				.from(chats)
				.where(and(eq(chats.accountId, accountId), eq(chats.jid, jid)))
				.limit(1)
			if (!row) throw app.httpErrors.notFound(`chat not found: ${jid}`)

			const lastSeqRows = await db
				.select({
					lastMessageSeq: sql<string | null>`MAX(${messages.seq})`
				})
				.from(messages)
				.where(and(eq(messages.accountId, accountId), eq(messages.chatJid, jid)))
			const lastSeqRaw = lastSeqRows[0]?.lastMessageSeq ?? null
			const lastMessageSeq = lastSeqRaw == null ? null : Number(lastSeqRaw)

			let participants:
				| Array<{ jid: string; pn: string | null; role: string | null; name: string | null; push_name: string | null }>
				| undefined
			if (req.query.include_participants && row.type === 'group') {
				const pps = await db
					.select({
						participant: groupParticipants.participant,
						participantPn: groupParticipants.participantPn,
						role: groupParticipants.role,
						name: contacts.name,
						pushName: contacts.pushName
					})
					.from(groupParticipants)
					.leftJoin(
						contacts,
						and(
							eq(contacts.accountId, groupParticipants.accountId),
							eq(contacts.jid, groupParticipants.participant)
						)
					)
					.where(
						and(
							eq(groupParticipants.accountId, accountId),
							eq(groupParticipants.groupJid, jid)
						)
					)
				participants = pps.map(p => ({
					jid: p.participant,
					pn: p.participantPn,
					role: p.role,
					name: p.name,
					push_name: p.pushName
				}))
			}

			const lastEventAt = row.conversationTs ?? row.updatedAt
			return {
				jid: row.jid,
				type: row.type,
				subject: row.subject,
				description: row.description,
				unread_count: row.unreadCount,
				unread_mention_count: row.unreadMentionCount,
				archived: row.archived,
				last_event_at: lastEventAt?.toISOString() ?? null,
				last_message_seq: lastMessageSeq,
				owner_jid: row.ownerJid,
				history_complete: row.historyComplete,
				participants
			}
		}
	)

	// ─────────── GET /v1/chats/:jid/messages ───────────
	app.get(
		'/v1/chats/:jid/messages',
		{
			schema: {
				params: Type.Object({ jid: Type.String() }),
				querystring: Type.Object({
					limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
					before_seq: Type.Optional(Type.Integer({ minimum: 1 })),
					after_seq: Type.Optional(Type.Integer({ minimum: 1 })),
					include_media: Type.Optional(Type.Boolean()),
					include_reactions: Type.Optional(Type.Boolean()),
					include_tombstones: Type.Optional(Type.Boolean())
				})
			}
		},
		async req => {
			const accountId = deps.store.accountId
			const jid = decodeURIComponent(req.params.jid)
			const limit = req.query.limit ?? 50
			const includeTombstones = req.query.include_tombstones ?? false

			const whereParts = [eq(messages.accountId, accountId), eq(messages.chatJid, jid)]
			if (req.query.before_seq != null) whereParts.push(lt(messages.seq, req.query.before_seq))
			if (req.query.after_seq != null) whereParts.push(gt(messages.seq, req.query.after_seq))
			if (!includeTombstones) {
				whereParts.push(sql`${messages.tombstone} = FALSE`)
			}

			// after_seq → ascending (forward in time), otherwise newest-first.
			const ascending = req.query.after_seq != null
			const order = ascending ? messages.seq : desc(messages.seq)

			const rows = await db
				.select({ chatJid: messages.chatJid, messageId: messages.id, seq: messages.seq })
				.from(messages)
				.where(and(...whereParts))
				.orderBy(order)
				.limit(limit + 1)

			const hasMore = rows.length > limit
			const page = hasMore ? rows.slice(0, limit) : rows

			const payloads = await buildMessagePayloadsBulk(accountId, page, {
				includeMedia: req.query.include_media !== false,
				includeReactions: req.query.include_reactions !== false
			})

			const nextBefore = !ascending && hasMore ? page[page.length - 1]?.seq : null
			const nextAfter = ascending && hasMore ? page[page.length - 1]?.seq : null

			return {
				chat_jid: jid,
				count: payloads.length,
				ascending,
				next_before_seq: nextBefore ?? null,
				next_after_seq: nextAfter ?? null,
				messages: payloads
			}
		}
	)
}
