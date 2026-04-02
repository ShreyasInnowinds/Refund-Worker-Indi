/**
 * worker.service.ts
 *
 * Orchestrates the refund processing pipeline:
 *   1. Fetch eligible records from itnry
 *   2. Launch a shared Playwright browser
 *   3. Process each record sequentially (new context per record)
 *   4. Save results to refund_book + update itnry status
 *
 * Retry policy:
 *   - System errors (timeouts, navigation failures) → retry up to MAX_RETRIES
 *   - Business errors (already refunded, IndiGo error popup) → NO retry
 */

import { chromium, Browser, BrowserContext } from "playwright";
import { ItnryRepo, IItnry } from "../repositories/itnry.repo";
import { RefundRepo, RefundBookInput } from "../repositories/refund.repo";
import { runIndigoAutomation, AutomationResult } from "./indigo.service";
import { ENV } from "../config/env";
import { logger } from "../utils/logger";

const itnryRepo = new ItnryRepo();
const refundRepo = new RefundRepo();

// ── Business error detection ─────────────────────────────────────────────────
// These are NOT retryable — the result is final.

function isBusinessError(result: AutomationResult): boolean {
  return (
    result.finalStatus === "Already_Refunded" ||
    result.finalStatus === "Success"
  );
}

function isSystemError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("navigation") ||
    msg.includes("net::") ||
    msg.includes("target closed") ||
    msg.includes("browser has been closed") ||
    msg.includes("execution context was destroyed")
  );
}

// ── Process a single record ──────────────────────────────────────────────────

async function processRecord(
  page: any,
  record: IItnry
): Promise<void> {
  const pnr = record.pnr;
  const matchedName = record.matchedName || "";
  const recordId = (record._id as any).toString();

  logger.info(`━━━ START processing PNR: ${pnr} | Name: ${matchedName} ━━━`);

  // Attempt to lock the record atomically
  const locked = await itnryRepo.lockRecord(recordId);
  if (!locked) {
    logger.warn(`PNR ${pnr} already picked up by another worker — skipping`);
    return;
  }

  let lastError: Error | null = null;
  let result: AutomationResult | null = null;

  for (let attempt = 1; attempt <= ENV.MAX_RETRIES + 1; attempt++) {
    let context: BrowserContext | null = null;

    try {
      logger.info(`PNR ${pnr} — attempt ${attempt}/${ENV.MAX_RETRIES + 1}`);

      // Fresh browser context per attempt (isolates cookies, storage)
      // context = await browser.newContext({
      //   viewport: { width: 1366, height: 768 },
      //   userAgent:
      //     "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      // });

      // const page = await browser.newPage();

      result = await runIndigoAutomation(page, pnr, matchedName);

      logger.info(
        `PNR ${pnr} — automation result: ${result.finalStatus} | msg: "${result.rawMessage.substring(0, 80)}"`
      );

      // Business result obtained — no retry needed regardless of status
      break;
    } catch (error: any) {
      lastError = error;
      logger.error(`PNR ${pnr} — attempt ${attempt} failed: ${error.message}`);

      // Only retry system errors
      if (!isSystemError(error) || attempt > ENV.MAX_RETRIES) {
        logger.error(
          `PNR ${pnr} — ${
            isSystemError(error)
              ? "max retries exhausted"
              : "non-retryable error"
          }`
        );
        break;
      }

      logger.info(`PNR ${pnr} — retrying in 5s...`);
      await delay(5000);
    } 
    // finally {
    //   if (page) {
    //     await context.close().catch(() => {});
    //   }
    // }
  }

  // ── Save result to refund_book ────────────────────────────────────────────
  const refundInput: RefundBookInput = {
    pnr,
    matchedName,
    batchId: record.batchId,
    RefundAmt_from_itnry: record.RefundAmount ?? null,
    Refund_Amt_from_UI_message: result?.Refund_Amt_from_UI_message ?? null,
    currency_from_itnry: record.Currency ?? null,
    currency_from_UI_message: result?.currency_from_UI_message ?? null,
    finalStatus: result?.finalStatus ?? "Error",
    rawMessage: result?.rawMessage ?? lastError?.message ?? "Unknown error",
  };

  await refundRepo.saveResult(refundInput);

  // ── Update itnry status ───────────────────────────────────────────────────
  if (result && result.finalStatus !== "Error") {
    await itnryRepo.markProcessed(recordId);
  } else {
    await itnryRepo.markFailed(recordId);
  }

  logger.info(`━━━ END processing PNR: ${pnr} | Status: ${refundInput.finalStatus} ━━━`);
}

// ── Main worker entry point ──────────────────────────────────────────────────

export async function runRefundWorker(batchId: string): Promise<void> {
  logger.info(`========================================`);
  logger.info(`Refund Worker starting for batchId: ${batchId}`);
  logger.info(`========================================`);

  // Fetch eligible records
  const records = await itnryRepo.fetchEligibleRecords(batchId);

  if (records.length === 0) {
    logger.info("No eligible records found — worker exiting");
    return;
  }

  logger.info(`Found ${records.length} records to process`);

  // Launch ONE shared browser instance (reused across all records)
  const browser = await chromium.launchPersistentContext('C:\\Users\\Shreyas\\AppData\\Local\\Google\\Chrome\\User Data\\Profile 25',{
    headless: ENV.BROWSER_HEADLESS,
    slowMo: ENV.BROWSER_SLOW_MO_MS,
    channel: 'chrome',
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  logger.info("Browser launched");

  try {
    // Reuse a single page across all records — only navigation changes, no new tabs
    const page = browser.pages().length > 0 ? browser.pages()[0] : await browser.newPage();

    // Process records sequentially — IndiGo rate-limits concurrent sessions
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      logger.info(
        `Processing record ${i + 1}/${records.length}: PNR=${record.pnr}`
      );

      try {
        await processRecord(page, record);
      } catch (error: any) {
        // Catch-all: should not happen (processRecord handles its own errors)
        // but ensures one bad record doesn't kill the entire batch
        logger.error(
          `Unhandled error processing PNR ${record.pnr}: ${error.message}`
        );
      }

      // Inter-record delay to avoid rate limiting (skip after last record)
      if (i < records.length - 1 && ENV.INTER_RECORD_DELAY_MS > 0) {
        logger.debug(
          `Waiting ${ENV.INTER_RECORD_DELAY_MS}ms before next record...`
        );
        await delay(ENV.INTER_RECORD_DELAY_MS);
      }
    }
  } finally {
    await browser.close();
    logger.info("Browser closed");
  }

  logger.info(`========================================`);
  logger.info(`Refund Worker finished for batchId: ${batchId}`);
  logger.info(`========================================`);
}

// ── Utility ──────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
