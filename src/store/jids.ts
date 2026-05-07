import type { chats } from '../db/schema.js'

export type ChatType = (typeof chats.$inferInsert)['type']

const SUFFIX_TO_TYPE: Record<string, ChatType> = {
	's.whatsapp.net': 'dm',
	'g.us': 'group',
	lid: 'lid',
	broadcast: 'broadcast',
	newsletter: 'newsletter',
	'status@broadcast': 'status'
}

/**
 * Maps a JID to one of the seven chat-type buckets used in `wa.chats.type`.
 * Falls back to 'system' (covers `0@s.whatsapp.net` system messages and any
 * unknown future suffix).
 */
export const classifyJid = (jid: string): ChatType => {
	if (!jid) return 'system'
	if (jid === 'status@broadcast') return 'status'
	if (jid === '0@s.whatsapp.net') return 'system'

	const at = jid.indexOf('@')
	if (at === -1) return 'system'
	const suffix = jid.slice(at + 1)
	return SUFFIX_TO_TYPE[suffix] ?? 'system'
}

/** True when a JID identifies a real (human or group) endpoint we want to ingest. */
export const isIngestibleJid = (jid: string | null | undefined): jid is string => {
	if (!jid) return false
	if (jid === 'status@broadcast') return false
	if (jid === '0@s.whatsapp.net') return false
	return jid.includes('@')
}
