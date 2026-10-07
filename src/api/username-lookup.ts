import { USyncQuery, USyncUser, type WASocket } from 'baileys'

/**
 * Username → JID lookup against WhatsApp, via Baileys' USync protocols.
 * No DB here, so the format checks can exercise it with a fake socket.
 */

export const isIndividual = (jid: unknown): jid is string =>
	typeof jid === 'string' && (/^\d{6,20}@lid$/.test(jid) || /^\d{6,20}@s\.whatsapp\.net$/.test(jid))

/**
 * Pick the account out of a USync username result. `contact: false` means
 * WhatsApp said the username isn't a reachable account; a `lid` beats the
 * row id, which may be either form.
 */
export const pickUsernameMatch = (
	list: Array<{ id?: string; contact?: unknown; lid?: unknown }> | undefined
): string | null => {
	for (const row of list ?? []) {
		if (row.contact === false) continue
		if (isIndividual(row.lid) && row.lid.endsWith('@lid')) return row.lid
		if (isIndividual(row.id)) return row.id
	}
	return null
}

/** Ask WhatsApp who owns a username. Throws only on transport errors. */
export const usyncLookupUsername = async (
	sock: Pick<WASocket, 'executeUSyncQuery'>,
	username: string,
	key?: string
): Promise<string | null> => {
	const user = new USyncUser().withUsername(username)
	if (key) user.withUsernameKey(key)
	const query = new USyncQuery().withContactProtocol().withLIDProtocol().withUser(user)
	const result = await sock.executeUSyncQuery(query)
	return pickUsernameMatch(result?.list as Array<{ id?: string; contact?: unknown; lid?: unknown }> | undefined)
}
