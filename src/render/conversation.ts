import { sql } from 'drizzle-orm'

import { db, schema } from '../db/index.js'

import {
	formatHeader,
	formatMessage,
	fmtDate,
	isHiddenSystemRow,
	type FormatContext
} from './format.js'
import {
	buildNameDirectory,
	fetchAccount,
	resolveTarget,
	type AccountInfo,
	type ResolvedTarget
} from './lookup.js'

const { messages, messageEdits, reactions: reactionsTbl, media: mediaTbl } = schema

type MessageRow = typeof messages.$inferSelect
type EditRow = typeof messageEdits.$inferSelect
type ReactionRow = typeof reactionsTbl.$inferSelect
type MediaRow = typeof mediaTbl.$inferSelect

export interface RenderInput {
	/** Phone number ("+44…", "447…") or full JID ("…@s.whatsapp.net", "…@g.us"). */
	target: string
	/** Account label (default: 'default'). */
	accountLabel?: string
	/** Hard cap on number of messages, oldest-first. Default: no cap. */
	limit?: number
}

export interface RenderResult {
	markdown: string
	target: ResolvedTarget
	account: AccountInfo
	messageCount: number
}

const groupByMessage = <T extends { chatJid: string; messageId: string }>(
	rows: T[]
): Map<string, T[]> => {
	const m = new Map<string, T[]>()
	for (const r of rows) {
		const k = `${r.chatJid}|${r.messageId}`
		const list = m.get(k)
		if (list) list.push(r)
		else m.set(k, [r])
	}
	return m
}

/**
 * Loads the entire conversation for a JID and renders it to Markdown.
 *
 * Single-pass design: one query per resource (messages, edits, reactions,
 * media), then in-memory join. Works comfortably up to a few tens of
 * thousands of messages without paging.
 */
export const renderConversation = async (input: RenderInput): Promise<RenderResult> => {
	const accountLabel = input.accountLabel ?? 'default'
	const account = await fetchAccount(accountLabel)
	if (!account) {
		throw new Error(
			`No wa.accounts row with label "${accountLabel}" — has the bot been paired yet?`
		)
	}

	const target = await resolveTarget(account.id, input.target)

	const dir = await buildNameDirectory(account)

	const limit = input.limit ?? 100_000
	const chatJids = target.chatJids

	const allMsgRows: MessageRow[] = (await db
		.select()
		.from(messages)
		.where(
			sql`${messages.accountId} = ${account.id} AND ${messages.chatJid} IN ${chatJids}`
		)
		.orderBy(messages.ts, messages.id)
		.limit(limit)) as MessageRow[]

	// reactionMessage envelopes and REVOKE protocol envelopes have already done
	// their job (they populated wa.reactions and tombstoned the target). Drop
	// them from the human-facing timeline so the conversation reads cleanly.
	const msgRows = allMsgRows.filter(m => !isHiddenSystemRow(m))
	const haveMessages = msgRows.length > 0
	const messageIds = msgRows.map(m => m.id)

	const editRows: EditRow[] = haveMessages
		? ((await db
				.select()
				.from(messageEdits)
				.where(
					sql`${messageEdits.accountId} = ${account.id}
					    AND ${messageEdits.chatJid} IN ${chatJids}
					    AND ${messageEdits.messageId} IN ${messageIds}`
				)) as EditRow[])
		: []

	const reactionRows: ReactionRow[] = haveMessages
		? ((await db
				.select()
				.from(reactionsTbl)
				.where(
					sql`${reactionsTbl.accountId} = ${account.id}
					    AND ${reactionsTbl.chatJid} IN ${chatJids}
					    AND ${reactionsTbl.messageId} IN ${messageIds}`
				)) as ReactionRow[])
		: []

	const mediaRows: MediaRow[] = haveMessages
		? ((await db
				.select()
				.from(mediaTbl)
				.where(
					sql`${mediaTbl.accountId} = ${account.id}
					    AND ${mediaTbl.chatJid} IN ${chatJids}
					    AND ${mediaTbl.messageId} IN ${messageIds}`
				)) as MediaRow[])
		: []

	const editsBy = groupByMessage(editRows)
	const reactsBy = groupByMessage(reactionRows)
	const mediaBy = new Map<string, MediaRow>()
	for (const m of mediaRows) mediaBy.set(`${m.chatJid}|${m.messageId}`, m)

	const ctx: FormatContext = {
		dir,
		isGroup: target.chatType === 'group'
	}

	const sections: string[] = []
	sections.push(
		formatHeader({
			chatJid: target.primaryChatJid,
			additionalChatJids: target.chatJids.filter(j => j !== target.primaryChatJid),
			chatType: target.chatType,
			chatSubject: target.chatSubject,
			contactName: target.contactName,
			contactPn: target.contactPn,
			contactLid: target.contactLid,
			messageCount: msgRows.length,
			firstTs: msgRows[0]?.ts ?? null,
			lastTs: msgRows[msgRows.length - 1]?.ts ?? null,
			exportedAt: new Date(),
			accountLabel
		})
	)

	let lastDate = ''
	for (const m of msgRows) {
		const date = fmtDate(m.ts)
		if (date !== lastDate) {
			sections.push(`\n## ${date}\n`)
			lastDate = date
		}
		const key = `${m.chatJid}|${m.id}`
		sections.push(
			formatMessage(
				{
					message: m,
					edits: editsBy.get(key) ?? [],
					reactions: reactsBy.get(key) ?? [],
					media: mediaBy.get(key) ?? null
				},
				ctx
			)
		)
	}

	return {
		markdown: sections.join('\n'),
		target,
		account,
		messageCount: msgRows.length
	}
}
