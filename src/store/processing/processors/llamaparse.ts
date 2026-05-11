import LlamaCloud from '@llamaindex/llama-cloud'

import { logger } from '../../../logger.js'
import type { ProcessorFn, ProcessorResult } from './types.js'

const log = logger.child({ module: 'store:processing:llamaparse' })

let _client: LlamaCloud | null = null

const getClient = (apiKey: string): LlamaCloud => {
	if (!_client) {
		_client = new LlamaCloud({ apiKey })
	}
	return _client
}

const stitchPages = (
	pages: ReadonlyArray<{ success: boolean; markdown?: string; page_number?: number; error?: string }>
): string => {
	if (pages.length === 0) return ''
	const parts: string[] = []
	for (const p of pages) {
		if (p.success && typeof p.markdown === 'string') {
			parts.push(p.markdown)
		} else if (!p.success) {
			parts.push(`<!-- page ${p.page_number ?? '?'} failed: ${p.error ?? 'unknown'} -->`)
		}
	}
	return parts.join('\n\n<!-- PAGE BREAK -->\n\n')
}

export const processDocument: ProcessorFn = async (ctx, input): Promise<ProcessorResult> => {
	const apiKey = ctx.config.llamaCloudApiKey
	if (!apiKey) throw new Error('LLAMA_CLOUD_API_KEY not configured')

	const client = getClient(apiKey)

	const startMs = Date.now()
	const buffer = await ctx.storage.download(input.gcsObject)

	const ext = input.gcsObject.split('.').pop() ?? 'bin'
	const fileName = `document.${ext}`

	// Node 20+ provides a global File constructor that the SDK's
	// Uploadable union accepts directly — no fs round-trip, no casts.
	const file = new File([new Uint8Array(buffer)], fileName, {
		type: input.mimeType ?? 'application/octet-stream'
	})

	const uploaded = await client.files.create({ file, purpose: 'parse' })
	const fileId = uploaded.id

	const tier = ctx.config.llamaParseTier

	try {
		// `parse()` is the high-level helper: creates the job, polls
		// to completion, and returns the full result. `expand: ['markdown']`
		// populates BOTH `markdown` (per-page) and `markdown_full` (string).
		const result = await client.parsing.parse({
			file_id: fileId,
			tier,
			version: 'latest',
			expand: ['markdown']
		})

		const processingMs = Date.now() - startMs

		const pages = result.markdown?.pages ?? []
		const fullText = result.markdown_full ?? stitchPages(pages)

		const successCount = pages.filter(p => p.success).length
		const failedCount = pages.length - successCount

		const resultMeta: Record<string, unknown> = {
			model: `llamaparse_${tier}`,
			pageCount: pages.length,
			pagesSucceeded: successCount,
			pagesFailed: failedCount,
			inputBytes: buffer.byteLength,
			fileName,
			jobId: result.job?.id ?? null
		}

		return { resultText: fullText, resultMeta, processingMs }
	} finally {
		// Best-effort cleanup so we don't accumulate uploaded files
		// against the project's storage quota. Same pattern as Gemini.
		try {
			await client.files.delete(fileId)
		} catch (err) {
			log.warn({ err, fileId }, 'failed to delete LlamaCloud file (non-fatal)')
		}
	}
}
