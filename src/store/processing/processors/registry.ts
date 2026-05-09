import type { ProcessorFn } from './types.js'
import { processVideo, processImage } from './gemini.js'
import { processAudio } from './elevenlabs.js'
import { processDocument } from './llamaparse.js'

export const PROCESSOR_REGISTRY: Record<string, ProcessorFn> = {
	gemini_video: processVideo,
	gemini_image: processImage,
	elevenlabs_audio: processAudio,
	llamaparse_document: processDocument
}
