import type { WAPresence, WASocket } from 'baileys'

import type { TypingConfig } from '../config.js'
import { childLogger } from '../logger.js'

const log = childLogger('presence:typing')

/** The two chatstates a caller may hold open. */
export type TypingState = 'composing' | 'recording'

/** Consecutive send failures before we give up on a session. */
const MAX_CONSECUTIVE_FAILURES = 3

/** Hard floor between two chatstate pushes, whatever the config asks for. */
const MIN_REFRESH_MS = 250

interface TypingSession {
	jid: string
	state: TypingState
	/** Refresh timer, re-armed after every chatstate we push. */
	timer: NodeJS.Timeout | null
	/** Soft deadline; each `start()` call for the same chat pushes it out. */
	expiresAt: number
	/** Absolute cap measured from the first `start()`, never extended. */
	hardDeadline: number
	startedAt: number
	failures: number
}

export interface TypingSessionInfo {
	jid: string
	state: TypingState
	expiresAt: Date
}

/**
 * Owns the "Jarvis is typing…" indicator.
 *
 * WhatsApp expires a chatstate after roughly ten seconds, so a long-running
 * agent turn needs the indicator re-sent periodically. Doing that from the
 * consumer over HTTP would mean a request every few seconds; instead a caller
 * opens a session once (`POST /v1/chats/:jid/typing`), the refresh cadence
 * lives here next to the socket, and the session self-terminates:
 *
 *   - when the caller closes it (`DELETE …/typing`),
 *   - when the bot sends a message to that chat — the message supersedes the
 *     indicator, exactly like a real client,
 *   - when the caller's TTL lapses (a crashed consumer can't leave the bot
 *     typing forever),
 *   - at `maxSessionMs`, whatever the caller keeps asking for.
 *
 * Every push is jittered so the cadence doesn't look metronomic, and the
 * number of simultaneously-typing chats is capped: one account typing in a
 * dozen conversations at once is not a pattern a human produces.
 */
export class TypingManager {
	private getSocket: () => WASocket | null = () => null
	private readonly sessions = new Map<string, TypingSession>()
	/** True while we hold global presence at `available` for typing. */
	private markedAvailable = false

	/**
	 * @param cfg tuning knobs
	 * @param idlePresence presence to restore once no chat is typing anymore.
	 *   Mirrors `MARK_ONLINE_ON_CONNECT` so we don't silently take the paired
	 *   phone's push notifications away.
	 */
	constructor(
		private readonly cfg: TypingConfig,
		private readonly idlePresence: WAPresence = 'unavailable'
	) {}

	bindSocket(getSocket: () => WASocket | null): void {
		this.getSocket = getSocket
	}

	get enabled(): boolean {
		return this.cfg.enabled
	}

	get activeChats(): number {
		return this.sessions.size
	}

	/**
	 * Open or extend a typing session. Pushes the chatstate immediately so the
	 * indicator appears on the caller's timescale, not on the next refresh.
	 */
	async start(
		jid: string,
		opts: { state?: TypingState; ttlMs?: number } = {}
	): Promise<TypingSessionInfo> {
		if (!this.cfg.enabled) throw new Error('typing indicators are disabled (TYPING_ENABLED=false)')

		const state = opts.state ?? 'composing'
		const ttlMs = Math.min(Math.max(opts.ttlMs ?? this.cfg.defaultTtlMs, 1_000), this.cfg.maxTtlMs)
		const now = Date.now()

		const existing = this.sessions.get(jid)
		if (existing) {
			existing.state = state
			existing.expiresAt = Math.min(now + ttlMs, existing.hardDeadline)
		} else {
			this.evictOverflow()
			this.sessions.set(jid, {
				jid,
				state,
				timer: null,
				expiresAt: now + ttlMs,
				hardDeadline: now + this.cfg.maxSessionMs,
				startedAt: now,
				failures: 0
			})
			log.debug({ jid, state, ttlMs }, 'typing session opened')
		}

		await this.push(jid)

		const session = this.sessions.get(jid)
		return {
			jid,
			state,
			// A failed first push closes the session; report the requested
			// window anyway so the caller sees what it asked for.
			expiresAt: new Date(session?.expiresAt ?? now + ttlMs)
		}
	}

	/** Close a session and tell the chat we stopped typing. */
	async stop(jid: string): Promise<void> {
		const session = this.sessions.get(jid)
		if (!session) return
		this.clear(jid)
		await this.send(jid, 'paused')
		await this.releasePresence()
		log.debug({ jid, heldMs: Date.now() - session.startedAt }, 'typing session closed')
	}

	/**
	 * Called after the bot successfully sends a message. The message itself
	 * clears the indicator on the recipient's client, so we drop the session
	 * without spending a `paused` node on it.
	 */
	noteOutboundMessage(jid: string): void {
		if (!this.sessions.has(jid)) return
		this.clear(jid)
		void this.releasePresence()
		log.debug({ jid }, 'typing session closed by outbound message')
	}

	/**
	 * Drop every session without touching the network. Used when the socket
	 * goes away: the chatstates are already void, and `paused` can't be sent.
	 */
	reset(): void {
		for (const jid of [...this.sessions.keys()]) this.clear(jid)
		this.markedAvailable = false
	}

	/** Best-effort graceful close of every session (shutdown path). */
	async stopAll(): Promise<void> {
		for (const jid of [...this.sessions.keys()]) {
			await this.stop(jid).catch(err => log.warn({ err, jid }, 'failed to close typing session'))
		}
	}

	private clear(jid: string): void {
		const session = this.sessions.get(jid)
		if (!session) return
		if (session.timer) clearTimeout(session.timer)
		this.sessions.delete(jid)
	}

	/** Keeps the number of concurrently-typing chats within the configured cap. */
	private evictOverflow(): void {
		while (this.sessions.size >= this.cfg.maxConcurrentChats) {
			const oldest = [...this.sessions.values()].sort((a, b) => a.startedAt - b.startedAt)[0]
			if (!oldest) return
			log.warn(
				{ jid: oldest.jid, cap: this.cfg.maxConcurrentChats },
				'typing session cap reached, evicting oldest session'
			)
			this.clear(oldest.jid)
		}
	}

	/**
	 * Push the chatstate once and schedule the next push. Terminal conditions
	 * (TTL lapsed, hard cap hit, repeated failures) end the session here.
	 */
	private async push(jid: string): Promise<void> {
		const session = this.sessions.get(jid)
		if (!session) return

		const now = Date.now()
		if (now >= session.expiresAt || now >= session.hardDeadline) {
			const reason = now >= session.hardDeadline ? 'max session length' : 'ttl lapsed'
			log.info({ jid, heldMs: now - session.startedAt, reason }, 'typing session expired')
			await this.stop(jid)
			return
		}

		if (this.cfg.markAvailable && !this.markedAvailable) {
			if (await this.send(undefined, 'available')) this.markedAvailable = true
		}

		const ok = await this.send(jid, session.state)
		if (ok) {
			session.failures = 0
		} else {
			session.failures += 1
			if (session.failures >= MAX_CONSECUTIVE_FAILURES) {
				log.warn({ jid, failures: session.failures }, 'giving up on typing session')
				this.clear(jid)
				await this.releasePresence()
				return
			}
		}

		if (!this.sessions.has(jid)) return
		const spread = this.cfg.refreshJitterMs
		const delay = this.cfg.refreshMs - spread + Math.floor(Math.random() * (spread * 2 + 1))
		// Never re-push faster than the floor, whatever the config says, and
		// don't schedule past the session's own deadline.
		const next = Math.max(MIN_REFRESH_MS, Math.min(delay, session.expiresAt - Date.now()))
		if (session.timer) clearTimeout(session.timer)
		session.timer = setTimeout(() => {
			void this.push(jid)
		}, next)
	}

	/** Restore idle presence once the last session goes away. */
	private async releasePresence(): Promise<void> {
		if (!this.markedAvailable || this.sessions.size > 0) return
		this.markedAvailable = false
		await this.send(undefined, this.idlePresence)
	}

	private async send(jid: string | undefined, presence: WAPresence): Promise<boolean> {
		const sock = this.getSocket()
		if (!sock) return false
		try {
			await sock.sendPresenceUpdate(presence, jid)
			return true
		} catch (err) {
			log.warn({ err, jid, presence }, 'failed to send presence update')
			return false
		}
	}
}
