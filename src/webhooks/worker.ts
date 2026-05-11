import { hostname } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

import pLimit from 'p-limit'
import { sql } from 'drizzle-orm'

import { childLogger } from '../logger.js'
import type { WebhookConfig } from '../config.js'
import { db } from '../db/index.js'
import { computeWebhookSignature } from './signature.js'

const log = childLogger('webhooks:worker')

interface ClaimRow extends Record<string, unknown> {
	id: string
	subscription_id: string
	event_type: string
	payload: unknown
	attempts: number
	url: string
	secret: string
	active: boolean
}

/**
 * Exponential backoff schedule. Mirrors the plan:
 *   30s → 2m → 10m → 1h → 6h → 24h.
 * After the last attempt the row is moved to `abandoned`.
 */
const BACKOFF_SECONDS = [30, 120, 600, 3_600, 21_600, 86_400]
const backoffSeconds = (attempt: number): number =>
	BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length - 1)] ?? 86_400

/**
 * `wa.webhook_deliveries` worker. Drains pending deliveries via
 * `FOR UPDATE SKIP LOCKED` at the configured concurrency, POSTs the JSON
 * payload to the subscription URL with HMAC-SHA256 signature, and retries
 * with exponential backoff on failure.
 */
export class WebhookWorker {
	private readonly workerId = `${hostname()}-${process.pid}-wh`
	private readonly limiter: ReturnType<typeof pLimit>
	private running = false
	private wakeResolve: (() => void) | null = null
	private loopPromise: Promise<void> | null = null
	private stopping = false

	constructor(private readonly cfg: WebhookConfig) {
		this.limiter = pLimit(cfg.concurrency)
	}

	start(): void {
		if (this.running) return
		this.running = true
		this.stopping = false
		this.loopPromise = this.loop().catch(err => {
			log.error({ err }, 'webhook worker loop crashed')
		})
		log.info(
			{
				workerId: this.workerId,
				concurrency: this.cfg.concurrency,
				batchSize: this.cfg.batchSize,
				timeoutMs: this.cfg.timeoutMs
			},
			'webhook worker started'
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
		log.info('webhook worker stopped')
	}

	private async loop(): Promise<void> {
		while (this.running) {
			await this.reapExpiredLeases().catch(err =>
				log.warn({ err }, 'webhook lease reaper failed')
			)

			const claimed = await this.claimBatch().catch(err => {
				log.error({ err }, 'webhook claim batch failed')
				return [] as ClaimRow[]
			})

			if (claimed.length === 0) {
				if (this.stopping) break
				await this.sleepUntilWake(this.cfg.pollIntervalMs)
				continue
			}

			log.debug({ n: claimed.length }, 'claimed webhook batch')
			await Promise.all(
				claimed.map(row =>
					this.limiter(() =>
						this.deliverRow(row).catch(err =>
							log.error({ err, id: row.id }, 'unexpected deliverRow error')
						)
					)
				)
			)
		}
	}

	private async claimBatch(): Promise<ClaimRow[]> {
		const rows = await db.execute<ClaimRow>(sql`
			WITH ready AS (
				SELECT d.id
				FROM wa.webhook_deliveries d
				WHERE d.status = 'pending'
				  AND d.next_attempt_at <= NOW()
				ORDER BY d.next_attempt_at
				FOR UPDATE SKIP LOCKED
				LIMIT ${this.cfg.batchSize}
			)
			UPDATE wa.webhook_deliveries d
			SET status      = 'in_progress',
			    attempts    = d.attempts + 1,
			    lease_until = NOW() + make_interval(secs => ${this.cfg.leaseSeconds}),
			    worker_id   = ${this.workerId},
			    updated_at  = NOW()
			FROM ready, wa.webhook_subscriptions s
			WHERE d.id = ready.id
			  AND s.id = d.subscription_id
			RETURNING d.id::text          AS id,
			          d.subscription_id::text AS subscription_id,
			          d.event_type        AS event_type,
			          d.payload           AS payload,
			          d.attempts          AS attempts,
			          s.url               AS url,
			          s.secret            AS secret,
			          s.active            AS active
		`)
		return rows as unknown as ClaimRow[]
	}

	private async reapExpiredLeases(): Promise<void> {
		await db.execute(sql`
			UPDATE wa.webhook_deliveries
			SET status          = 'pending',
			    lease_until     = NULL,
			    worker_id       = NULL,
			    next_attempt_at = NOW(),
			    updated_at      = NOW()
			WHERE status = 'in_progress'
			  AND lease_until IS NOT NULL
			  AND lease_until < NOW()
		`)
	}

	private async deliverRow(claim: ClaimRow): Promise<void> {
		// Subscription could have been disabled between enqueue and delivery.
		if (!claim.active) {
			await this.markAbandoned(claim.id, 'subscription disabled')
			return
		}

		const rawBody = JSON.stringify(claim.payload)
		const timestampSec = Math.floor(Date.now() / 1000)
		const signature = computeWebhookSignature(claim.secret, timestampSec, rawBody)

		const ac = new AbortController()
		const tHandle = setTimeout(() => ac.abort(), this.cfg.timeoutMs)

		let statusCode = 0
		let errorMessage: string | null = null

		try {
			const res = await fetch(claim.url, {
				method: 'POST',
				signal: ac.signal,
				headers: {
					'content-type': 'application/json',
					'user-agent': 'scandi-wa-bot/0.1',
					'x-webhook-id': claim.id,
					'x-webhook-event': claim.event_type,
					'x-webhook-timestamp': String(timestampSec),
					'x-webhook-signature': signature
				},
				body: rawBody
			})
			statusCode = res.status
			if (!res.ok) {
				const text = await res.text().catch(() => '')
				errorMessage = `HTTP ${res.status}: ${text.slice(0, 200)}`
			}
		} catch (err) {
			const e = err as Error
			errorMessage = e.name === 'AbortError' ? `timeout after ${this.cfg.timeoutMs}ms` : e.message
		} finally {
			clearTimeout(tHandle)
		}

		if (errorMessage == null) {
			await db.execute(sql`
				UPDATE wa.webhook_deliveries
				SET status           = 'delivered',
				    last_status_code = ${statusCode},
				    last_error       = NULL,
				    delivered_at     = NOW(),
				    lease_until      = NULL,
				    worker_id        = NULL,
				    updated_at       = NOW()
				WHERE id = ${BigInt(claim.id)}
			`)
			log.info(
				{ id: claim.id, event: claim.event_type, attempts: claim.attempts, statusCode },
				'webhook delivered'
			)
			return
		}

		log.warn(
			{ id: claim.id, event: claim.event_type, attempts: claim.attempts, statusCode, errorMessage },
			'webhook delivery failed'
		)

		if (claim.attempts >= this.cfg.maxAttempts) {
			await this.markAbandoned(
				claim.id,
				`gave up after ${claim.attempts} attempts: ${errorMessage.slice(0, 400)}`,
				statusCode
			)
			return
		}

		const delaySec = backoffSeconds(claim.attempts)
		await db.execute(sql`
			UPDATE wa.webhook_deliveries
			SET status           = 'pending',
			    last_status_code = ${statusCode || null},
			    last_error       = ${errorMessage.slice(0, 500)},
			    next_attempt_at  = NOW() + make_interval(secs => ${delaySec}),
			    lease_until      = NULL,
			    worker_id        = NULL,
			    updated_at       = NOW()
			WHERE id = ${BigInt(claim.id)}
		`)
		log.debug({ id: claim.id, attempts: claim.attempts, delaySec }, 'webhook retry scheduled')
	}

	private async markAbandoned(id: string, reason: string, statusCode = 0): Promise<void> {
		await db.execute(sql`
			UPDATE wa.webhook_deliveries
			SET status           = 'abandoned',
			    last_status_code = ${statusCode || null},
			    last_error       = ${reason.slice(0, 500)},
			    lease_until      = NULL,
			    worker_id        = NULL,
			    updated_at       = NOW()
			WHERE id = ${BigInt(id)}
		`)
		log.warn({ id, reason }, 'webhook delivery abandoned')
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
