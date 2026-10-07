/**
 * Text formatting for outbound notifications.
 *
 * WhatsApp's own syntax (sent as-is with `format: "whatsapp"`):
 *   *bold*  _italic_  ~strikethrough~  `inline code`  ```code block```
 *   > quote      - bullet      1. numbered
 * Links are made clickable by the WhatsApp client when they appear as plain
 * URLs; there is no way to hide a URL behind link text.
 *
 * `format: "markdown"` converts the common Markdown subset to that:
 *   **bold** / __bold__  → *bold*
 *   *italic* / _italic_  → _italic_
 *   ~~strike~~           → ~strike~
 *   # Heading            → *Heading*
 *   [text](https://url)  → text: https://url
 *   * item / + item      → - item
 * Code spans and fenced blocks pass through untouched.
 */

/** Convert Markdown to WhatsApp formatting. */
export const markdownToWhatsapp = (input: string): string => {
	// Protect code (fenced blocks first, then inline) from every other rule.
	const vault: string[] = []
	const stash = (s: string): string => {
		vault.push(s)
		return `\u0000${vault.length - 1}\u0000`
	}
	let text = input.replace(/\r\n/g, '\n')
	text = text.replace(/```[\s\S]*?```/g, m => stash(m))
	text = text.replace(/`[^`\n]+`/g, m => stash(m))

	// Links: WhatsApp can't hide URLs, so keep both, and keep bare URLs bare.
	text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) =>
		label.trim() === url ? url : `${label}: ${url}`
	)
	// Stash URLs so `_` / `*` inside them are never treated as formatting.
	text = text.replace(/https?:\/\/[^\s<>]+/g, m => stash(m))

	// Bold first (into a placeholder), so single-asterisk italics can't eat it.
	const BOLD = '\u0001'
	text = text.replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, `${BOLD}$1${BOLD}`)
	text = text.replace(/__(?=\S)([^_\n]+?)__/g, `${BOLD}$1${BOLD}`)
	// Markdown italic: *x* or _x_ → WhatsApp _x_.
	text = text.replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)\*(?!\w)/g, '$1_$2_')
	text = text.replace(new RegExp(BOLD, 'g'), '*')
	// Strikethrough.
	text = text.replace(/~~(?=\S)([^~\n]+?)~~/g, '~$1~')

	// Line-level rules.
	text = text
		.split('\n')
		.map(line => {
			const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
			if (heading) return `*${heading[1]}*`
			const bullet = /^(\s*)[*+]\s+(.*)$/.exec(line)
			if (bullet) return `${bullet[1]}- ${bullet[2]}`
			if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return '———'
			return line
		})
		.join('\n')

	// Restore stashed code and URLs.
	return text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => vault[Number(i)] ?? '')
}

/**
 * Normalise a WhatsApp username: strips a leading `@`, lowercases, and checks
 * WhatsApp's rules (3–35 characters of a–z, 0–9, `.` and `_`, at least one
 * letter, no leading/trailing or doubled dot). Returns null when invalid.
 */
export const normalizeUsername = (raw: string): string | null => {
	const value = raw.trim().replace(/^@/, '').toLowerCase()
	if (!/^[a-z0-9._]{3,35}$/.test(value)) return null
	if (!/[a-z]/.test(value)) return null
	if (value.startsWith('.') || value.endsWith('.') || value.includes('..')) return null
	return value
}

export type Recipient =
	| { kind: 'phone'; digits: string }
	| { kind: 'jid'; jid: string }
	| { kind: 'username'; username: string; key?: string }

/**
 * Normalise a recipient into a phone number (digits, international format
 * without `+`), a WhatsApp JID, or a WhatsApp username. Returns null when it
 * is none of them.
 *
 *   "+46 70 123 45 67"            → phone
 *   "46701234567@s.whatsapp.net"  → jid   ("…@lid" too; groups refused)
 *   "@handle"                     → username
 *   { username: "handle", key? }  → username (key = the person's username PIN, if set)
 */
export const parseRecipient = (raw: string | { username: string; key?: string }): Recipient | null => {
	if (typeof raw !== 'string') {
		const username = normalizeUsername(raw.username)
		if (!username) return null
		const key = raw.key?.trim()
		if (key !== undefined && key !== '' && !/^[A-Za-z0-9]{1,32}$/.test(key)) return null
		return key ? { kind: 'username', username, key } : { kind: 'username', username }
	}
	const value = raw.trim()
	if (value.startsWith('@')) {
		const username = normalizeUsername(value)
		return username ? { kind: 'username', username } : null
	}
	if (value.includes('@')) {
		const jid = value.toLowerCase()
		// Individual chats only — notifications never go to groups or broadcasts.
		if (/^\d{6,20}@s\.whatsapp\.net$/.test(jid) || /^\d{6,20}@lid$/.test(jid)) {
			return { kind: 'jid', jid }
		}
		return null
	}
	let digits = value.replace(/[\s().\-]/g, '')
	if (digits.startsWith('+')) digits = digits.slice(1)
	else if (digits.startsWith('00')) digits = digits.slice(2)
	if (!/^\d{8,15}$/.test(digits)) return null
	return { kind: 'phone', digits }
}
