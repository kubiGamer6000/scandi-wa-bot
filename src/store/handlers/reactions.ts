import { sql, eq } from 'drizzle-orm'
import { proto, type WAMessageKey } from 'baileys'

import { schema } from '../../db/index.js'
import type { StoreContext } from '../types.js'

const { reactions, accounts } = schema

// Postgres `timestamptz` accepts a wide range, but values produced by
// misinterpreting microseconds as milliseconds (e.g. ~ year 58000) trigger
// "time zone displacement out of range" errors. Clamp to a sane WhatsApp era.
const MIN_MS = Date.UTC(2010, 0, 1)
const MAX_MS = Date.UTC(9999, 11, 31)

/** Convert a millisecond timestamp (from `senderTimestampMs` etc.) to a Date. */
const toDateFromMs = (v: number | Long | null | undefined): Date => {
	if (v == null) return new Date()
	const n = typeof v === 'number' ? v : Number(v)
	if (!Number.isFinite(n) || n < MIN_MS || n > MAX_MS) return new Date()
	return new Date(n)
}

/**
 * Phase 1 reaction handling for the legacy `messages.reaction` event path.
 * (Modern WA delivers reactions inline via `messages.upsert`, see
 * `recordInlineReaction` below — this remains for compatibility.)
 *
 *   - reaction.text empty/missing → reaction was removed
 *   - reaction.senderTimestampMs is preferred over the WAMessageKey timestamp
 */
export const handleReactions = async (
	ctx: StoreContext,
	events: Array<{ key: WAMessageKey; reaction: proto.IReaction }>
): Promise<void> => {
	const { accountId, db, log } = ctx
	for (const ev of events) {
		const chatJid = ev.key.remoteJid
		const messageId = ev.key.id
		const actorJid = ev.reaction.key?.participant ?? ev.reaction.key?.remoteJid
		if (!chatJid || !messageId || !actorJid) continue

		const ts = toDateFromMs(ev.reaction.senderTimestampMs as number | null | undefined)
		const emoji = ev.reaction.text?.trim() || null

		await db
			.insert(reactions)
			.values({ accountId, chatJid, messageId, actorJid, emoji, ts })
			.onConflictDoUpdate({
				target: [reactions.accountId, reactions.chatJid, reactions.messageId, reactions.actorJid],
				set: { emoji: sql`EXCLUDED.emoji`, ts: sql`EXCLUDED.ts` }
			})
		ctx.bus.emit({ type: 'message.reacted', chatJid, messageId, actorJid, emoji })
	}
	log.debug({ n: events.length }, 'reactions persisted')
}

export interface InlineReactionInput {
	chatJid: string
	targetId: string
	/** Empty/null emoji means "reaction removed". */
	emoji: string | null
	ts: Date
	fromMe: boolean
	/** Outer-envelope participant (groups). */
	participant: string | null
	/** Outer-envelope participantAlt (PN form). */
	senderPn: string | null
	/** Outer-envelope remoteJid — the chat itself. Used as DM counterpart fallback. */
	senderRemoteJid: string | null
}

/**
 * Cache of self JIDs per account, fetched lazily. Self JIDs are required to
 * label `fromMe` reactions with a stable actor identity.
 */
const selfCache = new Map<string, { lid: string | null; pn: string | null }>()

const fetchSelf = async (
	{ accountId, db }: StoreContext
): Promise<{ lid: string | null; pn: string | null }> => {
	const cached = selfCache.get(accountId)
	if (cached) return cached
	const rows = await db
		.select({ lid: accounts.selfLidJid, pn: accounts.selfPnJid })
		.from(accounts)
		.where(eq(accounts.id, accountId))
		.limit(1)
	const r = rows[0] ?? { lid: null, pn: null }
	selfCache.set(accountId, r)
	return r
}

/**
 * Picks the actor JID that owns this reaction. In a group, that's the
 * outer envelope's `participant`. In a DM, the outer envelope's `participant`
 * is empty, so we fall back to the chat counterpart for `!fromMe`, or to the
 * bot's own self JID (matching the chat's addressing mode) for `fromMe`.
 */
const resolveActor = (
	input: InlineReactionInput,
	self: { lid: string | null; pn: string | null }
): string | null => {
	if (input.participant) return input.participant
	if (input.fromMe) {
		const isLidChat = input.chatJid.endsWith('@lid')
		return isLidChat ? (self.lid ?? self.pn) : (self.pn ?? self.lid)
	}
	return input.senderRemoteJid ?? null
}

/**
 * Persists a reaction that arrived inline as a `messages.upsert` payload.
 * Idempotent: the (account, chat, message, actor) tuple is the conflict key,
 * and newer events overwrite older ones.
 */
export const recordInlineReaction = async (
	ctx: StoreContext,
	input: InlineReactionInput
): Promise<void> => {
	const self = await fetchSelf(ctx)
	const actorJid = resolveActor(input, self)
	if (!actorJid) {
		ctx.log.warn(
			{ chat: input.chatJid, target: input.targetId },
			'reaction skipped: could not resolve actor JID'
		)
		return
	}
	await ctx.db
		.insert(reactions)
		.values({
			accountId: ctx.accountId,
			chatJid: input.chatJid,
			messageId: input.targetId,
			actorJid,
			emoji: input.emoji,
			ts: input.ts
		})
		.onConflictDoUpdate({
			target: [reactions.accountId, reactions.chatJid, reactions.messageId, reactions.actorJid],
			set: {
				emoji: sql`CASE WHEN EXCLUDED.ts >= ${reactions.ts} THEN EXCLUDED.emoji ELSE ${reactions.emoji} END`,
				ts: sql`GREATEST(${reactions.ts}, EXCLUDED.ts)`
			}
		})
	ctx.bus.emit({
		type: 'message.reacted',
		chatJid: input.chatJid,
		messageId: input.targetId,
		actorJid,
		emoji: input.emoji
	})
	ctx.log.debug(
		{ chat: input.chatJid, target: input.targetId, actor: actorJid, emoji: input.emoji },
		'inline reaction recorded'
	)
}

/** Clear the cached self JID for an account (e.g. after re-pairing). */
export const invalidateSelfCache = (accountId?: string): void => {
	if (accountId) selfCache.delete(accountId)
	else selfCache.clear()
}
