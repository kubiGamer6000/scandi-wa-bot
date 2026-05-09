import type { Logger } from 'pino'
import type { MediaStorage } from '../../media/storage.js'
import type { ProcessingConfig } from '../../../config.js'

export interface ProcessorInput {
	readonly id: bigint
	readonly mediaId: bigint
	readonly gcsBucket: string
	readonly gcsObject: string
	readonly mimeType: string | null
	readonly sizeBytes: number | null
	readonly prompt: string | null
	readonly model: string
}

export interface ProcessorResult {
	readonly resultText: string
	readonly resultMeta: Record<string, unknown>
	readonly processingMs: number
}

export interface ProcessorContext {
	readonly storage: MediaStorage
	readonly config: ProcessingConfig
	readonly log: Logger
}

export type ProcessorFn = (
	ctx: ProcessorContext,
	input: ProcessorInput
) => Promise<ProcessorResult>
