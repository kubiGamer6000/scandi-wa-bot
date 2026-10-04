# Notify API — sending WhatsApp messages from another app

A send-only HTTPS endpoint for apps that need to message people on WhatsApp
through the Scandi bot account (the same account Jarvis uses). Built for the
editor app: "a new video was assigned to you", "your edit was approved", etc.

The calling app owns everything about *who* gets notified and *when*. This API
only delivers a message to a phone number, safely.

```
POST https://wa-api.scandigum.com/v1/notify
Authorization: Bearer wak_…
Content-Type: application/json

{
  "to": "+46 70 123 45 67",
  "text": "**New video assigned**\nConcept 1906 · hook 2\n[Open brief](https://app.example.com/v/1906)",
  "format": "markdown",
  "idempotency_key": "assignment-8812"
}
```

```json
{ "id": 42, "status": "sent", "to": "46701234567@s.whatsapp.net",
  "wa_message_id": "3EB0…", "seq": 18311, "deduplicated": false,
  "created_at": "2026-10-04T19:40:12.000Z" }
```

## Getting a key

Keys are created on the droplet; the full key is printed once and only its
hash is stored.

```bash
cd /opt/scandi-wa-bot
npm run api-key -- create "editor-app"                 # scope: notify, 30/min, 1000/day
npm run api-key -- create "editor-app" --per-minute 10 --per-day 300
npm run api-key -- list                                # usage + last used
npm run api-key -- revoke wak_3f9a1c2b                 # by prefix or id; effective within 30s
```

A `notify` key can call exactly two routes: `POST /v1/notify` and
`GET /v1/notify/:id`. Anything else returns 403. Give each app its own key, so
a leak is one revoke away and every message is attributable.

## Request

| Field | Required | Notes |
|---|---|---|
| `to` | yes | Phone number in international format — `+46701234567`, `0046 70 123 45 67`, `+1 (415) 555-0100` all work. Must include the country code. An individual WhatsApp JID (`…@s.whatsapp.net` / `…@lid`) is accepted too. Groups are refused. |
| `text` | yes | Up to 4096 characters after formatting. |
| `format` | no | `"whatsapp"` (default, sent as-is) or `"markdown"` (converted, see below). |
| `idempotency_key` | no, recommended | Any string ≤ 200 chars, unique per logical notification (e.g. `assignment-<id>`). Also accepted as an `Idempotency-Key` header. |

### Formatting

WhatsApp's own syntax, usable directly with `format: "whatsapp"`:

| Looks like | Write |
|---|---|
| **bold** | `*bold*` |
| _italic_ | `_italic_` |
| ~~strike~~ | `~strike~` |
| `code` | `` `code` `` or ```` ```block``` ```` |
| quote | `> text` |
| lists | `- item` / `1. item` |
| line break | `\n` |

With `format: "markdown"`, standard Markdown is converted: `**bold**`/`__bold__`
→ `*bold*`, `*italic*` → `_italic_`, `~~x~~` → `~x~`, `# Heading` → `*Heading*`,
`* item` → `- item`, `[label](https://url)` → `label: https://url`. Code spans and
blocks pass through untouched.

**Links:** WhatsApp makes plain URLs clickable but can't hide a URL behind link
text, which is why `[label](url)` becomes `label: url`. Put the link on its own
line for the cleanest look.

## Responses

| Status | Meaning | Retry? |
|---|---|---|
| 200 | Sent. `deduplicated: true` means this idempotency key was already sent — nothing new went out. | — |
| 400 | Bad input (`to` not a phone number / JID, text empty or too long). | No — fix the request. |
| 401 / 403 | Missing, invalid or revoked key, or a route outside the key's scope. | No. |
| 409 | Same idempotency key is in flight right now. | Yes, after a second. |
| 422 | The number isn't on WhatsApp (often a missing country code). | No. |
| 429 | Rate limited. Honour `Retry-After` (seconds). | Yes, after `Retry-After`. |
| 502 | WhatsApp rejected the send. Failed sends can be retried with the same idempotency key. | Yes, with backoff. |
| 503 | The bot is briefly disconnected from WhatsApp. | Yes, with backoff. |

Error bodies look like `{ "error": "…", "message": "…" }`.

## Status lookup

```
GET https://wa-api.scandigum.com/v1/notify/42
Authorization: Bearer wak_…
```

```json
{ "id": 42, "status": "sent", "to": "46701234567@s.whatsapp.net", "wa_message_id": "3EB0…",
  "error": null, "created_at": "…", "delivered_at": "…", "read_at": "…" }
```

`delivered_at` / `read_at` come from WhatsApp receipts. `read_at` stays null when
the recipient has read receipts turned off. A key only sees its own
notifications.

## Limits

| Limit | Default | Set by |
|---|---|---|
| Per key, per minute | 30 | `--per-minute` at key creation |
| Per key, per 24 h | 1000 | `--per-day` at key creation |
| Per recipient, per hour (all keys) | 20 | `NOTIFY_PER_RECIPIENT_PER_HOUR` in the bot's `.env` |

These are deliberately conservative. The bot is a regular WhatsApp account
(Baileys, unofficial), and WhatsApp bans accounts that behave like bulk
senders. Practical advice for the calling app:

- **Have each person message the bot once before their first notification**
  (e.g. "hi" during onboarding). Messaging numbers that never interacted with
  the account is the pattern most likely to get it flagged.
- Send notifications, not marketing; batch several updates into one message
  where you can.
- Use idempotency keys so retries after a timeout never double-send.

## Example (TypeScript)

```ts
async function notifyEditor(phone: string, text: string, key: string) {
  const res = await fetch("https://wa-api.scandigum.com/v1/notify", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SCANDI_WA_NOTIFY_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ to: phone, text, format: "markdown", idempotency_key: key }),
  });
  if (res.status === 429 || res.status >= 500) {
    // retry later; honour Retry-After when present
    throw new Error(`retryable ${res.status}: ${await res.text()}`);
  }
  if (!res.ok) throw new Error(`notify failed ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{ id: number; status: string; deduplicated: boolean }>;
}

await notifyEditor(
  "+46701234567",
  "**New video assigned** 🎬\nConcept *1906*, hook 2 — due Friday\n\n[Open in the app](https://app.example.com/v/1906)",
  "assignment-8812",
);
```

## Replies and Jarvis

Replies land in the bot's message store like any other message. Jarvis only
acts for approved people (`JARVIS_WA_ALLOWED_SENDERS` in scandi-jarvis), so an
editor's reply is stored and ignored — nobody answers it. Editors who *are*
approved can talk to Jarvis as usual; your notifications show up in their DM
history with the bot.

## Security notes

- Keys are 256-bit random (`wak_` + 43 chars). Only sha256 hashes are stored.
- The bot's master token (`API_AUTH_TOKEN`) is refused for requests that come
  through the public proxy; it only works from the droplet itself. External
  apps must use scoped keys.
- Every request — sent, failed, deduplicated — is recorded in `wa.notifications`
  with the key that made it.
