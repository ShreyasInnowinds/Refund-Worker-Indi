/**
 * worker.service.ts
 *
 * Multi-worker queue system:
 *   1. Launch ONE browser instance
 *   2. Spawn N workers, each with its own browser context
 *   3. Each worker loops: fetch task atomically → process → update → repeat
 *   4. Workers stop when no more tasks are available
 *   5. All workers run concurrently via Promise.allSettled
 *
 * Architecture:
 *   Single Browser
 *   ├── Context 1 → Worker 1 (loop: fetchAndLock → process → update)
 *   ├── Context 2 → Worker 2
 *   └── Context N → Worker N
 *   All workers pull from the same DB queue using atomic findOneAndUpdate
 *
 * Error handling:
 *   - Browser errors (timeout, navigation, net::, etc.) → retry up to MAX_RETRIES → "browserError"
 *   - Business results (Success, Already_Refunded)       → NO retry, save as-is
 *   - Other application errors                           → NO retry, save as "Error"
 *   - Each worker handles its own errors — no worker crashes the system
 */

import { chromium, Browser, Page } from "playwright";
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

// ── Process a single record (already locked by fetchAndLockTask) ────────────

async function processRecord(
  page: Page,
  record: IItnry,
  workerName: string
): Promise<void> {
  const pnr = record.pnr;
  const matchedName = record.matchedName || "";
  const recordId = (record._id as any).toString();

  logger.info(`━━━ START PNR: ${pnr} | Name: ${matchedName} | Worker: ${workerName} ━━━`);

  let lastError: Error | null = null;
  let result: AutomationResult | null = null;
  let browserErrorOccurred = false;
  const maxAttempts = ENV.MAX_RETRIES + 1; // 1 original + retries

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
    finalStatus = result.finalStatus;
  } else if (browserErrorOccurred) {
    finalStatus = "browserError";
  } else {
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

  if (result && result.finalStatus !== "Error") {
    await itnryRepo.markProcessed(recordId);
  } else {
    await itnryRepo.markFailed(recordId);
  }

  logger.info(`━━━ END PNR: ${pnr} | Status: ${finalStatus} ━━━`);
}

// ── Single worker loop ──────────────────────────────────────────────────────

interface WorkerStats {
  processed: number;
  failed: number;
}

async function runSingleWorker(
  browser: Browser,
  workerName: string,
  workerId: string,
  batchId: string,
  seq: number
): Promise<WorkerStats> {
  const stats: WorkerStats = { processed: 0, failed: 0 };

  logger.info(`[Worker-${seq}] ${workerName} starting...`);

  // Mark worker IN_PROGRESS
  await refundWorkerRepo.markInProgress(workerId);

  // Create isolated browser context + page for this worker
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Infinite loop: fetch → process → update → repeat
    while (true) {
      // Atomically fetch and lock one task
      const task = await itnryRepo.fetchAndLockTask(batchId, workerName);

      if (!task) {
        logger.info(`[Worker-${seq}] ${workerName}: No more tasks available — stopping`);
        break;
      }

      stats.processed++;
      logger.info(
        `[Worker-${seq}] Task #${stats.processed} — PNR: ${task.pnr} | Worker: ${workerName}`
      );

      try {
        await processRecord(page, task, workerName);
      } catch (error: any) {
        stats.failed++;
        logger.error(
          `[Worker-${seq}] Unhandled error for PNR ${task.pnr}: ${error.message}`
        );
        logger.error(`[Worker-${seq}] Stack: ${error.stack}`);
      }

      // Inter-record delay to avoid rate limiting
      if (ENV.INTER_RECORD_DELAY_MS > 0) {
        logger.debug(
          `[Worker-${seq}] Waiting ${ENV.INTER_RECORD_DELAY_MS}ms before next task...`
        );
        await delay(ENV.INTER_RECORD_DELAY_MS);
      }
    }

    // All tasks done — mark worker COMPLETED
    await refundWorkerRepo.markCompleted(workerId);
    logger.info(
      `[Worker-${seq}] ${workerName} → COMPLETED | Processed: ${stats.processed} | Failed: ${stats.failed}`
    );
  } catch (error: any) {
    logger.error(`[Worker-${seq}] ${workerName} fatal error: ${error.message}`);
    logger.error(`[Worker-${seq}] Stack: ${error.stack}`);
    await refundWorkerRepo.markFailed(workerId);
  } finally {
    await context.close();
    logger.info(`[Worker-${seq}] ${workerName} context closed`);
  }

  return stats;
}

// ── Main entry point: multi-worker system ───────────────────────────────────

export async function runMultiWorkerSystem(
  batchId: string,
  workerCount: number
): Promise<void> {
  logger.info(`========================================`);
  logger.info(`Multi-Worker System starting`);
  logger.info(`Batch: ${batchId} | Workers: ${workerCount}`);
  logger.info(`========================================`);

  // ── Step 1: Create worker records in DB ───────────────────────────────────

  const workers: { name: string; id: string; seq: number }[] = [];

  for (let i = 1; i <= workerCount; i++) {
    const name = `${batchId}-w${i}`;
    const worker = await refundWorkerRepo.createWorker(name, i, batchId);
    workers.push({
      name,
      id: (worker._id as any).toString(),
      seq: i,
    });
  }

  logger.info(`Created ${workers.length} worker records in DB`);

  // ── Step 2: Launch ONE browser instance ───────────────────────────────────

  let browser: Browser;
  try {
    browser = await chromium.launch({
      headless: ENV.BROWSER_HEADLESS,
      slowMo: ENV.BROWSER_SLOW_MO_MS,
      channel: "chrome",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    });
  } catch (error: any) {
    logger.error(`Failed to launch browser: ${error.message}`);
    logger.error(`Browser launch stack: ${error.stack}`);

    // Mark all workers as FAILED since browser didn't start
    for (const w of workers) {
      await refundWorkerRepo.markFailed(w.id);
    }
    throw error;
  }

  logger.info("Browser launched successfully — spawning workers");

  // ── Step 3: Spawn all workers concurrently ────────────────────────────────

  try {
    const results = await Promise.allSettled(
      workers.map((w) =>
        runSingleWorker(browser, w.name, w.id, batchId, w.seq)
      )
    );

    // ── Summary ─────────────────────────────────────────────────────────────

    logger.info(`========================================`);
    logger.info(`All workers finished — Summary:`);

    let totalProcessed = 0;
    let totalFailed = 0;

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled") {
        totalProcessed += r.value.processed;
        totalFailed += r.value.failed;
        logger.info(
          `  Worker-${i + 1} (${workers[i].name}): processed=${r.value.processed}, failed=${r.value.failed}`
        );
      } else {
        logger.error(
          `  Worker-${i + 1} (${workers[i].name}): CRASHED — ${r.reason}`
        );
      }
    }

    logger.info(`Total: processed=${totalProcessed}, failed=${totalFailed}`);
    logger.info(`========================================`);
  } finally {
    await browser.close();
    logger.info("Browser closed");
  }
}

// ── Utility ─────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
