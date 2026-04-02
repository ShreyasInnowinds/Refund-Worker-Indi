/**
 * runWorker.ts — CLI entry point
 *
 * Usage:
 *   npm run start -- --workerName=26-03-2026-7L9A-w1
 *
 * or after build:
 *   node dist/scripts/runWorker.js --workerName=26-03-2026-7L9A-w1
 */

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { ENV } from "../config/env";
import { connectDB, disconnectDB } from "../config/db";
import { runRefundWorker } from "../services/worker.service";
import { logger } from "../utils/logger";

async function main(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .option("workerName", {
      type: "string",
      demandOption: true,
      describe: "Worker name from refund_worker collection (e.g., 26-03-2026-7L9A-w1)",
    })
    .strict()
    .help()
    .parseAsync();

  const workerName = argv.workerName;

  logger.info(`CLI started with workerName: ${workerName}`);
  logger.info(`MongoDB: ${ENV.MONGO_URI}/${ENV.DB_NAME}`);
  logger.info(`Headless: ${ENV.BROWSER_HEADLESS} | MaxRetries: ${ENV.MAX_RETRIES}`);

  try {
    // Connect to MongoDB
    await connectDB();

    // Run the worker
    await runRefundWorker(workerName);

    logger.info("Worker completed successfully");
  } catch (error: any) {
    logger.error(`Fatal error: ${error.message}`, { stack: error.stack });
    process.exitCode = 1;
  } finally {
    // Always disconnect MongoDB
    await disconnectDB();
    logger.info("Shutdown complete");
  }
}

main();
