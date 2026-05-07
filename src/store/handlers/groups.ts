import { sql } from 'drizzle-orm'
import type { GroupMetadata, ParticipantAction } from 'baileys'

import { schema } from '../../db/index.js'
import { serializeForJsonb } from '../serialize.js'
import type { StoreContext } from '../types.js'

import { upsertChats } from './chats.js'

const { chats, groupParticipants } = schema

const roleOf = (p: GroupMetadata['participants'][number]): string | null => {
	if (p.admin === 'superadmin' || p.isSuperAdmin) return 'superadmin'
	if (p.admin === 'admin' || p.isAdmin) return 'admin'
	return 'member'
}

type GroupLike = Partial<GroupMetadata> & { id: string }

/**
 * Persists everything we know about a group from `groups.upsert` /
 * `groups.update` events. Also drives the `wa.group_participants` table.
 */
export const upsertGroups = async (
	ctx: StoreContext,
	groups: ReadonlyArray<Partial<GroupMetadata>>
): Promise<void> => {
	const { accountId, db, log } = ctx
	if (!groups.length) return

	const fullGroups: GroupLike[] = groups.filter((g): g is GroupLike => typeof g.id === 'string')

	await upsertChats(
		ctx,
		fullGroups.map(g => ({
			id: g.id,
			name: g.subject,
			conversationTimestamp: g.subjectTime ?? g.creation
		})) as Parameters<typeof upsertChats>[1]
	)

	for (const g of fullGroups) {
		const groupJid: string = g.id
		await db
			.update(chats)
			.set({
				subject: g.subject ?? null,
				description: g.desc ?? null,
				ownerJid: g.owner ?? null,
				raw: serializeForJsonb(g) as object
			})
			.where(sql`${chats.accountId} = ${accountId} AND ${chats.jid} = ${groupJid}`)

		if (g.participants?.length) {
			const rows = g.participants.map(p => ({
				accountId,
				groupJid,
				participant: p.id,
				participantPn: p.phoneNumber ?? null,
				role: roleOf(p)
			}))
			await db
				.insert(groupParticipants)
				.values(rows)
				.onConflictDoUpdate({
					target: [groupParticipants.accountId, groupParticipants.groupJid, groupParticipants.participant],
					set: {
						participantPn: sql`COALESCE(EXCLUDED.participant_pn, ${groupParticipants.participantPn})`,
						role: sql`COALESCE(EXCLUDED.role, ${groupParticipants.role})`,
						leftAt: sql`NULL`
					}
				})
		}
	}

	log.debug({ n: fullGroups.length }, 'groups upserted')
}

/**
 * Applies a `group-participants.update`. We persist the change as a
 * participant-level upsert (or `left_at = now()` for removals) — never delete
 * rows so we keep history.
 */
export const handleGroupParticipantsUpdate = async (
	{ accountId, db, log }: StoreContext,
	payload: { id: string; participants: GroupMetadata['participants']; action: ParticipantAction }
): Promise<void> => {
	const { id, participants, action } = payload
	if (!id || !participants?.length) return

	if (action === 'remove') {
		for (const p of participants) {
			await db
				.update(groupParticipants)
				.set({ leftAt: sql`NOW()` })
				.where(
					sql`${groupParticipants.accountId} = ${accountId} AND ${groupParticipants.groupJid} = ${id} AND ${groupParticipants.participant} = ${p.id}`
				)
		}
	} else {
		const rows = participants.map(p => ({
			accountId,
			groupJid: id,
			participant: p.id,
			participantPn: p.phoneNumber ?? null,
			role: roleOf(p)
		}))
		await db
			.insert(groupParticipants)
			.values(rows)
			.onConflictDoUpdate({
				target: [groupParticipants.accountId, groupParticipants.groupJid, groupParticipants.participant],
				set: {
					participantPn: sql`COALESCE(EXCLUDED.participant_pn, ${groupParticipants.participantPn})`,
					role: sql`COALESCE(EXCLUDED.role, ${groupParticipants.role})`,
					leftAt: sql`NULL`
				}
			})
	}

	log.debug({ id, action, n: participants.length }, 'group participants updated')
}
