import { Boom } from '@hapi/boom'
import makeWASocket, {
	Browsers,
	type ConnectionState,
	DisconnectReason,
	type GroupMetadata,
	type WASocket
} from 'baileys'
import qrcode from 'qrcode-terminal'
import type { FastifyInstance } from 'fastify'

import { loadAuthState, type AuthHandle } from './auth.js'
import { config } from './config.js'
import { childLogger, logger } from './logger.js'
import { ChatStore } from './store/index.js'
import { buildMediaStorage, MediaWorker, type MediaStorage } from './store/media/index.js'
import { ProcessingWorker } from './store/processing/index.js'
import { ReadReceiptWorker, TypingManager } from './presence/index.js'
import { buildServer } from './api/server.js'
import { WebhookWorker } from './webhooks/worker.js'
import { bindWebhookEnqueuer } from './webhooks/enqueue.js'
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
	private webhookWorker: WebhookWorker | undefined
	private apiServer: FastifyInstance | undefined
	private mediaStorage: MediaStorage | undefined
	private detachWebhookEnqueuer: (() => void) | undefined

	/** Cached group metadata to avoid a USync request on every group send. */
	private readonly groupCache = new Map<string, GroupMetadata>()

	/** Acks inbound messages so DMs and groups don't sit unread. */
	private readonly readReceipts = new ReadReceiptWorker(config.readReceipts)

	/** Holds "typing…" open in a chat while a consumer works on a reply. */
	private readonly typing = new TypingManager(
		config.typing,
		config.markOnlineOnConnect ? 'available' : 'unavailable'
	)

	/** Exposed so the API send route can hold a closure that follows reconnects. */
	getSock(): WASocket | null {
		return this.sock ?? null
	}

	/** Exposed for the presence API routes, which drive typing indicators. */
	getTyping(): TypingManager {
		return this.typing
	}

	async start(): Promise<void> {
		this.store = await ChatStore.open()
		// Auth state is loaded once per process. Reconnects re-use the same
		// `creds` reference (Baileys mutates it in place); signal keys go
		// through the cached store, which is itself stable.
		this.auth = await loadAuthState(this.store.accountId)

		// Media downloader runs as an independent worker, polling wa.media for
		// rows in 'pending' status. The store wakes it up after every upsert.
		const storage = buildMediaStorage(config.media.firebase)
		this.mediaStorage = storage
		this.mediaWorker = new MediaWorker(
			{
				accountId: this.store.accountId,
				db,
				log: childLogger('store:media'),
				bus: this.store.bus
			},
			storage,
			config.media
		)
		this.mediaWorker.bindSocket(() => this.sock ?? null)
		this.store.bindMediaQueue(this.mediaWorker)
		this.mediaWorker.start()

		// Presence side-effects (read receipts + typing) talk to the socket
		// directly and survive reconnects via the same getter indirection.
		this.readReceipts.bindSocket(() => this.sock ?? null)
		this.typing.bindSocket(() => this.sock ?? null)
		log.info(
			{
				readReceipts: config.readReceipts.enabled,
				readReceiptJids: config.readReceipts.jids,
				typing: config.typing.enabled,
				typingRefreshMs: config.typing.refreshMs
			},
			'presence configured'
		)

		// AI processing worker: drains wa.media_processing after media
		// download completes. Routes to Gemini / ElevenLabs / LlamaParse.
		this.processingWorker = new ProcessingWorker(
			{
				accountId: this.store.accountId,
				db,
				log: childLogger('store:processing'),
				bus: this.store.bus
			},
			storage,
			config.processing
		)
		this.processingWorker.start()

		// HTTP API + webhook plumbing. Both pieces depend on the live socket
		// and the chat store; we wire them BEFORE Baileys connects so they
		// can stream history-sync events too once messaging starts flowing.
		if (config.api.enabled) {
			this.webhookWorker = new WebhookWorker(config.webhooks)
			this.detachWebhookEnqueuer = bindWebhookEnqueuer(this.store, this.webhookWorker)
			this.webhookWorker.start()

			this.apiServer = await buildServer({
				getSock: () => this.sock ?? null,
				store: this.store,
				storage: this.mediaStorage,
				typing: this.typing
			})
			const addr = await this.apiServer.listen({
				host: config.api.host,
				port: config.api.port
			})
			log.info({ addr }, 'api server listening')
		} else {
			log.info('api server disabled (set API_ENABLED=true to enable)')
		}

		await this.connect()
	}

	/** Cleanly close everything. Idempotent. Order matters:
	 *
	 *   1. API server first — drain inflight requests so callers see clean
	 *      EOF instead of half-completed sendMessage calls.
	 *   2. Detach the webhook enqueuer so no further bus events fan out.
	 *   3. Stop the WhatsApp socket — no new events from this point.
	 *   4. Stop the workers, which may still be flushing in-flight jobs.
	 */
	async stop(): Promise<void> {
		if (this.shuttingDown) return
		this.shuttingDown = true
		log.info('shutting down')
		try {
			await this.apiServer?.close()
		} catch (err) {
			log.warn({ err }, 'error closing api server (ignored)')
		}
		try {
			this.detachWebhookEnqueuer?.()
		} catch (err) {
			log.warn({ err }, 'error detaching webhook enqueuer (ignored)')
		}
		// Close typing indicators while the socket is still alive, otherwise
		// chats are left showing "typing…" until WhatsApp times it out.
		try {
			this.readReceipts.stop()
			await this.typing.stopAll()
		} catch (err) {
			log.warn({ err }, 'error closing presence state (ignored)')
		}
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
		try {
			await this.webhookWorker?.stop()
		} catch (err) {
			log.warn({ err }, 'error stopping webhook worker (ignored)')
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

		// Read receipts for live traffic only. `append` batches and
		// `messaging-history.set` carry backfill, and acking a backlog in one
		// burst is both pointless and a spam signal.
		sock.ev.on('messages.upsert', payload => {
			if (payload.type !== 'notify') return
			this.readReceipts.offer(payload.messages)
		})

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
			void this.readReceipts.checkPrivacy()
			return
		}

		if (connection !== 'close') return

		// The socket is gone, so every chatstate we pushed is void. Drop the
		// sessions instead of refreshing into a dead connection.
		this.typing.reset()

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
