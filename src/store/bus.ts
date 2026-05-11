import { EventEmitter } from 'node:events'

import type { Logger } from 'pino'

/**
 * Discriminated union of events the store emits after successful DB writes.
 * Carries identifiers only — consumers (e.g. the webhook enqueuer) re-query
 * the DB for the full payload to keep the bus cheap and to read the freshly
 * assigned `seq`.
 */
export type MessageBusEvent =
	| {
			type: 'message.received'
			chatJid: string
			messageId: string
			fromMe: boolean
	  }
	| {
			type: 'message.edited'
			chatJid: string
			messageId: string
	  }
	| {
			type: 'message.deleted'
			chatJid: string
			messageId: string
	  }
	| {
			type: 'message.reacted'
			chatJid: string
			messageId: string
			actorJid: string
			emoji: string | null
	  }
	| {
			type: 'message.processed'
			chatJid: string
			messageId: string
			processor: string
	  }

export type MessageBusEventType = MessageBusEvent['type']

export type MessageBusListener = (event: MessageBusEvent) => void | Promise<void>

const CHANNEL = 'event'

/**
 * Fire-and-forget pub/sub bus that decouples store-handler writes from
 * downstream consumers (webhooks, in-memory caches, future integrations).
 * Listener exceptions are caught and logged so the producer never crashes.
 */
export class MessageBus {
	private readonly emitter = new EventEmitter()

	constructor(private readonly log: Logger) {
		// Most events have a single listener (the webhook enqueuer). Bumping
		// the cap so multiple integrations can subscribe without warnings.
		this.emitter.setMaxListeners(32)
	}

	on(listener: MessageBusListener): void {
		this.emitter.on(CHANNEL, listener)
	}

	off(listener: MessageBusListener): void {
		this.emitter.off(CHANNEL, listener)
	}

	/**
	 * Synchronous emit. Listeners are invoked in registration order; their
	 * returned promises (if any) are observed for error logging but the
	 * caller never awaits them.
	 */
	emit(event: MessageBusEvent): void {
		const listeners = this.emitter.listeners(CHANNEL) as MessageBusListener[]
		for (const listener of listeners) {
			try {
				const result = listener(event)
				if (result && typeof (result as Promise<void>).then === 'function') {
					;(result as Promise<void>).catch(err =>
						this.log.warn({ err, event: event.type }, 'message bus listener rejected')
					)
				}
			} catch (err) {
				this.log.warn({ err, event: event.type }, 'message bus listener threw')
			}
		}
	}
}
