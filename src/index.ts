import { Bot } from './bot.js'
import { closeDb, verifyDb } from './db/index.js'
import { logger } from './logger.js'

const main = async (): Promise<void> => {
	await verifyDb()

	const bot = new Bot()

	const shutdown = async (signal: string): Promise<void> => {
		logger.info({ signal }, 'received shutdown signal')
		await bot.stop()
		await closeDb().catch(err => logger.warn({ err }, 'error closing DB pool (ignored)'))
		process.exit(0)
	}

	process.on('SIGINT', () => void shutdown('SIGINT'))
	process.on('SIGTERM', () => void shutdown('SIGTERM'))

	process.on('uncaughtException', err => {
		logger.fatal({ err }, 'uncaughtException')
	})
	process.on('unhandledRejection', err => {
		logger.fatal({ err }, 'unhandledRejection')
	})

	await bot.start()
}

await main()
