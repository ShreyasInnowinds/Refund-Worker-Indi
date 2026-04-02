/**
 * runWorker.ts — CLI entry point for multi-worker queue system
 *
 * Usage (interactive):
 *   npm run start
 *   → Enter batchId: 26-03-2026-7L9A
 *   → Enter number of workers: 3
 *
 * Usage (CLI args):
 *   npm run start -- --batchId=26-03-2026-7L9A --workers=3
 */

import * as readline from "readline";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { ENV } from "../config/env";
import { connectDB, disconnectDB } from "../config/db";
import { runMultiWorkerSystem } from "../services/worker.service";
import { logger } from "../utils/logger";

function askQuestion(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .option("batchId", {
      type: "string",
      describe: "Batch ID to process (e.g., 26-03-2026-7L9A)",
    })
    .option("workers", {
      type: "number",
      describe: "Number of parallel workers (default: 3)",
    })
    .strict()
    .help()
    .parseAsync();

  // Get batchId — from CLI arg or interactive prompt
  let batchId = argv.batchId;
  if (!batchId) {
    batchId = await askQuestion("Enter batchId: ");
  }
  if (!batchId) {
    logger.error("batchId is required");
    process.exitCode = 1;
    return;
  }

  // Get worker count — from CLI arg or interactive prompt
  let workerCount = argv.workers;
  if (!workerCount) {
    const input = await askQuestion("Enter number of workers (default 3): ");
    workerCount = parseInt(input, 10) || 3;
  }
  if (workerCount < 1 || workerCount > 10) {
    logger.error("Worker count must be between 1 and 10");
    process.exitCode = 1;
    return;
  }

  logger.info(`CLI started — batchId: ${batchId} | workers: ${workerCount}`);
  logger.info(`MongoDB: ${ENV.MONGO_URI}/${ENV.DB_NAME}`);
  logger.info(`Headless: ${ENV.BROWSER_HEADLESS} | MaxRetries: ${ENV.MAX_RETRIES}`);

  try {
    // Connect to MongoDB
    await connectDB();

    // Run multi-worker system
    await runMultiWorkerSystem(batchId, workerCount);

    logger.info("All workers completed successfully");
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
