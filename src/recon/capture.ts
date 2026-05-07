import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { BufferJSON, type BaileysEventMap } from 'baileys'

import { childLogger } from '../logger.js'

const log = childLogger('recon:capture')

/**
 * Append-only JSONL writer per event family.
 *
 * Every captured line is `{ ts, event, data }` serialized with Baileys'
 * `BufferJSON.replacer` so any `Buffer` / `Uint8Array` / `Long` round-trips
 * cleanly. We will read these dumps later via `BufferJSON.reviver`.
 *
 * One file per event keeps things easy to grep, easy to count, and means we
 * can `tail -f` whichever event we care about while it's running.
 */
export class ReconCapture {
	private readonly streams = new Map<string, WriteStream>()
	private readonly counts = new Map<string, number>()
	private readonly startedAt = new Date()
	private finalized = false

	constructor(private readonly dir: string) {}

	async init(): Promise<void> {
		await mkdir(this.dir, { recursive: true })
		log.info({ dir: this.dir }, 'recon dump dir ready')
	}

	private getStream(event: string): WriteStream {
		let s = this.streams.get(event)
		if (!s) {
			const fname = `${event.replace(/[^\w.-]/g, '_')}.jsonl`
			s = createWriteStream(join(this.dir, fname), { flags: 'a' })
			this.streams.set(event, s)
		}
		return s
	}

	capture<E extends keyof BaileysEventMap>(event: E, data: BaileysEventMap[E]): void {
		if (this.finalized) return
		const line = JSON.stringify(
			{ ts: new Date().toISOString(), event, data },
			BufferJSON.replacer
		)
		this.getStream(event).write(`${line}\n`)
		this.counts.set(event, (this.counts.get(event) ?? 0) + 1)
	}

	totalEvents(): number {
		let n = 0
		for (const v of this.counts.values()) n += v
		return n
	}

	countOf(event: string): number {
		return this.counts.get(event) ?? 0
	}

	snapshotCounts(): Record<string, number> {
		return Object.fromEntries(this.counts)
	}

	async finalize(): Promise<void> {
		if (this.finalized) return
		this.finalized = true

		const closes = [...this.streams.values()].map(
			s => new Promise<void>(resolve => s.end(() => resolve()))
		)
		await Promise.all(closes)

		const manifest = {
			startedAt: this.startedAt.toISOString(),
			finishedAt: new Date().toISOString(),
			durationSeconds: Math.round((Date.now() - this.startedAt.getTime()) / 1000),
			totalEvents: this.totalEvents(),
			countsByEvent: this.snapshotCounts()
		}
		await writeFile(join(this.dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
		log.info({ manifest }, 'recon manifest written')
	}
}
