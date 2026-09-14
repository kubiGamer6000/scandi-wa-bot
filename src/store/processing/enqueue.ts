import { EventEmitter } from 'node:events'

import { schema } from '../../db/index.js'
import { config, type ProcessingConfig } from '../../config.js'
import { childLogger } from '../../logger.js'
import { getVideoPrompt, getImagePrompt } from './prompts.js'
import type { StoreContext } from '../types.js'

const log = childLogger('store:processing:enqueue')

/**
 * Fires after a processing job is inserted, so the processing worker starts it
 * immediately instead of on its next idle poll.
 */
export const processingEnqueued = new EventEmitter()

interface MediaDoneRow {
	id: bigint
	accountId: string
	chatJid: string
	messageId: string
	mediaType: string
	mimeType: string | null
	gcsBucket: string
	gcsObject: string
	sizeBytes: number | null
}

interface RouteResult {
	processor: string
	model: string
	prompt: string | null
}

const DOCUMENT_MIMES = new Set([
	'application/pdf',
	'application/msword',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.ms-excel',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'application/vnd.ms-powerpoint',
	'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	'application/vnd.oasis.opendocument.text',
	'application/vnd.oasis.opendocument.spreadsheet',
	'application/rtf',
	'text/plain',
	'text/csv',
	'text/html',
	'text/markdown'
])

const route = (row: MediaDoneRow, cfg: ProcessingConfig): RouteResult | null => {
	const { mediaType, mimeType } = row
	const baseMime = mimeType?.split(';')[0]?.trim().toLowerCase() ?? ''

	switch (mediaType) {
		case 'video':
		case 'ptv':
		case 'gif':
			if (!cfg.geminiApiKey) return null
			return {
				processor: 'gemini_video',
				model: cfg.geminiModel,
				prompt: getVideoPrompt()
			}

		case 'image':
		case 'sticker':
			if (!cfg.geminiApiKey) return null
			return {
				processor: 'gemini_image',
				model: cfg.geminiImageModel,
				prompt: getImagePrompt()
			}

		case 'audio':
			if (!cfg.elevenlabsApiKey) return null
			return {
				processor: 'elevenlabs_audio',
				model: cfg.elevenlabsModel,
				prompt: null
			}

		case 'document':
			if (!cfg.llamaCloudApiKey) return null
			if (!DOCUMENT_MIMES.has(baseMime) && !baseMime.startsWith('text/')) return null
			return {
				processor: 'llamaparse_document',
				model: cfg.llamaParseTier,
				prompt: null
			}

		default:
			return null
	}
}

/**
 * Called after a media download completes successfully. Inserts a processing
 * job into wa.media_processing if the media type routes to an AI service.
 * Returns true if a job was enqueued.
 */
export const enqueueProcessing = async (
	ctx: StoreContext,
	row: MediaDoneRow
): Promise<boolean> => {
	const cfg = config.processing
	if (!cfg.enabled) return false

	const resolved = route(row, cfg)
	if (!resolved) return false

	try {
		await ctx.db
			.insert(schema.mediaProcessing)
			.values({
				accountId: row.accountId,
				mediaId: row.id,
				chatJid: row.chatJid,
				messageId: row.messageId,
				processor: resolved.processor,
				model: resolved.model,
				prompt: resolved.prompt,
				gcsBucket: row.gcsBucket,
				gcsObject: row.gcsObject,
				mimeType: row.mimeType,
				sizeBytes: row.sizeBytes
			})
			.onConflictDoNothing()

		processingEnqueued.emit('enqueued')
		log.debug(
			{ mediaId: String(row.id), processor: resolved.processor, model: resolved.model },
			'processing job enqueued'
		)
		return true
	} catch (err) {
		log.warn({ err, mediaId: String(row.id) }, 'failed to enqueue processing job')
		return false
	}
}
