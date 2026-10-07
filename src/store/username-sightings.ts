import type { Contact, WAMessage } from 'baileys'

import { normalizeUsername } from '../api/format.js'

/**
 * Usernames WhatsApp reveals on its own. Pure functions (no DB), so the
 * format checks can exercise them.
 */

export type UsernameSource = 'usync' | 'contact' | 'message'

export interface UsernameSighting {
	username: string
	jid: string
	source: UsernameSource
}

const isIndividual = (jid: string | null | undefined): jid is string =>
	!!jid && (/^\d{6,20}@lid$/.test(jid) || /^\d{6,20}@s\.whatsapp\.net$/.test(jid))

/** LID first: WhatsApp addresses 1:1 chats by LID. */
const preferLid = (...jids: Array<string | null | undefined>): string | null =>
	jids.find(j => isIndividual(j) && j.endsWith('@lid')) ?? jids.find(isIndividual) ?? null

/** Usernames WhatsApp attaches to contacts (app-state contact sync, history). */
export const sightingsFromContacts = (list: Contact[]): UsernameSighting[] =>
	list.flatMap(c => {
		const username = c.username ? normalizeUsername(c.username) : null
		const jid = preferLid(c.lid, c.id, c.phoneNumber)
		return username && jid ? [{ username, jid, source: 'contact' as const }] : []
	})

/**
 * Usernames WhatsApp attaches to 1:1 message stanzas (`peer_recipient_username`
 * / `recipient_username`, surfaced by Baileys as `key.remoteJidUsername`).
 * They come from WhatsApp itself, never from message text, so they can't be
 * spoofed by whoever is typing.
 */
export const sightingsFromMessages = (list: WAMessage[]): UsernameSighting[] =>
	list.flatMap(m => {
		const raw = m.key?.remoteJidUsername
		const username = raw ? normalizeUsername(raw) : null
		const jid = preferLid(m.key?.remoteJid, m.key?.remoteJidAlt)
		return username && jid ? [{ username, jid, source: 'message' as const }] : []
	})
