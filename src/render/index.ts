import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { closeDb, verifyDb } from '../db/index.js'
import { childLogger } from '../logger.js'

import { renderConversation } from './conversation.js'

export { renderConversation } from './conversation.js'
export { resolveTarget, fetchAccount, buildNameDirectory } from './lookup.js'

const log = childLogger('render')

const usage = `\nUsage: tsx src/render/index.ts <phone-or-jid> [out.md]\n
Examples:
  tsx src/render/index.ts +447960451664
  tsx src/render/index.ts 447960451664@s.whatsapp.net out/alice.md
  tsx src/render/index.ts 1203456789@g.us\n`

const slugify = (s: string): string =>
	s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'chat'

const defaultOutPath = (target: string): string => {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
	return resolve('out', `${slugify(target)}_${stamp}.md`)
}

const main = async (): Promise<number> => {
	const [, , targetArg, outArg] = process.argv
	if (!targetArg) {
		console.error(usage)
		return 2
	}

	await verifyDb()
	try {
		const result = await renderConversation({ target: targetArg })
		const outPath = outArg ? resolve(outArg) : defaultOutPath(targetArg)
		await mkdir(dirname(outPath), { recursive: true })
		await writeFile(outPath, result.markdown, 'utf-8')

		log.info(
			{
				out: outPath,
				chatJids: result.target.chatJids,
				messages: result.messageCount,
				contact: result.target.contactName,
				phone: result.target.contactPn,
				lid: result.target.contactLid
			},
			'rendered conversation'
		)
		return 0
	} finally {
		await closeDb().catch(() => {})
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().then(code => process.exit(code)).catch(err => {
		log.fatal({ err }, 'render failed')
		process.exit(1)
	})
}
