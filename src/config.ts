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
	readonly api: ApiConfig
	readonly webhooks: WebhookConfig
	readonly readReceipts: ReadReceiptConfig
	readonly typing: TypingConfig
}

export interface ReadReceiptConfig {
	/** Master switch. When off, no read receipts are ever sent. */
	readonly enabled: boolean
	/**
	 * Chats we send receipts for. `['*']` (default) means every DM and group.
	 * Anything else is an exact JID allow-list.
	 */
	readonly jids: readonly string[]
	/**
	 * Randomised think-time before a batch of receipts goes out. Receipts that
	 * land the same millisecond a message arrives read like a machine, so we
	 * wait a human-ish moment first.
	 */
	readonly delayMinMs: number
	readonly delayMaxMs: number
	/** Max keys per `readMessages()` call. Larger batches are split. */
	readonly batchSize: number
	/** Floor on the gap between two consecutive receipt flushes. */
	readonly minIntervalMs: number
}

export interface TypingConfig {
	/** Master switch for the `composing`/`recording` chatstate endpoints. */
	readonly enabled: boolean
	/**
	 * How often we re-send the chatstate. WhatsApp expires a typing indicator
	 * after ~10s, so this must stay under that; jitter is applied on top.
	 */
	readonly refreshMs: number
	/** Jitter (±) applied to every refresh so the cadence isn't metronomic. */
	readonly refreshJitterMs: number
	/** Session lifetime when the caller doesn't pass an explicit `ttl_ms`. */
	readonly defaultTtlMs: number
	/** Upper bound a caller may request for a single session. */
	readonly maxTtlMs: number
	/** Hard ceiling on one session's total lifetime, refreshes included. */
	readonly maxSessionMs: number
	/** Cap on chats typing at once — a bot typing everywhere looks automated. */
	readonly maxConcurrentChats: number
	/**
	 * Whether to flip global presence to `available` while typing. Off by
	 * default: going online suppresses push notifications on the paired phone
	 * (the same reason `MARK_ONLINE_ON_CONNECT` defaults to false).
	 */
	readonly markAvailable: boolean
}

export interface ApiConfig {
	readonly enabled: boolean
	/** Bind address. 127.0.0.1 by default — reverse-proxy via Nginx/Caddy for TLS. */
	readonly host: string
	readonly port: number
	/** Bearer token clients must send in Authorization. Required when `enabled`. */
	readonly authToken: string | null
	/** Cap on inbound request bodies (multipart for media uploads). */
	readonly maxBodyBytes: number
}

export interface WebhookConfig {
	/** Number of deliveries in flight at once. */
	readonly concurrency: number
	/** Rows claimed per poll cycle. */
	readonly batchSize: number
	/** Idle poll interval. Worker also wakes when a new delivery is enqueued. */
	readonly pollIntervalMs: number
	/** How long the worker holds a delivery's lease before re-claim. */
	readonly leaseSeconds: number
	/** Cap on attempts before a delivery is marked terminally abandoned. */
	readonly maxAttempts: number
	/** Per-request HTTP timeout. */
	readonly timeoutMs: number
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

export type LlamaParseTier = 'fast' | 'cost_effective' | 'agentic' | 'agentic_plus'
const LLAMAPARSE_TIERS: readonly LlamaParseTier[] = [
	'fast',
	'cost_effective',
	'agentic',
	'agentic_plus'
]

const parseLlamaParseTier = (raw: string | undefined): LlamaParseTier => {
	const v = raw?.trim() || 'agentic'
	if ((LLAMAPARSE_TIERS as readonly string[]).includes(v)) return v as LlamaParseTier
	throw new Error(
		`Invalid PROCESSING_LLAMAPARSE_TIER='${v}'. Valid: ${LLAMAPARSE_TIERS.join(', ')}`
	)
}

export interface ProcessingConfig {
	readonly enabled: boolean
	readonly geminiApiKey: string | null
	readonly geminiModel: string
	readonly elevenlabsApiKey: string | null
	readonly elevenlabsModel: string
	readonly llamaCloudApiKey: string | null
	readonly llamaParseTier: LlamaParseTier
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
		llamaParseTier: parseLlamaParseTier(process.env.PROCESSING_LLAMAPARSE_TIER),
		concurrency: Math.max(1, parseIntEnv(process.env.PROCESSING_CONCURRENCY, 2)),
		batchSize: Math.max(1, parseIntEnv(process.env.PROCESSING_BATCH_SIZE, 5)),
		pollIntervalMs: Math.max(1000, parseIntEnv(process.env.PROCESSING_POLL_MS, 10_000)),
		leaseSeconds: Math.max(60, parseIntEnv(process.env.PROCESSING_LEASE_SECONDS, 600)),
		maxAttempts: Math.max(1, parseIntEnv(process.env.PROCESSING_MAX_ATTEMPTS, 4)),
		promptVideo: process.env.PROCESSING_PROMPT_VIDEO?.trim() || null,
		promptImage: process.env.PROCESSING_PROMPT_IMAGE?.trim() || null
	}
}

const buildApiConfig = (): ApiConfig => {
	const enabled = parseBool(process.env.API_ENABLED, false)
	const authToken = process.env.API_AUTH_TOKEN?.trim() || null
	if (enabled && !authToken) {
		throw new Error('API_ENABLED=true but API_AUTH_TOKEN is empty. Refuse to start an unauthenticated API.')
	}
	return {
		enabled,
		host: process.env.API_HOST?.trim() || '127.0.0.1',
		port: Math.max(1, parseIntEnv(process.env.API_PORT, 8787)),
		authToken,
		maxBodyBytes: Math.max(1, parseIntEnv(process.env.API_MAX_BODY_MB, 25)) * 1024 * 1024
	}
}

const buildWebhookConfig = (): WebhookConfig => ({
	concurrency: Math.max(1, parseIntEnv(process.env.WEBHOOK_CONCURRENCY, 4)),
	batchSize: Math.max(1, parseIntEnv(process.env.WEBHOOK_BATCH_SIZE, 10)),
	pollIntervalMs: Math.max(500, parseIntEnv(process.env.WEBHOOK_POLL_MS, 5_000)),
	leaseSeconds: Math.max(15, parseIntEnv(process.env.WEBHOOK_LEASE_SECONDS, 60)),
	maxAttempts: Math.max(1, parseIntEnv(process.env.WEBHOOK_MAX_ATTEMPTS, 6)),
	timeoutMs: Math.max(1000, parseIntEnv(process.env.WEBHOOK_TIMEOUT_MS, 10_000))
})

const buildReadReceiptConfig = (): ReadReceiptConfig => {
	const jids = parseList(process.env.READ_RECEIPTS_JIDS)
	const delayMinMs = Math.max(0, parseIntEnv(process.env.READ_RECEIPTS_DELAY_MIN_MS, 600))
	const delayMaxMs = Math.max(delayMinMs, parseIntEnv(process.env.READ_RECEIPTS_DELAY_MAX_MS, 2_500))
	return {
		enabled: parseBool(process.env.READ_RECEIPTS_ENABLED, true),
		jids: jids.length > 0 ? jids : ['*'],
		delayMinMs,
		delayMaxMs,
		batchSize: Math.max(1, parseIntEnv(process.env.READ_RECEIPTS_BATCH_SIZE, 25)),
		minIntervalMs: Math.max(0, parseIntEnv(process.env.READ_RECEIPTS_MIN_INTERVAL_MS, 750))
	}
}

const buildTypingConfig = (): TypingConfig => {
	// Keep the refresh floor under WhatsApp's ~10s chatstate expiry even after
	// the worst-case negative jitter, otherwise the indicator flickers.
	const refreshMs = Math.min(9_000, Math.max(3_000, parseIntEnv(process.env.TYPING_REFRESH_MS, 7_500)))
	const refreshJitterMs = Math.max(
		0,
		Math.min(refreshMs - 2_000, parseIntEnv(process.env.TYPING_REFRESH_JITTER_MS, 1_200))
	)
	const maxTtlMs = Math.max(10_000, parseIntEnv(process.env.TYPING_MAX_TTL_MS, 300_000))
	const defaultTtlMs = Math.min(maxTtlMs, Math.max(5_000, parseIntEnv(process.env.TYPING_TTL_MS, 120_000)))
	return {
		enabled: parseBool(process.env.TYPING_ENABLED, true),
		refreshMs,
		refreshJitterMs,
		defaultTtlMs,
		maxTtlMs,
		maxSessionMs: Math.max(maxTtlMs, parseIntEnv(process.env.TYPING_MAX_SESSION_MS, 900_000)),
		maxConcurrentChats: Math.max(1, parseIntEnv(process.env.TYPING_MAX_CONCURRENT_CHATS, 10)),
		markAvailable: parseBool(process.env.TYPING_MARK_AVAILABLE, false)
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
	processing: buildProcessingConfig(),
	api: buildApiConfig(),
	webhooks: buildWebhookConfig(),
	readReceipts: buildReadReceiptConfig(),
	typing: buildTypingConfig()
}
