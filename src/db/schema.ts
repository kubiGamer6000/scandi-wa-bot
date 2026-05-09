import { sql } from 'drizzle-orm'
import {
	bigint,
	bigserial,
	boolean,
	customType,
	index,
	integer,
	jsonb,
	pgSchema,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core'

/**
 * postgres-js returns BYTEA columns as Node Buffers, but the driver currently
 * lacks a first-class type for it (issue #471). We declare our own here so the
 * inferred row types are `Buffer | null` rather than `unknown`.
 */
const bytea = customType<{ data: Buffer; default: false }>({
	dataType() {
		return 'bytea'
	}
})

export const wa = pgSchema('wa')

export const accounts = wa.table('accounts', {
	id: uuid('id').primaryKey().defaultRandom(),
	label: text('label').notNull().unique(),
	selfPnJid: text('self_pn_jid'),
	selfLidJid: text('self_lid_jid'),
	pushName: text('push_name'),
	pairedAt: timestamp('paired_at', { withTimezone: true }),
	lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
	status: text('status').notNull().default('active'),
	authDir: text('auth_dir').notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
})

export const lidMappings = wa.table(
	'lid_mappings',
	{
		accountId: uuid('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		lid: text('lid').notNull(),
		pn: text('pn').notNull(),
		observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow()
	},
	t => [primaryKey({ columns: [t.accountId, t.lid] }), index('lid_mappings_pn_idx').on(t.accountId, t.pn)]
)

export const contacts = wa.table(
	'contacts',
	{
		accountId: uuid('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		jid: text('jid').notNull(),
		pn: text('pn'),
		lid: text('lid'),
		name: text('name'),
		pushName: text('push_name'),
		businessInfo: jsonb('business_info'),
		isBusiness: boolean('is_business').notNull().default(false),
		raw: jsonb('raw').notNull(),
		firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
		lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow()
	},
	t => [primaryKey({ columns: [t.accountId, t.jid] })]
)

export const chats = wa.table(
	'chats',
	{
		accountId: uuid('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		jid: text('jid').notNull(),
		type: text('type').notNull(),
		subject: text('subject'),
		description: text('description'),
		ownerJid: text('owner_jid'),
		isDefaultSubgroup: boolean('is_default_subgroup'),
		suspended: boolean('suspended'),
		pnJid: text('pn_jid'),
		accountLid: text('account_lid'),
		contactPrimaryIdentityKey: bytea('contact_primary_identity_key'),
		shareOwnPn: boolean('share_own_pn'),
		lidOriginType: text('lid_origin_type'),
		unreadCount: integer('unread_count'),
		unreadMentionCount: integer('unread_mention_count'),
		markedAsUnread: boolean('marked_as_unread'),
		archived: boolean('archived'),
		readOnly: boolean('read_only'),
		notSpam: boolean('not_spam'),
		ephemeralSeconds: integer('ephemeral_seconds'),
		ephemeralSetTs: timestamp('ephemeral_set_ts', { withTimezone: true }),
		conversationTs: timestamp('conversation_ts', { withTimezone: true }),
		oldestKnownTs: timestamp('oldest_known_ts', { withTimezone: true }),
		historyComplete: boolean('history_complete').notNull().default(false),
		clearedAt: timestamp('cleared_at', { withTimezone: true }),
		raw: jsonb('raw').notNull(),
		insertedAt: timestamp('inserted_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	t => [primaryKey({ columns: [t.accountId, t.jid] })]
)

export const groupParticipants = wa.table(
	'group_participants',
	{
		accountId: uuid('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		groupJid: text('group_jid').notNull(),
		participant: text('participant').notNull(),
		participantPn: text('participant_pn'),
		role: text('role'),
		joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
		leftAt: timestamp('left_at', { withTimezone: true })
	},
	t => [primaryKey({ columns: [t.accountId, t.groupJid, t.participant] })]
)

export const messages = wa.table(
	'messages',
	{
		accountId: uuid('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		chatJid: text('chat_jid').notNull(),
		id: text('id').notNull(),
		fromMe: boolean('from_me').notNull(),
		participant: text('participant'),
		senderPn: text('sender_pn'),
		remoteJidAlt: text('remote_jid_alt'),
		ts: timestamp('ts', { withTimezone: true }).notNull(),
		status: text('status'),
		messageAddressingMode: text('message_addressing_mode'),
		pushName: text('push_name'),
		broadcast: boolean('broadcast'),
		messageType: text('message_type'),
		isProtocol: boolean('is_protocol').notNull().default(false),
		text: text('text'),
		caption: text('caption'),
		forwarded: boolean('forwarded'),
		forwardScore: integer('forward_score'),
		quotedMsgId: text('quoted_msg_id'),
		quotedParticipant: text('quoted_participant'),
		quotedText: text('quoted_text'),
		editCount: integer('edit_count').notNull().default(0),
		lastEditedAt: timestamp('last_edited_at', { withTimezone: true }),
		deletedAt: timestamp('deleted_at', { withTimezone: true }),
		deletedByJid: text('deleted_by_jid'),
		deletionReason: text('deletion_reason'),
		tombstone: boolean('tombstone').notNull().default(false),
		rawMessage: jsonb('raw_message'),
		rawEnvelope: jsonb('raw_envelope').notNull(),
		insertedAt: timestamp('inserted_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	t => [primaryKey({ columns: [t.accountId, t.chatJid, t.id] })]
)

export const messageEdits = wa.table(
	'message_edits',
	{
		id: bigserial('id', { mode: 'bigint' }).primaryKey(),
		accountId: uuid('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		chatJid: text('chat_jid').notNull(),
		messageId: text('message_id').notNull(),
		version: integer('version').notNull(),
		text: text('text'),
		caption: text('caption'),
		messageType: text('message_type'),
		rawMessage: jsonb('raw_message').notNull(),
		observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow()
	},
	t => [
		uniqueIndex('message_edits_unique').on(t.accountId, t.chatJid, t.messageId, t.version)
	]
)

export const reactions = wa.table(
	'reactions',
	{
		accountId: uuid('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		chatJid: text('chat_jid').notNull(),
		messageId: text('message_id').notNull(),
		actorJid: text('actor_jid').notNull(),
		emoji: text('emoji'),
		ts: timestamp('ts', { withTimezone: true }).notNull()
	},
	t => [primaryKey({ columns: [t.accountId, t.chatJid, t.messageId, t.actorJid] })]
)

export const media = wa.table('media', {
	id: bigserial('id', { mode: 'bigint' }).primaryKey(),
	accountId: uuid('account_id')
		.notNull()
		.references(() => accounts.id, { onDelete: 'cascade' }),
	chatJid: text('chat_jid').notNull(),
	messageId: text('message_id').notNull(),
	mediaType: text('media_type').notNull(),
	mimeType: text('mime_type'),
	fileName: text('file_name'),
	fileLength: bigint('file_length', { mode: 'number' }),
	width: integer('width'),
	height: integer('height'),
	durationSeconds: integer('duration_seconds'),
	pageCount: integer('page_count'),
	mediaKey: bytea('media_key'),
	fileSha256: bytea('file_sha256'),
	fileEncSha256: bytea('file_enc_sha256'),
	directPath: text('direct_path'),
	url: text('url'),
	thumbnail: bytea('thumbnail'),
	jpegThumbnail: bytea('jpeg_thumbnail'),
	caption: text('caption'),
	downloadStatus: text('download_status').notNull().default('pending'),
	downloadError: text('download_error'),
	downloadAttempts: integer('download_attempts').notNull().default(0),
	nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
	leaseUntil: timestamp('lease_until', { withTimezone: true }),
	workerId: text('worker_id'),
	completedAt: timestamp('completed_at', { withTimezone: true }),
	sizeBytes: bigint('size_bytes', { mode: 'number' }),
	contentType: text('content_type'),
	gcsBucket: text('gcs_bucket'),
	gcsObject: text('gcs_object'),
	gcsUrl: text('gcs_url'),
	localPath: text('local_path'),
	isVoiceNote: boolean('is_voice_note'),
	waveform: bytea('waveform'),
	raw: jsonb('raw').notNull(),
	insertedAt: timestamp('inserted_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

export const mediaProcessing = wa.table('media_processing', {
	id: bigserial('id', { mode: 'bigint' }).primaryKey(),
	accountId: uuid('account_id')
		.notNull()
		.references(() => accounts.id, { onDelete: 'cascade' }),
	mediaId: bigint('media_id', { mode: 'bigint' })
		.notNull()
		.references(() => media.id, { onDelete: 'cascade' }),
	chatJid: text('chat_jid').notNull(),
	messageId: text('message_id').notNull(),
	processor: text('processor').notNull(),
	model: text('model').notNull(),
	prompt: text('prompt'),
	gcsBucket: text('gcs_bucket').notNull(),
	gcsObject: text('gcs_object').notNull(),
	mimeType: text('mime_type'),
	sizeBytes: bigint('size_bytes', { mode: 'number' }),
	status: text('status').notNull().default('pending'),
	error: text('error'),
	attempts: integer('attempts').notNull().default(0),
	nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
	leaseUntil: timestamp('lease_until', { withTimezone: true }),
	workerId: text('worker_id'),
	resultText: text('result_text'),
	resultMeta: jsonb('result_meta'),
	processingMs: integer('processing_ms'),
	completedAt: timestamp('completed_at', { withTimezone: true }),
	insertedAt: timestamp('inserted_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

export const messageReceipts = wa.table(
	'message_receipts',
	{
		accountId: uuid('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		chatJid: text('chat_jid').notNull(),
		messageId: text('message_id').notNull(),
		userJid: text('user_jid').notNull(),
		receiptType: text('receipt_type').notNull(),
		ts: timestamp('ts', { withTimezone: true }).notNull()
	},
	t => [primaryKey({ columns: [t.accountId, t.chatJid, t.messageId, t.userJid, t.receiptType] })]
)

export const labels = wa.table(
	'labels',
	{
		accountId: uuid('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		id: text('id').notNull(),
		name: text('name'),
		color: integer('color'),
		predefinedId: integer('predefined_id'),
		deleted: boolean('deleted').notNull().default(false),
		raw: jsonb('raw'),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	t => [primaryKey({ columns: [t.accountId, t.id] })]
)

export const labelAssociations = wa.table(
	'label_associations',
	{
		accountId: uuid('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		labelId: text('label_id').notNull(),
		type: text('type').notNull(),
		chatJid: text('chat_jid').notNull(),
		messageId: text('message_id').notNull().default(sql`''`),
		raw: jsonb('raw')
	},
	t => [primaryKey({ columns: [t.accountId, t.labelId, t.type, t.chatJid, t.messageId] })]
)

export const settings = wa.table(
	'settings',
	{
		accountId: uuid('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		key: text('key').notNull(),
		value: jsonb('value'),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	t => [primaryKey({ columns: [t.accountId, t.key] })]
)

export const syncState = wa.table('sync_state', {
	accountId: uuid('account_id')
		.primaryKey()
		.references(() => accounts.id, { onDelete: 'cascade' }),
	historyReceivedAt: timestamp('history_received_at', { withTimezone: true }),
	historyProgressPct: integer('history_progress_pct'),
	historyChunkOrder: text('history_chunk_order'),
	historySyncType: text('history_sync_type'),
	isLatest: boolean('is_latest'),
	initialSyncDone: boolean('initial_sync_done').notNull().default(false),
	lastEventAt: timestamp('last_event_at', { withTimezone: true }),
	raw: jsonb('raw'),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

export const eventLog = wa.table('event_log', {
	id: bigserial('id', { mode: 'bigint' }).primaryKey(),
	accountId: uuid('account_id')
		.notNull()
		.references(() => accounts.id, { onDelete: 'cascade' }),
	event: text('event').notNull(),
	payload: jsonb('payload').notNull(),
	ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow()
})

/**
 * Postgres-backed Baileys auth state. One row per account; updated whenever
 * Baileys emits `creds.update`.
 */
export const authCreds = wa.table('auth_creds', {
	accountId: uuid('account_id')
		.primaryKey()
		.references(() => accounts.id, { onDelete: 'cascade' }),
	creds: jsonb('creds').notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

/**
 * Signal protocol keys. Bulk SELECT/UPSERT/DELETE per Baileys batch.
 *
 * `type` covers every member of `SignalDataTypeMap`: pre-key, session,
 * sender-key, sender-key-memory, app-state-sync-key, app-state-sync-version,
 * lid-mapping, device-list, tctoken, identity-key.
 */
export const authKeys = wa.table(
	'auth_keys',
	{
		accountId: uuid('account_id')
			.notNull()
			.references(() => accounts.id, { onDelete: 'cascade' }),
		type: text('type').notNull(),
		id: text('id').notNull(),
		value: jsonb('value').notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	t => [
		primaryKey({ columns: [t.accountId, t.type, t.id] }),
		index('auth_keys_account_type_idx').on(t.accountId, t.type)
	]
)
