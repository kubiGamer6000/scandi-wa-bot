import { createHmac } from 'node:crypto'

/**
 * Compute the canonical signature payload — `{timestamp}.{body}` — and
 * HMAC-SHA256 it with the per-subscription secret. Stripe-style format so
 * consumers can pin against a familiar pattern.
 *
 * Returned header value is `sha256=<hex>` (matches GitHub's webhook style
 * and is unambiguous about the algo).
 */
export const computeWebhookSignature = (
	secret: string,
	timestampSec: number,
	rawBody: string
): string => {
	const h = createHmac('sha256', secret)
	h.update(`${timestampSec}.${rawBody}`)
	return `sha256=${h.digest('hex')}`
}
