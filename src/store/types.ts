import type { Logger } from 'pino'

import type { Db } from '../db/index.js'
import type { MessageBus } from './bus.js'

export interface StoreContext {
	readonly accountId: string
	readonly db: Db
	readonly log: Logger
	readonly bus: MessageBus
}
