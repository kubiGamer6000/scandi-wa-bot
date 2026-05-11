import { randomBytes } from 'node:crypto'

import { and, desc, eq } from 'drizzle-orm'
import { Type } from '@sinclair/typebox'

import { db, schema } from '../../db/index.js'
import type { ApiDeps, TypedFastify } from '../types.js'

const { webhookSubscriptions, webhookDeliveries } = schema

const KNOWN_EVENT_TYPES = [
	'message.received',
	'message.edited',
	'message.deleted',
	'message.reacted',
	'message.processed',
	'webhook.test'
] as const

const SubscriptionReply = Type.Object({
	id: Type.String(),
	url: Type.String(),
	secret: Type.String(),
	event_types: Type.Array(Type.String()),
	active: Type.Boolean(),
	description: Type.Union([Type.String(), Type.Null()]),
	created_at: Type.String(),
	updated_at: Type.String()
})

const generateSecret = (): string => randomBytes(32).toString('hex')

const validateEventTypes = (types: string[]): string[] => {
	const allowed = new Set<string>(KNOWN_EVENT_TYPES)
	const bad = types.filter(t => !allowed.has(t))
	if (bad.length > 0) {
		throw new Error(`unknown event_types: ${bad.join(', ')}. Valid: ${[...allowed].join(', ')}`)
	}
	return types
}

export const registerWebhookRoutes = async (
	app: TypedFastify,
	deps: ApiDeps
): Promise<void> => {
	// ─────────── POST /v1/webhooks ───────────
	app.post(
		'/v1/webhooks',
		{
			schema: {
				body: Type.Object({
					url: Type.String({ format: 'uri' }),
					secret: Type.Optional(Type.String({ minLength: 16 })),
					event_types: Type.Optional(Type.Array(Type.String())),
					description: Type.Optional(Type.String()),
					active: Type.Optional(Type.Boolean())
				}),
				response: { 201: SubscriptionReply }
			}
		},
		async (req, reply) => {
			const accountId = deps.store.accountId

			let eventTypes: string[]
			try {
				eventTypes =
					req.body.event_types && req.body.event_types.length > 0
						? validateEventTypes(req.body.event_types)
						: [
								'message.received',
								'message.edited',
								'message.deleted',
								'message.reacted',
								'message.processed'
							]
			} catch (err) {
				throw app.httpErrors.badRequest((err as Error).message)
			}

			const [row] = await db
				.insert(webhookSubscriptions)
				.values({
					accountId,
					url: req.body.url,
					secret: req.body.secret ?? generateSecret(),
					eventTypes,
					active: req.body.active ?? true,
					description: req.body.description ?? null
				})
				.returning()

			if (!row) throw app.httpErrors.internalServerError('insert returned no row')

			reply.code(201).send({
				id: row.id,
				url: row.url,
				secret: row.secret,
				event_types: row.eventTypes,
				active: row.active,
				description: row.description,
				created_at: row.createdAt.toISOString(),
				updated_at: row.updatedAt.toISOString()
			})
			return reply
		}
	)

	// ─────────── GET /v1/webhooks ───────────
	app.get(
		'/v1/webhooks',
		{
			schema: {
				querystring: Type.Object({
					active: Type.Optional(Type.Boolean())
				})
			}
		},
		async req => {
			const accountId = deps.store.accountId
			const where =
				req.query.active === undefined
					? eq(webhookSubscriptions.accountId, accountId)
					: and(
							eq(webhookSubscriptions.accountId, accountId),
							eq(webhookSubscriptions.active, req.query.active)
						)
			const rows = await db
				.select()
				.from(webhookSubscriptions)
				.where(where)
				.orderBy(desc(webhookSubscriptions.createdAt))
			return {
				webhooks: rows.map(r => ({
					id: r.id,
					url: r.url,
					secret: r.secret,
					event_types: r.eventTypes,
					active: r.active,
					description: r.description,
					created_at: r.createdAt.toISOString(),
					updated_at: r.updatedAt.toISOString()
				}))
			}
		}
	)

	// ─────────── GET /v1/webhooks/:id ───────────
	app.get(
		'/v1/webhooks/:id',
		{
			schema: {
				params: Type.Object({ id: Type.String({ format: 'uuid' }) })
			}
		},
		async req => {
			const accountId = deps.store.accountId
			const [row] = await db
				.select()
				.from(webhookSubscriptions)
				.where(
					and(
						eq(webhookSubscriptions.accountId, accountId),
						eq(webhookSubscriptions.id, req.params.id)
					)
				)
				.limit(1)
			if (!row) throw app.httpErrors.notFound(`webhook ${req.params.id} not found`)

			const recentDeliveries = await db
				.select({
					id: webhookDeliveries.id,
					eventType: webhookDeliveries.eventType,
					status: webhookDeliveries.status,
					attempts: webhookDeliveries.attempts,
					lastStatusCode: webhookDeliveries.lastStatusCode,
					lastError: webhookDeliveries.lastError,
					deliveredAt: webhookDeliveries.deliveredAt,
					insertedAt: webhookDeliveries.insertedAt
				})
				.from(webhookDeliveries)
				.where(eq(webhookDeliveries.subscriptionId, req.params.id))
				.orderBy(desc(webhookDeliveries.insertedAt))
				.limit(10)

			return {
				id: row.id,
				url: row.url,
				secret: row.secret,
				event_types: row.eventTypes,
				active: row.active,
				description: row.description,
				created_at: row.createdAt.toISOString(),
				updated_at: row.updatedAt.toISOString(),
				recent_deliveries: recentDeliveries.map(d => ({
					id: d.id.toString(),
					event_type: d.eventType,
					status: d.status,
					attempts: d.attempts,
					last_status_code: d.lastStatusCode,
					last_error: d.lastError,
					delivered_at: d.deliveredAt?.toISOString() ?? null,
					inserted_at: d.insertedAt.toISOString()
				}))
			}
		}
	)

	// ─────────── PATCH /v1/webhooks/:id ───────────
	app.patch(
		'/v1/webhooks/:id',
		{
			schema: {
				params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
				body: Type.Object({
					url: Type.Optional(Type.String({ format: 'uri' })),
					event_types: Type.Optional(Type.Array(Type.String())),
					active: Type.Optional(Type.Boolean()),
					description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
					rotate_secret: Type.Optional(Type.Boolean())
				})
			}
		},
		async req => {
			const accountId = deps.store.accountId
			const patch: Record<string, unknown> = {}
			if (req.body.url !== undefined) patch.url = req.body.url
			if (req.body.active !== undefined) patch.active = req.body.active
			if (req.body.description !== undefined) patch.description = req.body.description
			if (req.body.event_types !== undefined) {
				try {
					patch.eventTypes = validateEventTypes(req.body.event_types)
				} catch (err) {
					throw app.httpErrors.badRequest((err as Error).message)
				}
			}
			if (req.body.rotate_secret) patch.secret = generateSecret()
			if (Object.keys(patch).length === 0) {
				throw app.httpErrors.badRequest('no fields to update')
			}

			const [row] = await db
				.update(webhookSubscriptions)
				.set(patch)
				.where(
					and(
						eq(webhookSubscriptions.accountId, accountId),
						eq(webhookSubscriptions.id, req.params.id)
					)
				)
				.returning()
			if (!row) throw app.httpErrors.notFound(`webhook ${req.params.id} not found`)

			return {
				id: row.id,
				url: row.url,
				secret: row.secret,
				event_types: row.eventTypes,
				active: row.active,
				description: row.description,
				created_at: row.createdAt.toISOString(),
				updated_at: row.updatedAt.toISOString()
			}
		}
	)

	// ─────────── DELETE /v1/webhooks/:id ───────────
	app.delete(
		'/v1/webhooks/:id',
		{
			schema: {
				params: Type.Object({ id: Type.String({ format: 'uuid' }) })
			}
		},
		async (req, reply) => {
			const accountId = deps.store.accountId
			const [row] = await db
				.delete(webhookSubscriptions)
				.where(
					and(
						eq(webhookSubscriptions.accountId, accountId),
						eq(webhookSubscriptions.id, req.params.id)
					)
				)
				.returning({ id: webhookSubscriptions.id })
			if (!row) throw app.httpErrors.notFound(`webhook ${req.params.id} not found`)
			reply.code(204).send()
			return reply
		}
	)

	// ─────────── POST /v1/webhooks/:id/test ───────────
	app.post(
		'/v1/webhooks/:id/test',
		{
			schema: {
				params: Type.Object({ id: Type.String({ format: 'uuid' }) })
			}
		},
		async req => {
			const accountId = deps.store.accountId
			const [sub] = await db
				.select({ id: webhookSubscriptions.id })
				.from(webhookSubscriptions)
				.where(
					and(
						eq(webhookSubscriptions.accountId, accountId),
						eq(webhookSubscriptions.id, req.params.id)
					)
				)
				.limit(1)
			if (!sub) throw app.httpErrors.notFound(`webhook ${req.params.id} not found`)

			const payload = {
				event: 'webhook.test' as const,
				created_at: new Date().toISOString(),
				account: { id: accountId },
				message: null,
				test: { source: 'POST /v1/webhooks/:id/test' }
			}

			const [row] = await db
				.insert(webhookDeliveries)
				.values({
					subscriptionId: sub.id,
					eventType: 'webhook.test',
					payload
				})
				.returning({ id: webhookDeliveries.id })

			return { delivery_id: row?.id?.toString() ?? null }
		}
	)
}
