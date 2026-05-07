import { sql } from 'drizzle-orm'

import { db, schema } from '../db/index.js'

const { accounts, contacts, chats, lidMappings } = schema

const stripNonDigits = (s: string): string => s.replace(/\D/g, '')

export interface AccountInfo {
	id: string
	label: string
	selfPnJid: string | null
	selfLidJid: string | null
	pushName: string | null
}

export const fetchAccount = async (label: string): Promise<AccountInfo | null> => {
	const rows = await db
		.select({
			id: accounts.id,
			label: accounts.label,
			selfPnJid: accounts.selfPnJid,
			selfLidJid: accounts.selfLidJid,
			pushName: accounts.pushName
		})
		.from(accounts)
		.where(sql`${accounts.label} = ${label}`)
		.limit(1)
	return rows[0] ?? null
}

export interface ResolvedTarget {
	/** Best single JID for header subject/type lookup. PN-form preferred over LID-form. */
	primaryChatJid: string
	/**
	 * Every JID under which messages of this conversation may live. WhatsApp v7
	 * splits a single logical DM across the PN-form chat (legacy / history-sync)
	 * and the LID-form chat (post-migration / live messages); we union both so
	 * the renderer shows one continuous timeline.
	 */
	chatJids: string[]
	contactJid: string | null
	contactName: string | null
	contactPn: string | null
	contactLid: string | null
	chatType: string | null
	chatSubject: string | null
}

/**
 * Resolves user input (phone number, raw JID, or LID) into a chat JID we
 * can query messages by. Logic:
 *
 *   1. If input contains '@', treat as a JID and use it as-is.
 *   2. Else strip to digits and try to find a matching contact via PN.
 *   3. If a LID-only contact is found, walk lid_mappings to find a PN match.
 *   4. Falls back to building a `<digits>@s.whatsapp.net` JID and warning.
 */
export const resolveTarget = async (
	accountId: string,
	rawInput: string
): Promise<ResolvedTarget> => {
	const input = rawInput.trim()

	if (input.includes('@')) {
		return enrich(accountId, input)
	}

	const digits = stripNonDigits(input)
	if (!digits) {
		throw new Error(`Cannot resolve "${rawInput}": expected a phone number or JID.`)
	}

	const matches = await db
		.select()
		.from(contacts)
		.where(
			sql`${contacts.accountId} = ${accountId}
			    AND (${contacts.pn} = ${digits}
			         OR ${contacts.pn} LIKE ${`${digits}@%`}
			         OR ${contacts.jid} LIKE ${`${digits}@%`}
			         OR ${contacts.jid} LIKE ${`${digits}:%`})`
		)
		.limit(5)

	if (matches.length) {
		const match = pickBestContactMatch(matches, digits)
		return enrich(accountId, match.jid)
	}

	const viaLid = await db
		.select()
		.from(lidMappings)
		.where(
			sql`${lidMappings.accountId} = ${accountId}
			    AND (${lidMappings.pn} = ${digits} OR ${lidMappings.pn} LIKE ${`${digits}@%`})`
		)
		.limit(1)
	if (viaLid[0]) {
		return enrich(accountId, viaLid[0].lid)
	}

	const guess = digits.includes('@') ? digits : `${digits}@s.whatsapp.net`
	return enrich(accountId, guess)
}

/**
 * Expands a JID into the full set of JIDs we should pull messages from.
 *
 * For a DM, this typically returns 2 JIDs: the PN form (history-sync legacy)
 * and the LID form (post-migration live messages). For a group, this is just
 * the single `@g.us` JID. For status broadcasts and similar special chats,
 * we leave them alone.
 */
const expandChatJids = async (accountId: string, primary: string): Promise<string[]> => {
	const set = new Set<string>([primary])

	if (
		primary.endsWith('@g.us') ||
		primary.endsWith('@newsletter') ||
		primary.endsWith('@broadcast') ||
		primary === 'status@broadcast' ||
		primary === '0@s.whatsapp.net'
	) {
		return [...set]
	}

	const contactRows = await db
		.select()
		.from(contacts)
		.where(
			sql`${contacts.accountId} = ${accountId}
			    AND (${contacts.jid} = ${primary}
			         OR ${contacts.pn} = ${primary}
			         OR ${contacts.lid} = ${primary})`
		)
	for (const c of contactRows) {
		if (c.jid) set.add(c.jid)
		if (c.pn) set.add(c.pn)
		if (c.lid) set.add(c.lid)
	}

	const lidRows = await db
		.select()
		.from(lidMappings)
		.where(
			sql`${lidMappings.accountId} = ${accountId}
			    AND (${lidMappings.pn} = ${primary} OR ${lidMappings.lid} = ${primary})`
		)
	for (const m of lidRows) {
		set.add(m.pn)
		set.add(m.lid)
	}

	return [...set]
}

type ContactRow = typeof contacts.$inferSelect

const pickBestContactMatch = (rows: ContactRow[], digits: string): ContactRow => {
	const exactPn = rows.find(r => r.pn === digits || r.pn === `${digits}@s.whatsapp.net`)
	if (exactPn) return exactPn
	const sNet = rows.find(r => r.jid.endsWith('@s.whatsapp.net'))
	if (sNet) return sNet
	return rows[0]!
}

const enrich = async (accountId: string, primary: string): Promise<ResolvedTarget> => {
	const chatJids = await expandChatJids(accountId, primary)

	// Pick the single best contact row: prefer the PN-form (it has the user's
	// saved name); fall back to whatever we have.
	const allContacts = await db
		.select()
		.from(contacts)
		.where(
			sql`${contacts.accountId} = ${accountId} AND ${contacts.jid} IN ${chatJids}`
		)
	const bestContact =
		allContacts.find(c => c.jid.endsWith('@s.whatsapp.net') && c.name) ??
		allContacts.find(c => c.jid.endsWith('@s.whatsapp.net')) ??
		allContacts.find(c => !!c.name) ??
		allContacts[0] ??
		null

	// Likewise, prefer the PN-form chat row for header subject/type.
	const allChats = await db
		.select({ jid: chats.jid, type: chats.type, subject: chats.subject })
		.from(chats)
		.where(sql`${chats.accountId} = ${accountId} AND ${chats.jid} IN ${chatJids}`)
	const bestChat =
		allChats.find(c => c.jid.endsWith('@s.whatsapp.net')) ??
		allChats.find(c => c.jid.endsWith('@g.us')) ??
		allChats[0] ??
		null

	const primaryChatJid = bestChat?.jid ?? bestContact?.jid ?? primary

	// If contact gave us PN/LID hints, surface them even when the matched
	// contact row doesn't carry them directly (LID-form rows often have null pn/lid).
	const counterpartLid =
		bestContact?.lid ??
		chatJids.find(j => j.endsWith('@lid')) ??
		null
	const counterpartPn =
		bestContact?.pn ??
		chatJids.find(j => j.endsWith('@s.whatsapp.net')) ??
		null

	return {
		primaryChatJid,
		chatJids,
		contactJid: bestContact?.jid ?? null,
		contactName: bestContact?.name ?? bestContact?.pushName ?? null,
		contactPn: counterpartPn,
		contactLid: counterpartLid,
		chatType: bestChat?.type ?? null,
		chatSubject: bestChat?.subject ?? null
	}
}

export interface NameDirectory {
	/** Direct map from any known JID alias to a display name. */
	readonly byJid: ReadonlyMap<string, string>
	/** PN ↔ LID translation derived from contacts + lid_mappings. */
	readonly pnToLid: ReadonlyMap<string, string>
	readonly lidToPn: ReadonlyMap<string, string>
	readonly self: { pn: string | null; lid: string | null; name: string | null }
}

/**
 * Builds a directory that maps every known JID alias (PN, LID, deviced-PN)
 * to the prettiest available display name.
 *
 * Order of preference per contact: `name` (saved name in WA) → `push_name`
 * (notify name they advertise) → bare JID.
 */
export const buildNameDirectory = async (account: AccountInfo): Promise<NameDirectory> => {
	const byJid = new Map<string, string>()
	const pnToLid = new Map<string, string>()
	const lidToPn = new Map<string, string>()

	const allContacts = await db
		.select({
			jid: contacts.jid,
			name: contacts.name,
			pushName: contacts.pushName,
			pn: contacts.pn,
			lid: contacts.lid
		})
		.from(contacts)
		.where(sql`${contacts.accountId} = ${account.id}`)

	for (const c of allContacts) {
		const display = c.name ?? c.pushName ?? c.jid
		setBest(byJid, c.jid, display)
		if (c.pn) {
			setBest(byJid, c.pn, display)
			if (c.lid) {
				pnToLid.set(c.pn, c.lid)
				lidToPn.set(c.lid, c.pn)
			}
		}
		if (c.lid) setBest(byJid, c.lid, display)
	}

	const mappings = await db
		.select()
		.from(lidMappings)
		.where(sql`${lidMappings.accountId} = ${account.id}`)
	for (const m of mappings) {
		if (!pnToLid.has(m.pn)) pnToLid.set(m.pn, m.lid)
		if (!lidToPn.has(m.lid)) lidToPn.set(m.lid, m.pn)
	}

	return {
		byJid,
		pnToLid,
		lidToPn,
		self: {
			pn: account.selfPnJid,
			lid: account.selfLidJid,
			name: account.pushName
		}
	}
}

const setBest = (m: Map<string, string>, k: string, v: string): void => {
	const cur = m.get(k)
	if (!cur || cur === k) m.set(k, v)
}

/** Strips device suffix (`:13` in `447xxx:13@s.whatsapp.net`) for resolution. */
export const stripDevice = (jid: string): string => jid.replace(/:\d+(?=@)/, '')

/**
 * Best-effort name lookup for a given JID (which may be PN, LID, deviced
 * variant, or unknown). Falls back to a short formatted JID.
 */
export const nameForJid = (
	dir: NameDirectory,
	jid: string | null | undefined,
	fallbackPushName: string | null = null
): string => {
	if (!jid) return fallbackPushName ?? '(unknown)'
	if (dir.self.pn && (jid === dir.self.pn || stripDevice(jid) === stripDevice(dir.self.pn))) {
		return dir.self.name ?? 'Me'
	}
	if (dir.self.lid && (jid === dir.self.lid || stripDevice(jid) === stripDevice(dir.self.lid))) {
		return dir.self.name ?? 'Me'
	}

	const candidates = [jid, stripDevice(jid)]
	const counterpart = dir.pnToLid.get(stripDevice(jid)) ?? dir.lidToPn.get(stripDevice(jid))
	if (counterpart) candidates.push(counterpart)

	for (const c of candidates) {
		const hit = dir.byJid.get(c)
		if (hit) return hit
	}
	return fallbackPushName ?? prettyJid(jid)
}

const prettyJid = (jid: string): string => {
	const at = jid.indexOf('@')
	if (at === -1) return jid
	const head = jid.slice(0, at)
	const tail = jid.slice(at + 1)
	const local = head.split(':')[0]
	if (tail === 's.whatsapp.net') return `+${local}`
	if (tail === 'lid') return `(lid ${local})`
	return jid
}
