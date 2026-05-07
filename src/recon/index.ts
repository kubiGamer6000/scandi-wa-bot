import { join } from 'node:path'

import { Boom } from '@hapi/boom'
import makeWASocket, {
	type BaileysEventMap,
	Browsers,
	type ConnectionState,
	DisconnectReason,
	makeCacheableSignalKeyStore,
	useMultiFileAuthState
} from 'baileys'
import qrcode from 'qrcode-terminal'

import { config } from '../config.js'
import { childLogger, logger } from '../logger.js'
import { ReconCapture } from './capture.js'

const log = childLogger('recon')

/**
 * Every event in `BaileysEventMap` we want to dump. We deliberately exclude
 * `creds.update` because it carries private signal keys / noise keys.
 *
 * The list is cross-checked against `BaileysEventMap` at compile time via
 * `satisfies (keyof BaileysEventMap)[]` so an upstream rename will fail the
 * build instead of silently being missed.
 */
const CAPTURED_EVENTS = [
	'connection.update',
	'messaging-history.set',
	'messaging-history.status',
	'chats.upsert',
	'chats.update',
	'chats.delete',
	'chats.lock',
	'lid-mapping.update',
	'presence.update',
	'contacts.upsert',
	'contacts.update',
	'messages.delete',
	'messages.update',
	'messages.media-update',
	'messages.upsert',
	'messages.reaction',
	'message-receipt.update',
	'groups.upsert',
	'groups.update',
	'group-participants.update',
	'group.join-request',
	'group.member-tag.update',
	'blocklist.set',
	'blocklist.update',
	'call',
	'labels.edit',
	'labels.association',
	'newsletter.reaction',
	'newsletter.view',
	'newsletter-participants.update',
	'newsletter-settings.update',
	'message-capping.update',
	'settings.update'
] as const satisfies readonly (keyof BaileysEventMap)[]

const isoStamp = (d: Date): string => d.toISOString().replace(/[:.]/g, '-')

const main = async (): Promise<void> => {
	const reconDir = join(process.cwd(), 'data', 'recon', isoStamp(new Date()))
	const capture = new ReconCapture(reconDir)
	await capture.init()

	const { state, saveCreds } = await useMultiFileAuthState(config.authDir)

	let shuttingDown = false
	let sock: ReturnType<typeof makeWASocket> | undefined
	let lastEventLogAt = Date.now()

	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return
		shuttingDown = true
		log.info(
			{ signal, totalEvents: capture.totalEvents(), counts: capture.snapshotCounts() },
			'shutting down recon'
		)
		try {
			await sock?.end(undefined)
		} catch {
			/* ignore */
		}
		await capture.finalize()
		log.info({ dir: reconDir }, 'recon dump complete')
		process.exit(0)
	}

	process.on('SIGINT', () => void shutdown('SIGINT'))
	process.on('SIGTERM', () => void shutdown('SIGTERM'))

	const connect = async (): Promise<void> => {
		log.info('connecting to WhatsApp (recon mode: full history sync, desktop browser)')

		sock = makeWASocket({
			auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
			logger,
			// "Desktop" suffix is what unlocks deep history sync
			browser: Browsers.ubuntu('Desktop'),
			markOnlineOnConnect: false,
			syncFullHistory: true,
			generateHighQualityLinkPreview: false,
			getMessage: async () => undefined,
			cachedGroupMetadata: async () => undefined
		})

		sock.ev.on('creds.update', saveCreds)

		for (const event of CAPTURED_EVENTS) {
			sock.ev.on(event, (data: BaileysEventMap[typeof event]) => {
				capture.capture(event, data)

				const now = Date.now()
				if (now - lastEventLogAt > 5_000) {
					lastEventLogAt = now
					log.info(
						{
							totalEvents: capture.totalEvents(),
							history: capture.countOf('messaging-history.set'),
							messages: capture.countOf('messages.upsert'),
							chats: capture.countOf('chats.upsert')
						},
						'recon progress'
					)
				}
			})
		}

		sock.ev.on('messaging-history.status', evt => {
			log.info({ evt }, '*** history sync milestone ***')
		})

		sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
			void onConnectionUpdate(update)
		})
	}

	const onConnectionUpdate = async (update: Partial<ConnectionState>): Promise<void> => {
		const { connection, lastDisconnect, qr } = update

		if (qr) {
			log.info('scan the QR with WhatsApp → Linked devices → Link a device')
			qrcode.generate(qr, { small: true })
		}

		if (connection === 'open') {
			log.info(
				{ me: sock?.user?.id, name: sock?.user?.name },
				'connection opened — history sync should now stream in. press Ctrl+C when you are ready to stop.'
			)
			return
		}

		if (connection !== 'close' || shuttingDown) return

		const boom = lastDisconnect?.error instanceof Boom ? lastDisconnect.error : undefined
		const statusCode = boom?.output?.statusCode
		const reason = statusCode ? (DisconnectReason[statusCode] ?? statusCode) : 'unknown'

		if (statusCode === DisconnectReason.loggedOut) {
			log.error({ reason }, 'session was logged out during recon')
			await capture.finalize()
			process.exit(1)
		}

		log.warn({ reason, statusCode }, 'connection closed — reconnecting in 2s')
		setTimeout(() => void connect(), 2_000)
	}

	await connect()
}

await main()
