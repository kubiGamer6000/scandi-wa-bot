import { LRUCache } from 'lru-cache'
import type { WAMessage, WAMessageKey, WASocket } from 'baileys'

import type { ReadReceiptConfig } from '../config.js'
import { childLogger } from '../logger.js'
import { extractContent, extractReaction } from '../store/extract.js'
import { classifyJid } from '../store/jids.js'

const log = childLogger('presence:read-receipts')

/**
 * Chat kinds we acknowledge. Status updates, channels and broadcast lists are
 * deliberately excluded: WhatsApp treats a "read" on those as a view event,
 * and viewing every status/channel post an account is subscribed to is exactly
 * the kind of non-human pattern that gets a number flagged.
 */
const RECEIPTABLE_CHAT_TYPES: ReadonlySet<string> = new Set(['dm', 'group', 'lid'])

const jitter = (minMs: number, maxMs: number): number =>
	minMs + Math.floor(Math.random() * (maxMs - minMs + 1))

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Sends read receipts ("blue ticks") for inbound messages.
 *
 * Every realtime message is offered here by {@link Bot}; the worker filters
 * out what shouldn't be acknowledged, coalesces the rest into batches, and
 * flushes them after a randomised think-time. `sock.readMessages()` already
 * drops `fromMe` keys and groups them per chat/participant, so one flush is
 * one `receipt` node per conversation regardless of batch size.
 *
 * Two things this deliberately does NOT do:
 *
 *   - Acknowledge history-sync payloads. Those arrive via
 *     `messaging-history.set`, and receipting a multi-year backlog in one
 *     burst is both spammy and a ban risk.
 *   - Retry. A dropped receipt is cosmetic; the next message in the chat
 *     produces another one.
 */
export class ReadReceiptWorker {
	private getSocket: () => WASocket | null = () => null
	/** Keyed by chat+participant+id so a re-delivered message queues once. */
	private readonly pending = new Map<string, WAMessageKey>()
	/** Message keys already acknowledged, so retries don't re-receipt. */
	private readonly acked: LRUCache<string, true>
	private readonly allowAll: boolean
	private readonly allowed: ReadonlySet<string>
	private flushTimer: NodeJS.Timeout | null = null
	private flushing = false
	private lastFlushAt = 0
	private stopped = false

	constructor(private readonly cfg: ReadReceiptConfig) {
		this.allowAll = cfg.jids.includes('*')
		this.allowed = new Set(cfg.jids)
		this.acked = new LRUCache<string, true>({ max: 5_000 })
	}

	bindSocket(getSocket: () => WASocket | null): void {
		this.getSocket = getSocket
	}

	get enabled(): boolean {
		return this.cfg.enabled
	}

	/**
	 * Offer a realtime `messages.upsert` batch. Call this only for
	 * `type === 'notify'` payloads.
	 */
	offer(messages: readonly WAMessage[]): void {
		if (!this.cfg.enabled || this.stopped) return

		let queued = 0
		for (const msg of messages) {
			const key = this.receiptKeyFor(msg)
			if (!key) continue
			const dedupKey = `${key.remoteJid}|${key.participant ?? ''}|${key.id}`
			if (this.acked.has(dedupKey) || this.pending.has(dedupKey)) continue
			this.pending.set(dedupKey, key)
			queued += 1
		}

		if (queued > 0) this.scheduleFlush()
	}

	/**
	 * One-shot diagnostic, run once per connection.
	 *
	 * `readMessages()` silently downgrades to a `read-self` receipt when the
	 * account has read receipts switched off in WhatsApp's privacy settings:
	 * the message is marked read on our side, but the sender never sees the
	 * blue ticks. That failure is invisible from the logs otherwise.
	 */
	async checkPrivacy(): Promise<void> {
		if (!this.cfg.enabled) return
		const sock = this.getSocket()
		if (!sock) return
		try {
			const settings = await sock.fetchPrivacySettings()
			const value = settings?.readreceipts ?? 'all'
			if (value === 'all') {
				log.info({ readreceipts: value }, 'read receipts enabled')
			} else {
				log.warn(
					{ readreceipts: value },
					'account has read receipts turned off: acks will be sent as read-self and senders will NOT see blue ticks. Enable WhatsApp → Settings → Privacy → Read receipts on the paired phone.'
				)
			}
		} catch (err) {
			log.debug({ err }, 'could not fetch privacy settings (ignored)')
		}
	}

	/** Cancel pending work. In-flight flushes are allowed to finish. */
	stop(): void {
		this.stopped = true
		this.pending.clear()
		if (this.flushTimer) {
			clearTimeout(this.flushTimer)
			this.flushTimer = null
		}
	}

	/**
	 * Decides whether a message deserves a receipt and, if so, builds the key
	 * WhatsApp expects. Group receipts need `participant` — without it the
	 * server can't attribute the ack.
	 */
	private receiptKeyFor(msg: WAMessage): WAMessageKey | null {
		const { key } = msg
		const chatJid = key?.remoteJid
		if (!chatJid || !key?.id || key.fromMe) return null
		if (!RECEIPTABLE_CHAT_TYPES.has(classifyJid(chatJid))) return null
		if (!this.allowAll && !this.allowed.has(chatJid)) return null

		// Reactions and protocol traffic (revokes, edits, ephemeral settings)
		// are not messages a human "reads"; real clients don't ack them.
		if (!msg.message) return null
		if (extractReaction(msg.message)) return null
		if (extractContent(msg.message).isProtocol) return null

		return {
			remoteJid: chatJid,
			id: key.id,
			fromMe: false,
			participant: key.participant ?? undefined
		}
	}

	private scheduleFlush(): void {
		if (this.flushTimer || this.flushing) return

		const think = jitter(this.cfg.delayMinMs, this.cfg.delayMaxMs)
		const sinceLast = Date.now() - this.lastFlushAt
		const cooldown = Math.max(0, this.cfg.minIntervalMs - sinceLast)

		this.flushTimer = setTimeout(() => {
			this.flushTimer = null
			void this.flush()
		}, think + cooldown)
	}

	private async flush(): Promise<void> {
		if (this.flushing || this.stopped) return
		this.flushing = true
		try {
			const sock = this.getSocket()
			if (!sock) {
				// Offline: drop the queue rather than acking stale messages when
				// the socket eventually returns.
				if (this.pending.size) {
					log.debug({ dropped: this.pending.size }, 'socket down, dropping queued read receipts')
					this.pending.clear()
				}
				return
			}

			while (this.pending.size > 0 && !this.stopped) {
				const batch: WAMessageKey[] = []
				for (const [dedupKey, key] of this.pending) {
					if (batch.length >= this.cfg.batchSize) break
					this.pending.delete(dedupKey)
					this.acked.set(dedupKey, true)
					batch.push(key)
				}
				if (!batch.length) break

				this.lastFlushAt = Date.now()
				try {
					await sock.readMessages(batch)
					log.debug({ n: batch.length }, 'read receipts sent')
				} catch (err) {
					log.warn({ err, n: batch.length }, 'failed to send read receipts (ignored)')
				}

				if (this.pending.size > 0 && this.cfg.minIntervalMs > 0) {
					await sleep(this.cfg.minIntervalMs)
				}
			}
		} finally {
			this.flushing = false
			// A message may have landed while we were awaiting the socket.
			if (this.pending.size > 0) this.scheduleFlush()
		}
	}
}
