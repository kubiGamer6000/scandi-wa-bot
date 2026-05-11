# scandi-wa-bot HTTP API

A complete integration guide for building automations, AI agents, cron jobs,
analytics pipelines, and any other consumer on top of this WhatsApp bot.

> **Audience.** You're building a system that talks to WhatsApp through this
> bot. You don't need to know the bot's internals, but you do need to know
> how WhatsApp identifies users, what data shapes look like, when media is
> processed, and how to reliably react to live events.

---

## Table of contents

1. [What this bot is](#1-what-this-bot-is)
2. [Mental model & WhatsApp/Baileys primer](#2-mental-model--whatsappbaileys-primer)
3. [Quick start (10 minutes)](#3-quick-start-10-minutes)
4. [Authentication](#4-authentication)
5. [Webhooks — the primary integration path](#5-webhooks--the-primary-integration-path)
6. [Endpoint reference](#6-endpoint-reference)
7. [The message payload](#7-the-message-payload)
8. [Media: storage, processing, and fetching](#8-media-storage-processing-and-fetching)
9. [Pagination patterns](#9-pagination-patterns)
10. [Error responses](#10-error-responses)
11. [Integration recipes](#11-integration-recipes)
12. [Operational notes](#12-operational-notes)
13. [Versioning, stability, and roadmap](#13-versioning-stability-and-roadmap)
14. [Glossary](#14-glossary)

---

## 1. What this bot is

This is a Node.js service that:

- Connects to WhatsApp using [Baileys](https://github.com/WhiskeySockets/Baileys)
  (the open-source WhatsApp Web reverse-engineering library).
- Stores every chat, contact, group, message, reaction, edit, deletion, and
  media file you can see in WhatsApp into a Postgres database.
- Runs uploaded media (images, videos, audio, documents) through AI
  processors (Gemini, ElevenLabs, LlamaParse) and stores the resulting text
  descriptions / transcriptions / parsed Markdown.
- Exposes an HTTP API (this document) plus durable outbound webhooks so
  external systems can read, react, and send.

The bot is **single-account** by design today: one WhatsApp number per
deployment. The API is also single-tenant — one bearer token for the whole
instance.

```
   ┌────────────────┐                ┌──────────────────────┐
   │   WhatsApp     │ ◀── Baileys ──▶│      this bot        │
   │    servers     │                │  (Node.js + Postgres)│
   └────────────────┘                └──────────┬───────────┘
                                                │
                          HTTP API (this doc)  ─┘
                          │                      │
                          ▼                      ▼
                 ┌──────────────┐     ┌───────────────────┐
                 │  Your code:  │     │   Your webhooks:  │
                 │  cron, REST  │     │  /event listeners │
                 │  callers     │     │                   │
                 └──────────────┘     └───────────────────┘
```

You'll typically use **both** sides at the same time: webhooks deliver
events in real time, and the REST API lets you fetch history, send
messages, and act on existing data.

---

## 2. Mental model & WhatsApp/Baileys primer

You can skip this section if you already know the WhatsApp/Baileys data
model. Otherwise read at least the first three subsections — they affect
every payload.

### 2.1 Identifiers: JIDs, PN, LID

WhatsApp's user identifiers are called **JIDs**. There are several flavors:

| Suffix              | Meaning                                                      | Example                              |
| ------------------- | ------------------------------------------------------------ | ------------------------------------ |
| `@s.whatsapp.net`   | A **phone-number JID** (PN). The user's real phone number.   | `359884430293@s.whatsapp.net`        |
| `@lid`              | A **LID JID** — opaque, privacy-preserving identifier.       | `205321565942003:14@lid`             |
| `@g.us`             | A **group chat** JID.                                        | `120363012345678901@g.us`            |
| `@newsletter`       | A WhatsApp channel.                                          | `120363098765432109@newsletter`      |
| `status@broadcast`  | The "Status" broadcast feed (not normally addressed).        | `status@broadcast`                   |

**LID vs PN.** WhatsApp introduced LIDs to obscure phone numbers in groups
where members may not know each other. Your bot may receive messages
where the `from.jid` is a LID rather than a PN, especially in groups. The
bot resolves the underlying PN where possible and includes it as
`from.pn` in payloads, but **always** trust `from.jid` as the canonical
identifier — that's what WhatsApp uses to route.

**To address a user**, you can use either their PN JID or LID JID; the
PN form (`359884430293@s.whatsapp.net`) is by far the most common and is
what you'll get from contact imports or phone-number lookups.

**`addressing_mode`** on the message payload tells you which form WhatsApp
used: `"pn"` (the chat is addressed by phone number) or `"lid"` (addressed
by LID — common in newer groups).

### 2.2 Chats: DM vs group

- **DM** (direct message). `chat.jid` ends in `@s.whatsapp.net`. In a DM
  the chat JID equals the other party's JID.
- **Group**. `chat.jid` ends in `@g.us`. Every message in a group has a
  separate `from.jid` identifying the participant who sent it.
- **`chat.type`** in payloads is `"dm"` or `"group"`.

You're not expected to address `status@broadcast` or channels; they're
read-only from the bot's perspective and the API does not expose send
operations for them.

### 2.3 Messages, `seq`, and `wa_id`

Every message in the bot's database has two IDs:

| Field   | Type         | Use                                                                            |
| ------- | ------------ | ------------------------------------------------------------------------------ |
| `seq`   | int64        | The **public ID** used everywhere in this API. Globally unique, auto-incrementing, sorts naturally for pagination. |
| `wa_id` | string       | WhatsApp's original `key.id` (something like `3EB0C123ABCDEF…`). Useful if you also use Baileys directly or need to correlate with WhatsApp Web. |

Always use `seq` when calling the API. `wa_id` is in every payload for
correlation only.

### 2.4 Message types

`message.type` is a string mirroring WhatsApp's protocol types. Common
values:

| Type                       | Description                                       |
| -------------------------- | ------------------------------------------------- |
| `conversation`             | Plain text (legacy short form).                   |
| `extendedTextMessage`      | Text with formatting / links / mentions / quotes. |
| `imageMessage`             | Image (+ optional caption).                       |
| `videoMessage`             | Video (+ optional caption). PTV = "video note".   |
| `audioMessage`             | Audio file. Voice notes have `is_voice_note=true`.|
| `documentMessage`          | Files (PDF, Word, etc.).                          |
| `stickerMessage`           | Stickers (animated or static).                    |
| `locationMessage`          | Map pin.                                          |
| `contactMessage`           | vCard share.                                      |
| `pollCreationMessageV3`    | Polls.                                            |
| `viewOnceMessageV2`        | "View once" wrapper around an image / video.      |
| `reactionMessage`          | Emoji reactions (recorded in `reactions[]`, not surfaced as their own webhook events). |

You'll mostly see `extendedTextMessage`, `imageMessage`, `audioMessage`,
`documentMessage`, `stickerMessage`.

### 2.5 Quotes, replies, and mentions

- **Quote**. A reply to an older message. The payload's `quoted` field
  references it (`{ seq, message_id, from_jid, text }`). The quoted
  message's text is denormalized — you don't always need to re-fetch.
- **Mentions**. A message in a group can tag specific users. The payload
  carries `mentioned_jids: string[]`. Additionally, the bot computes
  `mentioned_self: boolean` — true if the bot itself was @-mentioned.
  **Use `mentioned_self` to gate AI replies in groups.**

### 2.6 The bot's own messages

When **you** call `POST /v1/send`, the message you send is stored just
like any other. It will appear in webhooks as `from_me: true` (and the
`message.received` webhook is **filtered out** for `from_me=true`, so your
agent doesn't loop back to itself). You can still:

- read it back via `GET /v1/messages/:seq`,
- include it in chat history fetches,
- edit it (`POST /v1/messages/:seq/edit`),
- delete it for everyone (`POST /v1/messages/:seq/delete`),
- react to any message (yours or others').

WhatsApp **does not allow** editing or delete-for-everyone of messages
sent by other people. The API enforces this with `403 forbidden`.

### 2.7 Lifecycle of an inbound message

```
   phone sends → Baileys decrypt → store row in wa.messages (gets seq)
                                ↓
                      MessageBus.emit('message.received')
                                ↓
                    enqueue webhook delivery (one per active sub)
                                ↓
            ┌────── WebhookWorker POSTs to your URL ──────┐
            │   if 2xx → delivered                         │
            │   else   → retry (30s → 2m → 10m → 1h → 6h → 24h, ×6)
            └─────────────────────────────────────────────┘

   in parallel for media:
   download media bytes → store on Firebase → emit nothing yet
                                ↓
            run AI processor → store result_text + completed_at
                                ↓
                MessageBus.emit('message.processed')
                                ↓
                       webhooks fire again
```

This means you typically get **two** webhooks for a media message:

1. `message.received` — fires immediately when the message is persisted.
   At this point `media.url` may be present but `media.processed` will be
   `null` (the AI hasn't run yet).
2. `message.processed` — fires 5–60 seconds later (depends on processor &
   media size) when the AI result is ready. Same message payload, now
   with `media.processed` populated.

You can choose:
- **Subscribe to both** and react twice (e.g. acknowledge immediately,
  then process the image when ready).
- **Subscribe to only `message.processed`** for media-heavy bots that
  don't need a raw-bytes-only path.
- **Subscribe to only `message.received`** and fetch processed text on
  demand from `GET /v1/messages/:seq/media`.

---

## 3. Quick start (10 minutes)

### 3.1 Enable the API on the bot

In the bot's `.env`:

```bash
API_ENABLED=true
API_AUTH_TOKEN=$(openssl rand -hex 32)
# Optional overrides:
# API_HOST=127.0.0.1
# API_PORT=8787
# API_MAX_BODY_MB=25
```

Restart the bot. You should see `api server listening` in the logs.

### 3.2 First call

```bash
TOKEN="paste-the-token-from-.env-here"

# Health (no auth)
curl http://127.0.0.1:8787/v1/health

# Authenticated
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/me
```

### 3.3 Send your first message

```bash
curl -X POST http://127.0.0.1:8787/v1/send \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "359884430293@s.whatsapp.net",
    "text": "Hello from the API"
  }'
```

Response:

```json
{
  "seq": 42174,
  "wa_message_id": "3EB0C123ABCDEF1234",
  "to": "359884430293@s.whatsapp.net",
  "type": "extendedTextMessage"
}
```

### 3.4 Receive your first webhook

```bash
# Spin up a temporary listener (port 9001) that prints the body:
npx http-echo-server 9001 &

# Register the webhook
curl -X POST http://127.0.0.1:8787/v1/webhooks \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "http://127.0.0.1:9001/",
    "description": "Quick start"
  }'

# Save the returned "secret" (visible once) — you'll need it for verification.
# Now send any WhatsApp message to the bot from your phone.
# Your listener should receive a JSON POST.
```

---

## 4. Authentication

A single static bearer token authenticates **every** endpoint except
`GET /v1/health`.

```
Authorization: Bearer <API_AUTH_TOKEN>
```

| Condition               | Response               |
| ----------------------- | ---------------------- |
| No `Authorization` hdr  | `401 Unauthorized`     |
| Wrong scheme / format   | `401 Unauthorized`     |
| Wrong token             | `403 Forbidden`        |

The comparison is constant-time (`timingSafeEqual`), so timing attacks
won't recover the token byte-by-byte.

### 4.1 Token hygiene

- Treat the token as a database password. Never commit it. Never log it.
- Bind the API to `127.0.0.1` (default) and terminate TLS at a reverse
  proxy (Caddy, Nginx, Cloudflare Tunnel). Don't expose `:8787` to the
  internet directly.
- To rotate: change `API_AUTH_TOKEN` in `.env`, restart, update every
  consumer. Multi-token / scoped auth is on the roadmap.

---

## 5. Webhooks — the primary integration path

Webhooks are **durably queued in Postgres** and delivered by a worker that
retries with exponential backoff. You never lose events to a transient
outage on your end. Delivery is **at-least-once**: design your handler to
be idempotent (see [§5.6](#56-idempotency)).

### 5.1 Lifecycle

```
register sub ──▶ event fires ──▶ row inserted into wa.webhook_deliveries
                                              │
                  ┌───────────────────────────┘
                  ▼
            worker claims (FOR UPDATE SKIP LOCKED)
                  │
        ┌─────────┴──────────┐
        ▼                    ▼
   POST your URL         on 2xx → delivered
   with HMAC sig         on non-2xx / timeout → schedule retry
                            (30s → 2m → 10m → 1h → 6h → 24h, max 6 attempts)
                            after 6 → abandoned (never retried)
```

### 5.2 Registering a webhook

```bash
curl -X POST http://127.0.0.1:8787/v1/webhooks \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://agent.example.com/wa-webhook",
    "event_types": ["message.received", "message.edited", "message.processed"],
    "description": "AI agent v1"
  }'
```

Body fields:

| Field         | Type                | Required | Default                                                                                              |
| ------------- | ------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `url`         | string (URI)        | yes      | —                                                                                                    |
| `secret`      | string ≥16 chars    | no       | auto-generated 32-byte hex (returned once)                                                           |
| `event_types` | string[]            | no       | `["message.received","message.edited","message.deleted","message.reacted","message.processed"]`      |
| `description` | string              | no       | `null`                                                                                               |
| `active`      | boolean             | no       | `true`                                                                                               |

**Response (201 Created):**

```json
{
  "id": "3fbe0eec-5f88-4820-b415-fbd1eff5d433",
  "url": "https://agent.example.com/wa-webhook",
  "secret": "8e6f...e1a2",
  "event_types": ["message.received", "message.edited", "message.processed"],
  "active": true,
  "description": "AI agent v1",
  "created_at": "2026-05-11T18:00:00Z",
  "updated_at": "2026-05-11T18:00:00Z"
}
```

Store the `secret` securely — it's the only time it's returned in full
(after this, `GET /v1/webhooks/:id` returns it but you should treat it as
write-once). You need it to verify signatures.

### 5.3 Event catalog

| Event                | Fires when                                                            | `message` field           | Extra fields             |
| -------------------- | --------------------------------------------------------------------- | ------------------------- | ------------------------ |
| `message.received`   | An **inbound** message is persisted (filtered: `from_me=true` skipped) | Full message payload      | —                        |
| `message.edited`     | Content of a message changed via WhatsApp's edit flow                 | Full message payload      | —                        |
| `message.deleted`    | A message was revoked / deleted-for-me                                | Full message payload (`tombstone=true`, `deleted=true`) | — |
| `message.reacted`    | A reaction was added / changed / removed                              | Full message payload of the reacted-to message | `reaction: { actor_jid, emoji }` (`emoji` is `null` when removed) |
| `message.processed`  | AI processor finished on a media row                                  | Full message payload (now with `media.processed` populated) | — |
| `webhook.test`       | Synthetic — fired via `POST /v1/webhooks/:id/test`                    | `null`                    | `test: { source: "..." }` |

The body **always** has this envelope:

```json
{
  "event": "<event-type>",
  "created_at": "2026-05-11T18:43:58.123Z",
  "account": { "id": "uuid", "pn": "447960...@s.whatsapp.net", "lid": "205321...@lid" },
  "message": { /* MessagePayload or null */ }
  // plus event-specific extras (e.g. "reaction" for message.reacted)
}
```

See [§7](#7-the-message-payload) for the full `MessagePayload` schema.

### 5.4 Delivery HTTP headers

Every webhook POST has these headers:

| Header                 | Example                              | Meaning                                            |
| ---------------------- | ------------------------------------ | -------------------------------------------------- |
| `Content-Type`         | `application/json`                   | Always JSON.                                       |
| `User-Agent`           | `scandi-wa-bot/0.1`                  |                                                    |
| `X-Webhook-Id`         | `42`                                 | The `wa.webhook_deliveries.id` — stable per attempt-group, useful for dedup. |
| `X-Webhook-Event`      | `message.received`                   | Echoes the `event` field in the body.              |
| `X-Webhook-Timestamp`  | `1715882640`                         | Unix seconds at POST time.                         |
| `X-Webhook-Signature`  | `sha256=<64-hex-chars>`              | HMAC-SHA256 over `{timestamp}.{raw_body}`.         |

### 5.5 Verifying the signature

The signature scheme is Stripe-style: `sha256=hex(HMAC_SHA256(secret, "{timestamp}.{raw_body}"))`.
**Use the raw body bytes, before any parsing.**

#### Node.js / TypeScript

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

const SECRET = process.env.WA_WEBHOOK_SECRET!

export function verifyWebhook(rawBody: string, headers: Record<string, string>): boolean {
  const ts = headers['x-webhook-timestamp']
  const sig = headers['x-webhook-signature']
  if (!ts || !sig) return false

  // Optional: reject if older than 5 minutes (replay protection)
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false

  const expected = `sha256=${createHmac('sha256', SECRET).update(`${ts}.${rawBody}`).digest('hex')}`
  return (
    expected.length === sig.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(sig))
  )
}
```

#### Python

```python
import hmac, hashlib, time

SECRET = os.environ["WA_WEBHOOK_SECRET"].encode()

def verify_webhook(raw_body: bytes, headers: dict[str, str]) -> bool:
    ts = headers.get("x-webhook-timestamp")
    sig = headers.get("x-webhook-signature")
    if not ts or not sig:
        return False
    if abs(time.time() - int(ts)) > 300:
        return False
    mac = hmac.new(SECRET, f"{ts}.".encode() + raw_body, hashlib.sha256).hexdigest()
    expected = f"sha256={mac}"
    return hmac.compare_digest(expected, sig)
```

#### Go

```go
func VerifyWebhook(rawBody []byte, ts, sig, secret string) bool {
    h := hmac.New(sha256.New, []byte(secret))
    h.Write([]byte(ts + "."))
    h.Write(rawBody)
    expected := "sha256=" + hex.EncodeToString(h.Sum(nil))
    return hmac.Equal([]byte(expected), []byte(sig))
}
```

**Important:** if you're using Express, FastAPI, Next.js, etc. — make sure
your framework gives you the **raw body**, not a re-serialized JSON object.
Re-serialization will change whitespace / key order and the signature
will break. In Express use `express.raw({ type: 'application/json' })`;
in FastAPI use `await request.body()`.

### 5.6 Idempotency

Webhooks may be delivered **more than once** if your endpoint:

- returns a non-2xx response that succeeds on retry,
- times out (≥10s by default),
- crashes mid-handler,
- the worker's lease expires before completion.

To handle this safely, **dedupe by `X-Webhook-Id`**. Store the ID with a
short TTL (24h is plenty):

```ts
const seen = new Set<string>()
function handle(req) {
  const id = req.headers['x-webhook-id']
  if (seen.has(id)) return res.status(200).end()
  seen.add(id)
  setTimeout(() => seen.delete(id), 86_400_000)
  // ... your handler ...
}
```

For production, use Redis / Postgres / DynamoDB instead of an in-memory
`Set`.

### 5.7 Retry / failure behavior

| Attempt | Delay until next |
| ------- | ---------------- |
| 1       | (immediate)      |
| 2       | 30 s             |
| 3       | 2 min            |
| 4       | 10 min           |
| 5       | 1 hour           |
| 6       | 6 hours          |
| 7       | 24 hours         |

After **6 failed attempts** the row is marked `abandoned` and never
retried. You can re-trigger by:

- calling `POST /v1/webhooks/:id/test` (synthetic test event),
- having the underlying real event fire again,
- running an operator-side SQL `UPDATE wa.webhook_deliveries SET status='pending', next_attempt_at=NOW(), attempts=0 WHERE id=…`.

A 2xx response (any of 200–299) marks the delivery `delivered`. Anything
else triggers a retry.

### 5.8 Inspecting deliveries

```bash
# List your subscriptions
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/webhooks

# Get one with its recent deliveries
curl -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8787/v1/webhooks/3fbe0eec-...
```

The detail response includes `recent_deliveries[]` — the last 10
deliveries with status, attempts, and any last error message.

### 5.9 Managing subscriptions

```bash
# Toggle active off (pauses delivery but keeps history)
curl -X PATCH http://127.0.0.1:8787/v1/webhooks/$ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"active": false}'

# Rotate secret (returns new secret in response)
curl -X PATCH http://127.0.0.1:8787/v1/webhooks/$ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"rotate_secret": true}'

# Change event filter
curl -X PATCH http://127.0.0.1:8787/v1/webhooks/$ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"event_types": ["message.received","message.processed"]}'

# Delete
curl -X DELETE http://127.0.0.1:8787/v1/webhooks/$ID \
  -H "Authorization: Bearer $TOKEN"

# Test (fires a synthetic webhook.test delivery)
curl -X POST http://127.0.0.1:8787/v1/webhooks/$ID/test \
  -H "Authorization: Bearer $TOKEN"
```

---

## 6. Endpoint reference

Base URL: `http://<API_HOST>:<API_PORT>` (defaults: `http://127.0.0.1:8787`).

All endpoints return `application/json` unless noted. All require
`Authorization: Bearer <token>` except `GET /v1/health`.

### 6.1 Meta

#### `GET /v1/health` *(no auth)*

```json
{
  "status": "ok",
  "sock_connected": true,
  "account_label": "default",
  "last_event_at": "2026-05-11T18:43:58Z",
  "initial_sync_done": true,
  "account_status": "active"
}
```

| Field                | Meaning                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `sock_connected`     | Whether the WhatsApp socket is currently open. **Check before sending.**|
| `initial_sync_done`  | True once the history sync that runs on first login has finished.       |
| `last_event_at`      | Timestamp of the most recent WA event received (any kind).              |
| `account_status`     | `active`, `disconnected`, etc. — see `wa.accounts.status`.              |

Use this for liveness probes and dashboards.

#### `GET /v1/me`

```json
{
  "account_id": "03854893-9b92-4833-910f-a5dc3dfdef22",
  "account_label": "default",
  "pn_jid": "447960451664:14@s.whatsapp.net",
  "lid_jid": "205321565942003:14@lid",
  "push_name": "ScandiGPT",
  "status": "active"
}
```

The bot's own identity. `pn_jid` and `lid_jid` are what the bot will
appear as when sending; `mentioned_self` in webhooks is computed against
these.

### 6.2 Chats

#### `GET /v1/chats`

List all chats (DMs + groups), sorted newest-first.

| Query param | Type                | Default | Notes                                                            |
| ----------- | ------------------- | ------- | ---------------------------------------------------------------- |
| `limit`     | int 1..200          | 50      |                                                                  |
| `cursor`    | opaque base64url    | —       | From a previous response's `next_cursor`. See [§9](#9-pagination-patterns). |
| `type`      | `"dm"` \| `"group"` | (all)   |                                                                  |

```json
{
  "chats": [
    {
      "jid": "120363012345678901@g.us",
      "type": "group",
      "subject": "Family",
      "description": "Weekend plans",
      "unread_count": 1,
      "unread_mention_count": 0,
      "archived": false,
      "last_event_at": "2026-05-11T18:43:58Z",
      "last_message_seq": 42173
    }
  ],
  "next_cursor": "eyJsYXN0VHMiOiIyMDI2LTA1LTExVDE4OjQzOjU4WiJ9"
}
```

When `next_cursor` is `null`, there are no more chats.

#### `GET /v1/chats/:jid`

URL-encode the JID (the `@` and `:` are reserved). Add
`?include_participants=true` to get group members.

```json
{
  "jid": "120363012345678901@g.us",
  "type": "group",
  "subject": "Family",
  "description": "Weekend plans",
  "unread_count": 1,
  "unread_mention_count": 0,
  "archived": false,
  "last_event_at": "2026-05-11T18:43:58Z",
  "last_message_seq": 42173,
  "owner_jid": "359884430293@s.whatsapp.net",
  "history_complete": false,
  "participants": [
    { "jid": "359884430293@s.whatsapp.net", "pn": "359884430293@s.whatsapp.net", "role": "admin", "name": "Dolan", "push_name": "Dolan" }
  ]
}
```

`history_complete=false` means the initial history sync didn't reach the
beginning of this chat. Older messages may still arrive later as
WhatsApp dribbles them in.

#### `GET /v1/chats/:jid/messages`

Paginated chat history.

| Query param          | Type            | Default | Notes                                                                                              |
| -------------------- | --------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `limit`              | int 1..100      | 50      |                                                                                                    |
| `before_seq`         | int             | —       | Return messages with `seq < before_seq` (newest-first; default direction).                         |
| `after_seq`          | int             | —       | Return messages with `seq > after_seq` (flips order to oldest-first / ascending).                  |
| `include_media`      | bool            | true    | Embed media + processed result inline (set false to skip if you don't need it — slightly faster).  |
| `include_reactions`  | bool            | true    | Embed reactions[] inline.                                                                          |
| `include_tombstones` | bool            | false   | Include deleted-for-everyone placeholders.                                                         |

Response:

```json
{
  "chat_jid": "120363...@g.us",
  "count": 50,
  "ascending": false,
  "next_before_seq": 42120,
  "next_after_seq": null,
  "messages": [ /* MessagePayload[] (newest first by default) */ ]
}
```

`next_before_seq` is `null` when you've reached the oldest message.

**For AI context windows**, the typical pattern is:

```bash
GET /v1/chats/$JID/messages?limit=20             # newest 20
GET /v1/chats/$JID/messages?limit=20&before_seq=42120   # next 20 older
```

For sync / pull patterns, use `after_seq` to fetch only what's new
since you last looked:

```bash
GET /v1/chats/$JID/messages?after_seq=$LAST_SEQ_I_HAVE&limit=100
# ascending order, oldest first
```

### 6.3 Single message

#### `GET /v1/messages/:seq`

Returns the rich [MessagePayload](#7-the-message-payload).

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/messages/42173
```

#### `GET /v1/messages/:seq/media`

Returns media metadata + **every** processing run (not just the latest).

```json
{
  "seq": 42173,
  "wa_message_id": "3EB0C123...",
  "chat_jid": "120363...@g.us",
  "media": {
    "media_type": "image",
    "mime_type": "image/jpeg",
    "size_bytes": 184293,
    "width": 1080,
    "height": 1920,
    "duration_seconds": null,
    "page_count": null,
    "file_name": null,
    "caption": null,
    "is_voice_note": null,
    "download_status": "done",
    "url": "https://firebasestorage.googleapis.com/...?token=...",
    "gcs_bucket": "scandi-ai.firebasestorage.app",
    "gcs_object": "accounts/.../3EB0C123.jpg"
  },
  "processed": [
    {
      "processor": "gemini_image",
      "model": "gemini-2.5-flash",
      "status": "done",
      "result_text": "A photo of a sunset over mountains, deep orange...",
      "result_meta": { "tokens": 312 },
      "processing_ms": 3284,
      "completed_at": "2026-05-11T18:44:00Z",
      "error": null
    }
  ]
}
```

| `download_status` | Meaning                                                       |
| ----------------- | ------------------------------------------------------------- |
| `pending`         | Queued for download.                                          |
| `in_progress`     | The bot is downloading + uploading to Firebase right now.     |
| `done`            | Bytes available in `url`.                                     |
| `failed`          | Could not download (e.g. media expired on WA servers).        |

`404` if the message has no media row.

#### `GET /v1/messages/:seq/media/download`

Convenience endpoint:

- **Default**: 302 redirect to `media.url` (the long-lived Firebase
  token URL). Most consumers can just follow the redirect.
- **`?proxy=true`**: stream the bytes through the bot. Use when your
  consumer can't reach Firebase directly (private VPC, offline test
  rig). The response has correct `Content-Type` and (for documents)
  `Content-Disposition: attachment; filename="..."`.

```bash
# Save to disk via redirect
curl -L -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8787/v1/messages/42173/media/download \
  -o photo.jpg

# Stream through the bot (no redirect, bytes sent directly)
curl -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8787/v1/messages/42173/media/download?proxy=true" \
  -o photo.jpg
```

If the media isn't downloaded yet (`download_status != "done"`) you get
`409 Conflict`. Wait for the `message.processed` webhook or poll
`/v1/messages/:seq/media`.

### 6.4 Send

#### `POST /v1/send`

Body schema:

```ts
{
  to: string                       // JID (e.g. "359884430293@s.whatsapp.net" or "...@g.us")
  text?: string                    // text content (used as caption for media if `media.caption` absent)
  media?: {
    kind: "image" | "video" | "audio" | "document" | "sticker"
    url?: string                   // server-side fetched (must be publicly reachable)
    base64?: string                // alternative: raw bytes inline (use for files <~5 MB)
    mimetype?: string              // e.g. "image/jpeg" — usually inferred from URL or kind
    filename?: string              // documents only
    caption?: string               // image/video/document caption (overrides `text`)
    gif_playback?: boolean         // video: render as GIF in WA UI
    ptt?: boolean                  // audio: render as voice note (push-to-talk)
    seconds?: number               // audio: declare duration (helps UI)
  }
  quote_seq?: number               // seq of the message to quote/reply to
  mentions?: string[]              // JIDs to @-mention (you must also reference them in the text)
}
```

Exactly one of `text` or `media` is required. With media, exactly one of
`url` or `base64` is required. The bot fetches `url`-based media
server-side (10s+ timeout, max 100 MB).

**Response (200 OK):**

```json
{
  "seq": 42174,
  "wa_message_id": "3EB0C123ABCDEF1234",
  "to": "359884430293@s.whatsapp.net",
  "type": "extendedTextMessage"
}
```

Notes:

- `seq` may be `null` if ingestion didn't complete within ~8 s. The
  message **was sent** — `wa_message_id` is your handle. Look up by
  message ID later, or just trust the operation succeeded.
- `type` is the WhatsApp protocol type that was generated; useful for
  logging.

Examples:

```bash
# Plain text
curl -X POST http://127.0.0.1:8787/v1/send \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"to":"359884430293@s.whatsapp.net","text":"Daily report ready ✅"}'

# Image by URL with caption
curl -X POST http://127.0.0.1:8787/v1/send \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "to": "359884430293@s.whatsapp.net",
    "media": {
      "kind": "image",
      "url": "https://picsum.photos/seed/report/800/600.jpg",
      "caption": "Today\u2019s report"
    }
  }'

# Voice note (audio with ptt=true)
curl -X POST http://127.0.0.1:8787/v1/send \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "to": "359884430293@s.whatsapp.net",
    "media": {
      "kind": "audio",
      "url": "https://example.com/note.ogg",
      "mimetype": "audio/ogg; codecs=opus",
      "ptt": true
    }
  }'

# PDF
curl -X POST http://127.0.0.1:8787/v1/send \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "to": "359884430293@s.whatsapp.net",
    "media": {
      "kind": "document",
      "url": "https://example.com/report.pdf",
      "filename": "Q1-report.pdf",
      "mimetype": "application/pdf"
    }
  }'

# Reply to a previous message in a group + @-mention
curl -X POST http://127.0.0.1:8787/v1/send \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "to": "120363012345678901@g.us",
    "text": "Hey @359884430293, found it",
    "quote_seq": 42100,
    "mentions": ["359884430293@s.whatsapp.net"]
  }'
```

#### `POST /v1/send/multipart`

Same semantics, but `multipart/form-data`. Fields:

| Field          | Required | Notes                                                   |
| -------------- | -------- | ------------------------------------------------------- |
| `to`           | yes      | JID                                                     |
| `kind`         | yes      | `image`/`video`/`audio`/`document`/`sticker`            |
| `file`         | yes      | the binary part                                         |
| `caption`      | no       |                                                         |
| `mimetype`     | no       | overrides the multipart `Content-Type`                  |
| `filename`     | no       | for documents                                           |
| `mentions`     | no       | comma-separated JIDs                                    |
| `quote_seq`    | no       |                                                         |
| `gif_playback` | no       | `"true"` / `"false"` (string)                           |
| `ptt`          | no       | `"true"` / `"false"`                                    |

```bash
curl -X POST http://127.0.0.1:8787/v1/send/multipart \
  -H "Authorization: Bearer $TOKEN" \
  -F "to=359884430293@s.whatsapp.net" \
  -F "kind=document" \
  -F "filename=Q1-report.pdf" \
  -F "mimetype=application/pdf" \
  -F "caption=Quarter 1 numbers" \
  -F "file=@./Q1-report.pdf"
```

Max body size is `API_MAX_BODY_MB` (default 25 MB).

### 6.5 Modify existing messages

All three endpoints take `:seq` as the public message ID.

#### `POST /v1/messages/:seq/react`

```bash
# Add / change reaction
curl -X POST http://127.0.0.1:8787/v1/messages/42173/react \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"emoji":"👍"}'

# Remove (empty string)
curl -X POST http://127.0.0.1:8787/v1/messages/42173/react \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"emoji":""}'
```

You can react to **any** message, including ones you didn't send. Returns
`204 No Content`.

#### `POST /v1/messages/:seq/edit`

Requires `from_me=true` on the target. Returns `403` otherwise.

```bash
curl -X POST http://127.0.0.1:8787/v1/messages/42174/edit \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"oops, corrected text"}'
```

```json
{
  "seq": 42174,
  "wa_message_id": "3EB0C123...",
  "edit_wa_message_id": "3EB0DEAD..."
}
```

`edit_wa_message_id` is the protocol-level edit event ID (you usually
don't need it).

WhatsApp imposes a ~15-minute window for edits. Beyond that, the edit
will be silently rejected by the server.

#### `POST /v1/messages/:seq/delete`

Delete-for-everyone. Requires `from_me=true`. Returns `204`.

```bash
curl -X POST http://127.0.0.1:8787/v1/messages/42174/delete \
  -H "Authorization: Bearer $TOKEN"
```

After deletion, the message is **tombstoned** (`tombstone=true`,
`deleted=true`). It still appears in `GET /v1/messages/:seq` for audit,
but is excluded from chat history by default (use
`?include_tombstones=true` to surface).

### 6.6 Webhook management

Already covered in [§5](#5-webhooks--the-primary-integration-path). Reference:

- `POST   /v1/webhooks`
- `GET    /v1/webhooks` (query: `?active=true|false`)
- `GET    /v1/webhooks/:id`
- `PATCH  /v1/webhooks/:id`
- `DELETE /v1/webhooks/:id`
- `POST   /v1/webhooks/:id/test`

---

## 7. The message payload

This is the canonical shape used by:

- `GET /v1/messages/:seq` (the entire response body),
- the `messages[]` array in `GET /v1/chats/:jid/messages`,
- the `message` field inside every webhook delivery.

```json
{
  "seq": 42173,
  "wa_id": "3EB0C123ABCDEF1234",
  "chat": {
    "jid": "120363012345678901@g.us",
    "type": "group",
    "subject": "Family",
    "participant_count": 7
  },
  "from": {
    "jid": "205321565942003@lid",
    "pn": "359884430293@s.whatsapp.net",
    "lid": "205321565942003@lid",
    "push_name": "Dolan"
  },
  "from_me": false,
  "timestamp": "2026-05-11T18:43:58.000Z",
  "type": "imageMessage",
  "text": "look at this",
  "caption": null,
  "mentioned_self": true,
  "mentioned_jids": ["205000000000000@lid"],
  "addressing_mode": "lid",
  "forwarded": false,
  "forward_score": null,
  "edit_count": 0,
  "last_edited_at": null,
  "deleted": false,
  "deleted_at": null,
  "deleted_by_jid": null,
  "deletion_reason": null,
  "tombstone": false,
  "quoted": {
    "seq": 42170,
    "message_id": "ABCDE...",
    "from_jid": "359884430293@s.whatsapp.net",
    "text": "Check out the new view"
  },
  "media": {
    "media_type": "image",
    "mime_type": "image/jpeg",
    "size_bytes": 184293,
    "width": 1080,
    "height": 1920,
    "duration_seconds": null,
    "page_count": null,
    "file_name": null,
    "caption": null,
    "is_voice_note": null,
    "download_status": "done",
    "url": "https://firebasestorage.googleapis.com/.../3EB0C123.jpg?alt=media&token=...",
    "processed": {
      "text": "A photo of a sunset over mountains...",
      "processor": "gemini_image",
      "model": "gemini-2.5-flash",
      "completed_at": "2026-05-11T18:44:00.123Z"
    }
  },
  "reactions": [
    { "emoji": "👍", "actor_jid": "359884430293@s.whatsapp.net", "at": "2026-05-11T18:44:30.000Z" }
  ]
}
```

### 7.1 Field-by-field

| Field                       | Type                | Notes                                                                                   |
| --------------------------- | ------------------- | --------------------------------------------------------------------------------------- |
| `seq`                       | int64               | The public ID. Use everywhere.                                                          |
| `wa_id`                     | string              | WhatsApp's original `key.id`.                                                           |
| `chat.jid`                  | string              | DM or group JID.                                                                        |
| `chat.type`                 | `"dm"` \| `"group"` |                                                                                         |
| `chat.subject`              | string \| null      | Group name only.                                                                        |
| `chat.participant_count`    | int \| null         | Groups only; `null` for DMs.                                                            |
| `from.jid`                  | string              | The sender's canonical JID — could be LID or PN.                                        |
| `from.pn` / `from.lid`      | string \| null      | The resolved PN and LID forms when known.                                               |
| `from.push_name`            | string \| null      | Display name set by the sender. **Not authoritative** — can be spoofed.                 |
| `from_me`                   | bool                | True if **the bot** sent this message.                                                  |
| `timestamp`                 | string (ISO 8601)   | WhatsApp's server timestamp.                                                            |
| `type`                      | string \| null      | Protocol type. See [§2.4](#24-message-types).                                           |
| `text`                      | string \| null      | The text content for text messages; caption denormalized for media messages.            |
| `caption`                   | string \| null      | The original caption field (might differ from `text` in obscure cases).                 |
| `mentioned_self`            | bool                | **Use this to gate AI replies in groups.** True if the bot's `pn_jid` or `lid_jid` appears in any `contextInfo.mentionedJid` in the raw proto. |
| `mentioned_jids`            | string[]            | Every JID mentioned anywhere in the message (deep-scanned).                             |
| `addressing_mode`           | `"pn"` \| `"lid"` \| null | Which form WhatsApp used to address.                                              |
| `forwarded`                 | bool \| null        | True if WA marked this as forwarded.                                                    |
| `forward_score`             | int \| null         | WA's "forwarded many times" counter.                                                    |
| `edit_count`                | int                 | 0 if never edited.                                                                      |
| `last_edited_at`            | string \| null      | ISO of most recent edit.                                                                |
| `deleted`                   | bool                | True if deleted (revoked).                                                              |
| `deleted_at`                | string \| null      | ISO when deleted.                                                                       |
| `deleted_by_jid`            | string \| null      | Who deleted it (sender or admin).                                                       |
| `deletion_reason`           | string \| null      | `"revoke"` / `"admin"` / etc.                                                           |
| `tombstone`                 | bool                | True for delete-for-everyone messages. Excluded from history by default.                |
| `quoted`                    | object \| null      | If this message was a reply.                                                            |
| `quoted.seq`                | int \| null         | `null` if the quoted message isn't in our DB yet (e.g. quoted across a sync boundary). Use `quoted.message_id` (`wa_id`) for direct lookup. |
| `quoted.text`               | string \| null      | Denormalized snippet — saves a round trip in many cases.                                |
| `media`                     | object \| null      | See [§8](#8-media-storage-processing-and-fetching).                                     |
| `reactions[]`               | array               | Most recent state per actor. `emoji` may be `null` if reaction removed.                 |

### 7.2 Notes on `from` in groups vs DMs

- **DM**: `from.jid` equals the other party's PN JID (or LID if WA
  decided to address the chat in LID mode).
- **Group**: `from.jid` is the participant's JID inside the group
  (commonly LID). `chat.jid` is the group JID. Use `from.pn` for a
  user-friendly phone number when available.
- **`from_me=true`**: `from.jid` is the bot's own LID/PN. The bot won't
  receive its own outbound `message.received` webhooks (filtered).

---

## 8. Media: storage, processing, and fetching

### 8.1 How media flows

```
WhatsApp encrypted media → Baileys decrypts → bot uploads to Firebase
                                                      │
                                            wa.media.download_status = "done"
                                                      │
                                            enqueue AI processing job
                                                      │
                                       ┌──────────────┴──────────────┐
                                       ▼                             ▼
                              fire `message.received`            run AI processor
                              (media.processed = null yet)            │
                                                                fire `message.processed`
                                                                (media.processed populated)
```

### 8.2 The default: processed text

For most consumers (especially LLM agents), the bot's **AI-processed
text** is the most useful representation. It's what shows up in
`media.processed.text` in every payload. The processors:

| Media kind            | Processor              | Default model               | Output                                                            |
| --------------------- | ---------------------- | --------------------------- | ----------------------------------------------------------------- |
| `image`, `sticker`    | `gemini_image`         | `gemini-2.5-flash`          | A detailed natural-language description of the image.             |
| `video`, `gif`, `ptv` | `gemini_video`         | `gemini-2.5-flash`          | A natural-language description of the video (audio + visuals).    |
| `audio` (incl. voice) | `elevenlabs_audio`     | `scribe_v2`                 | A transcript of the audio.                                        |
| `document`            | `llamaparse_document`  | configured tier             | Parsed Markdown of the document (PDF / DOCX / XLSX / PPTX / etc.).|

Routing happens automatically based on `mime_type` + `media_type`.

The processed text is what most LLM agents should use as the "what's in
this attachment?" representation. It's a few hundred to a few thousand
tokens at most — far cheaper than including the raw media in the prompt.

### 8.3 When to fetch the original media

There are real reasons to fetch the bytes:

- You're forwarding the file to another service that needs the original
  (e.g. an OCR service tuned for a specific document type).
- The user asked the bot to "save this image" / "send this to my email".
- You're building an analytics pipeline that needs hashes / EXIF / etc.
- The processed text isn't good enough for your task (e.g. you want
  pixel-level detail for chart analysis).

**Don't fetch raw bytes by default** — the processed text is faster,
cheaper, and almost always sufficient for AI agents.

To fetch:

1. Take the message's `seq`.
2. `GET /v1/messages/:seq/media/download` → 302 to a long-lived Firebase
   token URL. Follow the redirect.
3. Or `GET /v1/messages/:seq/media/download?proxy=true` to stream
   through the bot.

The Firebase URL is **long-lived** (no rotation by default), so consumers
can safely cache it. If you ever need a fresh URL, just hit the endpoint
again.

### 8.4 Outbound media fetch headers

When you `POST /v1/send` with `media.url`, the bot fetches the URL
server-side with a Mozilla-style `User-Agent`. If the host blocks
non-browser UAs (some CDNs do), use `base64` or the multipart endpoint.

### 8.5 Size & format constraints

| Path                       | Limit                                                  |
| -------------------------- | ------------------------------------------------------ |
| Inbound multipart upload   | `API_MAX_BODY_MB` (default 25 MB)                      |
| Outbound `media.url` fetch | 100 MB hard cap                                        |
| Outbound `media.base64`    | bounded by JSON body size; aim for ≤5 MB               |
| WhatsApp's own limits      | ~16 MB images, ~100 MB documents, ~2 GB videos (approx — WA changes these) |

For very large outbound files, use the multipart endpoint to avoid
base64's ~33% overhead.

---

## 9. Pagination patterns

### 9.1 Chat history

Two cursors, used independently:

- **`before_seq`** — go further back in time. Newest-first ordering.
- **`after_seq`** — fetch only what's new. Oldest-first ordering.

```ts
// AI context window: newest N
const { messages } = await fetch(`/v1/chats/${jid}/messages?limit=20`).then(r => r.json())

// Pull-mode sync: incrementally fetch from a watermark
let lastSeq = readWatermark()
while (true) {
  const { messages, next_after_seq } = await fetch(
    `/v1/chats/${jid}/messages?after_seq=${lastSeq}&limit=100`
  ).then(r => r.json())
  for (const m of messages) processMessage(m)
  if (!next_after_seq) break
  lastSeq = next_after_seq
}
writeWatermark(lastSeq)
```

### 9.2 Chat list

The chat list uses an **opaque cursor** (base64url-encoded last
timestamp). Treat it as opaque — don't try to parse it.

```ts
let cursor: string | null = null
do {
  const url = cursor ? `/v1/chats?cursor=${encodeURIComponent(cursor)}` : '/v1/chats'
  const { chats, next_cursor } = await fetch(url).then(r => r.json())
  for (const c of chats) processChat(c)
  cursor = next_cursor
} while (cursor)
```

---

## 10. Error responses

The API uses standard HTTP status codes. Error bodies follow
[Fastify's default error shape](https://fastify.dev/docs/latest/Reference/Errors/):

```json
{
  "statusCode": 404,
  "code": "NOT_FOUND",
  "error": "Not Found",
  "message": "message seq=99999 not found"
}
```

| Status | Meaning                                                                                       |
| ------ | --------------------------------------------------------------------------------------------- |
| `200`  | OK.                                                                                           |
| `201`  | Created (returned by `POST /v1/webhooks`).                                                    |
| `204`  | No Content (react / delete / DELETE webhook).                                                 |
| `302`  | Redirect to Firebase URL (media download default mode).                                       |
| `400`  | Bad request — schema validation failed, or precondition violated (e.g. media missing buffer). |
| `401`  | No `Authorization` header.                                                                    |
| `403`  | Wrong token, or trying to edit/delete a message that isn't `from_me`.                         |
| `404`  | Entity not found (chat / message / webhook / media).                                          |
| `409`  | Conflict — most commonly media not yet downloaded (`download_status != "done"`).              |
| `413`  | Payload too large — multipart upload exceeded `API_MAX_BODY_MB`.                              |
| `415`  | Wrong content type (multipart endpoint called without `multipart/form-data`).                 |
| `500`  | Bug or unexpected failure. Check bot logs.                                                    |
| `503`  | Socket not connected (`sock_connected=false`) — temporary; retry after `GET /v1/health` shows true. |

Always log the `message` field — it carries the human-readable cause.

---

## 11. Integration recipes

### 11.1 AI agent that replies to mentions in a group

```ts
// server.ts (Express + Node 20+)
import express from 'express'
import { createHmac, timingSafeEqual } from 'node:crypto'

const app = express()
const BOT = 'http://127.0.0.1:8787'
const TOKEN = process.env.WA_API_TOKEN!
const SECRET = process.env.WA_WEBHOOK_SECRET!

// raw body is required for HMAC verification
app.use(express.raw({ type: 'application/json' }))

app.post('/wa-webhook', async (req, res) => {
  const ts = req.header('x-webhook-timestamp')!
  const sig = req.header('x-webhook-signature')!
  const expected = `sha256=${createHmac('sha256', SECRET).update(`${ts}.${req.body}`).digest('hex')}`
  if (
    expected.length !== sig.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))
  ) {
    return res.status(401).send('bad signature')
  }

  const event = JSON.parse(req.body.toString('utf8'))
  if (event.event !== 'message.received') return res.sendStatus(200)

  const m = event.message
  // Only reply in groups when @-mentioned, or in DMs.
  if (m.chat.type === 'group' && !m.mentioned_self) return res.sendStatus(200)

  // Build context: last 20 messages in the chat
  const history = await fetch(
    `${BOT}/v1/chats/${encodeURIComponent(m.chat.jid)}/messages?limit=20`,
    { headers: { authorization: `Bearer ${TOKEN}` } }
  ).then(r => r.json())

  // Render messages for LLM prompt (oldest first)
  const conversation = history.messages.reverse().map(msg => {
    const who = msg.from_me ? 'assistant' : (msg.from.push_name ?? msg.from.jid)
    const body = msg.media?.processed?.text
      ? `[${msg.media.media_type}] ${msg.media.processed.text}`
      : (msg.text ?? '[unsupported]')
    return `${who}: ${body}`
  }).join('\n')

  const reply = await callYourLLM(conversation, m.text ?? '')

  await fetch(`${BOT}/v1/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      to: m.chat.jid,
      text: reply,
      quote_seq: m.seq        // reply-quote the user's message
    })
  })

  res.sendStatus(200)
})

app.listen(3000)
```

### 11.2 Daily report via cron

Send a scheduled report to a chat at 09:00 every weekday. No webhook
needed — just one HTTP call from your scheduler.

```bash
#!/usr/bin/env bash
# /etc/cron.d/wa-daily-report
set -euo pipefail
TOKEN=$(cat /etc/wa-bot/token)
REPORT=$(/usr/local/bin/generate-report.sh)

curl -fsS -X POST http://127.0.0.1:8787/v1/send \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg to "359884430293@s.whatsapp.net" --arg text "$REPORT" \
        '{to:$to, text:$text}')"
```

### 11.3 Streaming an image into an LLM context

```ts
async function describeImage(seq: number): Promise<string> {
  // First, check if processed text is already there
  const m = await fetch(`${BOT}/v1/messages/${seq}`, {
    headers: { authorization: `Bearer ${TOKEN}` }
  }).then(r => r.json())

  if (m.media?.processed?.text) return m.media.processed.text

  // Not ready yet — poll the media endpoint
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const mm = await fetch(`${BOT}/v1/messages/${seq}/media`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    }).then(r => r.json())
    const done = mm.processed.find((p: any) => p.status === 'done' && p.result_text)
    if (done) return done.result_text
  }
  throw new Error('processing didn\'t complete in 30s')
}
```

A better pattern: subscribe to `message.processed` and react when it
arrives, instead of polling.

### 11.4 Fetching original media (when processed text isn't enough)

```ts
async function downloadOriginal(seq: number): Promise<Buffer> {
  // Default: follow 302 to Firebase
  const res = await fetch(`${BOT}/v1/messages/${seq}/media/download`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    redirect: 'follow'
  })
  if (!res.ok) throw new Error(`media fetch failed: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}
```

If your consumer can't reach Firebase (corporate firewall, air-gap),
use `?proxy=true` and the bot will stream the bytes from Firebase
through itself to you.

### 11.5 Reacting fast, processing slowly

A common UX pattern: react with ⏳ immediately on receive, then with ✅
when done.

```ts
async function handle(event) {
  if (event.event !== 'message.received') return
  const seq = event.message.seq

  // Acknowledge instantly
  await fetch(`${BOT}/v1/messages/${seq}/react`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ emoji: '⏳' })
  })

  // Do work...
  const reply = await yourSlowWork(event.message)

  // Replace with success
  await fetch(`${BOT}/v1/messages/${seq}/react`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ emoji: '✅' })
  })

  await fetch(`${BOT}/v1/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ to: event.message.chat.jid, text: reply, quote_seq: seq })
  })
}
```

---

## 12. Operational notes

### 12.1 Backpressure & rate limits

- **Outbound sending is serialized at the WhatsApp protocol level**. The
  bot doesn't queue at the HTTP layer, but if you fire dozens of sends
  in parallel they will be transmitted sequentially. Plan for a steady
  ~5 messages/second ceiling in practice; bursting higher risks WA's
  spam heuristics.
- **No HTTP rate limiting is enforced today.** Be a good neighbor —
  burst sensibly and back off on 503s.
- **Webhook delivery concurrency** is configurable via
  `WEBHOOK_CONCURRENCY` (default 4). The bot will not send more than N
  webhook POSTs in flight to **all** of your endpoints combined.

### 12.2 Socket disconnects

If WhatsApp drops the bot's socket, `sock_connected` flips to `false`.
Sends will return `503 service unavailable`. Webhooks will continue to
queue (events received during a brief reconnect window may still be
delivered late; events while disconnected can't be observed). Build your
consumer to retry on 503 with backoff.

### 12.3 First-run history sync

After a fresh login, the bot performs an initial history sync —
backfilling recent chats, groups, and messages. During this window:

- `initial_sync_done` is `false`,
- `history_complete` is `false` for most chats,
- you may see large bursts of `message.received` for "old" messages.

For agents that should only react to **truly new** messages, gate on
`timestamp > now() - 5 minutes` until `initial_sync_done` becomes true.

### 12.4 Logging consumer requests

The bot's pino logger emits a structured line per HTTP request
(method, path, status, response time). Tail `journalctl -fu scandi-wa-bot`
(or wherever your systemd unit logs) to see API traffic in real time.

### 12.5 Time zones

All `*_at` and `timestamp` fields are ISO 8601 with explicit UTC offset
(usually `Z`). Don't assume local time.

---

## 13. Versioning, stability, and roadmap

- All routes are under `/v1/`. Breaking changes will go to `/v2/`.
- Adding fields to responses or new optional query params is **not**
  considered breaking. Consumers should ignore unknown fields.
- Removing fields, changing field types, changing default behavior, or
  changing status codes is breaking and will bump the prefix.

### Out of scope today (may arrive later)

- **LLM tool wrappers.** Building these is your job — the API is the
  primitive layer.
- **Multi-tenant API keys / scoped permissions.** One bearer token
  today; key rotation requires a restart.
- **Rate limiting.** Will become important when the bot is exposed
  beyond a trusted local consumer.
- **Server-Sent Events / WebSocket push.** Webhooks cover this.
- **Call (`call.*`) and presence (`presence.update`) events.** Not
  currently surfaced as webhooks.
- **Channel / newsletter sends.** Receive-only for now.

---

## 14. Glossary

| Term                  | Meaning                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| **Account**           | The bot's WhatsApp identity. There's one account per running bot.                                     |
| **Addressing mode**   | Whether WhatsApp identifies parties in a chat by PN or LID (see [§2.1](#21-identifiers-jids-pn-lid)). |
| **Baileys**           | The open-source library this bot uses to speak WhatsApp's protocol.                                    |
| **DM**                | Direct message — a 1-on-1 conversation between two phone numbers.                                      |
| **JID**               | WhatsApp's "Jabber ID" — the protocol-level identifier (`xxx@s.whatsapp.net`, `xxx@lid`, etc.).        |
| **LID**               | Privacy-preserving identifier (`xxx@lid`) used in groups where members may not know each other.       |
| **`mentioned_self`**  | Computed boolean — true if the bot itself was @-mentioned in the message.                              |
| **Multi-account**     | Multiple WA numbers in one process. Not supported today.                                              |
| **PN**                | "Phone-number JID" (`xxx@s.whatsapp.net`). The "real" identifier.                                     |
| **PTV**               | Push-to-video — WhatsApp's circular video notes.                                                       |
| **Push name**         | The display name a WA user has set on their profile. Spoofable; not authoritative.                    |
| **`seq`**             | The bot's public, globally-unique, sortable message ID. Use this in URLs.                              |
| **Tombstone**         | A revoked/delete-for-everyone marker. The row still exists; content is empty.                          |
| **`wa_id`**           | WhatsApp's protocol-level message ID (`key.id` in Baileys).                                            |

---

## Appendix A: Minimal smoke check script

See `scripts/api-smoke.ts` in the bot repo for a 15-step integration test
that exercises every endpoint. Useful as both a deployment check and as
worked examples in TypeScript.

```bash
# After bot is up:
API_AUTH_TOKEN=$(grep '^API_AUTH_TOKEN=' .env | cut -d= -f2) \
  SMOKE_PHONE=359884430293 \
  npx tsx scripts/api-smoke.ts
```

## Appendix B: Local sandbox checklist

Building locally and want to make sure everything's wired up?

1. `npm run dev` — bot starts; logs show `api server listening`.
2. `curl http://127.0.0.1:8787/v1/health` — should return `sock_connected: true`.
3. `curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/me` — should return your bot's JIDs.
4. Send a message to the bot from another phone; tail logs for the
   `message.received` event.
5. `curl -X POST http://127.0.0.1:8787/v1/send -H "Authorization: Bearer $TOKEN" -d '{"to":"…@s.whatsapp.net","text":"hi"}'` — should arrive on the phone.
6. Register a webhook pointing at `https://webhook.site/<your-uuid>` and
   send another message. Verify it arrives at webhook.site with a valid
   HMAC signature.

If all six succeed, you're ready to build.
