import { hostname } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

import pLimit from 'p-limit'
import { sql } from 'drizzle-orm'
import type { WASocket } from 'baileys'

import { childLogger } from '../../logger.js'
import type { MediaConfig } from '../../config.js'
import { db } from '../../db/index.js'
import type { StoreContext } from '../types.js'
import {
	downloadOne,
	type DownloadOneInput,
	type DownloadOutcome
} from './downloader.js'
import type { MediaStorage } from './storage.js'

const log = childLogger('store:media:worker')

interface ClaimRow extends Record<string, unknown> {
	id: string // bigint serialized as string by postgres-js
	account_id: string
	chat_jid: string
	message_id: string
	media_type: string
	mime_type: string | null
	file_length: string | null // bigint
	download_attempts: number
}

/** Backoff schedule for transient retries: 30s, 2m, 10m, 1h, 6h, 24h. */
const BACKOFF_SECONDS = [30, 120, 600, 3600, 21_600, 86_400]
const backoffSeconds = (attempt: number): number =>
	BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length - 1)] ?? 86_400

export class MediaWorker {
	private readonly workerId = `${hostname()}-${process.pid}`
	private readonly limiter: ReturnType<typeof pLimit>
	private readonly allowedTypes: ReadonlySet<string>
	private running = false
	private wakeResolve: (() => void) | null = null
	private getSocket: () => WASocket | null = () => null
	private loopPromise: Promise<void> | null = null
	private stopping = false

	constructor(
		private readonly ctx: StoreContext,
		private readonly storage: MediaStorage,
		private readonly cfg: MediaConfig
	) {
		this.limiter = pLimit(cfg.concurrency)
		this.allowedTypes = new Set(cfg.types)
	}

	bindSocket(getSocket: () => WASocket | null): void {
		this.getSocket = getSocket
	}

	/** Start the worker loop. Idempotent: subsequent calls are no-ops. */
	start(): void {
		if (this.running) return
		if (!this.cfg.enabled) {
			log.info('media worker: disabled by config')
			return
		}
		this.running = true
		this.stopping = false
		this.loopPromise = this.loop().catch(err => {
			log.error({ err }, 'media worker loop crashed')
		})
		log.info(
			{
				workerId: this.workerId,
				storage: this.storage.kind,
				concurrency: this.cfg.concurrency,
				batchSize: this.cfg.batchSize,
				types: [...this.allowedTypes]
			},
			'media worker started'
		)
	}

	/**
	 * Notify the worker that new pending rows exist; it will skip its idle wait
	 * and immediately try to claim. Safe to call from hot paths.
	 */
	notify(): void {
		if (this.wakeResolve) {
			this.wakeResolve()
			this.wakeResolve = null
		}
	}

	/** Drain in-flight work and stop the loop. */
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
		log.info('media worker stopped')
	}

	private async loop(): Promise<void> {
		while (this.running) {
			// If the storage backend is a no-op (no bucket configured), don't
			// claim rows at all — they'd burn through the attempt budget for
			// no work. We sit idle and wait for restart with credentials.
			if (this.storage.kind === 'noop') {
				if (this.stopping) break
				await this.sleepUntilWake(this.cfg.pollIntervalMs * 4)
				continue
			}

			// First reap any expired leases so crashed workers' rows come back.
			await this.reapExpiredLeases().catch(err =>
				log.warn({ err }, 'lease reaper failed')
			)

			const claimed = await this.claimBatch().catch(err => {
				log.error({ err }, 'claim batch failed')
				return [] as ClaimRow[]
			})

			if (claimed.length === 0) {
				if (this.stopping) break
				await this.sleepUntilWake(this.cfg.pollIntervalMs)
				continue
			}

			log.debug({ n: claimed.length }, 'claimed media batch')
			await Promise.all(
				claimed.map(row =>
					this.limiter(() => this.processRow(row).catch(err =>
						log.error({ err, mediaId: row.id }, 'unexpected processRow error')
					))
				)
			)
		}
	}

	/**
	 * Atomically claim up to batchSize ready rows using FOR UPDATE SKIP LOCKED.
	 * Sets download_status='in_progress', stamps lease_until, increments attempts.
	 */
	private async claimBatch(): Promise<ClaimRow[]> {
		const leaseSeconds = this.cfg.leaseSeconds
		const batch = this.cfg.batchSize
		const workerId = this.workerId
		const accountId = this.ctx.accountId

		const rows = await db.execute<ClaimRow>(sql`
			WITH ready AS (
				SELECT id
				FROM wa.media
				WHERE download_status = 'pending'
				  AND account_id = ${accountId}
				  AND next_attempt_at <= NOW()
				ORDER BY next_attempt_at
				FOR UPDATE SKIP LOCKED
				LIMIT ${batch}
			)
			UPDATE wa.media m
			SET download_status   = 'in_progress',
			    download_attempts = m.download_attempts + 1,
			    lease_until       = NOW() + make_interval(secs => ${leaseSeconds}),
			    worker_id         = ${workerId},
			    updated_at        = NOW()
			FROM ready
			WHERE m.id = ready.id
			RETURNING m.id::text                AS id,
			          m.account_id::text        AS account_id,
			          m.chat_jid                AS chat_jid,
			          m.message_id              AS message_id,
			          m.media_type              AS media_type,
			          m.mime_type               AS mime_type,
			          m.file_length::text       AS file_length,
			          m.download_attempts       AS download_attempts
		`)
		// drizzle's execute returns the raw rows array
		return rows as unknown as ClaimRow[]
	}

	private async reapExpiredLeases(): Promise<void> {
		await db.execute(sql`
			UPDATE wa.media
			SET download_status = 'pending',
			    lease_until     = NULL,
			    worker_id       = NULL,
			    next_attempt_at = NOW(),
			    updated_at      = NOW()
			WHERE download_status = 'in_progress'
			  AND lease_until IS NOT NULL
			  AND lease_until < NOW()
			  AND account_id  = ${this.ctx.accountId}
		`)
	}

	private async processRow(claim: ClaimRow): Promise<void> {
		const input: DownloadOneInput = {
			id: BigInt(claim.id),
			accountId: claim.account_id,
			chatJid: claim.chat_jid,
			messageId: claim.message_id,
			mediaType: claim.media_type,
			mimeType: claim.mime_type,
			fileLength: claim.file_length == null ? null : Number(claim.file_length)
		}

		const outcome: DownloadOutcome = await downloadOne(
			{
				ctx: this.ctx,
				storage: this.storage,
				getSocket: this.getSocket,
				maxBytes: this.cfg.maxBytes,
				allowedTypes: this.allowedTypes
			},
			input
		).catch(err => {
			log.error({ err, mediaId: claim.id }, 'downloadOne threw')
			return { kind: 'retry', reason: (err as Error).message ?? 'unknown', transient: true } as DownloadOutcome
		})

		if (outcome.kind === 'done' || outcome.kind === 'failed' || outcome.kind === 'skipped') {
			return // downloader already wrote the terminal state
		}

		// retry
		const attempts = claim.download_attempts // already incremented at claim
		if (attempts >= this.cfg.maxAttempts) {
			await db.execute(sql`
				UPDATE wa.media
				SET download_status = 'failed',
				    download_error  = ${`gave up after ${attempts} attempts: ${outcome.reason.slice(0, 400)}`},
				    lease_until     = NULL,
				    worker_id       = NULL,
				    updated_at      = NOW()
				WHERE id = ${input.id}
			`)
			log.warn(
				{ mediaId: claim.id, attempts, reason: outcome.reason },
				'media gave up'
			)
			return
		}

		const delaySec = backoffSeconds(attempts)
		await db.execute(sql`
			UPDATE wa.media
			SET download_status = 'pending',
			    download_error  = ${outcome.reason.slice(0, 500)},
			    next_attempt_at = NOW() + make_interval(secs => ${delaySec}),
			    lease_until     = NULL,
			    worker_id       = NULL,
			    updated_at      = NOW()
			WHERE id = ${input.id}
		`)
		log.debug(
			{ mediaId: claim.id, attempts, delaySec, reason: outcome.reason },
			'media retry scheduled'
		)
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
		// tiny yield so notify() callers don't get blocked synchronously
		await sleep(0)
	}
}
