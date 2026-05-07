import { BufferJSON } from 'baileys'

/**
 * Serializes any Baileys event payload (which may contain Buffers, Longs, etc.)
 * into a plain JSON-safe object suitable for `JSONB` columns.
 *
 * Round-trip with `revive()` reproduces the original object including Buffers.
 */
export const serializeForJsonb = <T>(value: T): unknown => {
	if (value === undefined || value === null) return null
	return JSON.parse(JSON.stringify(value, BufferJSON.replacer))
}

/** Inverse of `serializeForJsonb` — restores Buffers from `{type:'Buffer',...}` shape. */
export const reviveFromJsonb = <T>(value: unknown): T => {
	return JSON.parse(JSON.stringify(value), BufferJSON.reviver) as T
}
