/**
 * indigo.service.ts
 *
 * All Playwright automation logic for the IndiGo website.
 *
 * This module ONLY knows about the browser and the IndiGo UI.
 * It does NOT touch MongoDB, logging levels, retry logic, or rate limiting.
 *
 * Key improvement over reference code:
 *   - Popup listener is attached BEFORE clicking the No-Show button
 *     via popup.service.ts, guaranteeing capture of the 2-3 second toast.
 */

import { Page } from "playwright";
import { capturePopupOnClick, PopupResult } from "./popup.service";
import {
  parseRefundText,
  isAlreadyRefundedText,
  classifyPopupText,
} from "../utils/parser";
import { logger } from "../utils/logger";

// ── Target URL ──────────────────────────────────────────────────────────────

const INDIGO_EDIT_BOOKING_URL =
  "https://www.goindigo.in/edit-booking.html?linkNav=Edit%20Booking%7CChange%20your%20journey%7CTrips";

// ── Selector registry ───────────────────────────────────────────────────────

const SEL = {
  PNR_INPUT: 'input[name="pnr-booking-ref"]',
  LAST_NAME_INPUT: 'input[name="email-last-name"]',
  GET_ITINERARY_BTN: 'button[title="Get Itinerary"]',

  ITINERARY_LOADED: 'p:has-text("Your itinerary is generated")',
  NO_SHOW_BTN: 'button[class="passenger-no-show-container__link"]',

  COOKIE_ACCEPT: [
    "#onetrust-accept-btn-handler",
    'button[aria-label="Accept cookies"]',
    ".cookie-accept-btn",
    ".consent-banner__accept",
  ],

  ERROR_INDICATORS: [
    ".error-message",
    ".booking-not-found",
    ".invalid-pnr",
    '[data-error="true"]',
    ".alert-danger",
    ".error-container",
  ],
};

const TIMEOUTS = {
  COOKIE_BANNER: 3000,
};

// ── Automation result contract ──────────────────────────────────────────────

export interface AutomationResult {
  Refund_Amt_from_UI_message: number | null;
  currency_from_UI_message: string | null;
  finalStatus: "Success" | "Error" | "Already_Refunded";
  rawMessage: string;
}

// ── Step 1: Navigate to booking page ────────────────────────────────────────

async function navigateToBookingPage(page: Page): Promise<void> {
  logger.debug("Navigating to IndiGo edit-booking URL");

  await page.goto(INDIGO_EDIT_BOOKING_URL, {
    waitUntil: "domcontentloaded",
    timeout: 0,
  });

  await page.waitForSelector(SEL.PNR_INPUT, {
    state: "visible",
    timeout: 0,
  });

  logger.debug("Booking page loaded — PNR input is visible");
}

// ── Step 2: Dismiss cookie banner ───────────────────────────────────────────

async function dismissCookieBanner(page: Page): Promise<void> {
  for (const selector of SEL.COOKIE_ACCEPT) {
    try {
      const btn = page.locator(selector);
      const isVisible = await btn
        .isVisible({ timeout: TIMEOUTS.COOKIE_BANNER })
        .catch(() => false);

      if (isVisible) {
        await btn.click({ timeout: TIMEOUTS.COOKIE_BANNER });
        logger.debug(`Cookie banner dismissed via: ${selector}`);
        return;
      }
    } catch {
      // This selector didn't match — try next
    }
  }

  logger.debug("No cookie banner found — skipping dismissal");
}

// ── Step 3: Fill booking form ───────────────────────────────────────────────

async function fillBookingForm(
  page: Page,
  pnr: string,
  matchedName: string
): Promise<void> {
  logger.info(`Filling form — PNR: ${pnr} | LastName: ${matchedName}`);

  const pnrInput = page.locator(SEL.PNR_INPUT);
  const lastNameInput = page.locator(SEL.LAST_NAME_INPUT);
  await page.waitForTimeout(2000);

  await pnrInput.clear();
  await pnrInput.fill(pnr);
  await page.waitForTimeout(2000);

  await lastNameInput.clear();
  await lastNameInput.fill(matchedName);
  await page.waitForTimeout(2000);

  logger.debug('Form filled — clicking "Get Itinerary"');

  const getItineraryBtn = page.locator(SEL.GET_ITINERARY_BTN);
  await getItineraryBtn.click();
}

// ── Step 4: Wait for itinerary + check errors ───────────────────────────────

async function waitForItineraryPage(page: Page, pnr: string): Promise<void> {
  logger.debug("Waiting for itinerary page to load...");

  // Check for error indicators first (fast fail)
  const errorSelector = SEL.ERROR_INDICATORS.join(", ");
  const errorEl = page.locator(errorSelector).first();
  const hasError = await errorEl
    .isVisible({ timeout: 2000 })
    .catch(() => false);

  if (hasError) {
    const errorText = await errorEl
      .textContent()
      .catch(() => "Unknown booking error");
    throw new Error(`IndiGo booking error for ${pnr}: ${errorText?.trim()}`);
  }

  // Wait for itinerary confirmation text
  // await page.waitForSelector(SEL.ITINERARY_LOADED, {
  //   state: "visible",
  //   timeout: 0,
  // });
  await page.waitForLoadState('domcontentloaded');

  logger.debug("Itinerary page loaded successfully");
}

// ── Step 5: Click No-Show button (with popup pre-listener) ─────────────────

interface NoShowResult {
  found: boolean;
  popupResult?: PopupResult;
  reason?: string;
}

async function clickNoShowAndCapturePopup(
  page: Page,
  pnr: string,
  matchedName: string
): Promise<NoShowResult> {
  logger.debug(`Checking for No-Show button — PNR: ${pnr}`);

  console.log("Checking for text for Noshow");
  await page.waitForTimeout(10000);
  // await page.waitForLoadState('networkidle');

  // await page.waitForSelector('p:has-text("Your itinerary is generated")', {
  //   state: "visible",
  //   timeout: 0,
  // });
  // const isExists = await page
  //   .locator('p:has-text("Your itinerary is generated")')
  //   .isVisible()
  //   .catch(() => false);

  const btn = page.locator(SEL.NO_SHOW_BTN);
  const isVisible = await btn.isVisible({ timeout: 5000 }).catch(() => false);

  if (!isVisible) {
    logger.info(
      `No-Show button not found for PNR ${pnr} — likely already refunded`
    );
    return {
      found: false,
      reason: `No-Show button not found on itinerary page for PNR ${pnr}`,
    };
  }

  logger.info(`No-Show button found for PNR ${pnr} — initiating popup capture`);

  // CRITICAL: capturePopupOnClick sets up listeners BEFORE clicking,
  // then clicks, then awaits the toast. This is the fix for the 2-3s popup.
  const popupResult = await capturePopupOnClick(page, btn, pnr, matchedName);
  await page.waitForTimeout(4000);

  return { found: true, popupResult };
}

// ── Main orchestrator ───────────────────────────────────────────────────────

/**
 * Runs the full IndiGo automation flow for one PNR.
 *
 * @param page        - Fresh Playwright page (caller manages lifecycle)
 * @param pnr         - Booking reference
 * @param matchedName - Passenger last name
 */
export async function runIndigoAutomation(
  page: Page,
  pnr: string,
  matchedName: string
): Promise<AutomationResult> {
  // Disable default timeouts — we use explicit timeout: 0 where needed
  page.setDefaultNavigationTimeout(0);
  page.setDefaultTimeout(0);

  // Step 1: Navigate
  await navigateToBookingPage(page);

  // Step 2: Dismiss cookie banner
  await dismissCookieBanner(page);

  // Step 3: Fill form + submit
  await fillBookingForm(page, pnr, matchedName);

  // Step 4: Wait for itinerary
  await waitForItineraryPage(page, pnr);

  // Step 5: Click No-Show + capture popup (pre-listener pattern)
  const noShowResult = await clickNoShowAndCapturePopup(page, pnr, matchedName);

  if (!noShowResult.found) {
    return {
      Refund_Amt_from_UI_message: null,
      currency_from_UI_message: null,
      finalStatus: "Already_Refunded",
      rawMessage: noShowResult.reason || "No-Show button not found",
    };
  }

  const popup = noShowResult.popupResult!;
  const rawText = popup.text;

  // ── Classify result ─────────────────────────────────────────────────────

  // Check if already refunded
  if (isAlreadyRefundedText(rawText)) {
    return {
      Refund_Amt_from_UI_message: null,
      currency_from_UI_message: null,
      finalStatus: "Already_Refunded",
      rawMessage: rawText,
    };
  }

  // Check if error
  if (popup.popupType === "error") {
    return {
      Refund_Amt_from_UI_message: null,
      currency_from_UI_message: null,
      finalStatus: "Error",
      rawMessage: rawText,
    };
  }

  // Try to parse refund amount from popup text
  const parsed = parseRefundText(rawText);

  // Classify based on text content
  const finalStatus = classifyPopupText(rawText);

  return {
    Refund_Amt_from_UI_message: parsed.amount,
    currency_from_UI_message: parsed.currency,
    finalStatus,
    rawMessage: rawText,
  };
}
