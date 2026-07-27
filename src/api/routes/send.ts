import { and, eq } from 'drizzle-orm'
import { Type } from '@sinclair/typebox'
import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage } from 'baileys'

import { db, schema } from '../../db/index.js'
import type { ApiDeps, TypedFastify } from '../types.js'

const { messages } = schema

const MEDIA_KINDS = ['image', 'video', 'audio', 'document', 'sticker'] as const
type MediaKind = (typeof MEDIA_KINDS)[number]

/**
 * Polls wa.messages for the freshly-sent message's seq. The ChatStore's
 * `messages.upsert` handler writes asynchronously, so we briefly wait for
 * it to land before returning. 3s is generous — the upsert is typically
 * sub-50ms after `sendMessage()` resolves.
 */
const waitForSeq = async (
	accountId: string,
	chatJid: string,
	waMessageId: string,
	timeoutMs: number
): Promise<number | null> => {
	const deadline = Date.now() + timeoutMs
	let delay = 25
	while (Date.now() < deadline) {
		const [row] = await db
			.select({ seq: messages.seq })
			.from(messages)
			.where(
				and(
					eq(messages.accountId, accountId),
					eq(messages.chatJid, chatJid),
					eq(messages.id, waMessageId)
				)
			)
			.limit(1)
		if (row?.seq != null) return row.seq
		await new Promise(r => setTimeout(r, delay))
		delay = Math.min(delay * 2, 250)
	}
	return null
}

interface MediaSpec {
	kind: MediaKind
	buffer?: Buffer
	url?: string
	mimetype?: string
	filename?: string
	caption?: string
	gif_playback?: boolean
	ptt?: boolean
	seconds?: number
}

const buildMediaContent = (m: MediaSpec): AnyMessageContent => {
	const payload = m.buffer ?? (m.url ? { url: m.url } : null)
	if (!payload) throw new Error('media missing buffer or url')

	switch (m.kind) {
		case 'image':
			return { image: payload, caption: m.caption, mimetype: m.mimetype, jpegThumbnail: undefined } as AnyMessageContent
		case 'video':
			return { video: payload, caption: m.caption, mimetype: m.mimetype, gifPlayback: m.gif_playback } as AnyMessageContent
		case 'audio':
			return {
				audio: payload,
				mimetype: m.mimetype ?? 'audio/ogg; codecs=opus',
				ptt: m.ptt ?? false,
				seconds: m.seconds
			} as AnyMessageContent
		case 'sticker':
			return { sticker: payload, mimetype: m.mimetype } as AnyMessageContent
		case 'document':
			return {
				document: payload,
				mimetype: m.mimetype ?? 'application/octet-stream',
				fileName: m.filename,
				caption: m.caption
			} as AnyMessageContent
	}
}

const fetchUrlBuffer = async (url: string, maxBytes: number): Promise<Buffer> => {
	// Some CDNs (Wikimedia, etc.) block the default Node fetch UA. Send a
	// real-looking UA so URL-based media works against common hosts.
	const res = await fetch(url, {
		headers: {
			'user-agent':
				'Mozilla/5.0 (compatible; scandi-wa-bot/1.0; +https://github.com/scandi/wa-bot)',
			accept: '*/*'
		}
	})
	if (!res.ok) throw new Error(`failed to fetch media url: ${res.status} ${res.statusText}`)
	const len = Number(res.headers.get('content-length') ?? '0')
	if (len > 0 && len > maxBytes) {
		throw new Error(`media too large: ${len} bytes > ${maxBytes}`)
	}
	const arr = new Uint8Array(await res.arrayBuffer())
	if (arr.byteLength > maxBytes) {
		throw new Error(`media too large: ${arr.byteLength} bytes > ${maxBytes}`)
	}
	return Buffer.from(arr)
}

export const registerSendRoute = async (
	app: TypedFastify,
	deps: ApiDeps
): Promise<void> => {
	const MediaSchema = Type.Object({
		kind: Type.Union(MEDIA_KINDS.map(k => Type.Literal(k))),
		url: Type.Optional(Type.String({ format: 'uri' })),
		base64: Type.Optional(Type.String()),
		mimetype: Type.Optional(Type.String()),
		filename: Type.Optional(Type.String()),
		caption: Type.Optional(Type.String()),
		gif_playback: Type.Optional(Type.Boolean()),
		ptt: Type.Optional(Type.Boolean()),
		seconds: Type.Optional(Type.Integer({ minimum: 0 }))
	})

	const JsonBody = Type.Object({
		to: Type.String({ minLength: 3 }),
		text: Type.Optional(Type.String()),
		media: Type.Optional(MediaSchema),
		quote_seq: Type.Optional(Type.Integer({ minimum: 1 })),
		mentions: Type.Optional(Type.Array(Type.String()))
	})

	const SendReply = Type.Object({
		seq: Type.Union([Type.Number(), Type.Null()]),
		wa_message_id: Type.String(),
		to: Type.String(),
		type: Type.String()
	})

	// ─────────── JSON path ───────────
	app.post(
		'/v1/send',
		{
			schema: {
				body: JsonBody,
				response: { 200: SendReply }
			}
		},
		async req => {
			const sock = deps.getSock()
			if (!sock) throw app.httpErrors.serviceUnavailable('socket not connected')

			const { to, text, media, quote_seq, mentions } = req.body

			if (!text && !media) {
				throw app.httpErrors.badRequest('one of `text` or `media` is required')
			}

			let quoted: WAMessage | undefined
			if (quote_seq != null) {
				const [q] = await db
					.select({
						chatJid: messages.chatJid,
						id: messages.id,
						fromMe: messages.fromMe,
						participant: messages.participant,
						rawMessage: messages.rawMessage
					})
					.from(messages)
					.where(and(eq(messages.accountId, deps.store.accountId), eq(messages.seq, quote_seq)))
					.limit(1)
				if (!q) throw app.httpErrors.notFound(`quote_seq=${quote_seq} not found`)
				quoted = {
					key: {
						remoteJid: q.chatJid,
						id: q.id,
						fromMe: q.fromMe,
						participant: q.participant ?? undefined
					},
					message: q.rawMessage as WAMessage['message']
				} as WAMessage
			}

			let content: AnyMessageContent
			let kindLabel: string

			if (media) {
				let buffer: Buffer | undefined
				if (media.base64) buffer = Buffer.from(media.base64, 'base64')
				else if (media.url) buffer = await fetchUrlBuffer(media.url, 100 * 1024 * 1024)
				else throw app.httpErrors.badRequest('media requires one of `url` or `base64`')

				content = buildMediaContent({
					kind: media.kind,
					buffer,
					mimetype: media.mimetype,
					filename: media.filename,
					caption: media.caption ?? text,
					gif_playback: media.gif_playback,
					ptt: media.ptt,
					seconds: media.seconds
				})
				kindLabel = `${media.kind}Message`
			} else {
				content = { text: text! } as AnyMessageContent
				kindLabel = 'extendedTextMessage'
			}

			if (mentions && mentions.length > 0) {
				;(content as { mentions?: string[] }).mentions = mentions
			}

			const opts: MiscMessageGenerationOptions = quoted ? { quoted } : {}

			const sent = await sock.sendMessage(to, content, opts)
			if (!sent?.key?.id) {
				throw app.httpErrors.internalServerError('sendMessage returned no key')
			}
			// The delivered message supersedes any "typing…" we were holding.
			deps.typing.noteOutboundMessage(to)
			const waId = sent.key.id
			const seq = await waitForSeq(deps.store.accountId, to, waId, 8_000)

			return { seq, wa_message_id: waId, to, type: kindLabel }
		}
	)

	// ─────────── Multipart path ───────────
	// POST /v1/send (multipart/form-data) — fields: to, kind, caption?, mentions?, mimetype?, filename?, gif_playback?, ptt?, file
	app.post('/v1/send/multipart', async (req, reply) => {
		const sock = deps.getSock()
		if (!sock) throw app.httpErrors.serviceUnavailable('socket not connected')

		if (!req.isMultipart()) {
			throw app.httpErrors.badRequest('Content-Type must be multipart/form-data')
		}

		let to: string | undefined
		let kind: MediaKind | undefined
		let caption: string | undefined
		let filename: string | undefined
		let mimetype: string | undefined
		let gifPlayback: boolean | undefined
		let ptt: boolean | undefined
		let quoteSeq: number | undefined
		let mentions: string[] = []
		let buffer: Buffer | undefined

		const parts = req.parts()
		for await (const part of parts) {
			if (part.type === 'file') {
				if (part.fieldname !== 'file') continue
				const chunks: Buffer[] = []
				for await (const chunk of part.file) {
					chunks.push(chunk as Buffer)
				}
				buffer = Buffer.concat(chunks)
				filename = filename ?? part.filename
				mimetype = mimetype ?? part.mimetype
			} else {
				const v = part.value
				const str = typeof v === 'string' ? v : ''
				switch (part.fieldname) {
					case 'to':
						to = str
						break
					case 'kind':
						if ((MEDIA_KINDS as readonly string[]).includes(str)) kind = str as MediaKind
						break
					case 'caption':
						caption = str
						break
					case 'filename':
						filename = str
						break
					case 'mimetype':
						mimetype = str
						break
					case 'gif_playback':
						gifPlayback = str === 'true'
						break
					case 'ptt':
						ptt = str === 'true'
						break
					case 'quote_seq':
						quoteSeq = Number(str) || undefined
						break
					case 'mentions':
						mentions = str.split(',').map(s => s.trim()).filter(Boolean)
						break
				}
			}
		}

		if (!to || !kind || !buffer) {
			throw app.httpErrors.badRequest('multipart send requires fields: to, kind, file')
		}

		let quoted: WAMessage | undefined
		if (quoteSeq != null) {
			const [q] = await db
				.select({
					chatJid: messages.chatJid,
					id: messages.id,
					fromMe: messages.fromMe,
					participant: messages.participant,
					rawMessage: messages.rawMessage
				})
				.from(messages)
				.where(and(eq(messages.accountId, deps.store.accountId), eq(messages.seq, quoteSeq)))
				.limit(1)
			if (!q) throw app.httpErrors.notFound(`quote_seq=${quoteSeq} not found`)
			quoted = {
				key: {
					remoteJid: q.chatJid,
					id: q.id,
					fromMe: q.fromMe,
					participant: q.participant ?? undefined
				},
				message: q.rawMessage as WAMessage['message']
			} as WAMessage
		}

		const content = buildMediaContent({
			kind,
			buffer,
			mimetype,
			filename,
			caption,
			gif_playback: gifPlayback,
			ptt
		})
		if (mentions.length > 0) {
			;(content as { mentions?: string[] }).mentions = mentions
		}

		const opts: MiscMessageGenerationOptions = quoted ? { quoted } : {}
		const sent = await sock.sendMessage(to, content, opts)
		if (!sent?.key?.id) throw app.httpErrors.internalServerError('sendMessage returned no key')
		deps.typing.noteOutboundMessage(to)
		const waId = sent.key.id
		const seq = await waitForSeq(deps.store.accountId, to, waId, 8_000)

		return reply.send({ seq, wa_message_id: waId, to, type: `${kind}Message` })
	})
}
