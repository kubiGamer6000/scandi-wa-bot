import { sql } from 'drizzle-orm'
import type { Contact } from 'baileys'

import { schema } from '../../db/index.js'
import { serializeForJsonb } from '../serialize.js'
import type { StoreContext } from '../types.js'

const { contacts } = schema

const buildRow = (accountId: string, c: Contact) => ({
	accountId,
	jid: c.id,
	pn: c.phoneNumber ?? null,
	lid: c.lid ?? null,
	name: c.name ?? null,
	pushName: c.notify ?? null,
	isBusiness: !!c.verifiedName,
	businessInfo: c.verifiedName ? { verifiedName: c.verifiedName } : null,
	raw: serializeForJsonb(c) as object
})

/**
 * Newer-data-wins upsert for contacts. We never overwrite a known name with
 * NULL, so partial updates from history sync chunks compose cleanly with
 * later real-time updates.
 */
export const upsertContacts = async (
	{ accountId, db, log }: StoreContext,
	list: Contact[]
): Promise<void> => {
	if (!list.length) return

	const rows = list
		.filter(c => !!c.id)
		.map(c => buildRow(accountId, c))

	if (!rows.length) return

	await db
		.insert(contacts)
		.values(rows)
		.onConflictDoUpdate({
			target: [contacts.accountId, contacts.jid],
			set: {
				pn: sql`COALESCE(EXCLUDED.pn, ${contacts.pn})`,
				lid: sql`COALESCE(EXCLUDED.lid, ${contacts.lid})`,
				name: sql`COALESCE(EXCLUDED.name, ${contacts.name})`,
				pushName: sql`COALESCE(EXCLUDED.push_name, ${contacts.pushName})`,
				isBusiness: sql`${contacts.isBusiness} OR EXCLUDED.is_business`,
				businessInfo: sql`COALESCE(EXCLUDED.business_info, ${contacts.businessInfo})`,
				raw: sql`EXCLUDED.raw`,
				lastSeenAt: sql`NOW()`
			}
		})

	log.debug({ n: rows.length }, 'contacts upserted')
}
