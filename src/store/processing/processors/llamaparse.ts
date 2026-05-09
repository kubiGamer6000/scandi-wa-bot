import LlamaCloud from '@llamaindex/llama-cloud'
import { Readable } from 'node:stream'

import type { ProcessorContext, ProcessorFn, ProcessorResult } from './types.js'

let _client: LlamaCloud | null = null

const getClient = (apiKey: string): LlamaCloud => {
	if (!_client) {
		_client = new LlamaCloud({ apiKey })
	}
	return _client
}

export const processDocument: ProcessorFn = async (ctx, input): Promise<ProcessorResult> => {
	const apiKey = ctx.config.llamaCloudApiKey
	if (!apiKey) throw new Error('LLAMA_CLOUD_API_KEY not configured')

	const client = getClient(apiKey)

	const startMs = Date.now()
	const buffer = await ctx.storage.download(input.gcsObject)

	const ext = input.gcsObject.split('.').pop() ?? 'bin'
	const fileName = `document.${ext}`

	const uploaded = await client.files.create({
		file: Readable.from(buffer),
		purpose: 'parse',
		filename: fileName
	} as never)

	const tier = ctx.config.llamaParseTier
	const parseResult = await client.parsing.parse({
		file_id: (uploaded as { id: string }).id,
		tier,
		version: 'latest',
		output: { markdown: { enabled: true } },
		expand: ['markdown']
	} as never)

	const processingMs = Date.now() - startMs

	const pages: string[] =
		(parseResult as { markdown?: { pages?: { text?: string }[] } }).markdown?.pages?.map(
			(p: { text?: string }) => p.text ?? ''
		) ?? []
	const resultText = pages.join('\n\n<!-- PAGE BREAK -->\n\n')

	const resultMeta: Record<string, unknown> = {
		model: `llamaparse_${tier}`,
		pageCount: pages.length,
		inputBytes: buffer.byteLength,
		fileName
	}

	return { resultText, resultMeta, processingMs }
}
