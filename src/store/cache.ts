import type { proto, WAMessageKey } from 'baileys'
import { LRUCache } from 'lru-cache'

import { reviveFromJsonb } from './serialize.js'

const cacheKey = (k: WAMessageKey): string =>
	`${k.remoteJid ?? ''}|${k.id ?? ''}|${k.fromMe ? '1' : '0'}`

/**
 * Small in-process LRU sitting in front of the DB-backed `getMessage` impl.
 * Baileys calls `getMessage` for retry-decryption and poll-vote decryption,
 * which is hot during reconnects and live group chats.
 */
export class MessageCache {
	private readonly cache: LRUCache<string, proto.IMessage>

	constructor(max = 1000) {
		this.cache = new LRUCache<string, proto.IMessage>({ max })
	}

	get(key: WAMessageKey): proto.IMessage | undefined {
		return this.cache.get(cacheKey(key))
	}

	set(key: WAMessageKey, message: proto.IMessage): void {
		this.cache.set(cacheKey(key), message)
	}

	setRaw(key: WAMessageKey, raw: unknown): void {
		try {
			const msg = reviveFromJsonb<proto.IMessage>(raw)
			this.cache.set(cacheKey(key), msg)
		} catch {
			// don't poison the cache
		}
	}

	get size(): number {
		return this.cache.size
	}
}
