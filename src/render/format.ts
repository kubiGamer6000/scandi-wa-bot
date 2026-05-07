import type { proto } from 'baileys'

import type { schema } from '../db/index.js'
import { extractProtocol } from '../store/extract.js'

import { nameForJid, type NameDirectory } from './lookup.js'

type MessageRow = typeof schema.messages.$inferSelect
type EditRow = typeof schema.messageEdits.$inferSelect
type ReactionRow = typeof schema.reactions.$inferSelect
type MediaRow = typeof schema.media.$inferSelect

export interface FormatBundle {
	message: MessageRow
	edits: EditRow[]
	reactions: ReactionRow[]
	media: MediaRow | null
}

export interface FormatContext {
	dir: NameDirectory
	isGroup: boolean
}

const fmtTime = (d: Date): string =>
	`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`

const fmtDate = (d: Date): string =>
	`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`

const pad = (n: number): string => n.toString().padStart(2, '0')

const escMd = (s: string | null | undefined): string => {
	if (!s) return ''
	return s
		.replace(/\\/g, '\\\\')
		.replace(/([_*`~])/g, '\\$1')
		.replace(/\r\n?/g, '\n')
}

const indent = (s: string, prefix: string): string =>
	s
		.split('\n')
		.map(line => prefix + line)
		.join('\n')

const fmtDuration = (s: number | null): string => {
	if (s == null || s <= 0) return ''
	const m = Math.floor(s / 60)
	const r = s % 60
	return `${m}:${pad(r)}`
}

const fmtBytes = (b: number | null): string => {
	if (!b || b <= 0) return ''
	if (b < 1024) return `${b} B`
	if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
	return `${(b / 1024 / 1024).toFixed(1)} MB`
}

const renderMediaTag = (m: MediaRow | null): string | null => {
	if (!m) return null
	const bits: string[] = []
	switch (m.mediaType) {
		case 'image':
			bits.push('🖼 image')
			break
		case 'video':
			bits.push('🎥 video')
			break
		case 'gif':
			bits.push('🎞 gif')
			break
		case 'audio':
			bits.push(m.isVoiceNote ? '🎙 voice note' : '🎵 audio')
			break
		case 'document':
			bits.push('📄 document')
			break
		case 'sticker':
			bits.push('🩹 sticker')
			break
		case 'ptv':
			bits.push('📹 video note')
			break
		default:
			bits.push(m.mediaType)
	}
	if (m.fileName) bits.push(`"${m.fileName}"`)
	if (m.mimeType) bits.push(m.mimeType)
	if (m.width && m.height) bits.push(`${m.width}×${m.height}`)
	if (m.durationSeconds) bits.push(fmtDuration(m.durationSeconds))
	const size = fmtBytes(m.fileLength)
	if (size) bits.push(size)
	if (m.gcsObject) bits.push(`gcs://${m.gcsBucket ?? '?'}/${m.gcsObject}`)
	else if (m.downloadStatus !== 'done') bits.push(`(media not yet downloaded: ${m.downloadStatus})`)
	return `[${bits.join(' • ')}]`
}

const renderQuote = (m: MessageRow, ctx: FormatContext): string | null => {
	if (!m.quotedMsgId) return null
	const who = nameForJid(ctx.dir, m.quotedParticipant, null)
	const text = m.quotedText
		? m.quotedText.length > 200
			? `${m.quotedText.slice(0, 200)}…`
			: m.quotedText
		: '(quote body unavailable)'
	return `> *↩ Replying to ${who}:* ${escMd(text).replace(/\n/g, ' ')}`
}

const renderReactions = (
	reactions: ReactionRow[],
	ctx: FormatContext
): string | null => {
	const live = reactions.filter(r => r.emoji && r.emoji.length > 0)
	if (!live.length) return null
	const grouped = new Map<string, string[]>()
	for (const r of live) {
		const list = grouped.get(r.emoji!) ?? []
		list.push(nameForJid(ctx.dir, r.actorJid))
		grouped.set(r.emoji!, list)
	}
	const parts: string[] = []
	for (const [emoji, who] of grouped) {
		parts.push(`${emoji} ${who.join(', ')}`)
	}
	return `↳ Reactions: ${parts.join(' • ')}`
}

const renderEdits = (edits: EditRow[]): string | null => {
	if (!edits.length) return null
	const sorted = [...edits].sort((a, b) => a.version - b.version)
	const lines = sorted.map(e => {
		const body = (e.text ?? e.caption ?? '').replace(/\n/g, ' ')
		const ts = fmtTime(e.observedAt)
		return `  - *prior v${e.version}:* ${escMd(body) || '(empty)'}${ts ? `  · *${ts}*` : ''}`
	})
	return `↳ Edited ${edits.length}× — earlier versions:\n${lines.join('\n')}`
}

const senderLabel = (m: MessageRow, ctx: FormatContext): string => {
	if (m.fromMe) return ctx.dir.self.name ?? 'Me'
	if (ctx.isGroup) {
		return nameForJid(ctx.dir, m.participant ?? m.senderPn ?? null, m.pushName)
	}
	// DM: `participant` is typically null because the chat itself identifies
	// the sender. Fall back to the chat JID (the counterpart's JID).
	return nameForJid(ctx.dir, m.participant ?? m.chatJid, m.pushName)
}

const renderProtocolBody = (m: MessageRow, ctx: FormatContext): string => {
	const proj = extractProtocol(m.rawMessage as proto.IMessage | null | undefined)
	if (!proj) {
		const t = m.messageType ?? 'protocolMessage'
		return m.text ? `*system:* ${t} — ${escMd(m.text)}` : `*system:* ${t}`
	}

	const head = `*system: protocolMessage* — type=\`${proj.type ?? `#${proj.typeCode ?? '?'}`}\``
	const lines: string[] = [head]

	if (proj.targetId) {
		const who = proj.targetParticipant
			? nameForJid(ctx.dir, proj.targetParticipant, null)
			: proj.targetFromMe
				? (ctx.dir.self.name ?? 'Me')
				: '(other party)'
		lines.push(
			`> target message: \`${proj.targetId}\` from **${escMd(who)}**${
				proj.targetChatJid ? ` in \`${proj.targetChatJid}\`` : ''
			}`
		)
	}

	for (const [k, v] of Object.entries(proj.extras)) {
		lines.push(`> ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
	}

	return lines.join('\n')
}

/**
 * Extracts a compact "key:value" dump of a `messageContextInfo`-only payload
 * so the user can see what the side-channel was actually carrying. Avoids
 * dumping the device-list metadata (very noisy and usually irrelevant).
 */
const renderMessageContextInfoBody = (m: MessageRow): string => {
	const raw = m.rawMessage as Record<string, unknown> | null | undefined
	const ctxInfo = (raw?.messageContextInfo ?? {}) as Record<string, unknown>
	const interesting: string[] = []
	for (const [k, v] of Object.entries(ctxInfo)) {
		if (k === 'deviceListMetadata' || k === 'deviceListMetadataVersion') continue
		if (v == null) continue
		interesting.push(
			`> ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v).slice(0, 200)}`
		)
	}
	return ['*system: messageContextInfo* (envelope-only)', ...interesting].join('\n')
}

/**
 * Renders one message bundle (message + its edits + its reactions + its
 * media row) as a Markdown block. The block always begins with a blank
 * line, never ends with one — joining is the caller's job.
 */
export const formatMessage = (b: FormatBundle, ctx: FormatContext): string => {
	const { message: m, edits, reactions, media } = b
	const time = fmtTime(m.ts)
	const who = senderLabel(m, ctx)
	const head = `**${time}** — **${escMd(who)}**`

	if (m.isProtocol) {
		return `\n${head} *(system)*  \n${renderProtocolBody(m, ctx)}`
	}

	// Side-channel envelopes WhatsApp emits (e.g. messageContextInfo for key
	// rotation) carry no user-visible content. Surface what's actually inside
	// rather than just the type name, so it's clear why this row exists.
	if (m.messageType === 'messageContextInfo' && !m.text && !m.caption && !media) {
		return `\n${head} *(system)*  \n${renderMessageContextInfoBody(m)}`
	}

	const lines: string[] = [head]
	const quote = renderQuote(m, ctx)
	if (quote) lines.push(quote)

	const mediaTag = renderMediaTag(media)
	const body = m.text ?? m.caption ?? ''
	const bodyMd = escMd(body)

	let main: string
	if (m.deletedAt) {
		const reason = m.deletionReason
			? m.deletionReason.replace(/_/g, ' ')
			: 'deleted'
		const original = bodyMd || mediaTag || '(body never observed)'
		const byPart = m.deletedByJid ? ` by ${nameForJid(ctx.dir, m.deletedByJid, null)}` : ''
		main = `~~${original}~~  \n*(${reason}${byPart} at ${fmtTime(m.deletedAt)})*`
	} else if (mediaTag && bodyMd) {
		main = `${mediaTag}\n${bodyMd}`
	} else if (mediaTag) {
		main = mediaTag
	} else if (bodyMd) {
		main = bodyMd
	} else if (m.tombstone) {
		main = `*[tombstone — body never observed]*`
	} else {
		main = `*[unsupported message type: ${m.messageType ?? '?'}]*`
	}

	if (m.forwarded) {
		const score = m.forwardScore ? ` (×${m.forwardScore})` : ''
		main = `↪ *Forwarded${score}*\n${main}`
	}

	lines.push(main)

	const editTrail = renderEdits(edits)
	if (editTrail) lines.push(editTrail)

	const reactionLine = renderReactions(reactions, ctx)
	if (reactionLine) lines.push(reactionLine)

	return `\n${lines[0]}\n${indent(lines.slice(1).join('\n\n'), '')}`
}

/**
 * Some message rows are technical envelopes whose user-visible effect is
 * already rendered elsewhere:
 *   - reactionMessage rows surface as a reaction line under the target message
 *   - protocolMessage REVOKE rows surface as a strikethrough on the target
 * Hiding them keeps the timeline focused on what a human sees.
 */
export const isHiddenSystemRow = (m: MessageRow): boolean => {
	if (m.messageType === 'reactionMessage') return true
	const raw = m.rawMessage as { protocolMessage?: { type?: number | string } } | null | undefined
	const ptype = raw?.protocolMessage?.type
	if (ptype === 0 || ptype === 'REVOKE') return true
	return false
}

export interface HeaderInput {
	chatJid: string
	/** Other JIDs whose messages were merged into this conversation (e.g. LID counterpart). */
	additionalChatJids?: string[]
	chatType: string | null
	chatSubject: string | null
	contactName: string | null
	contactPn: string | null
	contactLid: string | null
	messageCount: number
	firstTs: Date | null
	lastTs: Date | null
	exportedAt: Date
	accountLabel: string
}

const phoneFromPn = (pn: string | null): string | null => {
	if (!pn) return null
	const digits = pn.split('@')[0]?.split(':')[0] ?? ''
	return digits ? `+${digits}` : null
}

export const formatHeader = (h: HeaderInput): string => {
	const phone = phoneFromPn(h.contactPn)
	const title =
		h.chatType === 'group'
			? `Group: ${h.chatSubject ?? '(no subject)'}`
			: `Conversation: ${h.contactName ?? phone ?? h.chatJid}`

	const meta: string[] = []
	meta.push(`- **Chat JID:** \`${h.chatJid}\``)
	if (h.additionalChatJids && h.additionalChatJids.length) {
		meta.push(
			`- **Merged from:** ${h.additionalChatJids.map(j => `\`${j}\``).join(', ')}`
		)
	}
	if (h.chatType) meta.push(`- **Type:** ${h.chatType}`)
	if (phone) meta.push(`- **Phone:** ${phone}`)
	if (h.contactLid) meta.push(`- **LID:** \`${h.contactLid}\``)
	meta.push(`- **Messages:** ${h.messageCount}`)
	if (h.firstTs) meta.push(`- **First message:** ${fmtDate(h.firstTs)} ${fmtTime(h.firstTs)}`)
	if (h.lastTs) meta.push(`- **Last message:** ${fmtDate(h.lastTs)} ${fmtTime(h.lastTs)}`)
	meta.push(`- **WA account:** \`${h.accountLabel}\``)
	meta.push(`- **Exported:** ${fmtDate(h.exportedAt)} ${fmtTime(h.exportedAt)}`)

	return `# ${title}\n\n${meta.join('\n')}\n\n---\n`
}

export { fmtDate, fmtTime }
