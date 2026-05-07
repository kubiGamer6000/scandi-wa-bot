import { resolve } from 'node:path'

import 'dotenv/config'

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

const VALID_LOG_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']

const parseLogLevel = (raw: string | undefined): LogLevel => {
	const candidate = (raw ?? 'info').toLowerCase() as LogLevel
	return VALID_LOG_LEVELS.includes(candidate) ? candidate : 'info'
}

const parseBool = (raw: string | undefined, fallback: boolean): boolean => {
	if (raw === undefined) return fallback
	return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}

const parseList = (raw: string | undefined): string[] =>
	(raw ?? '')
		.split(',')
		.map(s => s.trim())
		.filter(Boolean)

const requireEnv = (name: string, hint: string): string => {
	const v = process.env[name]?.trim()
	if (!v) {
		throw new Error(`Missing required env var ${name}. ${hint}`)
	}
	return v
}

export interface AppConfig {
	readonly logLevel: LogLevel
	readonly databaseUrl: string
	readonly waAccountLabel: string
	readonly authDir: string
	readonly browser: {
		readonly platform: 'Ubuntu' | 'macOS' | 'Windows'
		readonly name: string
	}
	readonly syncFullHistory: boolean
	readonly markOnlineOnConnect: boolean
	/** When non-empty, bot will only send messages to these JIDs. */
	readonly allowedJids: readonly string[]
}

const browserPlatformRaw = (process.env.BROWSER_PLATFORM ?? 'Ubuntu').trim()
const browserPlatform: AppConfig['browser']['platform'] =
	browserPlatformRaw === 'macOS' || browserPlatformRaw === 'Windows' ? browserPlatformRaw : 'Ubuntu'

export const config: AppConfig = {
	logLevel: parseLogLevel(process.env.LOG_LEVEL),
	databaseUrl: requireEnv(
		'DATABASE_URL',
		'Set it from Supabase → Project Settings → Database → Connection string (Transaction pooler).'
	),
	waAccountLabel: process.env.WA_ACCOUNT_LABEL?.trim() || 'default',
	authDir: resolve(process.cwd(), process.env.AUTH_DIR ?? 'data/auth'),
	browser: {
		platform: browserPlatform,
		name: process.env.BROWSER_NAME?.trim() || 'Desktop'
	},
	syncFullHistory: parseBool(process.env.SYNC_FULL_HISTORY, true),
	markOnlineOnConnect: parseBool(process.env.MARK_ONLINE_ON_CONNECT, false),
	allowedJids: parseList(process.env.ALLOWED_JIDS)
}
