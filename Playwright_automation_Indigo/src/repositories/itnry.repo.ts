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
  LockedAt: Date | null;
  processedAt: Date | null;
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
    LockedAt: { type: Date, default: null },
    processedAt: { type: Date, default: null },
  },
  { collection: "itnry", timestamps: false }
);

itnrySchema.index({ batchId: 1, Status: 1, refundWorkerStatus: 1 });

const ItnryModel = mongoose.model<IItnry>("Itnry", itnrySchema);

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
    }).lean<IItnry[]>();

    logger.info(
      `Fetched ${records.length} eligible records for batchId: ${batchId}`
    );
    return records;
  }

  /**
   * Atomically lock a record: set refundWorkerStatus = "PROCESSING"
   * Only locks if current status is still NEW or IN_PROGRESS (prevents double-pick).
   */
  async lockRecord(recordId: string): Promise<IItnry | null> {
    const locked = await ItnryModel.findOneAndUpdate(
      {
        _id: recordId,
        refundWorkerStatus: { $in: ["NEW", "IN_PROGRESS"] },
      },
      {
        $set: {
          refundWorkerStatus: "PROCESSING",
          LockedAt: new Date(),
        },
      },
      { new: true }
    );

    if (locked) {
      logger.debug(`Locked record: ${locked.pnr} (${recordId})`);
    } else {
      logger.warn(`Failed to lock record ${recordId} — already picked up`);
    }
    return locked;
  }

  /**
   * Mark record as PROCESSED after successful automation.
   */
  async markProcessed(recordId: string): Promise<void> {
    await ItnryModel.updateOne(
      { _id: recordId },
      {
        $set: {
          refundWorkerStatus: "PROCESSED",
          isRefundProcessed: true,
          processedAt: new Date(),
        },
      }
    );
    logger.debug(`Marked record ${recordId} as PROCESSED`);
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
