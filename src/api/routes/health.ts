import { eq } from 'drizzle-orm'
import { Type } from '@sinclair/typebox'

import { db, schema } from '../../db/index.js'
import type { ApiDeps, TypedFastify } from '../types.js'

const { accounts, syncState } = schema

const HealthReply = Type.Object({
	status: Type.Literal('ok'),
	sock_connected: Type.Boolean(),
	/** ISO time the WhatsApp connection dropped; null while connected. */
	disconnected_since: Type.Union([Type.String(), Type.Null()]),
	/** False when the DB didn't answer within the health deadline. */
	db_ok: Type.Boolean(),
	account_label: Type.String(),
	last_event_at: Type.Union([Type.String(), Type.Null()]),
	initial_sync_done: Type.Boolean(),
	account_status: Type.String()
})

const MeReply = Type.Object({
	account_id: Type.String(),
	account_label: Type.String(),
	pn_jid: Type.Union([Type.String(), Type.Null()]),
	lid_jid: Type.Union([Type.String(), Type.Null()]),
	push_name: Type.Union([Type.String(), Type.Null()]),
	status: Type.String()
})

export const registerHealthRoutes = async (
	app: TypedFastify,
	deps: ApiDeps
): Promise<void> => {
	app.get(
		'/v1/health',
		{
			schema: { response: { 200: HealthReply } }
		},
		async () => {
			const accountId = deps.store.accountId

			// Health must always answer, even when the DB pool is wedged —
			// otherwise it hangs exactly when someone needs to see what's wrong.
			const withDeadline = <T>(query: Promise<T>): Promise<T | null> =>
				Promise.race([
					query,
					new Promise<null>(resolve => setTimeout(() => resolve(null), 3_000).unref())
				]).catch(() => null)

			const acctRows = await withDeadline(db
				.select({
					label: accounts.label,
					status: accounts.status
				})
				.from(accounts)
				.where(eq(accounts.id, accountId))
				.limit(1))

			const syncRows = await withDeadline(db
				.select({
					lastEventAt: syncState.lastEventAt,
					initialSyncDone: syncState.initialSyncDone
				})
				.from(syncState)
				.where(eq(syncState.accountId, accountId))
				.limit(1))
			const acct = acctRows?.[0]
			const sync = syncRows?.[0]
			const since = deps.getDisconnectedSince?.() ?? null

			return {
				status: 'ok' as const,
				sock_connected: deps.getSock() != null,
				disconnected_since: since === null ? null : new Date(since).toISOString(),
				db_ok: acctRows !== null && syncRows !== null,
				account_label: acct?.label ?? 'unknown',
				last_event_at: sync?.lastEventAt?.toISOString() ?? null,
				initial_sync_done: sync?.initialSyncDone ?? false,
				account_status: acct?.status ?? 'unknown'
			}
		}
	)

	app.get(
		'/v1/me',
		{
			schema: { response: { 200: MeReply } }
		},
		async () => {
			const accountId = deps.store.accountId

			const [row] = await db
				.select({
					label: accounts.label,
					selfPnJid: accounts.selfPnJid,
					selfLidJid: accounts.selfLidJid,
					pushName: accounts.pushName,
					status: accounts.status
				})
				.from(accounts)
				.where(eq(accounts.id, accountId))
				.limit(1)

			if (!row) {
				throw app.httpErrors.internalServerError('account row missing')
			}

			return {
				account_id: accountId,
				account_label: row.label,
				pn_jid: row.selfPnJid,
				lid_jid: row.selfLidJid,
				push_name: row.pushName,
				status: row.status
			}
		}
	)
}
