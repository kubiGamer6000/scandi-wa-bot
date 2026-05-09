import { Boom } from '@hapi/boom'
import makeWASocket, {
	Browsers,
	type ConnectionState,
	DisconnectReason,
	type GroupMetadata,
	type WASocket
} from 'baileys'
import qrcode from 'qrcode-terminal'

import { loadAuthState, type AuthHandle } from './auth.js'
import { config } from './config.js'
import { childLogger, logger } from './logger.js'
import { ChatStore } from './store/index.js'
import { buildMediaStorage, MediaWorker } from './store/media/index.js'
import { ProcessingWorker } from './store/processing/index.js'
import { db } from './db/index.js'

const log = childLogger('bot')

/** Backoff sequence (ms) used between reconnect attempts. */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const

const pickBrowser = (): [string, string, string] => {
	switch (config.browser.platform) {
		case 'macOS':
			return Browsers.macOS(config.browser.name)
		case 'Windows':
			return Browsers.windows(config.browser.name)
		case 'Ubuntu':
		default:
			return Browsers.ubuntu(config.browser.name)
	}
}

/**
 * Long-running WhatsApp bot.
 *
 * Owns the socket lifecycle: handles QR pairing, persists credentials,
 * transparently reconnects on transient drops, and pumps every Baileys
 * event into the persistent {@link ChatStore}.
 */
export class Bot {
	private sock: WASocket | undefined
	private shuttingDown = false
	private reconnectAttempt = 0
	private store: ChatStore | undefined
	private auth: AuthHandle | undefined
	private mediaWorker: MediaWorker | undefined
	private processingWorker: ProcessingWorker | undefined

	/** Cached group metadata to avoid a USync request on every group send. */
	private readonly groupCache = new Map<string, GroupMetadata>()

	async start(): Promise<void> {
		this.store = await ChatStore.open()
		// Auth state is loaded once per process. Reconnects re-use the same
		// `creds` reference (Baileys mutates it in place); signal keys go
		// through the cached store, which is itself stable.
		this.auth = await loadAuthState(this.store.accountId)

		// Media downloader runs as an independent worker, polling wa.media for
		// rows in 'pending' status. The store wakes it up after every upsert.
		const storage = buildMediaStorage(config.media.firebase)
		this.mediaWorker = new MediaWorker(
			{ accountId: this.store.accountId, db, log: childLogger('store:media') },
			storage,
			config.media
		)
		this.mediaWorker.bindSocket(() => this.sock ?? null)
		this.store.bindMediaQueue(this.mediaWorker)
		this.mediaWorker.start()

		// AI processing worker: drains wa.media_processing after media
		// download completes. Routes to Gemini / ElevenLabs / LlamaParse.
		this.processingWorker = new ProcessingWorker(
			{ accountId: this.store.accountId, db, log: childLogger('store:processing') },
			storage,
			config.processing
		)
		this.processingWorker.start()

		await this.connect()
	}

	/** Cleanly close the socket. Idempotent. */
	async stop(): Promise<void> {
		if (this.shuttingDown) return
		this.shuttingDown = true
		log.info('shutting down')
		try {
			await this.sock?.end(undefined)
		} catch (err) {
			log.warn({ err }, 'error during socket shutdown (ignored)')
		}
		try {
			await this.mediaWorker?.stop()
		} catch (err) {
			log.warn({ err }, 'error stopping media worker (ignored)')
		}
		try {
			await this.processingWorker?.stop()
		} catch (err) {
			log.warn({ err }, 'error stopping processing worker (ignored)')
		}
	}

	private async connect(): Promise<void> {
		if (!this.store || !this.auth) throw new Error('Bot.connect called before start()')
		const { state, saveCreds } = this.auth

		log.info(
			{
				syncFullHistory: config.syncFullHistory,
				browser: `${config.browser.platform}/${config.browser.name}`
			},
			'connecting to WhatsApp'
		)

		// We intentionally do NOT call fetchLatestBaileysVersion(): per the
		// Baileys 7.x docs the WA Web version is pinned to the library version
		// (ProtoCocktail), and dynamically fetching the latest version risks
		// protocol incompatibility.
		const sock = makeWASocket({
			auth: state,
			logger,
			browser: pickBrowser(),
			markOnlineOnConnect: config.markOnlineOnConnect,
			generateHighQualityLinkPreview: false,
			syncFullHistory: config.syncFullHistory,
			getMessage: this.store.getMessage,
			cachedGroupMetadata: async jid => this.groupCache.get(jid)
		})

		this.sock = sock

		this.store.bind(sock)

		sock.ev.on('creds.update', saveCreds)
		sock.ev.on('connection.update', update => void this.onConnectionUpdate(update))

		// Refresh in-memory group metadata cache (separate concern from the persistent store).
		sock.ev.on('groups.update', async events => {
			for (const e of events) {
				if (!e.id) continue
				try {
					this.groupCache.set(e.id, await sock.groupMetadata(e.id))
				} catch (err) {
					log.warn({ err, id: e.id }, 'failed to refresh group metadata')
				}
			}
		})

		sock.ev.on('group-participants.update', async ({ id }) => {
			try {
				this.groupCache.set(id, await sock.groupMetadata(id))
			} catch (err) {
				log.warn({ err, id }, 'failed to refresh group metadata')
			}
		})
	}

	private async onConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
		const { connection, lastDisconnect, qr } = update

		if (qr) {
			log.info('scan the QR code below with WhatsApp → Linked devices → Link a device')
			qrcode.generate(qr, { small: true })
		}

		if (connection === 'open') {
			this.reconnectAttempt = 0
			const me = this.sock?.user
			log.info({ me: me?.id, lid: me?.lid, name: me?.name }, 'connection opened')
			return
		}

		if (connection !== 'close') return

		const boom = lastDisconnect?.error instanceof Boom ? lastDisconnect.error : undefined
		const statusCode = boom?.output?.statusCode
		const reason = statusCode ? DisconnectReason[statusCode] ?? statusCode : 'unknown'

		log.warn({ reason, statusCode, err: lastDisconnect?.error?.message }, 'connection closed')

		if (this.shuttingDown) return

		if (statusCode === DisconnectReason.loggedOut) {
			log.error('session was logged out. Wiping auth state. Restart the bot to re-pair via QR.')
			await this.auth?.clear().catch(err =>
				log.warn({ err }, 'failed to clear auth state')
			)
			await this.store?.markLoggedOut().catch(err =>
				log.warn({ err }, 'failed to mark account logged_out in DB')
			)
			process.exit(1)
		}

		const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
		this.reconnectAttempt += 1
		log.info({ attempt: this.reconnectAttempt, delayMs: delay }, 'reconnecting')

		await new Promise(resolve => setTimeout(resolve, delay))
		if (this.shuttingDown) return

		try {
			await this.connect()
		} catch (err) {
			log.error({ err }, 'reconnect failed; will retry on next close')
		}
	}
}
