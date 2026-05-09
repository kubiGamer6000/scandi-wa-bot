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

const parseIntEnv = (raw: string | undefined, fallback: number): number => {
	if (raw === undefined) return fallback
	const n = Number(raw)
	return Number.isFinite(n) ? Math.trunc(n) : fallback
}

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
	readonly media: MediaConfig
	readonly processing: ProcessingConfig
}

export interface MediaConfig {
	readonly enabled: boolean
	/** Maximum total bytes to download for a single media. Larger files are skipped. */
	readonly maxBytes: number
	/** Comma-separated list of media types to download (image, video, audio, document, sticker, ptv, gif). */
	readonly types: readonly string[]
	/** Number of media downloads in flight at once. */
	readonly concurrency: number
	/** Rows claimed per poll cycle. */
	readonly batchSize: number
	/** Idle poll interval. Worker also wakes when new media is enqueued. */
	readonly pollIntervalMs: number
	/** How long the worker holds a row's lease before it can be re-claimed. */
	readonly leaseSeconds: number
	/** Cap on attempts before a row is marked terminally failed. */
	readonly maxAttempts: number
	readonly firebase: FirebaseConfig | null
}

export interface FirebaseConfig {
	readonly storageBucket: string
	/** Path to a service account JSON file. Takes precedence over GOOGLE_APPLICATION_CREDENTIALS. */
	readonly serviceAccountPath: string | null
	/** Inline JSON service account payload (for env-only deploys). */
	readonly serviceAccountJson: string | null
	readonly projectId: string | null
}

const DEFAULT_MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker', 'ptv', 'gif']

const buildFirebaseConfig = (): FirebaseConfig | null => {
	const bucket = process.env.FIREBASE_STORAGE_BUCKET?.trim()
	if (!bucket) return null
	return {
		storageBucket: bucket,
		serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim() || null,
		serviceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim() || null,
		projectId: process.env.FIREBASE_PROJECT_ID?.trim() || null
	}
}

const buildMediaConfig = (): MediaConfig => {
	const firebase = buildFirebaseConfig()
	const explicitlyEnabled = process.env.MEDIA_DOWNLOAD_ENABLED
	const enabled =
		explicitlyEnabled === undefined ? firebase != null : parseBool(explicitlyEnabled, true)
	const types = parseList(process.env.MEDIA_TYPES)
	return {
		enabled,
		maxBytes: parseIntEnv(process.env.MEDIA_MAX_BYTES, 100 * 1024 * 1024),
		types: types.length > 0 ? types : DEFAULT_MEDIA_TYPES,
		concurrency: Math.max(1, parseIntEnv(process.env.MEDIA_DOWNLOAD_CONCURRENCY, 3)),
		batchSize: Math.max(1, parseIntEnv(process.env.MEDIA_DOWNLOAD_BATCH_SIZE, 10)),
		pollIntervalMs: Math.max(500, parseIntEnv(process.env.MEDIA_DOWNLOAD_POLL_MS, 5000)),
		leaseSeconds: Math.max(15, parseIntEnv(process.env.MEDIA_LEASE_SECONDS, 120)),
		maxAttempts: Math.max(1, parseIntEnv(process.env.MEDIA_MAX_ATTEMPTS, 6)),
		firebase
	}
}

export interface ProcessingConfig {
	readonly enabled: boolean
	readonly geminiApiKey: string | null
	readonly geminiModel: string
	readonly elevenlabsApiKey: string | null
	readonly elevenlabsModel: string
	readonly llamaCloudApiKey: string | null
	readonly llamaParseTier: string
	readonly concurrency: number
	readonly batchSize: number
	readonly pollIntervalMs: number
	readonly leaseSeconds: number
	readonly maxAttempts: number
	readonly promptVideo: string | null
	readonly promptImage: string | null
}

const buildProcessingConfig = (): ProcessingConfig => {
	const geminiApiKey = process.env.GEMINI_API_KEY?.trim() || null
	const elevenlabsApiKey = process.env.ELEVENLABS_API_KEY?.trim() || null
	const llamaCloudApiKey = process.env.LLAMA_CLOUD_API_KEY?.trim() || null
	const hasAnyKey = !!(geminiApiKey || elevenlabsApiKey || llamaCloudApiKey)
	const explicitlyEnabled = process.env.PROCESSING_ENABLED
	const enabled =
		explicitlyEnabled === undefined ? hasAnyKey : parseBool(explicitlyEnabled, true)
	return {
		enabled,
		geminiApiKey,
		geminiModel: process.env.PROCESSING_MODEL_VIDEO?.trim() || 'gemini-2.5-flash',
		elevenlabsApiKey,
		elevenlabsModel: process.env.PROCESSING_MODEL_AUDIO?.trim() || 'scribe_v2',
		llamaCloudApiKey,
		llamaParseTier: process.env.PROCESSING_LLAMAPARSE_TIER?.trim() || 'agentic',
		concurrency: Math.max(1, parseIntEnv(process.env.PROCESSING_CONCURRENCY, 2)),
		batchSize: Math.max(1, parseIntEnv(process.env.PROCESSING_BATCH_SIZE, 5)),
		pollIntervalMs: Math.max(1000, parseIntEnv(process.env.PROCESSING_POLL_MS, 10_000)),
		leaseSeconds: Math.max(60, parseIntEnv(process.env.PROCESSING_LEASE_SECONDS, 600)),
		maxAttempts: Math.max(1, parseIntEnv(process.env.PROCESSING_MAX_ATTEMPTS, 4)),
		promptVideo: process.env.PROCESSING_PROMPT_VIDEO?.trim() || null,
		promptImage: process.env.PROCESSING_PROMPT_IMAGE?.trim() || null
	}
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
	allowedJids: parseList(process.env.ALLOWED_JIDS),
	media: buildMediaConfig(),
	processing: buildProcessingConfig()
}
