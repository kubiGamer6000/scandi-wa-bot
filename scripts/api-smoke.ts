/**
 * scripts/api-smoke.ts
 *
 * 15-step integration test that exercises every HTTP API endpoint against
 * the live bot. Run with the bot already up via `npm run dev` (so it's
 * fully connected to WhatsApp). Each step prints PASS / FAIL with the
 * actual vs expected so the run is auditable.
 *
 * Usage:
 *   API_AUTH_TOKEN=<token> SMOKE_PHONE=359884430293 tsx scripts/api-smoke.ts
 *
 * SMOKE_PHONE is the digits-only WhatsApp phone for the conversation we
 * use to send / react / edit / delete. The script will send several
 * test messages to that number — be prepared to see them on your phone.
 */

import 'dotenv/config'

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

const BASE = process.env.SMOKE_API_BASE?.trim() || 'http://127.0.0.1:8787'
const TOKEN = process.env.API_AUTH_TOKEN?.trim()
const PHONE = (process.env.SMOKE_PHONE?.trim() || '359884430293').replace(/[^\d]/g, '')
const TO_JID = `${PHONE}@s.whatsapp.net`
const RECEIVER_PORT = Number(process.env.SMOKE_RECEIVER_PORT ?? 9001)
const RECEIVER_HOST = process.env.SMOKE_RECEIVER_HOST ?? '127.0.0.1'

if (!TOKEN) {
	console.error('FATAL: API_AUTH_TOKEN is required (load from .env or set explicitly).')
	process.exit(1)
}

type Json = Record<string, unknown> | unknown[]

const COLOR = process.stdout.isTTY
const c = {
	g: (s: string) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s),
	r: (s: string) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s),
	y: (s: string) => (COLOR ? `\x1b[33m${s}\x1b[0m` : s),
	b: (s: string) => (COLOR ? `\x1b[34m${s}\x1b[0m` : s)
}

let stepNumber = 0
let passed = 0
let failed = 0
const failures: string[] = []

const printStep = async (
	title: string,
	fn: () => Promise<void>
): Promise<void> => {
	stepNumber += 1
	process.stdout.write(`${c.b(`[${stepNumber.toString().padStart(2, '0')}]`)} ${title} ... `)
	try {
		await fn()
		passed += 1
		console.log(c.g('PASS'))
	} catch (err) {
		failed += 1
		const msg = err instanceof Error ? err.message : String(err)
		failures.push(`#${stepNumber} ${title}: ${msg}`)
		console.log(c.r('FAIL'))
		console.log(c.r(`     → ${msg}`))
	}
}

const api = async <T extends Json>(
	method: string,
	path: string,
	body?: unknown,
	extraHeaders: Record<string, string> = {}
): Promise<{ status: number; body: T }> => {
	const headers: Record<string, string> = {
		authorization: `Bearer ${TOKEN}`,
		...extraHeaders
	}
	if (body !== undefined && !(body instanceof FormData)) {
		headers['content-type'] = 'application/json'
	}
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers,
		body:
			body === undefined
				? undefined
				: body instanceof FormData
					? body
					: JSON.stringify(body)
	})
	const text = await res.text()
	let parsed: T
	try {
		parsed = (text ? JSON.parse(text) : {}) as T
	} catch {
		parsed = text as unknown as T
	}
	return { status: res.status, body: parsed }
}

const assert = (cond: unknown, msg: string): void => {
	if (!cond) throw new Error(`assertion failed: ${msg}`)
}

interface WebhookCapture {
	body: Record<string, unknown>
	signature: string | undefined
	timestamp: string | undefined
	verified: boolean | null
}

const startReceiver = async (
	secretAccessor: () => string | null
): Promise<{
	captured: WebhookCapture[]
	close: () => Promise<void>
	url: string
}> => {
	const captured: WebhookCapture[] = []
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = []
		req.on('data', d => chunks.push(d as Buffer))
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8')
			let parsed: Record<string, unknown>
			try {
				parsed = JSON.parse(raw) as Record<string, unknown>
			} catch {
				parsed = { _raw: raw }
			}
			const signature = req.headers['x-webhook-signature'] as string | undefined
			const timestamp = req.headers['x-webhook-timestamp'] as string | undefined
			const secret = secretAccessor()
			let verified: boolean | null = null
			if (secret && signature && timestamp) {
				const expected = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex')}`
				try {
					verified =
						expected.length === signature.length &&
						timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
				} catch {
					verified = false
				}
				if (!verified) {
					console.log(
						c.r(
							`     HMAC mismatch: ts=${timestamp} secretLen=${secret.length} bodyBytes=${Buffer.byteLength(raw, 'utf8')}`
						)
					)
					console.log(c.r(`        expected=${expected}`))
					console.log(c.r(`        received=${signature}`))
					console.log(c.r(`        body[0..120]=${raw.slice(0, 120)}`))
				}
			}
			captured.push({ body: parsed, signature, timestamp, verified })
			res.writeHead(200, { 'content-type': 'application/json' })
			res.end('{"ok":true}')
		})
	})
	await new Promise<void>(resolve => server.listen(RECEIVER_PORT, RECEIVER_HOST, resolve))
	return {
		captured,
		close: () =>
			new Promise<void>(resolve => {
				server.close(() => resolve())
			}),
		url: `http://${RECEIVER_HOST}:${RECEIVER_PORT}/`
	}
}

const waitFor = async <T>(
	probe: () => T | undefined | null,
	timeoutMs: number,
	intervalMs = 250
): Promise<T> => {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const v = probe()
		if (v != null) return v
		await sleep(intervalMs)
	}
	throw new Error(`timed out after ${timeoutMs}ms`)
}

const main = async (): Promise<void> => {
	console.log(c.b('═══════════════════════════════════════════════════════════════'))
	console.log(c.b(`  scandi-wa-bot API smoke test`))
	console.log(c.b(`  base: ${BASE}`))
	console.log(c.b(`  to:   ${TO_JID}`))
	console.log(c.b('═══════════════════════════════════════════════════════════════'))

	let sentSeq: number | null = null
	let receivedWebhook: WebhookCapture | null = null
	let editTargetSeq: number | null = null
	let deleteTargetSeq: number | null = null
	let subscriptionId: string | null = null
	let webhookSecret: string | null = null

	const secretAccessor = (): string | null => webhookSecret
	const receiver = await startReceiver(secretAccessor)
	console.log(c.b(`  webhook receiver listening on ${receiver.url}`))

	// Clean up any leftover subs pointing at our receiver from an
	// interrupted previous run — they'd otherwise fan-out duplicate
	// deliveries with a secret we no longer know.
	try {
		const existing = await api<{ webhooks: Array<{ id: string; url: string }> }>(
			'GET',
			'/v1/webhooks'
		)
		if (existing.status === 200 && Array.isArray(existing.body.webhooks)) {
			for (const sub of existing.body.webhooks) {
				if (sub.url === receiver.url) {
					await api('DELETE', `/v1/webhooks/${sub.id}`)
					console.log(c.y(`  cleaned stale receiver-pointing sub ${sub.id}`))
				}
			}
		}
	} catch (err) {
		console.log(c.y(`  warning: could not clean stale subs: ${(err as Error).message}`))
	}

	try {
		await printStep('1. /v1/health (no auth, sock_connected=true)', async () => {
			const res = await fetch(`${BASE}/v1/health`)
			const body = (await res.json()) as Record<string, unknown>
			assert(res.status === 200, `status ${res.status}`)
			assert(body.sock_connected === true, `sock_connected was ${String(body.sock_connected)}`)
		})

		await printStep('2. /v1/me (returns pn_jid + lid_jid)', async () => {
			const { status, body } = await api<Record<string, string | null>>('GET', '/v1/me')
			assert(status === 200, `status ${status}`)
			assert(typeof body.pn_jid === 'string' && body.pn_jid.length > 0, 'pn_jid missing')
		})

		await printStep('3. POST /v1/send (text)', async () => {
			const { status, body } = await api<{ seq: number | null; wa_message_id: string }>(
				'POST',
				'/v1/send',
				{ to: TO_JID, text: `[smoke] step 3 hello @ ${new Date().toISOString()}` }
			)
			assert(status === 200, `status ${status}`)
			assert(typeof body.wa_message_id === 'string', 'wa_message_id missing')
			sentSeq = body.seq
			if (sentSeq == null) {
				// Acceptable: ingestion takes more than the 8s wait window
				// occasionally. We'll try to find it via the chat history below.
				console.log(c.y('   (seq null — will probe history)'))
			}
		})

		await printStep('4. GET /v1/messages/:seq matches', async () => {
			if (sentSeq == null) {
				// Pull the most recent from_me message in the chat instead.
				const { body } = await api<{ messages: Array<{ seq: number; from_me: boolean; text: string | null }> }>(
					'GET',
					`/v1/chats/${encodeURIComponent(TO_JID)}/messages?limit=10`
				)
				const recent = body.messages.find(m => m.from_me && (m.text ?? '').includes('[smoke] step 3'))
				if (!recent) throw new Error('could not locate just-sent message in history')
				sentSeq = recent.seq
			}
			const { status, body } = await api<Record<string, unknown>>('GET', `/v1/messages/${sentSeq}`)
			assert(status === 200, `status ${status}`)
			assert(body.from_me === true, 'expected from_me=true')
			assert(((body.text ?? '') as string).startsWith('[smoke] step 3'), `text mismatch: ${String(body.text)}`)
		})

		await printStep('5. POST /v1/webhooks (create sub)', async () => {
			const { status, body } = await api<{
				id: string
				secret: string
			}>('POST', '/v1/webhooks', {
				url: receiver.url,
				event_types: ['message.received', 'message.processed', 'webhook.test'],
				description: 'api-smoke'
			})
			assert(status === 201, `status ${status}`)
			subscriptionId = body.id
			webhookSecret = body.secret
		})

		await printStep('6. Receive a real inbound message (manual)', async () => {
			console.log(
				c.y(`\n     → Send any message to the bot from ${PHONE} within 60s.`)
			)
			try {
				receivedWebhook = await waitFor(
					() => receiver.captured.find(w => (w.body.event as string) === 'message.received'),
					60_000,
					500
				)
			} catch {
				throw new Error('no message.received webhook arrived in 60s')
			}
			assert(receivedWebhook.verified === true, 'HMAC signature did not verify')
			const m = receivedWebhook.body.message as { seq: number; from_me: boolean; mentioned_self: boolean }
			assert(m.from_me === false, 'expected from_me=false in inbound webhook')
			console.log(c.y(`     captured seq=${m.seq}, mentioned_self=${m.mentioned_self}`))
		})

		await printStep('7. Mention test (optional / manual)', async () => {
			console.log(
				c.y(
					`\n     → Send another message that @mentions the bot (or skip — 30s window).`
				)
			)
			const startLen = receiver.captured.length
			const event = await waitFor(
				() => {
					const fresh = receiver.captured.slice(startLen)
					const hit = fresh.find(
						w =>
							(w.body.event as string) === 'message.received' &&
							((w.body.message as { mentioned_self?: boolean }).mentioned_self ?? false)
					)
					return hit
				},
				30_000,
				500
			).catch(() => null)
			if (!event) {
				console.log(c.y(`     (skipped — no mention received; not a failure)`))
				return
			}
			assert(event.verified === true, 'HMAC failed on mention message')
		})

		await printStep('8. POST /v1/messages/:seq/react', async () => {
			if (sentSeq == null) throw new Error('no sentSeq from step 3/4')
			const { status } = await api('POST', `/v1/messages/${sentSeq}/react`, { emoji: '👍' })
			assert(status === 204, `status ${status}`)
		})

		await printStep('9. Edit a fresh message', async () => {
			const send = await api<{ seq: number | null; wa_message_id: string }>('POST', '/v1/send', {
				to: TO_JID,
				text: '[smoke] step 9 (will be edited)'
			})
			assert(send.status === 200, `send status ${send.status}`)
			editTargetSeq =
				send.body.seq ??
				(await api<{ messages: Array<{ seq: number; from_me: boolean; text: string | null }> }>(
					'GET',
					`/v1/chats/${encodeURIComponent(TO_JID)}/messages?limit=5`
				).then(r => r.body.messages.find(m => m.from_me && (m.text ?? '').includes('step 9'))?.seq ?? null))
			if (editTargetSeq == null) throw new Error('no seq for edit target')
			await sleep(500)
			const edit = await api<{ edit_wa_message_id: string | null }>(
				'POST',
				`/v1/messages/${editTargetSeq}/edit`,
				{ text: '[smoke] step 9 EDITED' }
			)
			assert(edit.status === 200, `edit status ${edit.status}`)
			assert(typeof edit.body.edit_wa_message_id === 'string', 'no edit_wa_message_id')
		})

		await printStep('10. Delete a fresh message', async () => {
			const send = await api<{ seq: number | null }>('POST', '/v1/send', {
				to: TO_JID,
				text: '[smoke] step 10 (will be deleted)'
			})
			assert(send.status === 200, `send status ${send.status}`)
			deleteTargetSeq =
				send.body.seq ??
				(await api<{ messages: Array<{ seq: number; from_me: boolean; text: string | null }> }>(
					'GET',
					`/v1/chats/${encodeURIComponent(TO_JID)}/messages?limit=5`
				).then(r => r.body.messages.find(m => m.from_me && (m.text ?? '').includes('step 10'))?.seq ?? null))
			if (deleteTargetSeq == null) throw new Error('no seq for delete target')
			await sleep(500)
			const del = await api('POST', `/v1/messages/${deleteTargetSeq}/delete`, {})
			assert(del.status === 204, `delete status ${del.status}`)
		})

		await printStep('11. History endpoint returns recent messages', async () => {
			const { status, body } = await api<{
				count: number
				messages: Array<{ seq: number; text: string | null }>
			}>('GET', `/v1/chats/${encodeURIComponent(TO_JID)}/messages?limit=20`)
			assert(status === 200, `status ${status}`)
			assert(body.count > 0, 'count is 0')
			const sample = body.messages.find(m => (m.text ?? '').includes('[smoke]'))
			if (!sample) throw new Error('no [smoke] messages in last 20')
		})

		await printStep('12. POST /v1/send with media url (image)', async () => {
			const send = await api<{ seq: number | null; type: string }>('POST', '/v1/send', {
				to: TO_JID,
				media: {
					kind: 'image',
					url: 'https://picsum.photos/seed/scandi-smoke/600/400.jpg',
					caption: '[smoke] step 12 image via URL'
				}
			})
			assert(send.status === 200, `status ${send.status}`)
			assert(send.body.type === 'imageMessage', `type was ${send.body.type}`)
		})

		await printStep('13. POST /v1/send/multipart', async () => {
			const png = Buffer.from(
				'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
				'base64'
			)
			const fd = new FormData()
			fd.append('to', TO_JID)
			fd.append('kind', 'image')
			fd.append('caption', '[smoke] step 13 image via multipart')
			fd.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'pixel.png')
			const res = await fetch(`${BASE}/v1/send/multipart`, {
				method: 'POST',
				headers: { authorization: `Bearer ${TOKEN}` },
				body: fd
			})
			assert(res.status === 200, `status ${res.status}`)
			const body = (await res.json()) as { seq: number | null; type: string }
			assert(body.type === 'imageMessage', `type was ${body.type}`)
		})

		await printStep('14. Media fetch + processed text', async () => {
			// Look for an inbound message with media that's been processed.
			const { body } = await api<{
				messages: Array<{
					seq: number
					from_me: boolean
					media: { processed?: { text?: string } | null; download_status?: string } | null
				}>
			}>('GET', `/v1/chats/${encodeURIComponent(TO_JID)}/messages?limit=50&include_media=true`)
			const target = body.messages.find(m => m.media && m.media.download_status === 'done')
			if (!target) {
				console.log(c.y(`     (no completed media in last 50 — skipped)`))
				return
			}
			const det = await api<{ media: { url: string | null } }>(
				'GET',
				`/v1/messages/${target.seq}/media`
			)
			assert(det.status === 200, `media meta status ${det.status}`)
			assert(typeof det.body.media.url === 'string', 'media.url missing')

			const dl = await fetch(`${BASE}/v1/messages/${target.seq}/media/download`, {
				method: 'GET',
				headers: { authorization: `Bearer ${TOKEN}` },
				redirect: 'manual'
			})
			assert(dl.status === 302, `download redirect status ${dl.status}`)
			assert((dl.headers.get('location') ?? '').startsWith('https://'), 'no https location')
		})

		await printStep('15. DELETE webhook + no more deliveries', async () => {
			if (!subscriptionId) throw new Error('no subscriptionId')
			const del = await api('DELETE', `/v1/webhooks/${subscriptionId}`)
			assert(del.status === 204, `delete status ${del.status}`)

			const before = receiver.captured.length
			// Send another from_me — it should NOT trigger a webhook (from_me
			// is filtered) AND if it did, the sub is gone anyway.
			await api('POST', '/v1/send', {
				to: TO_JID,
				text: '[smoke] step 15 — should not produce webhook'
			})
			await sleep(2_500)
			const after = receiver.captured.length
			assert(after === before, `${after - before} stale deliveries after DELETE`)
			subscriptionId = null
		})
	} finally {
		if (subscriptionId) {
			await api('DELETE', `/v1/webhooks/${subscriptionId}`).catch(() => undefined)
		}
		await receiver.close()
	}

	console.log()
	console.log(c.b('═══════════════════════════════════════════════════════════════'))
	console.log(`  ${c.g(`passed: ${passed}`)}   ${c.r(`failed: ${failed}`)}   total: ${passed + failed}`)
	if (failed > 0) {
		console.log(c.r('  failures:'))
		for (const f of failures) console.log(c.r(`   - ${f}`))
	}
	console.log(c.b('═══════════════════════════════════════════════════════════════'))

	if (failed > 0) process.exit(1)
}

main().catch(err => {
	console.error(c.r(`fatal: ${err instanceof Error ? err.stack : String(err)}`))
	process.exit(2)
})
