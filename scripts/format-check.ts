/**
 * Checks for the notification text formatter, recipient parser and the
 * username lookup (against a fake socket — nothing is sent to WhatsApp).
 *   npm run test:format
 */
import type { USyncQuery } from 'baileys'

import { markdownToWhatsapp, normalizeUsername, parseRecipient } from '../src/api/format.js'
import { pickUsernameMatch, usyncLookupUsername } from '../src/api/username-lookup.js'
import { sightingsFromContacts, sightingsFromMessages } from '../src/store/username-sightings.js'

let failures = 0
const eq = (name: string, actual: unknown, expected: unknown): void => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected)
	if (!ok) failures++
	console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n     got:      ${JSON.stringify(actual)}\n     expected: ${JSON.stringify(expected)}`}`)
}

// Markdown → WhatsApp
eq('bold **x**', markdownToWhatsapp('a **new video** for you'), 'a *new video* for you')
eq('bold __x__', markdownToWhatsapp('__urgent__'), '*urgent*')
eq('italic *x*', markdownToWhatsapp('due *tomorrow*'), 'due _tomorrow_')
eq('italic _x_ unchanged', markdownToWhatsapp('due _tomorrow_'), 'due _tomorrow_')
eq('bold + italic on one line', markdownToWhatsapp('**Concept 1906** is *ready*'), '*Concept 1906* is _ready_')
eq('strikethrough', markdownToWhatsapp('~~old~~ new'), '~old~ new')
eq('heading', markdownToWhatsapp('## New assignment'), '*New assignment*')
eq('link with label', markdownToWhatsapp('[Open brief](https://app.example.com/v/12)'), 'Open brief: https://app.example.com/v/12')
eq('bare url untouched', markdownToWhatsapp('see https://x.com/a_b_c/*d*'), 'see https://x.com/a_b_c/*d*')
eq('url-only link label', markdownToWhatsapp('[https://x.io](https://x.io)'), 'https://x.io')
eq('bullets', markdownToWhatsapp('* one\n+ two\n- three'), '- one\n- two\n- three')
eq('numbered list kept', markdownToWhatsapp('1. first\n2. second'), '1. first\n2. second')
eq('inline code protected', markdownToWhatsapp('run `**x**` now'), 'run `**x**` now')
eq('code block protected', markdownToWhatsapp('```\n**raw**\n```'), '```\n**raw**\n```')
eq('snake_case untouched', markdownToWhatsapp('file_name_v2.mp4'), 'file_name_v2.mp4')
eq('quote kept', markdownToWhatsapp('> note'), '> note')
eq('rule', markdownToWhatsapp('---'), '———')

// Recipients
eq('+46 spaced', parseRecipient('+46 70 483 29 98'), { kind: 'phone', digits: '46704832998' })
eq('00 prefix', parseRecipient('0046704832998'), { kind: 'phone', digits: '46704832998' })
eq('dashes/parens', parseRecipient('+1 (415) 555-0100'), { kind: 'phone', digits: '14155550100' })
eq('pn jid', parseRecipient('46704832998@s.whatsapp.net'), { kind: 'jid', jid: '46704832998@s.whatsapp.net' })
eq('lid jid', parseRecipient('215714799603744@lid'), { kind: 'jid', jid: '215714799603744@lid' })
eq('group refused', parseRecipient('120363419881705357@g.us'), null)
eq('broadcast refused', parseRecipient('status@broadcast'), null)
eq('too short', parseRecipient('12345'), null)
eq('letters refused', parseRecipient('+46 70 ABC'), null)

// Usernames
eq('@handle', parseRecipient('@Scandi.Gum_1'), { kind: 'username', username: 'scandi.gum_1' })
eq('@handle trimmed', parseRecipient('  @rex  '), { kind: 'username', username: 'rex' })
eq('{username}', parseRecipient({ username: 'rex_edits' }), { kind: 'username', username: 'rex_edits' })
eq('{username, key}', parseRecipient({ username: '@rex', key: '1234' }), { kind: 'username', username: 'rex', key: '1234' })
eq('bad key refused', parseRecipient({ username: 'rex', key: '12 34' }), null)
eq('@ too short', parseRecipient('@ab'), null)
eq('@ digits only', parseRecipient('@12345'), null)
eq('@ bad chars', parseRecipient('@rex-edits'), null)
eq('@ leading dot', parseRecipient('@.rex'), null)
eq('@ double dot', parseRecipient('@re..x'), null)
eq('@ 36 chars', parseRecipient(`@${'a'.repeat(36)}`), null)
eq('normalize', normalizeUsername('@Rex.Edits'), 'rex.edits')

// USync result → JID
eq('usync: lid wins', pickUsernameMatch([{ id: '46704832998@s.whatsapp.net', contact: true, lid: '215714799603744@lid' }]), '215714799603744@lid')
eq('usync: id when no lid', pickUsernameMatch([{ id: '215714799603744@lid', contact: true }]), '215714799603744@lid')
eq('usync: contact=false is a miss', pickUsernameMatch([{ id: '215714799603744@lid', contact: false }]), null)
eq('usync: empty', pickUsernameMatch([]), null)
eq('usync: undefined', pickUsernameMatch(undefined), null)
eq('usync: group id refused', pickUsernameMatch([{ id: '120363419881705357@g.us', contact: true }]), null)

// The query sent to WhatsApp: <contact username="…" pin="…"/> + <lid/>
const fakeSock = (list: unknown[]) => {
	const seen: USyncQuery[] = []
	return {
		seen,
		executeUSyncQuery: async (q: USyncQuery) => {
			seen.push(q)
			return { list, sideList: [] } as never
		}
	}
}
const sock1 = fakeSock([{ id: '215714799603744@lid', contact: true }])
eq('usync: resolves', await usyncLookupUsername(sock1, 'rex', '1234'), '215714799603744@lid')
const q = sock1.seen[0]!
eq('usync: protocols', q.protocols.map(p => p.name), ['contact', 'lid'])
eq('usync: contact element', q.protocols[0]!.getUserElement(q.users[0]!), { tag: 'contact', attrs: { username: 'rex', pin: '1234' } })
eq('usync: no pin when no key', (() => {
	const s = fakeSock([])
	void usyncLookupUsername(s, 'rex')
	return s.seen[0]!.protocols[0]!.getUserElement(s.seen[0]!.users[0]!)
})(), { tag: 'contact', attrs: { username: 'rex' } })
eq('usync: not found', await usyncLookupUsername(fakeSock([]), 'nobody_here'), null)

// Usernames WhatsApp reveals on its own
eq('sighting: contact', sightingsFromContacts([{ id: '215714799603744@lid', username: 'Rex' }]), [{ username: 'rex', jid: '215714799603744@lid', source: 'contact' }])
eq('sighting: contact without username', sightingsFromContacts([{ id: '215714799603744@lid' }]), [])
eq('sighting: message prefers lid', sightingsFromMessages([{ key: { remoteJid: '46704832998@s.whatsapp.net', remoteJidAlt: '215714799603744@lid', remoteJidUsername: 'rex' } }]), [{ username: 'rex', jid: '215714799603744@lid', source: 'message' }])
eq('sighting: group message ignored', sightingsFromMessages([{ key: { remoteJid: '120363419881705357@g.us', remoteJidUsername: 'rex' } }]), [])

console.log(failures ? `\n${failures} failed` : '\nall formatting checks passed')
process.exit(failures ? 1 : 0)
