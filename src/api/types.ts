import type { WASocket } from 'baileys'
import type { FastifyBaseLogger } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import type { RawReplyDefaultExpression, RawRequestDefaultExpression, RawServerDefault } from 'fastify'

import type { ChatStore } from '../store/index.js'
import type { MediaStorage } from '../store/media/storage.js'

/** Returns the current Baileys socket, or null if not yet connected. */
export type GetSock = () => WASocket | null

/** Dependencies injected into the Fastify server at build time. */
export interface ApiDeps {
	getSock: GetSock
	store: ChatStore
	storage: MediaStorage
}

/**
 * Convenience alias for our typed Fastify instance. All routes registered
 * via `app.withTypeProvider<TypeBoxTypeProvider>()` will infer params/body
 * from their TypeBox schemas.
 */
export type TypedFastify = import('fastify').FastifyInstance<
	RawServerDefault,
	RawRequestDefaultExpression,
	RawReplyDefaultExpression,
	FastifyBaseLogger,
	TypeBoxTypeProvider
>
