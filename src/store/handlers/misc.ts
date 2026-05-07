import { sql } from 'drizzle-orm'
import type { BaileysEventMap, proto } from 'baileys'

import { schema } from '../../db/index.js'
import { serializeForJsonb } from '../serialize.js'
import type { StoreContext } from '../types.js'

type LabelEvent = BaileysEventMap['labels.edit']

const { labels, labelAssociations, settings, syncState, eventLog, messageReceipts } = schema

export const upsertLabel = async ({ accountId, db }: StoreContext, label: LabelEvent): Promise<void> => {
	if (!label.id) return
	await db
		.insert(labels)
		.values({
			accountId,
			id: label.id,
			name: label.name ?? null,
			color: label.color ?? null,
			predefinedId: label.predefinedId ? Number(label.predefinedId) : null,
			deleted: !!label.deleted,
			raw: serializeForJsonb(label) as object
		})
		.onConflictDoUpdate({
			target: [labels.accountId, labels.id],
			set: {
				name: sql`EXCLUDED.name`,
				color: sql`EXCLUDED.color`,
				predefinedId: sql`EXCLUDED.predefined_id`,
				deleted: sql`EXCLUDED.deleted`,
				raw: sql`EXCLUDED.raw`
			}
		})
}

export const upsertLabelAssociation = async (
	{ accountId, db }: StoreContext,
	association: {
		labelId?: string
		type?: 'chat' | 'message'
		chatId?: string
		messageId?: string
	},
	op: 'add' | 'remove'
): Promise<void> => {
	if (!association.labelId || !association.type || !association.chatId) return

	if (op === 'remove') {
		await db
			.delete(labelAssociations)
			.where(
				sql`${labelAssociations.accountId} = ${accountId}
				    AND ${labelAssociations.labelId} = ${association.labelId}
				    AND ${labelAssociations.type} = ${association.type}
				    AND ${labelAssociations.chatJid} = ${association.chatId}
				    AND ${labelAssociations.messageId} = ${association.messageId ?? ''}`
			)
		return
	}

	await db
		.insert(labelAssociations)
		.values({
			accountId,
			labelId: association.labelId,
			type: association.type,
			chatJid: association.chatId,
			messageId: association.messageId ?? '',
			raw: serializeForJsonb(association) as object
		})
		.onConflictDoNothing()
}

export const updateSetting = async (
	{ accountId, db }: StoreContext,
	setting: string,
	value: unknown
): Promise<void> => {
	await db
		.insert(settings)
		.values({ accountId, key: setting, value: serializeForJsonb(value) as object })
		.onConflictDoUpdate({
			target: [settings.accountId, settings.key],
			set: { value: sql`EXCLUDED.value` }
		})
}

/** Patch the per-account `wa.sync_state` row. */
export const updateSyncState = async (
	{ accountId, db }: StoreContext,
	patch: {
		historyReceivedAt?: Date | null
		historyProgressPct?: number | null
		historyChunkOrder?: string | null
		historySyncType?: string | null
		isLatest?: boolean | null
		initialSyncDone?: boolean
		lastEventAt?: Date | null
		raw?: unknown
	}
): Promise<void> => {
	const set: Record<string, unknown> = {}
	if (patch.historyReceivedAt !== undefined) set.historyReceivedAt = patch.historyReceivedAt
	if (patch.historyProgressPct !== undefined) set.historyProgressPct = patch.historyProgressPct
	if (patch.historyChunkOrder !== undefined) set.historyChunkOrder = patch.historyChunkOrder
	if (patch.historySyncType !== undefined) set.historySyncType = patch.historySyncType
	if (patch.isLatest !== undefined) set.isLatest = patch.isLatest
	if (patch.initialSyncDone !== undefined) set.initialSyncDone = patch.initialSyncDone
	if (patch.lastEventAt !== undefined) set.lastEventAt = patch.lastEventAt
	if (patch.raw !== undefined) set.raw = serializeForJsonb(patch.raw) as object

	await db
		.insert(syncState)
		.values({ accountId, ...set })
		.onConflictDoUpdate({ target: syncState.accountId, set })
}

/** Append-only log of unmodeled events. Bounded externally — truncate freely. */
export const logEvent = async (
	{ accountId, db }: StoreContext,
	event: string,
	payload: unknown
): Promise<void> => {
	await db.insert(eventLog).values({
		accountId,
		event,
		payload: serializeForJsonb(payload) as object
	})
}

export const recordReceipts = async (
	{ accountId, db }: StoreContext,
	updates: Array<{ key: { remoteJid?: string | null; id?: string | null }; receipt: proto.IUserReceipt }>
): Promise<void> => {
	const rows = updates
		.map(u => {
			const chatJid = u.key.remoteJid
			const messageId = u.key.id
			const userJid = u.receipt.userJid
			if (!chatJid || !messageId || !userJid) return null
			const tsField =
				u.receipt.readTimestamp ??
				u.receipt.playedTimestamp ??
				u.receipt.receiptTimestamp
			if (tsField == null) return null
			const ts = new Date(Number(tsField) * 1000)
			let receiptType: string
			if (u.receipt.readTimestamp != null) receiptType = 'read'
			else if (u.receipt.playedTimestamp != null) receiptType = 'played'
			else receiptType = 'delivery'
			return { accountId, chatJid, messageId, userJid, receiptType, ts }
		})
		.filter((r): r is NonNullable<typeof r> => r !== null)

	if (!rows.length) return
	await db.insert(messageReceipts).values(rows).onConflictDoNothing()
}
