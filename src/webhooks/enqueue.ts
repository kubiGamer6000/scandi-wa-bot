import { and, eq } from 'drizzle-orm'

import { db, schema } from '../db/index.js'
import { childLogger } from '../logger.js'
import type { ChatStore } from '../store/index.js'
import { buildMessagePayload, type MessagePayload } from '../api/payloads.js'
import type { MessageBusEvent, MessageBusEventType } from '../store/bus.js'
import type { WebhookWorker } from './worker.js'

const log = childLogger('webhooks:enqueue')

const { webhookSubscriptions, webhookDeliveries, accounts } = schema

/**
 * Maps each MessageBusEvent.type to the public event_type filter string
 * stored on subscriptions. 1:1 here, but kept as a function so we can fan
 * one bus event into multiple webhook events later if needed.
 */
const toWebhookEventType = (t: MessageBusEvent['type']): MessageBusEventType => t

/** Per-event payload-building strategy. */
const buildDeliveryPayload = async (
	accountId: string,
	event: MessageBusEvent
): Promise<{
	eventType: string
	payload: Record<string, unknown>
	skip: boolean
}> => {
	// Resolve `from_me` so we can short-circuit message.received for our own
	// outbound messages (default: AI agents only want inbound traffic).
	let messagePayload: MessagePayload | null = null
	if (
		event.type === 'message.received' ||
		event.type === 'message.edited' ||
		event.type === 'message.deleted' ||
		event.type === 'message.reacted' ||
		event.type === 'message.processed'
	) {
		messagePayload = await buildMessagePayload(accountId, {
			chatJid: event.chatJid,
			messageId: event.messageId
		})
	}

	if (event.type === 'message.received' && messagePayload?.from_me) {
		return { eventType: 'message.received', payload: {}, skip: true }
	}

	// Look up account self JIDs for the envelope (so consumers can identify
	// which account fired this when running multi-account).
	const [acct] = await db
		.select({ pn: accounts.selfPnJid, lid: accounts.selfLidJid })
		.from(accounts)
		.where(eq(accounts.id, accountId))
		.limit(1)

	const base: Record<string, unknown> = {
		event: event.type,
		created_at: new Date().toISOString(),
		account: { id: accountId, pn: acct?.pn ?? null, lid: acct?.lid ?? null }
	}

	switch (event.type) {
		case 'message.received':
		case 'message.edited':
		case 'message.deleted':
		case 'message.processed':
			return {
				eventType: event.type,
				payload: { ...base, message: messagePayload },
				skip: messagePayload == null
			}
		case 'message.reacted':
			return {
				eventType: 'message.reacted',
				payload: {
					...base,
					message: messagePayload,
					reaction: {
						actor_jid: event.actorJid,
						emoji: event.emoji
					}
				},
				skip: messagePayload == null
			}
	}
}

/**
 * Subscribe the webhook enqueuer to the in-process MessageBus. Every event
 * fans out to all matching active subscriptions, inserting one row per
 * subscription into `wa.webhook_deliveries`. The worker drains from there.
 *
 * Returns a `dispose()` function the caller can use to stop subscribing
 * (e.g. during graceful shutdown).
 */
export const bindWebhookEnqueuer = (
	store: ChatStore,
	worker: WebhookWorker
): (() => void) => {
	const accountId = store.accountId

	const listener = async (event: MessageBusEvent): Promise<void> => {
		try {
			const built = await buildDeliveryPayload(accountId, event)
			if (built.skip) return

			const eventType = built.eventType

			// Find all active subs that asked for this event_type.
			const subs = await db
				.select({
					id: webhookSubscriptions.id,
					eventTypes: webhookSubscriptions.eventTypes
				})
				.from(webhookSubscriptions)
				.where(
					and(
						eq(webhookSubscriptions.accountId, accountId),
						eq(webhookSubscriptions.active, true)
					)
				)
			const matching = subs.filter(s => s.eventTypes.includes(eventType))
			if (matching.length === 0) return

			const rows = matching.map(s => ({
				subscriptionId: s.id,
				eventType,
				payload: built.payload
			}))
			await db.insert(webhookDeliveries).values(rows)

			worker.notify()

			log.debug(
				{ event: event.type, matched: matching.length, total: subs.length },
				'fanned out webhook event'
			)
		} catch (err) {
			log.warn({ err, event: event.type }, 'failed to enqueue webhook deliveries')
		}
	}

	store.bus.on(listener)
	log.info({ accountId }, 'webhook enqueuer subscribed to bus')

	return () => {
		store.bus.off(listener)
		log.info('webhook enqueuer detached')
	}
}
