import pino, { type Logger } from 'pino'

import { config } from './config.js'

/**
 * Root pino logger.
 *
 * In development we attach `pino-pretty` for human-friendly colored output.
 * In production we emit raw NDJSON so logs can be ingested by anything
 * (journald, Loki, Datadog, etc.) without further processing.
 */
const isDev = process.env.NODE_ENV !== 'production'

export const logger: Logger = pino({
	level: config.logLevel,
	base: { service: 'scandi-wa-bot' },
	...(isDev
		? {
				transport: {
					target: 'pino-pretty',
					options: {
						colorize: true,
						translateTime: 'SYS:HH:MM:ss.l',
						ignore: 'pid,hostname,service'
					}
				}
			}
		: {})
})

/** Returns a child logger scoped to a specific module. */
export const childLogger = (module: string): Logger => logger.child({ module })
