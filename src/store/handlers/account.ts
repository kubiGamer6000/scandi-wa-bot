import { sql } from 'drizzle-orm'
import type { Logger } from 'pino'

import { config } from '../../config.js'
import { type Db, schema } from '../../db/index.js'

const { accounts, syncState } = schema

/**
 * Ensures the `wa.accounts` row for our label exists and returns its id.
 * Idempotent — safe to call on every startup.
 */
export const ensureAccount = async (db: Db, log: Logger): Promise<string> => {
	const rows = await db
		.insert(accounts)
		.values({
			label: config.waAccountLabel,
			authDir: config.authDir
		})
		.onConflictDoUpdate({
			target: accounts.label,
			set: { authDir: config.authDir }
		})
		.returning({ id: accounts.id })

	const id = rows[0]?.id
	if (!id) throw new Error('failed to create or fetch wa.accounts row')

	await db
		.insert(syncState)
		.values({ accountId: id })
		.onConflictDoNothing({ target: syncState.accountId })

	log.info({ accountId: id, label: config.waAccountLabel }, 'wa.accounts row ready')
	return id
}

/** Updates self_pn_jid / self_lid_jid / push_name once we know who we are. */
export const updateAccountIdentity = async (
	db: Db,
	accountId: string,
	patch: { selfPnJid?: string | null; selfLidJid?: string | null; pushName?: string | null }
): Promise<void> => {
	await db
		.update(accounts)
		.set({
			...(patch.selfPnJid !== undefined ? { selfPnJid: patch.selfPnJid } : {}),
			...(patch.selfLidJid !== undefined ? { selfLidJid: patch.selfLidJid } : {}),
			...(patch.pushName !== undefined ? { pushName: patch.pushName } : {}),
			lastSeenAt: sql`NOW()`
		})
		.where(sql`${accounts.id} = ${accountId}`)
}

export const markAccountStatus = async (
	db: Db,
	accountId: string,
	status: 'active' | 'logged_out' | 'paused'
): Promise<void> => {
	await db.update(accounts).set({ status }).where(sql`${accounts.id} = ${accountId}`)
}
