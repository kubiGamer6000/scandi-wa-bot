import type { BaileysEventMap, WAMessage } from 'baileys'
import { proto } from 'baileys'

import type { MessageCache } from '../cache.js'
import type { StoreContext } from '../types.js'

import { upsertChats } from './chats.js'
import { upsertContacts } from './contacts.js'
import { upsertLidMappings } from './lid.js'
import { upsertMessages } from './messages.js'
import { updateSyncState } from './misc.js'

type HistoryPayload = BaileysEventMap['messaging-history.set']

const messageKey = (m: WAMessage): string =>
	`${m.key.remoteJid ?? ''}|${m.key.id ?? ''}|${m.key.fromMe ? 1 : 0}`

const syncTypeName = (t: proto.HistorySync.HistorySyncType | null | undefined): string | null => {
	if (t == null) return null
	const e = proto.HistorySync.HistorySyncType
	for (const [k, v] of Object.entries(e)) {
		if (typeof v === 'number' && v === t) return k
	}
	return String(t)
}

/**
 * Single chunk of `messaging-history.set`. The payload may overlap with prior
 * chunks; idempotent upserts in `upsertMessages` make repeats safe.
 *
 * Inline chats[].messages[] (most recent message per chat) is merged with the
 * top-level `messages` array before insertion so we don't double-write.
 *
 * Note: messages may not have a chats[] entry (rare, but happens), so we
 * always run `upsertChats` from a SUPERSET of (top-level chats + chats
 * derived from messages). The chats handler will synthesize barebones rows
 * for jids we haven't seen.
 */
export const handleHistorySet = async (
	ctx: StoreContext,
	payload: HistoryPayload,
	cache: MessageCache | null
): Promise<void> => {
	const { log } = ctx
	const start = Date.now()

	if (payload.lidPnMappings?.length) {
		await upsertLidMappings(
			ctx,
			payload.lidPnMappings.map(m => ({ lid: m.lid, pn: m.pn }))
		)
	}

	if (payload.contacts?.length) {
		await upsertContacts(ctx, payload.contacts)
	}

	if (payload.chats?.length) {
		await upsertChats(ctx, payload.chats)
	}

	const merged = new Map<string, WAMessage>()
	if (payload.messages?.length) {
		for (const m of payload.messages) merged.set(messageKey(m), m)
	}
	if (payload.chats?.length) {
		for (const c of payload.chats) {
			if (!c.messages?.length) continue
			for (const wrapper of c.messages) {
				const inner = wrapper.message
				if (!inner) continue
				merged.set(messageKey(inner as WAMessage), inner as WAMessage)
			}
		}
	}

	if (merged.size) {
		await upsertMessages(ctx, [...merged.values()], cache)
	}

	await updateSyncState(ctx, {
		historyReceivedAt: new Date(),
		historyProgressPct: payload.progress ?? null,
		historyChunkOrder: payload.chunkOrder?.toString() ?? null,
		historySyncType: syncTypeName(payload.syncType),
		isLatest: payload.isLatest ?? null,
		lastEventAt: new Date()
	})

	log.info(
		{
			chats: payload.chats?.length ?? 0,
			contacts: payload.contacts?.length ?? 0,
			messages: merged.size,
			lidMappings: payload.lidPnMappings?.length ?? 0,
			isLatest: payload.isLatest,
			progress: payload.progress,
			chunkOrder: payload.chunkOrder,
			syncType: syncTypeName(payload.syncType),
			ms: Date.now() - start
		},
		'history chunk processed'
	)
}

/** `messaging-history.status` — flips initial_sync_done when WhatsApp says we're done. */
export const handleHistoryStatus = async (
	ctx: StoreContext,
	payload: BaileysEventMap['messaging-history.status']
): Promise<void> => {
	if (payload.status === 'complete') {
		await updateSyncState(ctx, {
			initialSyncDone: true,
			lastEventAt: new Date(),
			raw: payload
		})
		ctx.log.info(payload, 'history sync complete')
	} else {
		await updateSyncState(ctx, { lastEventAt: new Date(), raw: payload })
		ctx.log.info(payload, 'history sync paused')
	}
}
