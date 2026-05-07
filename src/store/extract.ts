import { proto } from 'baileys'

export interface ExtractedContent {
	/** Stable label for the dominant message type. */
	messageType: string | null
	/** Plain text the user sees. Captions are stored separately. */
	text: string | null
	caption: string | null
	/** True if `protocolMessage` is the dominant payload. */
	isProtocol: boolean
	/** True if `contextInfo.isForwarded` was set somewhere. */
	forwarded: boolean | null
	forwardScore: number | null
	quotedMsgId: string | null
	quotedParticipant: string | null
	quotedText: string | null
}

const EMPTY: ExtractedContent = {
	messageType: null,
	text: null,
	caption: null,
	isProtocol: false,
	forwarded: null,
	forwardScore: null,
	quotedMsgId: null,
	quotedParticipant: null,
	quotedText: null
}

/**
 * Strips ephemeralMessage / viewOnceMessage / viewOnceMessageV2 / etc. wrappers
 * to find the "real" message payload underneath.
 */
const unwrap = (msg: proto.IMessage | null | undefined): proto.IMessage | null => {
	if (!msg) return null
	if (msg.ephemeralMessage?.message) return unwrap(msg.ephemeralMessage.message)
	if (msg.viewOnceMessage?.message) return unwrap(msg.viewOnceMessage.message)
	if (msg.viewOnceMessageV2?.message) return unwrap(msg.viewOnceMessageV2.message)
	if (msg.viewOnceMessageV2Extension?.message) return unwrap(msg.viewOnceMessageV2Extension.message)
	if (msg.documentWithCaptionMessage?.message) return unwrap(msg.documentWithCaptionMessage.message)
	if (msg.editedMessage?.message) return unwrap(msg.editedMessage.message)
	return msg
}

const peekText = (msg: proto.IMessage): string | null => {
	if (msg.conversation) return msg.conversation
	if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text
	if (msg.buttonsResponseMessage?.selectedDisplayText) return msg.buttonsResponseMessage.selectedDisplayText
	if (msg.listResponseMessage?.title) return msg.listResponseMessage.title
	if (msg.templateButtonReplyMessage?.selectedDisplayText) return msg.templateButtonReplyMessage.selectedDisplayText
	return null
}

const peekCaption = (msg: proto.IMessage): string | null => {
	return (
		msg.imageMessage?.caption ??
		msg.videoMessage?.caption ??
		msg.documentMessage?.caption ??
		msg.documentWithCaptionMessage?.message?.documentMessage?.caption ??
		null
	)
}

/**
 * Picks the dominant content key, skipping the side-channel `messageContextInfo`
 * envelope that WA bundles with most modern messages. Without this, reaction
 * and protocol messages get mislabelled as `messageContextInfo` because the
 * decoder happens to surface that key first.
 */
const messageTypeOf = (msg: proto.IMessage): string | null => {
	const keys = Object.keys(msg).filter(k => msg[k as keyof proto.IMessage] != null)
	const real = keys.find(k => k !== 'messageContextInfo')
	return real ?? keys[0] ?? null
}

const peekContextInfo = (msg: proto.IMessage): proto.IContextInfo | null => {
	return (
		msg.extendedTextMessage?.contextInfo ??
		msg.imageMessage?.contextInfo ??
		msg.videoMessage?.contextInfo ??
		msg.audioMessage?.contextInfo ??
		msg.documentMessage?.contextInfo ??
		msg.stickerMessage?.contextInfo ??
		msg.contactMessage?.contextInfo ??
		msg.locationMessage?.contextInfo ??
		msg.liveLocationMessage?.contextInfo ??
		null
	)
}

/**
 * Projects the WhatsApp proto message into a flat shape we store on
 * `wa.messages`. Untouched fields fall back to `null` rather than `undefined`
 * so callers can splat into Drizzle insert objects without surprises.
 */
export const extractContent = (raw: proto.IMessage | null | undefined): ExtractedContent => {
	const msg = unwrap(raw)
	if (!msg) return EMPTY

	const isProtocol = !!msg.protocolMessage
	const text = peekText(msg)
	const caption = peekCaption(msg)
	const messageType = messageTypeOf(msg)
	const ctx = peekContextInfo(msg)

	let quotedMsgId: string | null = null
	let quotedParticipant: string | null = null
	let quotedText: string | null = null
	if (ctx?.stanzaId) {
		quotedMsgId = ctx.stanzaId
		quotedParticipant = ctx.participant ?? null
		if (ctx.quotedMessage) {
			const q = unwrap(ctx.quotedMessage)
			quotedText = q ? (peekText(q) ?? peekCaption(q)) : null
		}
	}

	return {
		messageType,
		text,
		caption,
		isProtocol,
		forwarded: ctx?.isForwarded ?? null,
		forwardScore: ctx?.forwardingScore ?? null,
		quotedMsgId,
		quotedParticipant,
		quotedText
	}
}

export interface ExtractedReaction {
	/** ID of the message being reacted to. */
	targetId: string
	/** chatJid the target message lives in (may differ from outer chat in groups, but in practice
	 *  WhatsApp keeps it consistent). May be empty in DM reactions; caller should fall back to outer chat. */
	targetChatJid: string | null
	targetParticipant: string | null
	targetFromMe: boolean
	/** Empty/null emoji means "reaction removed". */
	emoji: string | null
	senderTimestampMs: number | null
}

export const extractReaction = (
	raw: proto.IMessage | null | undefined
): ExtractedReaction | null => {
	const msg = unwrap(raw)
	const r = msg?.reactionMessage
	if (!r?.key?.id) return null
	const ts = r.senderTimestampMs as unknown
	const tsNum =
		typeof ts === 'number'
			? ts
			: typeof ts === 'bigint'
				? Number(ts)
				: typeof (ts as { toNumber?: () => number })?.toNumber === 'function'
					? (ts as { toNumber: () => number }).toNumber()
					: null
	return {
		targetId: r.key.id,
		targetChatJid: r.key.remoteJid ?? null,
		targetParticipant: r.key.participant ?? null,
		targetFromMe: !!r.key.fromMe,
		emoji: r.text?.trim() || null,
		senderTimestampMs: tsNum
	}
}

export interface ExtractedProtocol {
	/** Enum name (e.g. "REVOKE", "EPHEMERAL_SETTING", "MESSAGE_EDIT"). */
	type: string | null
	/** Numeric enum value, useful when WA adds new types we don't have a name for. */
	typeCode: number | null
	/** Target message id (mostly relevant for REVOKE / MESSAGE_EDIT). */
	targetId: string | null
	targetChatJid: string | null
	targetParticipant: string | null
	targetFromMe: boolean | null
	/** Anything else worth showing in the renderer (ephemeral expiration, etc.). */
	extras: Record<string, unknown>
}

const PROTOCOL_TYPE_TABLE = (() => {
	const numToName: Record<number, string> = {}
	const nameToNum: Record<string, number> = {}
	const e = (proto.Message?.ProtocolMessage?.Type ?? {}) as Record<string, unknown>
	for (const [name, val] of Object.entries(e)) {
		if (typeof val === 'number') {
			numToName[val] = name
			nameToNum[name] = val
		}
	}
	return { numToName, nameToNum }
})()

/**
 * Resolves the protocolMessage type whether it was decoded as a numeric enum
 * (live socket events) or as a string name (revived from JSONB by JSON.parse).
 */
const resolveProtocolType = (
	t: unknown
): { name: string | null; code: number | null } => {
	if (typeof t === 'number') {
		return { name: PROTOCOL_TYPE_TABLE.numToName[t] ?? null, code: t }
	}
	if (typeof t === 'string') {
		return { name: t, code: PROTOCOL_TYPE_TABLE.nameToNum[t] ?? null }
	}
	return { name: null, code: null }
}

export const extractProtocol = (
	raw: proto.IMessage | null | undefined
): ExtractedProtocol | null => {
	const msg = unwrap(raw)
	const p = msg?.protocolMessage
	if (!p) return null
	const { name, code } = resolveProtocolType(p.type)
	const extras: Record<string, unknown> = {}
	if (p.ephemeralExpiration != null) extras.ephemeralExpiration = p.ephemeralExpiration
	if (p.ephemeralSettingTimestamp != null)
		extras.ephemeralSettingTimestamp = String(p.ephemeralSettingTimestamp)
	if (p.disappearingMode) extras.disappearingMode = p.disappearingMode
	if (p.editedMessage) extras.editedMessage = '<edited body present>'
	return {
		type: name,
		typeCode: code,
		targetId: p.key?.id ?? null,
		targetChatJid: p.key?.remoteJid ?? null,
		targetParticipant: p.key?.participant ?? null,
		targetFromMe: p.key ? !!p.key.fromMe : null,
		extras
	}
}

export interface ExtractedMedia {
	mediaType: 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'ptv' | 'gif'
	mimeType: string | null
	fileName: string | null
	fileLength: number | null
	width: number | null
	height: number | null
	durationSeconds: number | null
	pageCount: number | null
	mediaKey: Buffer | null
	fileSha256: Buffer | null
	fileEncSha256: Buffer | null
	directPath: string | null
	url: string | null
	thumbnail: Buffer | null
	jpegThumbnail: Buffer | null
	caption: string | null
	isVoiceNote: boolean | null
	waveform: Buffer | null
}

const toBuffer = (v: unknown): Buffer | null => {
	if (!v) return null
	if (Buffer.isBuffer(v)) return v
	if (v instanceof Uint8Array) return Buffer.from(v)
	return null
}

const toNumber = (v: unknown): number | null => {
	if (v == null) return null
	if (typeof v === 'number') return v
	if (typeof v === 'bigint') return Number(v)
	if (typeof v === 'string') {
		const n = Number(v)
		return Number.isFinite(n) ? n : null
	}
	if (typeof (v as { toNumber?: () => number }).toNumber === 'function') {
		try {
			return (v as { toNumber: () => number }).toNumber()
		} catch {
			return null
		}
	}
	return null
}

/**
 * If the message carries one of the known media payloads, returns a row ready
 * for `wa.media`. Otherwise returns null.
 */
export const extractMedia = (raw: proto.IMessage | null | undefined): ExtractedMedia | null => {
	const msg = unwrap(raw)
	if (!msg) return null

	const candidates: Array<[ExtractedMedia['mediaType'], unknown]> = [
		['image', msg.imageMessage],
		['video', msg.videoMessage],
		['audio', msg.audioMessage],
		['document', msg.documentMessage ?? msg.documentWithCaptionMessage?.message?.documentMessage],
		['sticker', msg.stickerMessage],
		['ptv', msg.ptvMessage]
	]
	for (const [mediaType, m] of candidates) {
		if (!m || typeof m !== 'object') continue
		const x = m as Record<string, unknown>

		const isGif = mediaType === 'video' && (x.gifPlayback === true || x.gifAttribution != null)
		return {
			mediaType: isGif ? 'gif' : mediaType,
			mimeType: (x.mimetype as string | undefined) ?? null,
			fileName: (x.fileName as string | undefined) ?? null,
			fileLength: toNumber(x.fileLength),
			width: toNumber(x.width),
			height: toNumber(x.height),
			durationSeconds: toNumber(x.seconds),
			pageCount: toNumber(x.pageCount),
			mediaKey: toBuffer(x.mediaKey),
			fileSha256: toBuffer(x.fileSha256),
			fileEncSha256: toBuffer(x.fileEncSha256),
			directPath: (x.directPath as string | undefined) ?? null,
			url: (x.url as string | undefined) ?? null,
			thumbnail: toBuffer(x.thumbnail),
			jpegThumbnail: toBuffer(x.jpegThumbnail),
			caption: (x.caption as string | undefined) ?? null,
			isVoiceNote: mediaType === 'audio' ? ((x.ptt as boolean | undefined) ?? null) : null,
			waveform: toBuffer(x.waveform)
		}
	}
	return null
}
