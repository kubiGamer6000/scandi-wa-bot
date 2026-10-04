/**
 * Manage scoped API keys (wa.api_keys).
 *
 *   npm run api-key -- create "editor-app" [--scopes notify] [--per-minute 30] [--per-day 1000]
 *   npm run api-key -- list
 *   npm run api-key -- revoke <id | key prefix>
 *
 * The full key is printed once, at creation. Only its sha256 is stored, so a
 * lost key can't be recovered — revoke it and create a new one.
 */
import { and, eq, isNull, like, or, sql } from 'drizzle-orm'

import { config } from '../config.js'
import { closeDb, db, schema } from '../db/index.js'
import { generateKey, hashKey, KEY_PREFIX } from '../api/auth.js'

const KNOWN_SCOPES = ['notify']

const argv = process.argv.slice(2)
const command = argv[0]

const flag = (name: string): string | undefined => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 ? argv[i + 1] : undefined
}

const fail = (message: string): never => {
	console.error(`error: ${message}`)
	process.exit(1)
}

const accountId = async (): Promise<string> => {
	const [row] = await db
		.select({ id: schema.accounts.id })
		.from(schema.accounts)
		.where(eq(schema.accounts.label, config.waAccountLabel))
		.limit(1)
	return row?.id ?? fail(`no wa.accounts row for label "${config.waAccountLabel}" — has the bot run yet?`)
}

const main = async (): Promise<void> => {
	switch (command) {
		case 'create': {
			const label = argv[1]
			if (!label || label.startsWith('--')) fail('usage: create "<label>" [--scopes notify] [--per-minute N] [--per-day N]')
			const scopes = (flag('scopes') ?? 'notify').split(',').map(s => s.trim()).filter(Boolean)
			const unknown = scopes.filter(s => !KNOWN_SCOPES.includes(s))
			if (unknown.length) fail(`unknown scope(s): ${unknown.join(', ')} (known: ${KNOWN_SCOPES.join(', ')})`)
			const perMinute = Number(flag('per-minute') ?? 30)
			const perDay = Number(flag('per-day') ?? 1000)
			if (!(perMinute > 0 && perDay > 0)) fail('--per-minute and --per-day must be positive numbers')

			const key = generateKey()
			const [row] = await db
				.insert(schema.apiKeys)
				.values({
					accountId: await accountId(),
					label: label!,
					keyPrefix: key.slice(0, KEY_PREFIX.length + 8),
					keyHash: hashKey(key),
					scopes,
					ratePerMinute: perMinute,
					ratePerDay: perDay
				})
				.returning({ id: schema.apiKeys.id })

			console.log(`\nCreated API key "${label}" (${row!.id})`)
			console.log(`scopes: ${scopes.join(', ')} · limits: ${perMinute}/min, ${perDay}/day\n`)
			console.log(`  ${key}\n`)
			console.log('Store it in the calling app\'s secrets now — it is not shown again.')
			break
		}

		case 'list': {
			const rows = await db
				.select({
					id: schema.apiKeys.id,
					label: schema.apiKeys.label,
					prefix: schema.apiKeys.keyPrefix,
					scopes: schema.apiKeys.scopes,
					perMinute: schema.apiKeys.ratePerMinute,
					perDay: schema.apiKeys.ratePerDay,
					created: schema.apiKeys.createdAt,
					lastUsed: schema.apiKeys.lastUsedAt,
					revoked: schema.apiKeys.revokedAt,
					sent24h: sql<number>`(select count(*)::int from wa.notifications n
						where n.api_key_id = wa.api_keys.id and n.status = 'sent'
						and n.created_at > now() - interval '24 hours')`
				})
				.from(schema.apiKeys)
				.orderBy(schema.apiKeys.createdAt)
			if (!rows.length) {
				console.log('no API keys yet — create one with: npm run api-key -- create "<label>"')
				break
			}
			console.table(
				rows.map(r => ({
					id: r.id,
					label: r.label,
					prefix: `${r.prefix}…`,
					scopes: r.scopes.join(','),
					limits: `${r.perMinute}/min ${r.perDay}/day`,
					'sent 24h': r.sent24h,
					'last used': r.lastUsed?.toISOString().slice(0, 16) ?? '—',
					status: r.revoked ? `revoked ${r.revoked.toISOString().slice(0, 10)}` : 'active'
				}))
			)
			break
		}

		case 'revoke': {
			const target = argv[1] ?? fail('usage: revoke <id | key prefix>')
			const isUuid = /^[0-9a-f-]{36}$/i.test(target!)
			const revoked = await db
				.update(schema.apiKeys)
				.set({ revokedAt: new Date() })
				.where(
					and(
						isNull(schema.apiKeys.revokedAt),
						isUuid
							? eq(schema.apiKeys.id, target!)
							: or(like(schema.apiKeys.keyPrefix, `${target!.replace(/…$/, '')}%`))
					)
				)
				.returning({ id: schema.apiKeys.id, label: schema.apiKeys.label })
			if (revoked.length === 0) fail(`no active key matches "${target}"`)
			if (revoked.length > 1) console.warn(`warning: revoked ${revoked.length} keys matching "${target}"`)
			for (const r of revoked) console.log(`revoked "${r.label}" (${r.id}) — takes effect within 30s`)
			break
		}

		default:
			console.log(
				'usage:\n' +
					'  npm run api-key -- create "<label>" [--scopes notify] [--per-minute 30] [--per-day 1000]\n' +
					'  npm run api-key -- list\n' +
					'  npm run api-key -- revoke <id | key prefix>'
			)
	}
}

main()
	.catch(err => {
		console.error(err instanceof Error ? err.message : err)
		process.exitCode = 1
	})
	.finally(() => closeDb().catch(() => undefined))
