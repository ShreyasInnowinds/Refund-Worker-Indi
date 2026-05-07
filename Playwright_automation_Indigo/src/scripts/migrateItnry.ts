/**
 * migrateItnry.ts — Per-batch migration script
 *
 * For a given batchId, ensures every itnry document has:
 *   1. "refundWorkerStatus"  (renamed from "WorkerStatus" if present,
 *                             else set to "NEW" when missing)
 *   2. "lockedBy: null"      (added when missing)
 *
 * Usage (interactive):
 *   npx ts-node src/scripts/migrateItnry.ts
 *   → Enter batchId: 29-04-2026-PNEU
 *
 * Usage (CLI args):
 *   npx ts-node src/scripts/migrateItnry.ts --batchId=29-04-2026-PNEU
 */

import * as readline from "readline";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import mongoose from "mongoose";
import { connectDB, closeDB } from "../config/db";
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

async function migrate(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .option("batchId", {
      type: "string",
      describe: "Batch ID to migrate (e.g., 29-04-2026-PNEU)",
    })
    .strict()
    .help()
    .parseAsync();

  let batchId = argv.batchId;
  if (!batchId) {
    batchId = await askQuestion("Enter batchId: ");
  }
  if (!batchId) {
    logger.error("batchId is required");
    process.exit(1);
  }

  const URI = process.env.MONGO_URI || "mongodb://localhost:27017";
  const dbName = process.env.DB_NAME || "tvc_prod";
  await connectDB(URI, dbName);

  const db = mongoose.connection.db;
  if (!db) {
    throw new Error("Database connection not available");
  }

  const collection = db.collection("itnry");

  const totalInBatch = await collection.countDocuments({ batchId });
  logger.info(`Found ${totalInBatch} documents in batch "${batchId}"`);

  if (totalInBatch === 0) {
    logger.warn("Nothing to migrate — exiting");
    await closeDB();
    return;
  }

  // 1a. Rename WorkerStatus → refundWorkerStatus (only docs in this batch)
  const renameResult = await collection.updateMany(
    { batchId, WorkerStatus: { $exists: true } },
    { $rename: { WorkerStatus: "refundWorkerStatus" } }
  );
  logger.info(
    `Renamed WorkerStatus → refundWorkerStatus: ${renameResult.modifiedCount} document(s)`
  );

  // 1b. Add refundWorkerStatus="NEW" where it still doesn't exist
  // (docs that never had WorkerStatus to rename)
  const addStatusResult = await collection.updateMany(
    { batchId, refundWorkerStatus: { $exists: false } },
    { $set: { refundWorkerStatus: "NEW" } }
  );
  logger.info(
    `Added refundWorkerStatus="NEW": ${addStatusResult.modifiedCount} document(s)`
  );

  // 2. Add lockedBy=null where missing
  const addLockedByResult = await collection.updateMany(
    { batchId, lockedBy: { $exists: false } },
    { $set: { lockedBy: null } }
  );
  logger.info(
    `Added lockedBy=null: ${addLockedByResult.modifiedCount} document(s)`
  );

  // 3. Add isToShowTaxRefund=true where missing (schema default)
  const addIsToShowResult = await collection.updateMany(
    { batchId, isToShowTaxRefund: { $exists: false } },
    { $set: { isToShowTaxRefund: true } }
  );
  logger.info(
    `Added isToShowTaxRefund=true: ${addIsToShowResult.modifiedCount} document(s)`
  );

  await closeDB();
  logger.info(`Migration complete for batchId "${batchId}"`);
}

migrate().catch((err) => {
  logger.error(`Migration failed: ${err.message}`);
  process.exit(1);
});
