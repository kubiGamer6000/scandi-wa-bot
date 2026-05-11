import { hostname } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

import pLimit from 'p-limit'
import { sql } from 'drizzle-orm'

import { childLogger } from '../../logger.js'
import type { ProcessingConfig } from '../../config.js'
import { db } from '../../db/index.js'
import type { StoreContext } from '../types.js'
import type { MediaStorage } from '../media/storage.js'
import { PROCESSOR_REGISTRY } from './processors/registry.js'
import type { ProcessorInput, ProcessorContext } from './processors/types.js'

const log = childLogger('store:processing:worker')

interface ClaimRow extends Record<string, unknown> {
	id: string
	account_id: string
	media_id: string
	chat_jid: string
	message_id: string
	processor: string
	model: string
	prompt: string | null
	gcs_bucket: string
	gcs_object: string
	mime_type: string | null
	size_bytes: string | null
	attempts: number
}

/** Backoff: 1m, 5m, 30m, 2h */
const BACKOFF_SECONDS = [60, 300, 1800, 7200]
const backoffSeconds = (attempt: number): number =>
	BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length - 1)] ?? 7200

export class ProcessingWorker {
	private readonly workerId = `${hostname()}-${process.pid}-proc`
	private readonly limiter: ReturnType<typeof pLimit>
	private running = false
	private wakeResolve: (() => void) | null = null
	private loopPromise: Promise<void> | null = null
	private stopping = false

	constructor(
		private readonly ctx: StoreContext,
		private readonly storage: MediaStorage,
		private readonly cfg: ProcessingConfig
	) {
		this.limiter = pLimit(cfg.concurrency)
	}

	start(): void {
		if (this.running) return
		if (!this.cfg.enabled) {
			log.info('processing worker: disabled by config')
			return
		}
		this.running = true
		this.stopping = false
		this.loopPromise = this.loop().catch(err => {
			log.error({ err }, 'processing worker loop crashed')
		})
		log.info(
			{
				workerId: this.workerId,
				concurrency: this.cfg.concurrency,
				batchSize: this.cfg.batchSize,
				gemini: !!this.cfg.geminiApiKey,
				elevenlabs: !!this.cfg.elevenlabsApiKey,
				llamaparse: !!this.cfg.llamaCloudApiKey
			},
			'processing worker started'
		)
	}

	notify(): void {
		if (this.wakeResolve) {
			this.wakeResolve()
			this.wakeResolve = null
		}
	}

	async stop(): Promise<void> {
		if (!this.running) return
		this.stopping = true
		this.running = false
		this.notify()
		try {
			await this.loopPromise
		} finally {
			this.loopPromise = null
		}
		log.info('processing worker stopped')
	}

	private async loop(): Promise<void> {
		while (this.running) {
			await this.reapExpiredLeases().catch(err =>
				log.warn({ err }, 'processing lease reaper failed')
			)

			const claimed = await this.claimBatch().catch(err => {
				log.error({ err }, 'processing claim batch failed')
				return [] as ClaimRow[]
			})

			if (claimed.length === 0) {
				if (this.stopping) break
				await this.sleepUntilWake(this.cfg.pollIntervalMs)
				continue
			}

			log.debug({ n: claimed.length }, 'claimed processing batch')
			await Promise.all(
				claimed.map(row =>
					this.limiter(() => this.processRow(row).catch(err =>
						log.error({ err, id: row.id }, 'unexpected processRow error')
					))
				)
			)
		}
	}

	private async claimBatch(): Promise<ClaimRow[]> {
		const rows = await db.execute<ClaimRow>(sql`
			WITH ready AS (
				SELECT id
				FROM wa.media_processing
				WHERE status = 'pending'
				  AND account_id = ${this.ctx.accountId}
				  AND next_attempt_at <= NOW()
				ORDER BY next_attempt_at
				FOR UPDATE SKIP LOCKED
				LIMIT ${this.cfg.batchSize}
			)
			UPDATE wa.media_processing m
			SET status   = 'in_progress',
			    attempts = m.attempts + 1,
			    lease_until = NOW() + make_interval(secs => ${this.cfg.leaseSeconds}),
			    worker_id  = ${this.workerId},
			    updated_at = NOW()
			FROM ready
			WHERE m.id = ready.id
			RETURNING m.id::text         AS id,
			          m.account_id::text  AS account_id,
			          m.media_id::text    AS media_id,
			          m.chat_jid          AS chat_jid,
			          m.message_id        AS message_id,
			          m.processor         AS processor,
			          m.model             AS model,
			          m.prompt            AS prompt,
			          m.gcs_bucket        AS gcs_bucket,
			          m.gcs_object        AS gcs_object,
			          m.mime_type         AS mime_type,
			          m.size_bytes::text  AS size_bytes,
			          m.attempts          AS attempts
		`)
		return rows as unknown as ClaimRow[]
	}

	private async reapExpiredLeases(): Promise<void> {
		await db.execute(sql`
			UPDATE wa.media_processing
			SET status = 'pending',
			    lease_until = NULL,
			    worker_id = NULL,
			    next_attempt_at = NOW(),
			    updated_at = NOW()
			WHERE status = 'in_progress'
			  AND lease_until IS NOT NULL
			  AND lease_until < NOW()
			  AND account_id = ${this.ctx.accountId}
		`)
	}

	private async processRow(claim: ClaimRow): Promise<void> {
		const processorFn = PROCESSOR_REGISTRY[claim.processor]
		if (!processorFn) {
			await this.markFailed(claim.id, `unknown processor: ${claim.processor}`)
			return
		}

		const input: ProcessorInput = {
			id: BigInt(claim.id),
			mediaId: BigInt(claim.media_id),
			gcsBucket: claim.gcs_bucket,
			gcsObject: claim.gcs_object,
			mimeType: claim.mime_type,
			sizeBytes: claim.size_bytes == null ? null : Number(claim.size_bytes),
			prompt: claim.prompt,
			model: claim.model
		}

		const processorCtx: ProcessorContext = {
			storage: this.storage,
			config: this.cfg,
			log
		}

		try {
			const result = await processorFn(processorCtx, input)

			await db.execute(sql`
				UPDATE wa.media_processing
				SET status        = 'done',
				    error         = NULL,
				    result_text   = ${result.resultText},
				    result_meta   = ${JSON.stringify(result.resultMeta)}::jsonb,
				    processing_ms = ${result.processingMs},
				    completed_at  = NOW(),
				    lease_until   = NULL,
				    worker_id     = NULL,
				    updated_at    = NOW()
				WHERE id = ${BigInt(claim.id)}
			`)

			this.ctx.bus.emit({
				type: 'message.processed',
				chatJid: claim.chat_jid,
				messageId: claim.message_id,
				processor: claim.processor
			})

			log.info(
				{
					id: claim.id,
					processor: claim.processor,
					processingMs: result.processingMs,
					resultLen: result.resultText.length
				},
				'processing complete'
			)
		} catch (err) {
			const e = err as Error
			log.warn({ err: e, id: claim.id, processor: claim.processor }, 'processing failed')

			const attempts = claim.attempts
			if (attempts >= this.cfg.maxAttempts) {
				await this.markFailed(claim.id, `gave up after ${attempts} attempts: ${e.message.slice(0, 400)}`)
				log.warn({ id: claim.id, attempts }, 'processing gave up')
				return
			}

			const delaySec = backoffSeconds(attempts)
			await db.execute(sql`
				UPDATE wa.media_processing
				SET status          = 'pending',
				    error           = ${e.message.slice(0, 500)},
				    next_attempt_at = NOW() + make_interval(secs => ${delaySec}),
				    lease_until     = NULL,
				    worker_id       = NULL,
				    updated_at      = NOW()
				WHERE id = ${BigInt(claim.id)}
			`)
			log.debug({ id: claim.id, attempts, delaySec }, 'processing retry scheduled')
		}
	}

	private async markFailed(id: string, reason: string): Promise<void> {
		await db.execute(sql`
			UPDATE wa.media_processing
			SET status      = 'failed',
			    error       = ${reason.slice(0, 500)},
			    lease_until = NULL,
			    worker_id   = NULL,
			    updated_at  = NOW()
			WHERE id = ${BigInt(id)}
		`)
	}

	private async sleepUntilWake(maxMs: number): Promise<void> {
		await new Promise<void>(resolve => {
			const timer = setTimeout(() => {
				this.wakeResolve = null
				resolve()
			}, maxMs)
			this.wakeResolve = () => {
				clearTimeout(timer)
				resolve()
			}
		})
		await sleep(0)
	}
}
