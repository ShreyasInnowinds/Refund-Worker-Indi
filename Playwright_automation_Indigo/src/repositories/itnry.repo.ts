import mongoose, { Schema, Document } from "mongoose";
import { logger } from "../utils/logger";

// ── Types ────────────────────────────────────────────────────────────────────

export interface IItnry extends Document {
  pnr: string;
  batchId: string;
  inputName: string | null;
  matchedName: string | null;
  fetchedAt: Date | null;
  Status: string | null;
  isRefundProcessed: boolean;
  isToShowTaxRefund: boolean;
  RefundAmount: number | null;
  Currency: string | null;
  data: any;
  errors: any;
  metadata: any;
  refundWorkerStatus: string;
  lockedBy: string | null;
  lockedAt: Date | null;
  processedAt: Date | null;
  refundStatus: string | null;
  message: string | null;
  Msg_refundAmt: number | null;
}

// ── Schema ───────────────────────────────────────────────────────────────────

const itnrySchema = new Schema(
  {
    pnr: { type: String, required: true },
    batchId: { type: String, required: true },
    inputName: { type: String, default: null },
    matchedName: { type: String, default: null },
    fetchedAt: { type: Date, default: null },
    Status: { type: String, default: null },
    isRefundProcessed: { type: Boolean, default: false },
    isToShowTaxRefund: { type: Boolean, default: true },
    RefundAmount: { type: Number, default: null },
    Currency: { type: String, default: null },
    data: { type: Schema.Types.Mixed, default: {} },
    errors: { type: Schema.Types.Mixed, default: null },
    metadata: { type: Schema.Types.Mixed, default: null },
    refundWorkerStatus: {
      type: String,
      enum: ["NEW", "IN_PROGRESS", "PROCESSING", "PROCESSED", "FAILED"],
      default: "NEW",
    },
    lockedBy: { type: String, default: null },
    lockedAt: { type: Date, default: null },
    processedAt: { type: Date, default: null },
    refundStatus: { type: String, default: null },
    message: { type: String, default: null },
    Msg_refundAmt: { type: Number, default: null },
  },
  { collection: "itnry", timestamps: false }
);

itnrySchema.index({ batchId: 1, Status: 1, refundWorkerStatus: 1 });

const ItnryModel = mongoose.model<IItnry>("itnry", itnrySchema);

// ── Repository ───────────────────────────────────────────────────────────────

export class ItnryRepo {
  /**
   * Fetch all eligible records for a given batchId.
   * Filter: Status=NoShow, refundWorkerStatus IN [NEW, IN_PROGRESS], batchId=batchId
   */
  async fetchEligibleRecords(batchId: string): Promise<IItnry[]> {
    const records = await ItnryModel.find({
      batchId,
      Status: "NoShow",
      refundWorkerStatus: { $in: ["NEW", "IN_PROGRESS"] },
      isToShowTaxRefund: true,
    }).lean<IItnry[]>();

    logger.info(
      `Fetched ${records.length} eligible records for batchId: ${batchId}`
    );
    return records;
  }

  /**
   * Atomically lock a record: set refundWorkerStatus = "IN_PROGRESS"
   * Only locks if current status is NEW (prevents double-pick).
   */
  async lockRecord(recordId: string, workerName: string): Promise<IItnry | null> {
    const locked = await ItnryModel.findOneAndUpdate(
      {
        _id: recordId,
        refundWorkerStatus: "NEW",
        isToShowTaxRefund: true,
      },
      {
        $set: {
          refundWorkerStatus: "IN_PROGRESS",
          lockedBy: workerName,
          lockedAt: new Date(),
        },
      },
      { new: true }
    );

    if (locked) {
      logger.debug(`Locked record: ${locked.pnr} (${recordId}) by ${workerName}`);
    } else {
      logger.warn(`Failed to lock record ${recordId} — already picked up`);
    }
    return locked;
  }

  /**
   * Mark record as PROCESSED after successful automation.
   */
  async markProcessed(
    recordId: string,
    refundStatus: "Refund_Processed" | "Already_Refunded",
    message: string | null,
    msgRefundAmt: number | null
  ): Promise<void> {
    await ItnryModel.updateOne(
      { _id: recordId },
      {
        $set: {
          refundWorkerStatus: "PROCESSED",
          isRefundProcessed: true,
          processedAt: new Date(),
          refundStatus,
          message,
          Msg_refundAmt: msgRefundAmt,
        },
      }
    );
    logger.debug(
      `Marked record ${recordId} as PROCESSED | refundStatus=${refundStatus} | Msg_refundAmt=${msgRefundAmt}`
    );
  }

  /**
   * Atomically fetch and lock ONE eligible task from the queue.
   * Uses findOneAndUpdate so no two workers can pick the same task.
   */
  async fetchAndLockTask(
    batchId: string,
    workerName: string
  ): Promise<IItnry | null> {
    // Pick FAILED records first (re-tries), then NEW.
    // "FAILED" < "NEW" alphabetically, so ascending sort puts them first.
    const task = await ItnryModel.findOneAndUpdate(
      {
        batchId,
        Status: "NoShow",
        refundWorkerStatus: { $in: ["NEW", "FAILED"] },
        isToShowTaxRefund: true,
      },
      {
        $set: {
          refundWorkerStatus: "IN_PROGRESS",
          lockedBy: workerName,
          lockedAt: new Date(),
        },
      },
      { new: true, sort: { refundWorkerStatus: 1 } }
    );

    if (task) {
      logger.debug(
        `Fetched & locked task: PNR=${task.pnr} by ${workerName}`
      );
    }
    return task;
  }

  /**
   * Mark record as FAILED after exhausting retries.
   */
  async markFailed(recordId: string): Promise<void> {
    await ItnryModel.updateOne(
      { _id: recordId },
      {
        $set: {
          refundWorkerStatus: "FAILED",
          processedAt: new Date(),
        },
      }
    );
    logger.debug(`Marked record ${recordId} as FAILED`);
  }
}
