import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js'

import type { ProcessorContext, ProcessorFn, ProcessorResult } from './types.js'

let _client: ElevenLabsClient | null = null

const getClient = (apiKey: string): ElevenLabsClient => {
	if (!_client) {
		_client = new ElevenLabsClient({ apiKey })
	}
	return _client
}

export const processAudio: ProcessorFn = async (ctx, input): Promise<ProcessorResult> => {
	const apiKey = ctx.config.elevenlabsApiKey
	if (!apiKey) throw new Error('ELEVENLABS_API_KEY not configured')

	const client = getClient(apiKey)

	const startMs = Date.now()
	const buffer = await ctx.storage.download(input.gcsObject)

	const mimeType = input.mimeType ?? 'audio/ogg'
	const ext = mimeType.includes('mp3') ? 'mp3' : mimeType.includes('mp4') ? 'm4a' : 'ogg'
	const file = new File([new Uint8Array(buffer)], `audio.${ext}`, { type: mimeType })

	const result = await client.speechToText.convert({
		file,
		modelId: input.model as 'scribe_v2' | 'scribe_v1'
	})
	const processingMs = Date.now() - startMs

	const body = result as { text?: string; languageCode?: string; languageProbability?: number }
	const resultText = body.text ?? ''
	const resultMeta: Record<string, unknown> = {
		model: input.model,
		languageCode: body.languageCode ?? null,
		languageProbability: body.languageProbability ?? null,
		wordCount: resultText.split(/\s+/).filter(Boolean).length
	}

	return { resultText, resultMeta, processingMs }
}
