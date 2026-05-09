import { readFileSync } from 'node:fs'

import { cert, getApp, getApps, initializeApp, type App } from 'firebase-admin/app'
import { getDownloadURL, getStorage } from 'firebase-admin/storage'
import type { ServiceAccount } from 'firebase-admin'

import type { FirebaseConfig } from '../../config.js'
import { childLogger } from '../../logger.js'

const log = childLogger('store:media:storage')

export interface PutInput {
	readonly key: string
	readonly contentType: string
	readonly bytes: Buffer
	readonly metadata?: Record<string, string | number | undefined>
}

export interface PutResult {
	readonly bucket: string
	readonly object: string
	readonly sizeBytes: number
	readonly contentType: string
	/** A token-bearing public download URL, when the backend can produce one. */
	readonly downloadUrl: string | null
}

export interface MediaStorage {
	readonly kind: 'firebase' | 'noop'
	readonly bucketName: string | null
	put(input: PutInput): Promise<PutResult>
	exists(object: string): Promise<boolean>
	/** Download an object's bytes from storage. Used by AI processors that need raw data. */
	download(object: string): Promise<Buffer>
	/** Build a gs:// URI for this object. Used by Gemini for direct GCS access. */
	gcsUri(object: string): string | null
}

/**
 * Lazily initialize a single Firebase Admin app per process. Calls beyond the
 * first are a no-op — Firebase already throws if you try to init twice with
 * the same name, so we explicitly check `getApps()`.
 */
const ensureFirebaseApp = (cfg: FirebaseConfig): App => {
	const existing = getApps()
	if (existing.length > 0) return getApp()

	let credential: ReturnType<typeof cert> | undefined
	if (cfg.serviceAccountPath) {
		try {
			const raw = readFileSync(cfg.serviceAccountPath, 'utf8')
			credential = cert(JSON.parse(raw) as ServiceAccount)
		} catch (err) {
			throw new Error(
				`Failed to read FIREBASE_SERVICE_ACCOUNT_PATH=${cfg.serviceAccountPath}: ${(err as Error).message}`
			)
		}
	} else if (cfg.serviceAccountJson) {
		try {
			credential = cert(JSON.parse(cfg.serviceAccountJson) as ServiceAccount)
		} catch (err) {
			throw new Error(
				`Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON: ${(err as Error).message}`
			)
		}
	}
	// else: fall through to Application Default Credentials
	// (GOOGLE_APPLICATION_CREDENTIALS, gcloud login, GCE metadata, etc.)

	return initializeApp({
		...(credential ? { credential } : {}),
		...(cfg.projectId ? { projectId: cfg.projectId } : {}),
		storageBucket: cfg.storageBucket
	})
}

class FirebaseStorage implements MediaStorage {
	readonly kind = 'firebase'
	readonly bucketName: string

	constructor(private readonly cfg: FirebaseConfig) {
		ensureFirebaseApp(cfg)
		this.bucketName = cfg.storageBucket
	}

	async put({ key, contentType, bytes, metadata }: PutInput): Promise<PutResult> {
		const file = getStorage().bucket(this.bucketName).file(key)
		// Filter out undefined metadata values; GCS rejects them.
		const customMetadata: Record<string, string> = {}
		if (metadata) {
			for (const [k, v] of Object.entries(metadata)) {
				if (v !== undefined && v !== null && v !== '') customMetadata[k] = String(v)
			}
		}
		await file.save(bytes, {
			resumable: false,
			contentType,
			metadata: {
				contentType,
				cacheControl: 'public, max-age=31536000, immutable',
				metadata: customMetadata
			}
		})

		let downloadUrl: string | null = null
		try {
			downloadUrl = await getDownloadURL(file)
		} catch (err) {
			log.warn({ err, key }, 'getDownloadURL failed; saving object without public URL')
		}

		return {
			bucket: this.bucketName,
			object: key,
			sizeBytes: bytes.byteLength,
			contentType,
			downloadUrl
		}
	}

	async exists(object: string): Promise<boolean> {
		const [exists] = await getStorage().bucket(this.bucketName).file(object).exists()
		return exists
	}

	async download(object: string): Promise<Buffer> {
		const [buffer] = await getStorage().bucket(this.bucketName).file(object).download()
		return buffer
	}

	gcsUri(object: string): string | null {
		return `gs://${this.bucketName}/${object}`
	}
}

class NoopStorage implements MediaStorage {
	readonly kind = 'noop'
	readonly bucketName = null

	async put(): Promise<PutResult> {
		throw new Error(
			'Media storage is disabled. Set FIREBASE_STORAGE_BUCKET (and credentials) to enable uploads.'
		)
	}
	async exists(): Promise<boolean> {
		return false
	}
	async download(): Promise<Buffer> {
		throw new Error('Media storage is disabled.')
	}
	gcsUri(): string | null {
		return null
	}
}

export const buildMediaStorage = (firebase: FirebaseConfig | null): MediaStorage => {
	if (!firebase) {
		log.info('media storage: noop (no FIREBASE_STORAGE_BUCKET configured)')
		return new NoopStorage()
	}
	try {
		const storage = new FirebaseStorage(firebase)
		log.info({ bucket: firebase.storageBucket }, 'media storage: firebase ready')
		return storage
	} catch (err) {
		log.error(
			{ err, bucket: firebase.storageBucket },
			'media storage: firebase init failed — running in noop mode. Media will stay in `pending` until credentials are fixed and the bot is restarted.'
		)
		return new NoopStorage()
	}
}
