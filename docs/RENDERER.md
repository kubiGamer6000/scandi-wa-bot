# Conversation renderer

`npm run render -- <phone-or-jid> [out.md]` reads everything we know
about a conversation from `wa.*` and emits a single Markdown file ready
for human reading or LLM context-window stuffing.

## Quick examples

```bash
# Phone number — looked up via wa.contacts.pn / wa.lid_mappings.pn
npm run render -- +359884430293

# Raw JID
npm run render -- 187595850019032@lid

# Group
npm run render -- 1203456789@g.us

# Custom output path
npm run render -- 447960451664 out/me.md
```

Output files land in `out/<slug>_<timestamp>.md` by default. The folder
is gitignored.

## What gets produced

A single Markdown document with:

1. **Header block** — chat type, primary JID, merged JIDs, contact name,
   phone, LID, message count, first/last timestamps, account label.
2. **Day buckets** — one `## YYYY-MM-DD` heading per day.
3. **Message blocks**:
   - `**HH:MM:SS UTC** — **Sender Name**`
   - Optional reply quote line (`> ↩ Replying to X: …`)
   - Body (text, caption, or media tag)
   - Edit history (prior versions)
   - Reaction summary (`↳ Reactions: ❤️ Alice • 🔥 Bob`)
4. **Deletions** rendered as strikethrough with the deletion reason and
   actor: `~~original~~ *(sender revoke by Velislav at 16:52 UTC)*`.
5. **System events** rendered with full data: `*system: protocolMessage* —
   type=`HISTORY_SYNC_NOTIFICATION`` with target message info when
   relevant.

See `out/*.md` for live samples.

## Pipeline

```
   CLI arg → resolveTarget()  ──▶ ResolvedTarget {
                                    primaryChatJid,
                                    chatJids: [...],   // PN-form + LID-form + device variants
                                    contact info,
                                    chat type/subject
                                  }
              │
              ▼
   buildNameDirectory(account)  ──▶ NameDirectory {
                                      byJid: Map,      // any alias → display name
                                      pnToLid / lidToPn: Map,
                                      self: { pn, lid, name }
                                    }
              │
              ▼
   one query per resource:
     • wa.messages    WHERE chat_jid IN (chatJids)   ORDER BY ts, id
     • wa.message_edits, wa.reactions, wa.media        IN (visible message_ids)
              │
              ▼
   filter `isHiddenSystemRow` (drop reactionMessage envelopes + REVOKE protocols)
              │
              ▼
   formatHeader() + per-message formatMessage(bundle, ctx)
              │
              ▼
   Markdown file
```

The renderer is implemented in:

| File                          | Role                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `src/render/index.ts`         | CLI entry point. Parses args, calls the renderer, writes the file.                  |
| `src/render/lookup.ts`        | `resolveTarget`, `expandChatJids`, `buildNameDirectory`, `nameForJid`.              |
| `src/render/conversation.ts`  | Orchestrates DB queries and message bundling.                                       |
| `src/render/format.ts`        | Pure Markdown formatting helpers.                                                   |

## Resolving a target (`resolveTarget`)

The CLI accepts a phone number, a JID, or a LID. The resolver:

1. If input contains `@`, treat as JID, pass through.
2. Else strip to digits and:
   - Look up `wa.contacts` by `pn = digits` or by JID prefix.
   - If LID-only contact found, walk `wa.lid_mappings` for a PN match.
3. Fall back to building `<digits>@s.whatsapp.net`.

Then `enrich()` picks the best available contact row and chat row to
populate the header (preferring PN-form for the saved name and chat
metadata).

## Merging PN-form and LID-form chats (`expandChatJids`)

WhatsApp v7 split DMs across two JIDs:

- **PN form** (`…@s.whatsapp.net`) — old chat that history-sync uses.
- **LID form** (`…@lid`) — new chat that real-time messages flow through
  after the LID migration.

The renderer queries both and merges chronologically. `expandChatJids(primary)`:

1. Look up `wa.contacts` by primary JID, `pn`, or `lid` and add every
   `(jid, pn, lid)` triple it returns.
2. Look up `wa.lid_mappings` by `pn` or `lid` and add both sides.
3. Return the union.

For groups, the LID/PN split doesn't apply; we return `[primary]`.

## Display names (`buildNameDirectory`)

The directory maps any known alias (PN, LID, deviced JID) to the prettiest
display name in this order of preference:

1. `wa.contacts.name` (saved name in your address book)
2. `wa.contacts.push_name` (notify name advertised by the user)
3. `prettyJid(jid)` — `+359884…` for PN, `(lid 187…)` for LID

`nameForJid(dir, jid, fallback)`:
- Detects "me" by matching against `account.self_pn_jid` /
  `self_lid_jid` (with device-suffix tolerance).
- Tries the JID, then `stripDevice(jid)`, then the LID/PN counterpart
  via `pnToLid` / `lidToPn`.
- Falls back to `fallbackPushName` (the message's `pushName` at send
  time), then to `prettyJid`.

This is what lets the renderer label the same person consistently across
the PN-form and LID-form halves of a conversation.

## Hiding noise (`isHiddenSystemRow`)

Two row types are filtered before rendering, since their effect is
already shown elsewhere:

- `messageType === 'reactionMessage'` — surfaces under the *target*
  message as `↳ Reactions: …`.
- `protocolMessage.type` is `REVOKE` (numeric `0` or string `"REVOKE"`)
  — surfaces as a strikethrough on the *target* message via `deleted_at`.

Other protocolMessage subtypes (HISTORY_SYNC_NOTIFICATION,
INITIAL_SECURITY_NOTIFICATION_SETTING_SYNC, EPHEMERAL_SETTING, etc.) are
rendered as inline system notes with full type and target detail.

## Markdown formatting rules

- **Sender:** for DMs we fall back to `chatJid` when `participant` is
  null (which is normal for DMs); the directory then resolves the
  counterpart name.
- **Quote line:** truncated at 200 chars; shows `(quote body unavailable)`
  when the quoted body is media or wasn't captured.
- **Edit history:** sorted by version, each prior version on its own
  bullet `- *prior v1:* old text · *HH:MM:SS UTC*`.
- **Deletions:** `~~body~~  \n*(reason by Actor at HH:MM:SS UTC)*`. The
  `by Actor` part is omitted when `deleted_by_jid` is null (e.g. orphan
  revokes where we never observed a revoker JID).
- **Forwarded messages:** prepended with `↪ *Forwarded* (×N)`.
- **Reactions:** grouped by emoji; `↳ Reactions: ❤️ Alice, Bob • 🔥 Carl`.
- **Media:** `[🎥 video • video/mp4 • 1280×720 • 0:42 • 4.2 MB]` plus a
  `(media not yet downloaded: pending)` suffix until the downloader runs.
- **System messages:** prefix `*(system)*`, body shows the protocol
  subtype + extras.

## Limits

- The CLI reads everything for a chat in memory (default cap 100k
  messages, configurable via `RenderInput.limit`). Comfortably handles
  tens of thousands of messages; for larger archives, paginate by
  passing a smaller `limit` and a date range filter (not yet a CLI flag).
- Output is one file per chat (no per-day splits).
- Times are rendered as UTC. Locale-aware rendering is a TODO.

## Programmatic use

`src/render/index.ts` re-exports `renderConversation`,
`resolveTarget`, `fetchAccount`, and `buildNameDirectory`. You can call
`renderConversation({ target: '+359…', limit: 5000 })` from another
script to get `{ markdown, target, account, messageCount }` without
writing a file.
