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

import { chromium, Browser, BrowserContext, Page } from "playwright";
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

function isSomethingWentWrong(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.toLowerCase().includes("something went wrong");
}

// Sentinel thrown when the second consecutive "Something went wrong" hits.
// runSingleWorker catches this by name and stops the worker loop.
class StopExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StopExecutionError";
  }
}

async function runAutomationWithBrowserRetry(
  page: Page,
  pnr: string,
  matchedName: string
): Promise<{
  result: AutomationResult | null;
  lastError: Error | null;
  browserErrorOccurred: boolean;
}> {
  let lastError: Error | null = null;
  let result: AutomationResult | null = null;
  let browserErrorOccurred = false;
  const maxAttempts = ENV.MAX_RETRIES + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      logger.info(`PNR ${pnr} — attempt ${attempt}/${maxAttempts}`);
      result = await runIndigoAutomation(page, pnr, matchedName);
      logger.info(
        `PNR ${pnr} — result: ${result.finalStatus} | msg: "${result.rawMessage.substring(0, 100)}"`
      );
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
          `PNR ${pnr} — BROWSER ERROR: all ${maxAttempts} attempts exhausted.`
        );
      } else {
        logger.error(
          `PNR ${pnr} — APPLICATION ERROR (non-retryable): ${error.message}`
        );
        logger.error(`PNR ${pnr} — stack: ${error.stack}`);
        break;
      }
    }
  }

  return { result, lastError, browserErrorOccurred };
}

// ── Process a single record (already locked by fetchAndLockTask) ────────────

async function processRecord(
  page: Page,
  record: IItnry,
  workerName: string,
  refreshSession: () => Promise<Page>
): Promise<void> {
  const pnr = record.pnr;
  const matchedName = record.matchedName || "";
  const recordId = (record._id as any).toString();

  logger.info(`━━━ START PNR: ${pnr} | Name: ${matchedName} | Worker: ${workerName} ━━━`);

  // First pass
  let { result, lastError, browserErrorOccurred } =
    await runAutomationWithBrowserRetry(page, pnr, matchedName);

  // If we hit "Something went wrong", refresh the browser context and retry once.
  // If the second pass also returns "Something went wrong", save the result
  // and throw StopExecutionError so the worker loop exits.
  let stopAfterSave = false;
  if (isSomethingWentWrong(result?.rawMessage)) {
    logger.warn(
      `PNR ${pnr} — popup said "Something went wrong" — refreshing browser context (auth token refresh) and retrying once`
    );
    page = await refreshSession();
    ({ result, lastError, browserErrorOccurred } =
      await runAutomationWithBrowserRetry(page, pnr, matchedName));

    if (isSomethingWentWrong(result?.rawMessage)) {
      stopAfterSave = true;
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
    const refundStatus =
      result.finalStatus === "Already_Refunded"
        ? "Already_Refunded"
        : "Refund_Processed";
    await itnryRepo.markProcessed(
      recordId,
      refundStatus,
      result.rawMessage,
      result.Refund_Amt_from_UI_message
    );
  } else {
    await itnryRepo.markFailed(recordId);
  }

  logger.info(`━━━ END PNR: ${pnr} | Status: ${finalStatus} ━━━`);

  if (stopAfterSave) {
    throw new StopExecutionError(
      `session refreshed but again msg: "Something went wrong" so stopping execution`
    );
  }
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

  // Create isolated browser context + page for this worker.
  // These are `let` so refreshSession() can swap them in-place.
  let context: BrowserContext = await browser.newContext();
  let page: Page = await context.newPage();

  const refreshSession = async (): Promise<Page> => {
    logger.warn(
      `[Worker-${seq}] ${workerName}: closing browser context & opening a fresh one (auth token refresh)`
    );
    try {
      await context.close();
    } catch (err: any) {
      logger.warn(`[Worker-${seq}] context.close() during refresh failed: ${err.message}`);
    }
    context = await browser.newContext();
    page = await context.newPage();
    return page;
  };

  let stoppedByExecutionHalt = false;

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
        await processRecord(page, task, workerName, refreshSession);
      } catch (error: any) {
        if (error instanceof StopExecutionError) {
          logger.error(`[Worker-${seq}] ${error.message}`);
          stoppedByExecutionHalt = true;
          break;
        }
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

    if (stoppedByExecutionHalt) {
      await refundWorkerRepo.markFailed(workerId);
      logger.error(
        `[Worker-${seq}] ${workerName} → HALTED after consecutive "Something went wrong" | Processed: ${stats.processed} | Failed: ${stats.failed}`
      );
    } else {
      await refundWorkerRepo.markCompleted(workerId);
      logger.info(
        `[Worker-${seq}] ${workerName} → COMPLETED | Processed: ${stats.processed} | Failed: ${stats.failed}`
      );
    }
  } catch (error: any) {
    logger.error(`[Worker-${seq}] ${workerName} fatal error: ${error.message}`);
    logger.error(`[Worker-${seq}] Stack: ${error.stack}`);
    await refundWorkerRepo.markFailed(workerId);
  } finally {
    try {
      await context.close();
    } catch {
      // already closed during refresh; ignore
    }
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

  // ── Step 1: Fetch idle worker records from DB ─────────────────────────────

  const idleWorkers = await refundWorkerRepo.fetchIdleListByBatch(
    batchId,
    workerCount
  );

  if (idleWorkers.length === 0) {
    logger.error(`No IDEL workers found for batch ${batchId} — aborting`);
    return;
  }

  if (idleWorkers.length < workerCount) {
    logger.warn(
      `Requested ${workerCount} workers but only ${idleWorkers.length} IDEL worker(s) available for batch ${batchId}`
    );
  }

  const workers = idleWorkers.map((w) => ({
    name: w.name,
    id: (w._id as any).toString(),
    seq: w.seq,
  }));

  logger.info(`Fetched ${workers.length} idle worker record(s) from DB`);

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
    // for (const w of workers) {
    //   await refundWorkerRepo.markFailed(w.id);
    // }
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
