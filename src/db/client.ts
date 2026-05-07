import { lookup } from 'node:dns/promises'

import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { config } from '../config.js'
import { childLogger } from '../logger.js'

import * as schema from './schema.js'

const log = childLogger('db')

/**
 * Pre-resolves the DB hostname to an IPv4 address. Some hosts (consumer ISPs,
 * Docker default networks) advertise IPv6 connectivity but can't actually
 * route to Supabase's IPv6 endpoint, leading to ENETUNREACH. By resolving up
 * front and rewriting the URL we sidestep Node's happy-eyeballs entirely.
 */
const resolveIpv4 = async (url: string): Promise<string> => {
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		return url
	}
	if (!parsed.hostname || /^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname)) return url
	try {
		const { address } = await lookup(parsed.hostname, { family: 4 })
		parsed.hostname = address
		return parsed.toString()
	} catch (err) {
		log.warn({ err, host: parsed.hostname }, 'IPv4 DNS resolution failed; falling back to default resolution')
		return url
	}
}

/**
 * Detects whether the connection URL is the Supabase transaction pooler
 * (port 6543). Transaction-mode pooling does not support PREPARE, so we must
 * disable prepared statements.
 *
 * Session-mode pooling (port 5432) and direct connections support PREPARE
 * fine, so we leave them alone.
 */
const isTransactionPooler = (url: string): boolean => {
	try {
		const port = new URL(url).port
		return port === '6543'
	} catch {
		return false
	}
}

const usePooler = isTransactionPooler(config.databaseUrl)

const resolvedUrl = await resolveIpv4(config.databaseUrl)

const sqlClient = postgres(resolvedUrl, {
	max: usePooler ? 10 : 5,
	idle_timeout: 20,
	connect_timeout: 10,
	prepare: !usePooler,
	onnotice: () => {}
})

export const db = drizzle(sqlClient, { schema, casing: 'snake_case' })

export const sql = sqlClient

/**
 * Probes the DB connection. Hard-fails the process on error so we never
 * silently start the bot with a misconfigured DATABASE_URL.
 */
export const verifyDb = async (): Promise<void> => {
	try {
		const rows = await sqlClient`SELECT current_database() AS db, current_user AS usr`
		log.info(
			{ db: rows[0]?.db, usr: rows[0]?.usr, pooler: usePooler },
			'database connection verified'
		)
	} catch (err) {
		log.fatal({ err }, 'failed to connect to DATABASE_URL — check the URL in .env')
		throw err
	}
}

export const closeDb = async (): Promise<void> => {
	await sqlClient.end({ timeout: 5 })
}

export type Db = typeof db
