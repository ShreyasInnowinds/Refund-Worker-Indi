import mongoose, { Schema, Document } from "mongoose";
import { logger } from "../utils/logger";

// ── Types ────────────────────────────────────────────────────────────────────

export interface IRefundWorker extends Document {
  name: string;
  seq: number;
  assignedBatch: string;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
}

// ── Schema ───────────────────────────────────────────────────────────────────

const refundWorkerSchema = new Schema(
  {
    name: { type: String, required: true },
    seq: { type: Number, required: true },
    assignedBatch: { type: String, required: true },
    status: {
      type: String,
      enum: ["IDEL", "IN_PROGRESS", "COMPLETED", "FAILED"],
      default: "IDEL",
    },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { collection: "refund_worker", timestamps: false }
);

refundWorkerSchema.index({ name: 1 }, { unique: true });

const RefundWorkerModel = mongoose.model<IRefundWorker>(
  "RefundWorker",
  refundWorkerSchema
);

// ── Repository ───────────────────────────────────────────────────────────────

export class RefundWorkerRepo {
  /**
   * Look up a worker by name.
   */
  async fetchByName(name: string): Promise<IRefundWorker | null> {
    const worker = await RefundWorkerModel.findOne({ name }).lean<IRefundWorker>();
    if (worker) {
      logger.info(
        `Found worker: ${name} | assignedBatch: ${worker.assignedBatch} | status: ${worker.status}`
      );
    } else {
      logger.error(`Worker not found: ${name}`);
    }
    return worker;
  }

  /**
   * Mark worker as IN_PROGRESS and set startedAt.
   */
  async markInProgress(workerId: string): Promise<void> {
    await RefundWorkerModel.updateOne(
      { _id: workerId },
      { $set: { status: "IN_PROGRESS", startedAt: new Date() } }
    );
    logger.info(`Worker ${workerId} status → IN_PROGRESS`);
  }

  /**
   * Mark worker as COMPLETED and set completedAt.
   */
  async markCompleted(workerId: string): Promise<void> {
    await RefundWorkerModel.updateOne(
      { _id: workerId },
      { $set: { status: "COMPLETED", completedAt: new Date() } }
    );
    logger.info(`Worker ${workerId} status → COMPLETED`);
  }

  /**
   * Mark worker as FAILED and set completedAt.
   */
  async markFailed(workerId: string): Promise<void> {
    await RefundWorkerModel.updateOne(
      { _id: workerId },
      { $set: { status: "FAILED", completedAt: new Date() } }
    );
    logger.info(`Worker ${workerId} status → FAILED`);
  }
}
