import { connectDB, closeDB, getDB } from "../config/db";
import { ItnryRepo } from "../repositories/itnry.repo";
import mongoose from "mongoose";
import { logger } from "../utils/logger";

async function debug() {
  const batchId = process.argv[2] || "29-04-2026-PNEU";
  const URI = process.env.MONGO_URI || "mongodb://localhost:27017";
  const dbName = process.env.DB_NAME || "tvc_prod";

  await connectDB(URI, dbName);
  const db = getDB();

  logger.info(`Connected DB name: ${db.databaseName}`);

  const col = db.collection("itnry");
  const total = await col.countDocuments({});
  const withBatch = await col.countDocuments({ batchId });
  const fullMatch = await col.countDocuments({
    batchId,
    Status: "NoShow",
    refundWorkerStatus: "NEW",
    isToShowTaxRefund: true,
  });
  const distinctAll = await col.distinct("batchId");

  logger.info(`itnry total                                        : ${total}`);
  logger.info(`itnry batchId="${batchId}"                         : ${withBatch}`);
  logger.info(`itnry FULL match (filter used by fetchAndLockTask) : ${fullMatch}`);
  logger.info(`distinct batchId values: ${JSON.stringify(distinctAll)}`);

  const repo = new ItnryRepo();
  const task = await repo.fetchAndLockTask(batchId, "debug-probe");
  logger.info(
    `repo.fetchAndLockTask returned: ${task ? `PNR=${task.pnr} (_id=${task._id})` : "null"}`
  );

  // Roll back the probe's lock through Mongoose so the real worker can pick it up.
  if (task) {
    const ItnryModel = mongoose.connection.model("itnry");
    await ItnryModel.updateOne(
      { _id: task._id },
      { $set: { refundWorkerStatus: "NEW", lockedBy: null, lockedAt: null } }
    );
    logger.info(`Rolled back probe lock on PNR ${task.pnr}`);
  }

  await closeDB();
}

debug().catch((err) => {
  logger.error(`debug failed: ${err.message}\n${err.stack}`);
  process.exit(1);
});
