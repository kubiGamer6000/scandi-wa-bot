import { readdir, readFile, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { eq, and, inArray, sql } from 'drizzle-orm'
import {
	BufferJSON,
	initAuthCreds,
	makeCacheableSignalKeyStore,
	proto
} from 'baileys'
import type {
	AuthenticationCreds,
	AuthenticationState,
	SignalDataSet,
	SignalDataTypeMap,
	SignalKeyStore
} from 'baileys'

import { config } from './config.js'
import { db, schema } from './db/index.js'
import { childLogger } from './logger.js'

const log = childLogger('auth')

const { authCreds, authKeys } = schema

type SignalCategory = keyof SignalDataTypeMap

/**
 * Every key category Baileys persists, sorted longest-first so the legacy
 * file importer can disambiguate `app-state-sync-key-xxx` from `app-state-sync-version-xxx`
 * (both share a prefix). Mirrors `SignalDataTypeMap`.
 */
const KNOWN_KEY_TYPES = [
	'app-state-sync-version',
	'app-state-sync-key',
	'sender-key-memory',
	'identity-key',
	'lid-mapping',
	'device-list',
	'sender-key',
	'pre-key',
	'tctoken',
	'session'
] as const satisfies readonly SignalCategory[]

/**
 * Round-trips a value through `BufferJSON` so Buffer fields land in JSONB as
 * `{"type":"Buffer","data":"<base64>"}` — exactly the shape the file-based
 * reference implementation produces. This keeps wire-format parity with
 * Baileys' own helpers and lets us swap backends without re-pairing.
 */
const encode = (value: unknown): unknown =>
	JSON.parse(JSON.stringify(value, BufferJSON.replacer))

const decode = <T>(value: unknown): T =>
	JSON.parse(JSON.stringify(value), BufferJSON.reviver) as T

export interface AuthHandle {
	/** State to pass into `makeWASocket({ auth })`. */
	state: AuthenticationState
	/** Wire this to `sock.ev.on('creds.update', saveCreds)`. */
	saveCreds: () => Promise<void>
	/** Wipe every credential + signal key for this account. Call on permanent loggedOut. */
	clear: () => Promise<void>
}

/**
 * Loads (or initialises) a persistent Postgres-backed auth state for Baileys.
 *
 * Compared with `useMultiFileAuthState` (which Baileys explicitly warns
 * against in production), this implementation:
 *
 *   - Performs **bulk** SELECT/UPSERT/DELETE per Baileys batch — no per-key
 *     IO storm.
 *   - Wraps the underlying store in `makeCacheableSignalKeyStore` so hot keys
 *     never round-trip the DB during message decryption.
 *   - Is multi-account ready: every row is scoped by `account_id`.
 *   - Survives process restarts identically to the file-based impl: same
 *     BufferJSON wire format, same `app-state-sync-key` proto-class hydration.
 *
 * The first call for a brand-new account auto-imports an existing
 * `useMultiFileAuthState` directory (`config.authDir`) when present, so
 * upgrading bots don't need to re-pair.
 */
export const loadAuthState = async (accountId: string): Promise<AuthHandle> => {
	await maybeImportLegacyAuthDir(accountId)

	const existing = await db
		.select({ creds: authCreds.creds })
		.from(authCreds)
		.where(eq(authCreds.accountId, accountId))
		.limit(1)

	const creds: AuthenticationCreds = existing[0]?.creds
		? decode<AuthenticationCreds>(existing[0].creds)
		: initAuthCreds()

	if (existing[0]?.creds) {
		log.info({ accountId }, 'auth creds loaded from db')
	} else {
		log.info({ accountId }, 'no auth creds found — fresh pair will be required')
	}

	const saveCreds = async (): Promise<void> => {
		await db
			.insert(authCreds)
			.values({ accountId, creds: encode(creds) as object })
			.onConflictDoUpdate({
				target: [authCreds.accountId],
				set: { creds: sql`EXCLUDED.creds`, updatedAt: sql`NOW()` }
			})
	}

	const baseStore: SignalKeyStore = {
		get: async (type, ids) => {
			if (!ids.length) return {}
			const rows = await db
				.select({ id: authKeys.id, value: authKeys.value })
				.from(authKeys)
				.where(
					and(
						eq(authKeys.accountId, accountId),
						eq(authKeys.type, type),
						inArray(authKeys.id, ids)
					)
				)

			const out: { [id: string]: SignalDataTypeMap[typeof type] } = {}
			for (const row of rows) {
				let value = decode<SignalDataTypeMap[typeof type]>(row.value)
				if (type === 'app-state-sync-key' && value) {
					// app-state-sync-key arrives as a proto class instance from Baileys;
					// JSONB stores plain objects, so we re-hydrate to the proto class.
					value = proto.Message.AppStateSyncKeyData.fromObject(
						value as object
					) as unknown as SignalDataTypeMap[typeof type]
				}
				out[row.id] = value
			}
			return out
		},

		set: async (data: SignalDataSet) => {
			const upserts: Array<typeof authKeys.$inferInsert> = []
			const deletesByType = new Map<SignalCategory, string[]>()

			for (const category of Object.keys(data) as SignalCategory[]) {
				const bucket = data[category]
				if (!bucket) continue
				for (const id of Object.keys(bucket)) {
					const value = (bucket as Record<string, unknown>)[id]
					if (value == null) {
						const list = deletesByType.get(category) ?? []
						list.push(id)
						deletesByType.set(category, list)
					} else {
						upserts.push({
							accountId,
							type: category,
							id,
							value: encode(value) as object
						})
					}
				}
			}

			if (!upserts.length && !deletesByType.size) return

			// One transaction so partial failures don't leave the store inconsistent.
			// Each statement is itself atomic; the transaction is the cherry on top.
			await db.transaction(async tx => {
				if (upserts.length) {
					await tx
						.insert(authKeys)
						.values(upserts)
						.onConflictDoUpdate({
							target: [authKeys.accountId, authKeys.type, authKeys.id],
							set: {
								value: sql`EXCLUDED.value`,
								updatedAt: sql`NOW()`
							}
						})
				}
				for (const [type, ids] of deletesByType) {
					await tx
						.delete(authKeys)
						.where(
							and(
								eq(authKeys.accountId, accountId),
								eq(authKeys.type, type),
								inArray(authKeys.id, ids)
							)
						)
				}
			})
		},

		clear: async () => {
			await db.delete(authKeys).where(eq(authKeys.accountId, accountId))
		}
	}

	const keys = makeCacheableSignalKeyStore(baseStore, log)

	const clear = async (): Promise<void> => {
		await db.delete(authKeys).where(eq(authKeys.accountId, accountId))
		await db.delete(authCreds).where(eq(authCreds.accountId, accountId))
		log.warn({ accountId }, 'auth state cleared')
	}

	return {
		state: { creds, keys },
		saveCreds,
		clear
	}
}

/* -------------------- one-time legacy import -------------------- */

/**
 * If there is no auth row for this account in the DB but a legacy
 * `data/auth/` folder exists on disk, import it once and rename the folder
 * to `data/auth.migrated-<ts>` so subsequent boots skip the import.
 *
 * This is a non-destructive migration: the folder is preserved (renamed)
 * in case anyone needs to roll back.
 */
const maybeImportLegacyAuthDir = async (accountId: string): Promise<void> => {
	const folder = config.authDir

	const folderInfo = await stat(folder).catch(() => null)
	if (!folderInfo?.isDirectory()) return

	const credsPath = join(folder, 'creds.json')
	const credsExists = await stat(credsPath)
		.then(s => s.isFile())
		.catch(() => false)
	if (!credsExists) return

	const existing = await db
		.select({ accountId: authCreds.accountId })
		.from(authCreds)
		.where(eq(authCreds.accountId, accountId))
		.limit(1)
	if (existing[0]) return

	log.warn(
		{ folder, accountId },
		'legacy file-based auth detected — importing into Postgres (one-time)'
	)

	const credsRaw = await readFile(credsPath, 'utf-8')
	const credsJson = JSON.parse(credsRaw) as object
	await db
		.insert(authCreds)
		.values({ accountId, creds: credsJson })
		.onConflictDoUpdate({
			target: [authCreds.accountId],
			set: { creds: sql`EXCLUDED.creds`, updatedAt: sql`NOW()` }
		})

	const files = await readdir(folder)
	const keyRows: Array<typeof authKeys.$inferInsert> = []
	for (const f of files) {
		if (f === 'creds.json' || !f.endsWith('.json')) continue
		const base = f.slice(0, -'.json'.length)
		// Type names themselves contain dashes (`pre-key`, `app-state-sync-key`,
		// …) so we can't naively split on the last dash. Match the known types
		// longest-first and treat the rest as the id.
		const type = KNOWN_KEY_TYPES.find(t => base === t || base.startsWith(`${t}-`))
		if (!type || base.length <= type.length + 1) continue
		const idEncoded = base.slice(type.length + 1)
		// Reverse the fixFileName mangling done by useMultiFileAuthState:
		//   '/' → '__'   ':' → '-'
		const id = idEncoded.replace(/__/g, '/').replace(/-/g, ':')
		const raw = await readFile(join(folder, f), 'utf-8').catch(() => null)
		if (!raw) continue
		try {
			keyRows.push({
				accountId,
				type,
				id,
				value: JSON.parse(raw) as object
			})
		} catch (err) {
			log.warn({ err, file: f }, 'skipping unparseable legacy auth file')
		}
	}

	if (keyRows.length) {
		// Drizzle has a default insert chunking limit; play it safe with batches.
		const BATCH = 200
		for (let i = 0; i < keyRows.length; i += BATCH) {
			const slice = keyRows.slice(i, i + BATCH)
			await db
				.insert(authKeys)
				.values(slice)
				.onConflictDoUpdate({
					target: [authKeys.accountId, authKeys.type, authKeys.id],
					set: { value: sql`EXCLUDED.value`, updatedAt: sql`NOW()` }
				})
		}
	}

	const archived = `${folder}.migrated-${new Date().toISOString().replace(/[:.]/g, '-')}`
	await rename(folder, archived).catch(err =>
		log.warn({ err, folder, archived }, 'failed to archive legacy auth dir')
	)

	log.info(
		{ creds: 1, keys: keyRows.length, archived },
		'legacy auth state imported into Postgres'
	)
}
