/**
 * Checks for the notification text formatter and recipient parser.
 *   npm run test:format
 */
import { markdownToWhatsapp, parseRecipient } from '../src/api/format.js'

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

console.log(failures ? `\n${failures} failed` : '\nall formatting checks passed')
process.exit(failures ? 1 : 0)
