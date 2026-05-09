import { sql } from 'drizzle-orm'
import { downloadMediaMessage, type WAMessage, type WASocket } from 'baileys'

import { schema } from '../../db/index.js'
import type { StoreContext } from '../types.js'
import { reviveFromJsonb } from '../serialize.js'
import type { MediaStorage } from './storage.js'
import { enqueueProcessing } from '../processing/enqueue.js'

/** Map common WhatsApp mime types to a sane file extension. */
const EXTENSION_MAP: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/jpg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'image/heic': 'heic',
	'video/mp4': 'mp4',
	'video/3gpp': '3gp',
	'video/quicktime': 'mov',
	'audio/ogg': 'ogg',
	'audio/ogg; codecs=opus': 'opus',
	'audio/opus': 'opus',
	'audio/mpeg': 'mp3',
	'audio/mp4': 'm4a',
	'audio/aac': 'aac',
	'audio/wav': 'wav',
	'audio/x-wav': 'wav',
	'application/pdf': 'pdf',
	'application/zip': 'zip',
	'application/msword': 'doc',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
	'application/vnd.ms-excel': 'xls',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
	'text/plain': 'txt',
	'text/csv': 'csv'
}

const extensionFor = (mime: string | null, mediaType: string): string => {
	if (mime) {
		const base = mime.split(';')[0]?.trim().toLowerCase() ?? ''
		const known = EXTENSION_MAP[base]
		if (known) return known
		// fallback: take the subtype if it looks like a sane extension
		const sub = base.split('/')[1]
		if (sub && /^[a-z0-9]{1,8}$/.test(sub)) return sub
	}
	switch (mediaType) {
		case 'image':
			return 'jpg'
		case 'video':
		case 'ptv':
		case 'gif':
			return 'mp4'
		case 'audio':
			return 'ogg'
		case 'sticker':
			return 'webp'
		case 'document':
			return 'bin'
		default:
			return 'bin'
	}
}

const sanitizeJid = (jid: string): string => jid.replace(/[^a-zA-Z0-9_.@-]+/g, '_').replace(/[@:]/g, '_')

const buildObjectKey = (input: {
	accountId: string
	chatJid: string
	messageId: string
	mediaType: string
	mime: string | null
}): string => {
	const ext = extensionFor(input.mime, input.mediaType)
	const chat = sanitizeJid(input.chatJid)
	const safeId = input.messageId.replace(/[^a-zA-Z0-9._-]+/g, '_')
	return `accounts/${input.accountId}/${chat}/${safeId}.${ext}`
}

const reviveWaMessage = (envelope: object | null, body: object | null): WAMessage | null => {
	if (!envelope) return null
	const env = reviveFromJsonb<Record<string, unknown>>(envelope as object)
	const message = body ? reviveFromJsonb<object>(body as object) : null
	return { ...env, message } as WAMessage
}

/** Per-row outcome that the worker uses to decide retry/terminate. */
export type DownloadOutcome =
	| { kind: 'done' }
	| { kind: 'retry'; reason: string; transient: true }
	| { kind: 'failed'; reason: string }
	| { kind: 'skipped'; reason: string }

export interface DownloadOneInput {
	id: bigint
	accountId: string
	chatJid: string
	messageId: string
	mediaType: string
	mimeType: string | null
	fileLength: number | null
}

export interface DownloaderDeps {
	ctx: StoreContext
	storage: MediaStorage
	getSocket: () => WASocket | null
	maxBytes: number
	allowedTypes: ReadonlySet<string>
}

const TRANSIENT_PATTERNS = [
	/timeout/i,
	/network/i,
	/socket/i,
	/ECONNRESET/,
	/EAI_AGAIN/,
	/ETIMEDOUT/,
	/getaddrinfo/i,
	/fetch failed/i,
	/aborted/i
]

const isTransient = (err: Error): boolean => TRANSIENT_PATTERNS.some(p => p.test(err.message))

/**
 * Download a single media row to Firebase. Pure with respect to claim/retry
 * mechanics — the caller (worker) handles the queue side.
 */
export const downloadOne = async (
	deps: DownloaderDeps,
	row: DownloadOneInput
): Promise<DownloadOutcome> => {
	const { ctx, storage, getSocket, maxBytes, allowedTypes } = deps
	const { db, log } = ctx

	if (!allowedTypes.has(row.mediaType)) {
		await markSkipped(ctx, row.id, `media type ${row.mediaType} not enabled`)
		return { kind: 'skipped', reason: 'type_not_enabled' }
	}

	if (row.fileLength != null && row.fileLength > maxBytes) {
		await markSkipped(ctx, row.id, `file_length ${row.fileLength} exceeds MEDIA_MAX_BYTES ${maxBytes}`)
		return { kind: 'skipped', reason: 'too_large' }
	}

	if (storage.kind === 'noop') {
		// No bucket configured — keep rows pending so they get picked up once
		// the operator finishes onboarding Firebase. We don't bump attempts.
		return { kind: 'retry', reason: 'storage_disabled', transient: true }
	}

	// Pull the original WAMessage from wa.messages so we can re-decrypt.
	const messageRows = await db
		.select({
			rawMessage: schema.messages.rawMessage,
			rawEnvelope: schema.messages.rawEnvelope
		})
		.from(schema.messages)
		.where(
			sql`${schema.messages.accountId} = ${row.accountId}
			    AND ${schema.messages.chatJid} = ${row.chatJid}
			    AND ${schema.messages.id} = ${row.messageId}`
		)
		.limit(1)

	const messageRow = messageRows[0]
	if (!messageRow?.rawEnvelope || !messageRow?.rawMessage) {
		// No body — likely a tombstone or media row we ingested out of order.
		// This is terminal: there's nothing to download.
		await markFailed(ctx, row.id, 'no_raw_message_in_db')
		return { kind: 'failed', reason: 'no_raw_message' }
	}

	const waMessage = reviveWaMessage(messageRow.rawEnvelope, messageRow.rawMessage)
	if (!waMessage) {
		await markFailed(ctx, row.id, 'failed_to_revive_envelope')
		return { kind: 'failed', reason: 'revive_failed' }
	}

	const sock = getSocket()
	let buffer: Buffer
	try {
		buffer = await downloadMediaMessage(
			waMessage,
			'buffer',
			{},
			{
				logger: log as never,
				// reuploadRequest is what triggers WA to re-upload media whose URL
				// has expired (404/410). When we have no live socket (rare) we
				// still pass an identity to satisfy the type — the call will just
				// throw if a re-upload was actually needed.
				reuploadRequest: sock?.updateMediaMessage ?? (async (m: WAMessage) => m)
			}
		)
	} catch (err) {
		const e = err as Error
		log.warn(
			{ err: e, mediaId: String(row.id), chatJid: row.chatJid, messageId: row.messageId },
			'media download failed'
		)
		if (isTransient(e)) {
			return { kind: 'retry', reason: e.message, transient: true }
		}
		// Non-transient: mark failed, no retry.
		await markFailed(ctx, row.id, e.message.slice(0, 500))
		return { kind: 'failed', reason: e.message }
	}

	if (buffer.byteLength > maxBytes) {
		await markSkipped(ctx, row.id, `decrypted bytes ${buffer.byteLength} exceeds MEDIA_MAX_BYTES ${maxBytes}`)
		return { kind: 'skipped', reason: 'decrypted_too_large' }
	}

	const contentType = row.mimeType ?? 'application/octet-stream'
	const objectKey = buildObjectKey({
		accountId: row.accountId,
		chatJid: row.chatJid,
		messageId: row.messageId,
		mediaType: row.mediaType,
		mime: row.mimeType
	})

	let putResult: Awaited<ReturnType<MediaStorage['put']>>
	try {
		putResult = await storage.put({
			key: objectKey,
			contentType,
			bytes: buffer,
			metadata: {
				account_id: row.accountId,
				chat_jid: row.chatJid,
				message_id: row.messageId,
				media_type: row.mediaType,
				media_id: String(row.id)
			}
		})
	} catch (err) {
		const e = err as Error
		log.warn({ err: e, key: objectKey }, 'storage upload failed')
		// All storage failures are treated as transient — Firebase has its own
		// retry semantics but if we hit a hard error (auth/quota) we want the
		// row visible in `failed` after MAX_ATTEMPTS.
		return { kind: 'retry', reason: `upload: ${e.message}`, transient: true }
	}

	await db
		.update(schema.media)
		.set({
			downloadStatus: 'done',
			downloadError: null,
			gcsBucket: putResult.bucket,
			gcsObject: putResult.object,
			gcsUrl: putResult.downloadUrl,
			sizeBytes: putResult.sizeBytes,
			contentType: putResult.contentType,
			completedAt: sql`NOW()` as unknown as Date,
			leaseUntil: null,
			workerId: null,
			updatedAt: sql`NOW()` as unknown as Date
		})
		.where(sql`${schema.media.id} = ${row.id}`)

	log.info(
		{
			mediaId: String(row.id),
			chatJid: row.chatJid,
			messageId: row.messageId,
			bytes: putResult.sizeBytes,
			object: putResult.object
		},
		'media uploaded'
	)

	await enqueueProcessing(ctx, {
		id: row.id,
		accountId: row.accountId,
		chatJid: row.chatJid,
		messageId: row.messageId,
		mediaType: row.mediaType,
		mimeType: row.mimeType,
		gcsBucket: putResult.bucket,
		gcsObject: putResult.object,
		sizeBytes: putResult.sizeBytes
	}).catch(err => log.warn({ err, mediaId: String(row.id) }, 'enqueue processing failed (non-fatal)'))

	return { kind: 'done' }
}

const markSkipped = async (ctx: StoreContext, id: bigint, reason: string): Promise<void> => {
	const { db } = ctx
	await db
		.update(schema.media)
		.set({
			downloadStatus: 'skipped',
			downloadError: reason.slice(0, 500),
			leaseUntil: null,
			workerId: null,
			updatedAt: sql`NOW()` as unknown as Date
		})
		.where(sql`${schema.media.id} = ${id}`)
}

const markFailed = async (ctx: StoreContext, id: bigint, reason: string): Promise<void> => {
	const { db } = ctx
	await db
		.update(schema.media)
		.set({
			downloadStatus: 'failed',
			downloadError: reason.slice(0, 500),
			leaseUntil: null,
			workerId: null,
			updatedAt: sql`NOW()` as unknown as Date
		})
		.where(sql`${schema.media.id} = ${id}`)
}
