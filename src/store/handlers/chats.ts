import { sql } from 'drizzle-orm'
import type { Chat, ChatUpdate } from 'baileys'

import { schema } from '../../db/index.js'
import { classifyJid, isIngestibleJid } from '../jids.js'
import { serializeForJsonb } from '../serialize.js'
import type { StoreContext } from '../types.js'

const { chats } = schema

const fromUnixSeconds = (v: number | Long | null | undefined): Date | null => {
	if (v == null) return null
	const n = typeof v === 'number' ? v : Number(v)
	if (!Number.isFinite(n) || n <= 0) return null
	return new Date(n * 1000)
}

type ChatLike = Chat | ChatUpdate

const buildRow = (accountId: string, c: ChatLike) => {
	if (!c.id) return null
	const conversationTs = fromUnixSeconds(c.conversationTimestamp ?? null)
	const ephemeralSetTs = fromUnixSeconds(c.ephemeralSettingTimestamp ?? null)
	const lastMessageRecv = fromUnixSeconds(
		(c as Chat).lastMessageRecvTimestamp ?? null
	)

	return {
		accountId,
		jid: c.id,
		type: classifyJid(c.id),
		subject: c.name ?? null,
		description: null,
		ownerJid: null,
		isDefaultSubgroup: null,
		suspended: null,
		pnJid: c.pnJid ?? null,
		accountLid: c.accountLid ?? null,
		contactPrimaryIdentityKey: c.contactPrimaryIdentityKey
			? Buffer.from(c.contactPrimaryIdentityKey)
			: null,
		shareOwnPn: c.shareOwnPn ?? null,
		lidOriginType: c.lidOriginType ?? null,
		unreadCount: c.unreadCount ?? null,
		unreadMentionCount: c.unreadMentionCount ?? null,
		markedAsUnread: c.markedAsUnread ?? null,
		archived: c.archived ?? null,
		readOnly: c.readOnly ?? null,
		notSpam: c.notSpam ?? null,
		ephemeralSeconds: c.ephemeralExpiration ?? null,
		ephemeralSetTs,
		conversationTs: conversationTs ?? lastMessageRecv,
		oldestKnownTs: null,
		historyComplete: false,
		clearedAt: null,
		raw: serializeForJsonb(c) as object
	}
}

/**
 * Inserts new chats and idempotently merges updates from history sync,
 * `chats.upsert`, and `chats.update`. Newer non-null fields win; older
 * non-null fields are preserved (`COALESCE(EXCLUDED.x, chats.x)`).
 */
export const upsertChats = async (
	{ accountId, db, log }: StoreContext,
	list: ChatLike[]
): Promise<void> => {
	if (!list.length) return

	const rows = list
		.filter(c => c.id != null && (isIngestibleJid(c.id) || c.id === 'status@broadcast' || c.id === '0@s.whatsapp.net'))
		.map(c => buildRow(accountId, c))
		.filter((r): r is NonNullable<typeof r> => r !== null)

	if (!rows.length) return

	await db
		.insert(chats)
		.values(rows)
		.onConflictDoUpdate({
			target: [chats.accountId, chats.jid],
			set: {
				type: sql`COALESCE(EXCLUDED.type, ${chats.type})`,
				subject: sql`COALESCE(EXCLUDED.subject, ${chats.subject})`,
				pnJid: sql`COALESCE(EXCLUDED.pn_jid, ${chats.pnJid})`,
				accountLid: sql`COALESCE(EXCLUDED.account_lid, ${chats.accountLid})`,
				contactPrimaryIdentityKey: sql`COALESCE(EXCLUDED.contact_primary_identity_key, ${chats.contactPrimaryIdentityKey})`,
				shareOwnPn: sql`COALESCE(EXCLUDED.share_own_pn, ${chats.shareOwnPn})`,
				lidOriginType: sql`COALESCE(EXCLUDED.lid_origin_type, ${chats.lidOriginType})`,
				unreadCount: sql`COALESCE(EXCLUDED.unread_count, ${chats.unreadCount})`,
				unreadMentionCount: sql`COALESCE(EXCLUDED.unread_mention_count, ${chats.unreadMentionCount})`,
				markedAsUnread: sql`COALESCE(EXCLUDED.marked_as_unread, ${chats.markedAsUnread})`,
				archived: sql`COALESCE(EXCLUDED.archived, ${chats.archived})`,
				readOnly: sql`COALESCE(EXCLUDED.read_only, ${chats.readOnly})`,
				notSpam: sql`COALESCE(EXCLUDED.not_spam, ${chats.notSpam})`,
				ephemeralSeconds: sql`COALESCE(EXCLUDED.ephemeral_seconds, ${chats.ephemeralSeconds})`,
				ephemeralSetTs: sql`COALESCE(EXCLUDED.ephemeral_set_ts, ${chats.ephemeralSetTs})`,
				conversationTs: sql`GREATEST(EXCLUDED.conversation_ts, ${chats.conversationTs})`,
				raw: sql`EXCLUDED.raw`
			}
		})

	log.debug({ n: rows.length }, 'chats upserted')
}

/**
 * Bulk shortcut: ensures every JID has a chats row so we can attach messages
 * via FK without a separate fetch. Used by the messaging-history.set handler
 * when the chat metadata for a message hasn't arrived yet.
 */
export const ensureChatsExist = async (
	{ accountId, db }: StoreContext,
	jids: Iterable<string>
): Promise<void> => {
	const seen = new Set<string>()
	const rows: Array<{ accountId: string; jid: string; type: ReturnType<typeof classifyJid>; raw: object }> = []
	for (const jid of jids) {
		if (seen.has(jid)) continue
		seen.add(jid)
		if (!jid) continue
		rows.push({
			accountId,
			jid,
			type: classifyJid(jid),
			raw: { id: jid, _synthetic: true }
		})
	}
	if (!rows.length) return
	await db.insert(chats).values(rows).onConflictDoNothing()
}

export const markChatCleared = async (
	{ accountId, db }: StoreContext,
	jids: string[]
): Promise<void> => {
	if (!jids.length) return
	for (const jid of jids) {
		await db
			.update(chats)
			.set({ clearedAt: sql`NOW()` })
			.where(sql`${chats.accountId} = ${accountId} AND ${chats.jid} = ${jid}`)
	}
}
