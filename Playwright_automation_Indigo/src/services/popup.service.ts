/**
 * popup.service.ts
 *
 * CRITICAL: The IndiGo toast popup appears for only 2-3 seconds after
 * clicking the No-Show button. The ONLY reliable way to capture it is:
 *
 *   1. Start a waitForSelector promise BEFORE clicking
 *   2. Click the button
 *   3. Await the already-running promise
 *
 * This guarantees Playwright is actively polling the DOM the instant the
 * toast mounts — no race condition, no missed popup.
 *
 * Primary selector: .skyplus-design-toast-container li.desc
 * Fallback:         MutationObserver on document.body
 */

import { Page, Locator } from "playwright";
import { logger } from "../utils/logger";

// ── Selectors ────────────────────────────────────────────────────────────────

const PRIMARY_TOAST_SELECTOR = ".skyplus-design-toast-container li.desc";

const FALLBACK_SELECTORS = [
  ".skyplus-design-toast-container",
  ".passenger-no-show-container__popup",
  ".toast-message",
  ".notification-message",
  ".success-message",
  '[role="alert"]',
];

// ── Popup capture result ─────────────────────────────────────────────────────

export interface PopupResult {
  text: string;
  popupType: "success" | "error" | "unknown";
  capturedVia: string;
}

// ── Main export: setup listener → click → capture ────────────────────────────

/**
 * Sets up popup listening, clicks the no-show button, and captures the toast.
 *
 * @param page      - Current Playwright page
 * @param noShowBtn - The no-show button locator (already verified visible)
 * @returns PopupResult with extracted text and classification
 */
export async function capturePopupOnClick(
  page: Page,
  noShowBtn: Locator,
  pnr: string,
  matchedName: string,
): Promise<PopupResult> {
  logger.info("Setting up popup listeners BEFORE clicking No-Show button");

  // ── Strategy 1: waitForSelector on primary toast (started BEFORE click) ───
  const primaryPromise = page
    .waitForSelector(PRIMARY_TOAST_SELECTOR, {
      state: "visible",
      timeout: 15000,
    })
    .then(async (handle) => {
      if (!handle) throw new Error("Handle is null");
      const text = await handle.textContent();
      return {
        text: text?.trim() || "",
        capturedVia: "primary:skyplus-toast-li.desc",
      };
    })
    .catch(() => null);

  // ── Strategy 2: waitForSelector on fallback selectors ─────────────────────
  const fallbackPromise = Promise.any(
    FALLBACK_SELECTORS.map((sel) =>
      page
        .waitForSelector(sel, { state: "visible", timeout: 15000 })
        .then(async (handle) => {
          if (!handle) throw new Error("Handle is null");
          const text = await handle.textContent();
          if (!text || text.trim().length < 5) throw new Error("Empty text");
          return { text: text.trim(), capturedVia: `fallback:${sel}` };
        })
    )
  ).catch(() => null);


  // ── Strategy 3: MutationObserver capturing any DOM text changes ───────────
  const mutationPromise = page
    .evaluate(() => {
      return new Promise<string>((resolve) => {
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            const nodes = Array.from(mutation.addedNodes);
            for (const node of nodes) {
              if (node instanceof HTMLElement) {
                const text = node.innerText?.trim();
                if (text && text.length > 10) {
                  observer.disconnect();
                  resolve(text);
                  return;
                }
              }
            }
          }
        });

        const container = document.querySelector(
          ".skyplus-design-toast-container"
        );
        const target = container || document.body;

        observer.observe(target, { childList: true, subtree: true });

        // Auto-disconnect after 15s to prevent memory leak
        setTimeout(() => {
          observer.disconnect();
          resolve("");
        }, 15000);
      });
    })
    .then((text) => {
      if (!text) return null;
      return { text, capturedVia: "mutation-observer" };
    })
    .catch(() => null);

  // ── NOW click the button (all listeners are already active) ───────────────
  logger.info("Clicking No-Show button (listeners active)");
  await noShowBtn.click();
  logger.info("No-Show button clicked — awaiting popup capture");

  // ── Race all strategies — first valid result wins ─────────────────────────
  const results = await Promise.allSettled([
    primaryPromise,
    fallbackPromise,
    mutationPromise,
  ]);
  await page.screenshot({
    path: `screenshots/popups/${pnr}_${matchedName}.png`,
    fullPage: true
  });

  // Pick the first non-null result (priority: primary > fallback > mutation)
  let captured: { text: string; capturedVia: string } | null = null;

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      captured = result.value;
      break;
    }
  }

  // ── Last resort: grab body text ───────────────────────────────────────────
  if (!captured || !captured.text) {
    logger.warn("All popup strategies returned empty — falling back to body text");
    const bodyText = await page.locator("body").innerText().catch(() => "");
    captured = {
      text: bodyText.trim(),
      capturedVia: "fallback:document.body",
    };
  }

  // ── Determine popup type ──────────────────────────────────────────────────
  const popupType = detectPopupType(page, captured.text);

  logger.info(
    `Popup captured via: ${captured.capturedVia} | type: ${popupType} | text: "${captured.text.substring(0, 100)}"`
  );

  return {
    text: captured.text,
    popupType,
    capturedVia: captured.capturedVia,
  };
}

// ── Popup type detection (success/error/unknown) ─────────────────────────────

function detectPopupType(
  _page: Page,
  text: string
): "success" | "error" | "unknown" {
  const lower = text.toLowerCase();

  // Error indicators
  if (
    lower.includes("something went wrong") ||
    lower.includes("error") ||
    lower.includes("failed") ||
    lower.includes("unable to process") ||
    lower.includes("try again")
  ) {
    return "error";
  }

  // Success indicators
  if (
    lower.includes("refund") &&
    (lower.includes("processed") || lower.includes("credited"))
  ) {
    return "success";
  }

  if (lower.includes("success")) {
    return "success";
  }

  return "unknown";
}
