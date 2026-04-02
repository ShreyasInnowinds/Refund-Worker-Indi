/**
 * migrateItnry.ts — One-time migration script
 *
 * Migrates the itnry collection:
 *   1. Renames "WorkerStatus" → "refundWorkerStatus"
 *   2. Adds "lockedBy: null" to all documents
 *
 * Usage:
 *   npx ts-node src/scripts/migrateItnry.ts
 */

import { connectDB, disconnectDB } from "../config/db";
import mongoose from "mongoose";
import { logger } from "../utils/logger";

async function migrate(): Promise<void> {
  await connectDB();

  const db = mongoose.connection.db;
  if (!db) {
    throw new Error("Database connection not available");
  }

  const collection = db.collection("itnry");

  // Step 1: Rename WorkerStatus → refundWorkerStatus
  const renameResult = await collection.updateMany(
    { WorkerStatus: { $exists: true } },
    { $rename: { WorkerStatus: "refundWorkerStatus" } }
  );
  logger.info(
    `Renamed WorkerStatus → refundWorkerStatus: ${renameResult.modifiedCount} documents updated`
  );

  // Step 2: Add lockedBy field where it doesn't exist
  const addFieldResult = await collection.updateMany(
    { lockedBy: { $exists: false } },
    { $set: { lockedBy: null } }
  );
  logger.info(
    `Added lockedBy field: ${addFieldResult.modifiedCount} documents updated`
  );

  await disconnectDB();
  logger.info("Migration complete");
}

migrate().catch((err) => {
  logger.error(`Migration failed: ${err.message}`);
  process.exit(1);
});
