import { schema } from '../../db/index.js'
import type { StoreContext } from '../types.js'

const { lidMappings } = schema

/**
 * Persists every observed LID/PN pair. The PK on (account_id, lid) collapses
 * duplicates from history sync; on conflict we just refresh observed_at.
 */
export const upsertLidMappings = async (
	{ accountId, db, log }: StoreContext,
	pairs: Array<{ lid: string; pn: string }>
): Promise<void> => {
	const rows = pairs
		.filter(p => !!p.lid && !!p.pn)
		.map(p => ({ accountId, lid: p.lid, pn: p.pn }))

	if (!rows.length) return

	await db.insert(lidMappings).values(rows).onConflictDoNothing()

	log.debug({ n: rows.length }, 'lid mappings persisted')
}
