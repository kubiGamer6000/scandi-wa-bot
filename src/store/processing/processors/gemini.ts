import { setTimeout as sleep } from 'node:timers/promises'

import { FileState, GoogleGenAI, type File as GenaiFile } from '@google/genai'

import type { ProcessorContext, ProcessorFn, ProcessorInput, ProcessorResult } from './types.js'

let _client: GoogleGenAI | null = null

const getClient = (apiKey: string): GoogleGenAI => {
	if (!_client) {
		_client = new GoogleGenAI({ apiKey })
	}
	return _client
}

/**
 * Wait for an uploaded Files API entry to reach ACTIVE state.
 *
 * Images are processed almost instantly; long videos can take 1-2 minutes
 * (Gemini reads frames at 1 fps server-side). We cap at 5 minutes total.
 */
const waitForActive = async (
	ai: GoogleGenAI,
	fileName: string,
	ctx: ProcessorContext
): Promise<GenaiFile> => {
	const deadline = Date.now() + 5 * 60 * 1000
	let backoffMs = 1000
	while (Date.now() < deadline) {
		const file = await ai.files.get({ name: fileName })
		if (file.state === FileState.ACTIVE) return file
		if (file.state === FileState.FAILED) {
			throw new Error(`Gemini Files API reported FAILED state for ${fileName}`)
		}
		ctx.log.debug({ fileName, state: file.state }, 'gemini file still processing')
		await sleep(backoffMs)
		backoffMs = Math.min(backoffMs * 1.5, 10_000)
	}
	throw new Error(`Gemini Files API did not reach ACTIVE within 5 minutes for ${fileName}`)
}

const callGemini = async (
	ctx: ProcessorContext,
	input: ProcessorInput,
	isVideo: boolean
): Promise<ProcessorResult> => {
	const apiKey = ctx.config.geminiApiKey
	if (!apiKey) throw new Error('GEMINI_API_KEY not configured')

	const ai = getClient(apiKey)
	const mimeType = input.mimeType ?? (isVideo ? 'video/mp4' : 'image/jpeg')
	const prompt = input.prompt ?? ''

	const startMs = Date.now()
	const buffer = await ctx.storage.download(input.gcsObject)
	const blob = new Blob([new Uint8Array(buffer)], { type: mimeType })

	// Upload to Gemini Files API. The public Gemini Developer API doesn't
	// accept gs:// URIs (those need OAuth + Cloud Storage registration), so
	// we go through the Files API instead. We delete the upload as soon as
	// inference completes to avoid filling the 20 GiB per-project quota.
	let uploaded: GenaiFile | null = null
	try {
		uploaded = await ai.files.upload({
			file: blob,
			config: { mimeType }
		})
		const fileName = uploaded.name
		if (!fileName) throw new Error('Gemini Files API upload returned no file name')

		const ready = await waitForActive(ai, fileName, ctx)
		const fileUri = ready.uri
		if (!fileUri) throw new Error(`Gemini Files API entry has no URI: ${fileName}`)

		const filePart: Record<string, unknown> = {
			fileData: { fileUri, mimeType: ready.mimeType ?? mimeType }
		}
		if (isVideo) filePart.videoMetadata = { fps: 1 }

		const response = await ai.models.generateContent({
			model: input.model,
			contents: [
				{
					role: 'user',
					parts: [filePart as never, { text: prompt }]
				}
			]
		})

		const processingMs = Date.now() - startMs
		const resultText = response.text ?? ''
		const resultMeta: Record<string, unknown> = {
			model: input.model,
			finishReason: response.candidates?.[0]?.finishReason ?? null,
			tokensUsed: response.usageMetadata ?? null,
			geminiFile: fileName,
			geminiFileBytes: buffer.byteLength,
			gcsObject: input.gcsObject
		}
		return { resultText, resultMeta, processingMs }
	} finally {
		// Always delete the temporary Files API entry so we don't accumulate
		// storage. Best-effort: never fail the job because cleanup failed.
		const fileName = uploaded?.name
		if (fileName) {
			try {
				await ai.files.delete({ name: fileName })
			} catch (err) {
				ctx.log.warn({ err, fileName }, 'gemini file cleanup failed (non-fatal)')
			}
		}
	}
}

export const processVideo: ProcessorFn = async (ctx, input) => callGemini(ctx, input, true)
export const processImage: ProcessorFn = async (ctx, input) => callGemini(ctx, input, false)
