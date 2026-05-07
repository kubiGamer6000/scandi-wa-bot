import type { Logger } from 'pino'

import type { Db } from '../db/index.js'

export interface StoreContext {
	readonly accountId: string
	readonly db: Db
	readonly log: Logger
}
