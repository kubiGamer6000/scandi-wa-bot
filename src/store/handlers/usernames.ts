import { sql } from 'drizzle-orm'

import { schema, type Db } from '../../db/index.js'
import type { UsernameSighting } from '../username-sightings.js'
import type { StoreContext } from '../types.js'

export { sightingsFromContacts, sightingsFromMessages } from '../username-sightings.js'
export type { UsernameSighting } from '../username-sightings.js'

const { usernames } = schema

/** Upsert sightings: the newest JID for a username wins. */
export const recordUsernames = async (
	db: Db,
	accountId: string,
	sightings: UsernameSighting[]
): Promise<number> => {
	const byName = new Map<string, UsernameSighting>()
	for (const s of sightings) byName.set(s.username, s)
	const rows = [...byName.values()].map(s => ({ accountId, username: s.username, jid: s.jid, source: s.source }))
	if (!rows.length) return 0
	await db
		.insert(usernames)
		.values(rows)
		.onConflictDoUpdate({
			target: [usernames.accountId, usernames.username],
			set: { jid: sql`EXCLUDED.jid`, source: sql`EXCLUDED.source`, lastSeenAt: sql`NOW()` }
		})
	return rows.length
}

export const recordUsernameSightings = async (
	{ accountId, db, log }: StoreContext,
	sightings: UsernameSighting[]
): Promise<void> => {
	const n = await recordUsernames(db, accountId, sightings)
	if (n) log.debug({ n }, 'usernames recorded')
}
