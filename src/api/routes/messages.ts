import { and, eq } from 'drizzle-orm'
import { Type } from '@sinclair/typebox'

import { db, schema } from '../../db/index.js'
import { buildMessagePayload } from '../payloads.js'
import type { ApiDeps, TypedFastify } from '../types.js'

const { messages, media, mediaProcessing } = schema

export const registerMessageRoutes = async (
	app: TypedFastify,
	deps: ApiDeps
): Promise<void> => {
	// ─────────── GET /v1/messages/:seq ───────────
	app.get(
		'/v1/messages/:seq',
		{
			schema: {
				params: Type.Object({ seq: Type.Integer({ minimum: 1 }) })
			}
		},
		async req => {
			const accountId = deps.store.accountId
			const payload = await buildMessagePayload(accountId, { seq: req.params.seq })
			if (!payload) throw app.httpErrors.notFound(`message seq=${req.params.seq} not found`)
			return payload
		}
	)

	// ─────────── GET /v1/messages/:seq/media ───────────
	// Returns metadata + the Firebase token URL produced at upload time.
	// The URL is long-lived (no rotation) so consumers can cache it freely.
	app.get(
		'/v1/messages/:seq/media',
		{
			schema: {
				params: Type.Object({ seq: Type.Integer({ minimum: 1 }) })
			}
		},
		async req => {
			const accountId = deps.store.accountId
			const seq = req.params.seq

			const [msgRow] = await db
				.select({ chatJid: messages.chatJid, id: messages.id })
				.from(messages)
				.where(and(eq(messages.accountId, accountId), eq(messages.seq, seq)))
				.limit(1)
			if (!msgRow) throw app.httpErrors.notFound(`message seq=${seq} not found`)

			const [mediaRow] = await db
				.select()
				.from(media)
				.where(
					and(
						eq(media.accountId, accountId),
						eq(media.chatJid, msgRow.chatJid),
						eq(media.messageId, msgRow.id)
					)
				)
				.limit(1)
			if (!mediaRow) throw app.httpErrors.notFound(`no media for message seq=${seq}`)

			const processed = await db
				.select()
				.from(mediaProcessing)
				.where(eq(mediaProcessing.mediaId, mediaRow.id))

			return {
				seq,
				wa_message_id: msgRow.id,
				chat_jid: msgRow.chatJid,
				media: {
					media_type: mediaRow.mediaType,
					mime_type: mediaRow.mimeType,
					size_bytes: mediaRow.sizeBytes ?? mediaRow.fileLength,
					width: mediaRow.width,
					height: mediaRow.height,
					duration_seconds: mediaRow.durationSeconds,
					page_count: mediaRow.pageCount,
					file_name: mediaRow.fileName,
					caption: mediaRow.caption,
					is_voice_note: mediaRow.isVoiceNote,
					download_status: mediaRow.downloadStatus,
					url: mediaRow.gcsUrl,
					gcs_bucket: mediaRow.gcsBucket,
					gcs_object: mediaRow.gcsObject
				},
				processed: processed.map(p => ({
					processor: p.processor,
					model: p.model,
					status: p.status,
					result_text: p.resultText,
					result_meta: p.resultMeta,
					processing_ms: p.processingMs,
					completed_at: p.completedAt?.toISOString() ?? null,
					error: p.error
				}))
			}
		}
	)

	// ─────────── GET /v1/messages/:seq/media/download ───────────
	// Convenience redirect to the Firebase token URL. Consumers that can hit
	// Firebase directly should use this for `wget`-style fetches.
	app.get(
		'/v1/messages/:seq/media/download',
		{
			schema: {
				params: Type.Object({ seq: Type.Integer({ minimum: 1 }) }),
				querystring: Type.Object({ proxy: Type.Optional(Type.Boolean()) })
			}
		},
		async (req, reply) => {
			const accountId = deps.store.accountId
			const seq = req.params.seq

			const [msgRow] = await db
				.select({ chatJid: messages.chatJid, id: messages.id })
				.from(messages)
				.where(and(eq(messages.accountId, accountId), eq(messages.seq, seq)))
				.limit(1)
			if (!msgRow) throw app.httpErrors.notFound(`message seq=${seq} not found`)

			const [mediaRow] = await db
				.select()
				.from(media)
				.where(
					and(
						eq(media.accountId, accountId),
						eq(media.chatJid, msgRow.chatJid),
						eq(media.messageId, msgRow.id)
					)
				)
				.limit(1)
			if (!mediaRow) throw app.httpErrors.notFound(`no media for message seq=${seq}`)
			if (mediaRow.downloadStatus !== 'done' || !mediaRow.gcsObject) {
				throw app.httpErrors.conflict(
					`media not yet downloaded (status=${mediaRow.downloadStatus})`
				)
			}

			// Proxy mode: stream the bytes through the bot. Used when the
			// caller can't reach Firebase directly (private network etc.).
			if (req.query.proxy) {
				const buf = await deps.storage.download(mediaRow.gcsObject)
				reply
					.header('content-type', mediaRow.mimeType ?? 'application/octet-stream')
					.header('content-length', buf.byteLength)
				if (mediaRow.fileName) {
					reply.header('content-disposition', `attachment; filename="${mediaRow.fileName}"`)
				}
				return reply.send(buf)
			}

			// Default: redirect to the Firebase token URL.
			if (!mediaRow.gcsUrl) {
				throw app.httpErrors.conflict('media has no downloadable URL; retry with ?proxy=true')
			}
			reply.code(302).header('location', mediaRow.gcsUrl).send()
			return reply
		}
	)
}
