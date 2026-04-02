/**
 * worker.service.ts
 *
 * Orchestrates the refund processing pipeline:
 *   1. Fetch worker details from refund_worker by workerName
 *   2. Get assignedBatch → fetch eligible records from itnry
 *   3. Launch a shared Playwright browser (persistent context)
 *   4. Process each record sequentially (single page, navigation-only)
 *   5. Save results to refund_book + update itnry status
 *   6. Update refund_worker status on completion
 *
 * Error handling:
 *   - Browser errors (timeout, navigation, net::, etc.) → retry up to 2 times → "browserError"
 *   - Business results (Success, Already_Refunded)       → NO retry, save as-is
 *   - Other application errors                           → NO retry, save as "Error"
 */

import { chromium, BrowserContext } from "playwright";
import { ItnryRepo, IItnry } from "../repositories/itnry.repo";
import { RefundRepo, RefundBookInput } from "../repositories/refund.repo";
import { RefundWorkerRepo } from "../repositories/refundWorker.repo";
import { runIndigoAutomation, AutomationResult } from "./indigo.service";
import { ENV } from "../config/env";
import { logger } from "../utils/logger";

const itnryRepo = new ItnryRepo();
const refundRepo = new RefundRepo();
const refundWorkerRepo = new RefundWorkerRepo();

// ── Error classification ────────────────────────────────────────────────────

function isBrowserError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("navigation") ||
    msg.includes("net::") ||
    msg.includes("target closed") ||
    msg.includes("browser has been closed") ||
    msg.includes("execution context was destroyed") ||
    msg.includes("frame was detached") ||
    msg.includes("page crashed") ||
    msg.includes("protocol error") ||
    msg.includes("session closed")
  );
}

// ── Process a single record ─────────────────────────────────────────────────

async function processRecord(
  page: any,
  record: IItnry,
  workerName: string
): Promise<void> {
  const pnr = record.pnr;
  const matchedName = record.matchedName || "";
  const recordId = (record._id as any).toString();

  logger.info(`━━━ START PNR: ${pnr} | Name: ${matchedName} | Worker: ${workerName} ━━━`);

  // Atomically lock — only succeeds if refundWorkerStatus is "NEW"
  const locked = await itnryRepo.lockRecord(recordId, workerName);
  if (!locked) {
    logger.warn(`PNR ${pnr} already picked up by another worker — skipping`);
    return;
  }

  let lastError: Error | null = null;
  let result: AutomationResult | null = null;
  let browserErrorOccurred = false;
  const maxAttempts = ENV.MAX_RETRIES + 1; // 1 original + 2 retries = 3

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      logger.info(`PNR ${pnr} — attempt ${attempt}/${maxAttempts}`);

      result = await runIndigoAutomation(page, pnr, matchedName);

      logger.info(
        `PNR ${pnr} — result: ${result.finalStatus} | msg: "${result.rawMessage.substring(0, 100)}"`
      );

      // Got a business result — done, no retry needed
      break;
    } catch (error: any) {
      lastError = error;

      if (isBrowserError(error)) {
        browserErrorOccurred = true;
        logger.error(
          `PNR ${pnr} — BROWSER ERROR attempt ${attempt}/${maxAttempts}: ${error.message}`
        );

        if (attempt < maxAttempts) {
          logger.info(`PNR ${pnr} — retrying in 5s (browser error)...`);
          await delay(5000);
          continue;
        }

        // All retries exhausted for browser error
        logger.error(
          `PNR ${pnr} — BROWSER ERROR: all ${maxAttempts} attempts exhausted. Marking as browserError.`
        );
      } else {
        // Non-browser error — do NOT retry
        logger.error(
          `PNR ${pnr} — APPLICATION ERROR (non-retryable): ${error.message}`
        );
        logger.error(`PNR ${pnr} — stack: ${error.stack}`);
        break;
      }
    }
  }

  // ── Determine final status ────────────────────────────────────────────────

  let finalStatus: "Success" | "Error" | "Already_Refunded" | "browserError";

  if (result) {
    // Automation returned a result
    finalStatus = result.finalStatus;
  } else if (browserErrorOccurred) {
    // Browser error after all retries exhausted
    finalStatus = "browserError";
  } else {
    // Other application error
    finalStatus = "Error";
  }

  // ── Save result to refund_book ────────────────────────────────────────────

  const refundInput: RefundBookInput = {
    pnr,
    matchedName,
    batchId: record.batchId,
    refundWorker: workerName,
    RefundAmt_from_itnry: record.RefundAmount ?? null,
    Refund_Amt_from_UI_message: result?.Refund_Amt_from_UI_message ?? null,
    currency_from_itnry: record.Currency ?? null,
    currency_from_UI_message: result?.currency_from_UI_message ?? null,
    finalStatus,
    rawMessage: result?.rawMessage ?? lastError?.message ?? "Unknown error",
  };

  await refundRepo.saveResult(refundInput);

  // ── Update itnry status ───────────────────────────────────────────────────
  // processedAt is set inside markProcessed / markFailed

  if (result && result.finalStatus !== "Error") {
    await itnryRepo.markProcessed(recordId);
  } else {
    await itnryRepo.markFailed(recordId);
  }

  logger.info(`━━━ END PNR: ${pnr} | Status: ${finalStatus} ━━━`);
}

// ── Main worker entry point ─────────────────────────────────────────────────

export async function runRefundWorker(workerName: string): Promise<void> {
  logger.info(`========================================`);
  logger.info(`Refund Worker starting: ${workerName}`);
  logger.info(`========================================`);

  // ── Step 1: Fetch worker from refund_worker collection ────────────────────

  const worker = await refundWorkerRepo.fetchByName(workerName);
  if (!worker) {
    throw new Error(`Worker "${workerName}" not found in refund_worker collection`);
  }

  const workerId = (worker._id as any).toString();
  const batchId = worker.assignedBatch;

  logger.info(`Worker: ${workerName} | Batch: ${batchId} | Seq: ${worker.seq}`);

  // ── Step 2: Mark worker IN_PROGRESS ───────────────────────────────────────

  await refundWorkerRepo.markInProgress(workerId);
  logger.info(`Worker ${workerName} status → IN_PROGRESS, startedAt → ${new Date().toISOString()}`);

  // ── Step 3: Fetch eligible itnry records for the assigned batch ───────────

  const records = await itnryRepo.fetchEligibleRecords(batchId);

  if (records.length === 0) {
    logger.info("No eligible records found — marking worker COMPLETED");
    await refundWorkerRepo.markCompleted(workerId);
    return;
  }

  logger.info(`Found ${records.length} records to process for batch: ${batchId}`);

  // ── Step 4: Launch browser ────────────────────────────────────────────────

  let browser: BrowserContext;
  try {
    browser = await chromium.launchPersistentContext(
      "C:\\Users\\Shreyas\\AppData\\Local\\Google\\Chrome\\User Data\\Profile 25",
      {
        headless: ENV.BROWSER_HEADLESS,
        slowMo: ENV.BROWSER_SLOW_MO_MS,
        channel: "chrome",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
        ],
      }
    );
  } catch (error: any) {
    logger.error(`Failed to launch browser: ${error.message}`);
    logger.error(`Browser launch stack: ${error.stack}`);
    await refundWorkerRepo.markFailed(workerId);
    throw error;
  }

  logger.info("Browser launched successfully");

  // ── Step 5: Process records sequentially ──────────────────────────────────

  try {
    // Reuse a single page — only navigation changes, no new tabs
    const page =
      browser.pages().length > 0 ? browser.pages()[0] : await browser.newPage();

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      logger.info(
        `[${i + 1}/${records.length}] PNR: ${record.pnr} | Worker: ${workerName}`
      );

      try {
        await processRecord(page, record, workerName);
      } catch (error: any) {
        // Catch-all: processRecord handles its own errors,
        // but this ensures one bad record doesn't kill the entire batch
        logger.error(
          `Unhandled error for PNR ${record.pnr}: ${error.message}`
        );
        logger.error(`Stack: ${error.stack}`);
      }

      // Inter-record delay to avoid rate limiting (skip after last record)
      if (i < records.length - 1 && ENV.INTER_RECORD_DELAY_MS > 0) {
        logger.debug(
          `Waiting ${ENV.INTER_RECORD_DELAY_MS}ms before next record...`
        );
        await delay(ENV.INTER_RECORD_DELAY_MS);
      }
    }

    // ── Step 6: Mark worker COMPLETED ───────────────────────────────────────
    await refundWorkerRepo.markCompleted(workerId);
    logger.info(`Worker ${workerName} status → COMPLETED`);
  } catch (error: any) {
    logger.error(`Worker ${workerName} fatal error: ${error.message}`);
    logger.error(`Stack: ${error.stack}`);
    await refundWorkerRepo.markFailed(workerId);
    throw error;
  } finally {
    await browser.close();
    logger.info("Browser closed");
  }

  logger.info(`========================================`);
  logger.info(`Refund Worker finished: ${workerName}`);
  logger.info(`========================================`);
}

// ── Utility ─────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
