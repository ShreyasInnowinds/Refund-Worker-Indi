import mongoose, { Schema, Document } from "mongoose";
import { logger } from "../utils/logger";

// ── Types ────────────────────────────────────────────────────────────────────

export interface IRefundBook extends Document {
  pnr: string;
  matchedName: string | null;
  batchId: string;
  refundWorker: string | null;
  RefundAmt_from_itnry: number | null;
  Refund_Amt_from_UI_message: number | null;
  currency_from_itnry: string | null;
  currency_from_UI_message: string | null;
  finalStatus: "Success" | "Error" | "Already_Refunded" | "browserError";
  rawMessage: string | null;
  processedAt: Date;
}

// ── Schema ───────────────────────────────────────────────────────────────────

const refundBookSchema = new Schema(
  {
    pnr: { type: String, required: true },
    matchedName: { type: String, default: null },
    batchId: { type: String, required: true },
    refundWorker: { type: String, default: null },
    RefundAmt_from_itnry: { type: Number, default: null },
    Refund_Amt_from_UI_message: { type: Number, default: null },
    currency_from_itnry: { type: String, default: null },
    currency_from_UI_message: { type: String, default: null },
    finalStatus: {
      type: String,
      enum: ["Success", "Error", "Already_Refunded", "browserError"],
      required: true,
    },
    rawMessage: { type: String, default: null },
    processedAt: { type: Date, default: Date.now },
  },
  { collection: "refund_book", timestamps: false }
);

refundBookSchema.index({ pnr: 1, batchId: 1 }, { unique: true });
refundBookSchema.index({ finalStatus: 1 });
refundBookSchema.index({ batchId: 1 });

const RefundBookModel = mongoose.model<IRefundBook>(
  "RefundBook",
  refundBookSchema
);

// ── Repository ───────────────────────────────────────────────────────────────

export interface RefundBookInput {
  pnr: string;
  matchedName: string | null;
  batchId: string;
  refundWorker: string | null;
  RefundAmt_from_itnry: number | null;
  Refund_Amt_from_UI_message: number | null;
  currency_from_itnry: string | null;
  currency_from_UI_message: string | null;
  finalStatus: "Success" | "Error" | "Already_Refunded" | "browserError";
  rawMessage: string | null;
}

export class RefundRepo {
  /**
   * Insert or update a refund_book entry (upsert on pnr + batchId).
   * Prevents duplicates if worker retries after a crash.
   */
  async saveResult(input: RefundBookInput): Promise<void> {
    await RefundBookModel.updateOne(
      { pnr: input.pnr, batchId: input.batchId },
      {
        $set: {
          ...input,
          processedAt: new Date(),
        },
      },
      { upsert: true }
    );

    logger.info(
      `Saved refund result: PNR=${input.pnr} status=${input.finalStatus}`
    );
  }
}
