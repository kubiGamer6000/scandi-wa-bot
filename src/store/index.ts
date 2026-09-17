import { sql } from 'drizzle-orm'
import type { BaileysEventMap, proto, WAMessageKey, WASocket } from 'baileys'

import { db, schema } from '../db/index.js'
import { childLogger } from '../logger.js'
import { reviveFromJsonb } from './serialize.js'
import { MessageCache } from './cache.js'
import {
	ensureAccount,
	markAccountStatus,
	updateAccountIdentity
} from './handlers/account.js'
import { upsertContacts } from './handlers/contacts.js'
import { ensureChatsExist, markChatCleared, upsertChats } from './handlers/chats.js'
import { upsertGroups, handleGroupParticipantsUpdate } from './handlers/groups.js'
import {
	handleHistorySet,
	handleHistoryStatus
} from './handlers/history.js'
import { upsertLidMappings } from './handlers/lid.js'
import {
	handleMessageDeletes,
	handleMessageUpdates,
	upsertMessages
} from './handlers/messages.js'
import {
	logEvent,
	recordReceipts,
	updateSetting,
	upsertLabel,
	upsertLabelAssociation,
	updateSyncState
} from './handlers/misc.js'
import { handleReactions, invalidateSelfCache } from './handlers/reactions.js'
import { MessageBus } from './bus.js'
import type { StoreContext } from './types.js'

const log = childLogger('store')

/** Listener interface implemented by MediaWorker; lets ChatStore wake it up. */
export interface MediaQueueListener {
	notify(): void
}

/**
 * High-level facade around the WhatsApp message store.
 *
 *   const store = await ChatStore.open()
 *   store.bind(sock)        // attaches all event listeners to the socket
 *   await store.getMessage(key)  // satisfies Baileys' getMessage config
 *
 * All ingestion goes through here so multiple sockets (e.g. on reconnect)
 * see the same set of handlers.
 */
export class ChatStore {
	private readonly cache = new MessageCache(2_000)
	private readonly ctx: StoreContext
	private mediaQueue: MediaQueueListener | null = null
	private readonly _bus: MessageBus

	private constructor(accountId: string) {
		this._bus = new MessageBus(log)
		this.ctx = { accountId, db, log, bus: this._bus }
	}

	static async open(): Promise<ChatStore> {
		const accountId = await ensureAccount(db, log)
		return new ChatStore(accountId)
	}

	get accountId(): string {
		return this.ctx.accountId
	}

	/** In-process event bus. Webhook enqueuer + future consumers subscribe here. */
	get bus(): MessageBus {
		return this._bus
	}

	/** Register a listener that wants to be notified when new media is enqueued. */
	bindMediaQueue(listener: MediaQueueListener): void {
		this.mediaQueue = listener
	}

	/**
	 * Wires every event we know how to ingest. Safe to call once per socket
	 * lifetime — listeners are auto-released when the socket closes (Baileys
	 * uses a fresh emitter per socket).
	 */
	bind(sock: WASocket): void {
		const ev = sock.ev

		ev.on('connection.update', u => {
			if (u.connection === 'open' && sock.user) {
				const id = sock.user.id ?? null
				const lid = sock.user.lid ?? null
				invalidateSelfCache(this.accountId)
				updateAccountIdentity(db, this.accountId, {
					...(id ? { selfPnJid: id } : {}),
					...(lid ? { selfLidJid: lid } : {}),
					pushName: sock.user.name ?? null
				}).catch(err =>
					log.error({ err }, 'failed to update account identity on connection.open')
				)
			}
		})

		ev.on('lid-mapping.update', m => {
			if (m?.lid && m?.pn) void this.run('lid-mapping.update', () => upsertLidMappings(this.ctx, [m]))
		})

		ev.on('contacts.upsert', list => {
			void this.run('contacts.upsert', () => upsertContacts(this.ctx, list))
		})
		ev.on('contacts.update', list => {
			const full = list.filter((c): c is { id: string } & typeof c => !!c.id)
			void this.run('contacts.update', () => upsertContacts(this.ctx, full))
		})

		ev.on('chats.upsert', list => {
			void this.run('chats.upsert', () => upsertChats(this.ctx, list))
		})
		ev.on('chats.update', list => {
			const full = list.filter((c): c is { id: string } & typeof c => !!c.id)
			void this.run('chats.update', () => upsertChats(this.ctx, full))
		})
		ev.on('chats.delete', jids => {
			void this.run('chats.delete', () => markChatCleared(this.ctx, jids))
		})

		ev.on('messaging-history.set', payload => {
			void this.run('messaging-history.set', async () => {
				await handleHistorySet(this.ctx, payload, this.cache)
				this.mediaQueue?.notify()
			})
		})
		ev.on('messaging-history.status', payload => {
			void this.run('messaging-history.status', () => handleHistoryStatus(this.ctx, payload))
		})

		ev.on('messages.upsert', payload => {
			void this.run('messages.upsert', async () => {
				await upsertMessages(this.ctx, payload.messages, this.cache)
				// Best-effort wake of the media worker. We don't know without a
				// query whether any new media rows were inserted, but a spurious
				// wake costs one DB poll which the worker already does anyway.
				this.mediaQueue?.notify()
			})
		})
		ev.on('messages.update', list => {
			void this.run('messages.update', () => handleMessageUpdates(this.ctx, list))
		})
		ev.on('messages.delete', payload => {
			void this.run('messages.delete', () => handleMessageDeletes(this.ctx, payload))
		})
		ev.on('messages.reaction', list => {
			void this.run('messages.reaction', () => handleReactions(this.ctx, list))
		})
		ev.on('message-receipt.update', list => {
			void this.run('message-receipt.update', () => recordReceipts(this.ctx, list))
		})

		ev.on('groups.upsert', list => {
			void this.run('groups.upsert', () => upsertGroups(this.ctx, list))
		})
		ev.on('groups.update', list => {
			void this.run('groups.update', () =>
				upsertGroups(this.ctx, list.filter((g): g is { id: string } & typeof g => !!g.id))
			)
		})
		ev.on('group-participants.update', payload => {
			void this.run('group-participants.update', () =>
				handleGroupParticipantsUpdate(this.ctx, payload)
			)
		})

		ev.on('labels.edit', label => {
			void this.run('labels.edit', () => upsertLabel(this.ctx, label))
		})
		ev.on('labels.association', payload => {
			const a = payload.association as {
				labelId?: string
				type?: string
				chatId?: string
				messageId?: string
			}
			const mappedType: 'chat' | 'message' | undefined =
				a.type === 'label_jid' ? 'chat' : a.type === 'label_message' ? 'message' : undefined
			if (!mappedType) return
			void this.run('labels.association', () =>
				upsertLabelAssociation(
					this.ctx,
					{
						labelId: a.labelId,
						type: mappedType,
						chatId: a.chatId,
						messageId: a.messageId
					},
					payload.type
				)
			)
		})

		ev.on('settings.update', payload => {
			void this.run('settings.update', () => updateSetting(this.ctx, payload.setting, payload.value))
		})

		// Catchall debug events we don't model yet — keep the JSON for forensics.
		const passThrough: Array<keyof BaileysEventMap> = [
			'blocklist.set',
			'blocklist.update',
			'call',
			'message-capping.update',
			'newsletter.reaction',
			'newsletter.view',
			'newsletter-participants.update',
			'newsletter-settings.update',
			'group.join-request',
			'group.member-tag.update',
			'chats.lock'
		]
		for (const e of passThrough) {
			ev.on(e, payload => {
				void this.run(`${e}:passthrough`, () => logEvent(this.ctx, e, payload))
			})
		}

		log.info('store bound to socket')
	}

	/** Implements Baileys' `getMessage` config. LRU first, then DB. */
	getMessage = async (key: WAMessageKey): Promise<proto.IMessage | undefined> => {
		const hit = this.cache.get(key)
		if (hit) return hit
		if (!key.remoteJid || !key.id) return undefined
		const rows = await db
			.select({ rawMessage: schema.messages.rawMessage })
			.from(schema.messages)
			.where(
				sql`${schema.messages.accountId} = ${this.accountId}
				    AND ${schema.messages.chatJid} = ${key.remoteJid}
				    AND ${schema.messages.id} = ${key.id}`
			)
			.limit(1)
		const raw = rows[0]?.rawMessage
		if (!raw) return undefined
		try {
			const revived = reviveFromJsonb<proto.IMessage>(raw)
			this.cache.set(key, revived)
			return revived
		} catch (err) {
			log.warn({ err, key }, 'getMessage: failed to revive raw message')
			return undefined
		}
	}

	async markLoggedOut(): Promise<void> {
		await markAccountStatus(db, this.accountId, 'logged_out')
	}

	/** Called when a connection opens, so a past logout doesn't linger in health. */
	async markActive(): Promise<void> {
		await markAccountStatus(db, this.accountId, 'active')
	}

	async heartbeat(): Promise<void> {
		await updateSyncState(this.ctx, { lastEventAt: new Date() })
	}

	private async run(label: string, fn: () => Promise<unknown>): Promise<void> {
		try {
			await fn()
		} catch (err) {
			log.error({ err, event: label }, 'store handler failed')
		}
	}
}

export { ensureChatsExist, MessageCache }
