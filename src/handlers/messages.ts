import type { MessageUpsertType, WAMessage, WASocket } from 'baileys'

import { config } from '../config.js'
import { childLogger } from '../logger.js'

const log = childLogger('handler:messages')

/** WhatsApp JIDs we should never reply to. */
const STATUS_JID = 'status@broadcast'

/** True if we should reply to a given message. */
const shouldReply = (m: WAMessage): boolean => {
	if (!m.message) return false // ephemeral / protocol message we can't decode
	if (m.key.fromMe) return false // our own messages
	if (!m.key.remoteJid) return false
	if (m.key.remoteJid === STATUS_JID) return false // stories
	if (m.key.remoteJid.endsWith('@newsletter')) return false // channels
	if (m.messageStubType) return false // group system events, etc.

	if (config.allowedJids.length > 0 && !config.allowedJids.includes(m.key.remoteJid)) {
		log.debug({ jid: m.key.remoteJid }, 'skipping message: jid not in ALLOWED_JIDS')
		return false
	}

	return true
}

/** Best-effort plain-text extraction (works for the most common message types). */
const extractText = (m: WAMessage): string | undefined => {
	const msg = m.message
	if (!msg) return undefined
	return (
		msg.conversation ??
		msg.extendedTextMessage?.text ??
		msg.imageMessage?.caption ??
		msg.videoMessage?.caption ??
		msg.documentMessage?.caption ??
		undefined
	)
}

/**
 * Replies "Hello World" to every incoming user message we're allowed to
 * respond to.
 *
 * Quotes the original message so the conversation thread stays clean.
 */
export const handleIncomingMessages = async (
	sock: WASocket,
	{ messages, type }: { messages: WAMessage[]; type: MessageUpsertType }
): Promise<void> => {
	if (type !== 'notify') return // historical / re-sync messages — ignore

	for (const m of messages) {
		if (!shouldReply(m)) continue

		const jid = m.key.remoteJid!
		const text = extractText(m)
		log.info({ from: jid, text }, 'incoming message')

		try {
			await sock.sendMessage(jid, { text: 'Hello World' }, { quoted: m })
		} catch (err) {
			log.error({ err, jid }, 'failed to send Hello World reply')
		}
	}
}
