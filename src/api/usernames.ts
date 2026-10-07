import { and, eq, sql } from 'drizzle-orm'
import type { WASocket } from 'baileys'

import { db, schema } from '../db/index.js'
import { recordUsernames } from '../store/handlers/usernames.js'
import { isIndividual, usyncLookupUsername } from './username-lookup.js'

/**
 * Resolve a WhatsApp username to the JID to message (the person's LID when
 * WhatsApp gives one).
 *
 * Order, cheapest and most trustworthy first:
 *   1. in-memory cache (hits and misses);
 *   2. wa.usernames — earlier lookups, plus usernames WhatsApp itself attached
 *      to contacts and incoming messages (so anyone who has messaged the bot
 *      resolves without asking WhatsApp anything);
 *   3. a USync lookup by username — the same query WhatsApp clients use for
 *      "message by username" (`<contact username="…" pin="…"/>`), sent through
 *      Baileys' own USyncContactProtocol + USyncLIDProtocol. A hit is stored
 *      in wa.usernames.
 *
 * Usernames can be changed and later taken by someone else, so a stored row
 * is trusted for STORED_TRUST_MS after it was last seen; an older row is
 * re-checked with WhatsApp before use.
 */

const HIT_TTL_MS = 6 * 60 * 60 * 1000
const MISS_TTL_MS = 15 * 60 * 1000
const STORED_TRUST_MS = 30 * 24 * 60 * 60 * 1000

const cache = new Map<string, { jid: string | null; at: number }>()

const fromStore = async (
	accountId: string,
	username: string
): Promise<{ jid: string; fresh: boolean } | null> => {
	const [row] = await db
		.select({ jid: schema.usernames.jid, lastSeenAt: schema.usernames.lastSeenAt })
		.from(schema.usernames)
		.where(and(eq(schema.usernames.accountId, accountId), eq(schema.usernames.username, username)))
		.limit(1)
	if (row) return { jid: row.jid, fresh: Date.now() - row.lastSeenAt.getTime() < STORED_TRUST_MS }
	// Contacts stored before wa.usernames existed keep the username in raw.
	const [contact] = await db
		.select({ jid: schema.contacts.jid, lid: schema.contacts.lid })
		.from(schema.contacts)
		.where(
			and(
				eq(schema.contacts.accountId, accountId),
				sql`lower(${schema.contacts.raw}->>'username') = ${username}`
			)
		)
		.limit(1)
	const jid = contact ? (isIndividual(contact.lid) ? contact.lid : contact.jid) : null
	return isIndividual(jid) ? { jid, fresh: true } : null
}

export const resolveUsername = async (
	sock: Pick<WASocket, 'executeUSyncQuery'>,
	accountId: string,
	username: string,
	key?: string
): Promise<string | null> => {
	const cacheKey = `${username}#${key ?? ''}`
	const cached = cache.get(cacheKey)
	if (cached && Date.now() - cached.at < (cached.jid ? HIT_TTL_MS : MISS_TTL_MS)) return cached.jid

	const stored = await fromStore(accountId, username)
	if (stored?.fresh) {
		cache.set(cacheKey, { jid: stored.jid, at: Date.now() })
		return stored.jid
	}

	const jid = await usyncLookupUsername(sock, username, key)
	cache.set(cacheKey, { jid, at: Date.now() })
	if (jid) await recordUsernames(db, accountId, [{ username, jid, source: 'usync' }])
	return jid
}

/** Test hook. */
export const clearUsernameCache = (): void => cache.clear()
