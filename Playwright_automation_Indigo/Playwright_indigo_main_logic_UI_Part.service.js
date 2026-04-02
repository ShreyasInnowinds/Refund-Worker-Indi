const puppeteer = require("puppeteer");
/**
 * automation/indigo.service.js
 *
 * All Playwright automation logic for the IndiGo website.
 *
 * ─── Separation of concerns ───────────────────────────────────────────────────
 * This module ONLY knows about the browser and the IndiGo UI.
 * It does NOT touch MongoDB, logging levels, retry logic, or rate limiting.
 * All of those live in workerProcessor.service.js (one level up).
 *
 * ─── Resilience strategy ──────────────────────────────────────────────────────
 * 1. Selectors: stored as named constants — one place to fix if IndiGo updates its UI.
 * 2. Waiting: prefer waitForSelector / waitForLoadState over fixed timeouts.
 *    Fixed timeouts are used ONLY as last-resort buffers after load state changes.
 * 3. Popup detection: combined CSS selector string lets Playwright return on
 *    whichever popup element appears first, rather than polling each individually.
 * 4. Cookie banner: dismissed at the start to prevent it from blocking form fields.
 * 5. Error detection: after form submit, checks for known error indicators before
 *    waiting for the no-show button — gives a fast, specific error message.
 *
 * ─── Return contract ──────────────────────────────────────────────────────────
 * runIndigoAutomation() always returns an AutomationResult:
 *
 * @typedef {Object} AutomationResult
 * @property {number|null}  refundValue      - Refund amount from itnry table (e.g. 1227)
 * @property {string|null}  currency         - Currency code from itnry table (e.g. "INR")
 * @property {string}       refund_status    - One of the REFUND_STATUS constants
 * @property {string|null}  message          - Human-readable outcome / error text
 * @property {string}       rawPopupText     - Full text as extracted from popup
 * @property {string}       popupType        - 'success' (blue) | 'error' (red) | 'unknown'
 */

("use strict");

const { parseRefundText, isAlreadyRefundedText } = require("../utils/parser");
const { REFUND_STATUS } = require("../utils/constants");
const logger = require("../utils/logger");

// ── Target URL ────────────────────────────────────────────────────────────────
const INDIGO_EDIT_BOOKING_URL =
  "https://www.goindigo.in/edit-booking.html?linkNav=Edit%20Booking%7CChange%20your%20journey%7CTrips";

// ── Selector registry ─────────────────────────────────────────────────────────
// All CSS selectors are defined here — not scattered throughout the code.
// If IndiGo updates their markup, this is the only place to change.
const SEL = {
  // Booking form
  PNR_INPUT: 'input[name="pnr-booking-ref"]',
  LAST_NAME_INPUT: 'input[name="email-last-name"]',
  GET_ITINERARY_BTN: 'button[title="Get Itinerary"]',

  // Itinerary page
  // Gate-check paragraph — must be present before the no-show button is clicked.
  // If absent, the refund has already been processed.
  NO_SHOW_GATE_TEXT: "To claim the tax refund please",
  NO_SHOW_BTN: 'button[class="passenger-no-show-container__link"]',

  // Cookie / consent banner (IndiGo shows this on first visit)
  // If absent, the dismissal step is skipped gracefully.
  COOKIE_ACCEPT: [
    "#onetrust-accept-btn-handler",
    'button[aria-label="Accept cookies"]',
    ".cookie-accept-btn",
    ".consent-banner__accept",
  ],

  // Popup / modal candidates (tried in order — first visible match wins)
  // Broad list to survive minor UI changes.
  POPUP_CANDIDATES: [
    ".passenger-no-show-container__popup",
    ".no-show-popup",
    ".refund-confirmation",
    ".confirmation-popup",
    ".popup-content",
    ".modal-body p",
    ".modal-content p",
    '[role="dialog"] p',
    '[role="alertdialog"] p',
    ".toast-message",
    ".alert-message",
    ".notification-message",
    ".success-message",
    // Fallback: any paragraph inside a visible overlay
    ".overlay p",
  ],

  // Indicators that the form submission failed (wrong PNR / last name)
  ERROR_INDICATORS: [
    ".error-message",
    ".booking-not-found",
    ".invalid-pnr",
    '[data-error="true"]',
    ".alert-danger",
    ".error-container",
  ],
};

// ── Timeouts (ms) ─────────────────────────────────────────────────────────────
// All page navigation and load-state waits use timeout: 0 (wait indefinitely).
// Playwright will not throw a TimeoutError — it simply keeps waiting until the
// page/element is ready, however long that takes. No browser refresh occurs.
//
// The only short timeout is COOKIE_BANNER — the banner either exists immediately
// on page load or not at all; there is no reason to wait long for it.
const TIMEOUTS = {
  COOKIE_BANNER: 3000, // Short — cookie banner either exists immediately or not at all
};

// ── Step 1: Navigate to the IndiGo edit-booking page ─────────────────────────

/**
 * Navigates to the IndiGo edit-booking URL and waits for the PNR input
 * to be visible before returning. This confirms the form page loaded correctly.
 *
 * @param {import('playwright').Page} page
 */
const navigateToBookingPage = async (page) => {
  logger.debug(`Navigating to IndiGo edit-booking URL`);

  await page.goto(INDIGO_EDIT_BOOKING_URL, {
    waitUntil: "domcontentloaded", // Don't wait for full networkidle — IndiGo has analytics
    timeout: 0, // No timeout — wait as long as the page needs to load
  });

  // Wait for the PNR input — proof the form rendered correctly.
  // timeout: 0 means wait indefinitely; no error thrown on slow connections.
  await page.waitForSelector(SEL.PNR_INPUT, {
    state: "visible",
    timeout: 0,
  });

  logger.debug("Booking page loaded — PNR input is visible");
  console.log("Booking page loaded — PNR input is visible");
};

// ── Step 2: Dismiss cookie / consent banner ───────────────────────────────────

/**
 * Attempts to click the cookie consent accept button.
 * Silently skips if none of the known selectors exist (e.g., already accepted).
 *
 * Must run BEFORE filling the form to prevent the banner from overlapping inputs.
 *
 * @param {import('playwright').Page} page
 */
const dismissCookieBanner = async (page) => {
  for (const selector of SEL.COOKIE_ACCEPT) {
    try {
      const btn = page.locator(selector);
      const isVisible = await btn
        .isVisible({ timeout: TIMEOUTS.COOKIE_BANNER })
        .catch(() => false);

      if (isVisible) {
        await btn.click({ timeout: TIMEOUTS.COOKIE_BANNER });
        logger.debug(`Cookie banner dismissed via: ${selector}`);
        console.log(`Cookie banner dismissed via: ${selector}`);
        return;
      }
    } catch {
      // This selector didn't match — try the next one
    }
  }

  logger.debug("No cookie banner found — skipping dismissal");
  console.log("No cookie banner found — skipping dismissal");
};

// ── Step 3: Fill the booking form ─────────────────────────────────────────────

/**
 * Clears and fills the PNR and last-name inputs, then clicks "Get Itinerary".
 *
 * Uses `fill()` (which clears then types) rather than `type()` to avoid
 * leftover characters from any pre-filled values.
 *
 * @param {import('playwright').Page} page
 * @param {string} pnr          - Booking reference (e.g., "UYW15R")
 * @param {string} matchedName  - Passenger last name (e.g., "Das")
 */
const fillBookingForm = async (page, pnr, matchedName) => {
  logger.debug(`Filling form — PNR: ${pnr} | LastName: ${matchedName}`);
  console.log(`Filling form — PNR: ${pnr} | LastName: ${matchedName}`);

  const pnrInput = page.locator(SEL.PNR_INPUT);
  const lastNameInput = page.locator(SEL.LAST_NAME_INPUT);

  // Clear any pre-filled values before typing
  await pnrInput.clear();
  await pnrInput.fill(pnr);
  await page.waitForTimeout(1000);

  await lastNameInput.clear();
  await lastNameInput.fill(matchedName);
  await page.waitForTimeout(1000);

  logger.debug('Form filled — clicking "Get Itinerary"');
  console.log('Form filled — clicking "Get Itinerary"');

  const getItineraryBtn = page.locator(SEL.GET_ITINERARY_BTN);
  await getItineraryBtn.click();
  //   await Promise.all([
  //   page.waitForFunction(() => {
  //     return (
  //       document.querySelector('button.passenger-no-show-container__link') ||
  //       document.body.innerText.includes('No Show') ||
  //       document.querySelector('.error-message')
  //     );
  //   }, { timeout: 60000 }),
  //   getItineraryBtn.click()
  // ]);
  // await page.waitForTimeout(8000);
  // await page.waitForLoadState('networkidle');
  //   await page.screenshot({
  //   path: `screenshots/${pnr}.png`,
  //   fullPage: true
  // });
};

// ── Step 4: Wait for the itinerary page ───────────────────────────────────────

/**
 * Waits for the itinerary results page to fully load after form submission.
 *
 * Strategy:
 *   1. waitForLoadState('networkidle') — waits for all in-flight XHR/fetch to settle
 *   2. Checks for error indicators — fast fail with descriptive error if PNR invalid
 *   3. Confirms presence of the no-show button OR a booking-summary element
 *
 * @param {import('playwright').Page} page
 */
const waitForItineraryPage = async (page) => {
  logger.debug("Waiting for itinerary page to load...");
  console.log("Waiting for itinerary page to load...");

  // Wait for network activity to settle — IndiGo loads booking data via XHR.
  // timeout: 0 — waits however long is needed for all XHR/fetch calls to settle.
  // await page.waitForLoadState('networkidle', { timeout: 0 });

  // ── Check for error state ─────────────────────────────────────────────────
  // If the PNR/last-name combination is wrong, IndiGo shows an error message.
  // Detect it early so the retry loop gets a meaningful error instead of timing out.
  const errorSelector = SEL.ERROR_INDICATORS.join(", ");
  const errorEl = page.locator(errorSelector).first();
  const hasError = await errorEl
    .isVisible({ timeout: 2000 })
    .catch(() => false);

  if (hasError) {
    const errorText = await errorEl
      .textContent()
      .catch(() => "Unknown booking error");
    throw new Error(`IndiGo booking error: ${errorText.trim()}`);
  }

  logger.debug("Itinerary page loaded successfully");
  console.log("Itinerary page loaded successfully");
  page.screenshot({
    path: `screenshots/${pnr}.png`,
    fullPage: true,
  });
};

// ── Step 5: Click the No-Show button ─────────────────────────────────────────

/**
 * @typedef {Object} NoShowClickResult
 * @property {boolean} found   - Whether the button existed on the page
 * @property {string}  [reason] - Human-readable reason when found = false
 */

/**
 * Attempts to find and click the passenger no-show button.
 *
 * Gate check: first verifies the paragraph
 * "Passenger(s) in this PNR is No Show. To claim the tax refund please"
 * is present on the page. If that text is absent the refund has already been
 * processed (or is not applicable) — returns { found: false } immediately
 * without looking for the button.
 *
 * Returns { found: false } in all non-actionable cases — this is not an error;
 * the caller maps it to the Already_Refunded outcome.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<NoShowClickResult>}
 */
const clickNoShowButton = async (page, pnr, matchedName) => {
  console.log("Checking for text for Noshow");
  await page.waitForTimeout(8000);
  // await page.waitForLoadState('networkidle');

  // await page.waitForSelector('p:has-text("Your itinerary is generated")', {
  //   state: "visible",
  //   timeout: 0,
  // });
  // const isExists = await page
  //   .locator('p:has-text("Your itinerary is generated")')
  //   .isVisible()
  //   .catch(() => false);


  //   await page.screenshot({
  //   path: `screenshots/${pnr}_${matchedName}.png`,
  //   fullPage: true
  // });
  // console.log("Screen shot taken");
  if (!isExists) {
    return false;
  }
  // ── Gate check: confirm the no-show eligibility paragraph is present ───────
  // page.getByText does a substring match, so partial text is fine.
  // const gateTextLocator = page.getByText(SEL.NO_SHOW_GATE_TEXT, { exact: false });
  // // timeout: 0 — page is already fully loaded (networkidle passed), so check
  // // immediately. If the text isn't in the DOM right now, it won't appear later.
  // const gateTextVisible = await gateTextLocator.first().isVisible({ timeout: 0 }).catch(() => false);

  // if (!gateTextVisible) {
  //   logger.info('No-show eligibility text not found — marking as already refunded');
  //   return {
  //     found: false,
  //     reason: `Gate text "${SEL.NO_SHOW_GATE_TEXT}" not present on itinerary page`,
  //   };
  // }

  // logger.debug('No-show eligibility text confirmed — looking for no-show button');
  // console.log("text for Noshow found");

  // ── Now look for the button ───────────────────────────────────────────────
  const btn = page.locator(SEL.NO_SHOW_BTN);
  const isVisible = await btn.isVisible({ timeout: 5000 }).catch(() => false);

  console.log("Checking for button for Noshow");
  if (!isVisible) {
    logger.info(
      "No-show button not found despite eligibility text — likely already refunded",
    );
    return {
      found: false,
      reason: `Selector "${SEL.NO_SHOW_BTN}" not found or not visible on itinerary page`,
    };
  }

  logger.debug("No-show button found — clicking");
  console.log("button for Noshow Found");
  await page.waitForTimeout(5000);
  await btn.click();
  logger.debug("No-show button clicked");
  console.log("button for Noshow Clicked");
  await page.waitForLoadState('domcontentloaded');

  return { found: true };
};

// ── Step 6: Wait for and extract popup text ───────────────────────────────────

/**
 * Waits for the confirmation popup to appear after clicking the no-show button,
 * then extracts its text content and determines whether it is a success (blue)
 * or error (red) popup.
 *
 * Detection strategy:
 *   1. CSS class name keywords  — words like "error"/"danger" vs "success"/"info"
 *   2. Computed background-color — red-dominant vs blue-dominant RGB values
 *   3. Falls back to 'unknown' if neither check is conclusive
 *
 * @param {import('playwright').Page} page
 * @param {string} pnr
 * @param {string} matchedName
 * @returns {Promise<{ text: string, popupType: 'success'|'error'|'unknown' }>}
 *
 * @throws {Error} If no popup appears within the configured timeout.
 */
const extractPopupText = async (page, pnr, matchedName) => {
  await page.screenshot({
    path: `screenshots/popups/${pnr}_${matchedName}.png`,
    fullPage: true,
  });
  console.log("Screen shot taken");

  const combinedSelector = SEL.POPUP_CANDIDATES.join(", ");
  console.log("Finding Popup");
  logger.debug("Waiting for confirmation popup to appear...");

  // Wait for at least one popup candidate to become visible.
  // timeout: 0 — waits indefinitely after the no-show button is clicked.
  await page.waitForSelector(combinedSelector, {
    state: "visible",
    timeout: 0,
  });

  // Find whichever candidate is visible and has meaningful text,
  // then determine whether it is a red (error) or blue (success) popup.
  for (const selector of SEL.POPUP_CANDIDATES) {
    const locator = page.locator(selector).first();
    const isVisible = await locator.isVisible().catch(() => false);
    if (!isVisible) continue;

    const text = await locator.textContent().catch(() => null);
    if (!text || text.trim().length <= 10) continue;

    // ── 1. Check CSS class name for color keywords ──────────────────────────
    const className = await locator.getAttribute("class").catch(() => "");
    const lowerClass = (className || "").toLowerCase();
    let popupType = "unknown";

    if (/error|danger|fail|red/.test(lowerClass)) {
      popupType = "error";
    } else if (/success|confirm|blue|info/.test(lowerClass)) {
      popupType = "success";
    } else {
      // ── 2. Fallback: computed background-color ──────────────────────────
      const bgColor = await locator
        .evaluate((el) => window.getComputedStyle(el).backgroundColor)
        .catch(() => null);

      if (bgColor) {
        const m = bgColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        if (m) {
          const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
          if (r > g && r > b && r > 150) popupType = "error";      // Red dominant
          else if (b > r && b > g && b > 100) popupType = "success"; // Blue dominant
        }
      }
    }

    logger.debug(`Popup text extracted from: ${selector} | type: ${popupType}`);
    console.log(`Popup type detected: ${popupType}`);
    return { text: text.trim(), popupType };
  }

  // If every candidate was visible but had no useful text, fall back to page body.
  logger.warn(
    "Popup appeared but individual selectors returned empty text — falling back to page body",
  );
  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");
  if (!bodyText) {
    throw new Error("Popup appeared but could not extract any text content");
  }

  return { text: bodyText.trim(), popupType: "unknown" };
};

// ── Main orchestrator ─────────────────────────────────────────────────────────

/**
 * Runs the full IndiGo automation flow for one (pnr, matchedName) pair.
 *
 * The `page` must be a fresh Playwright page (created by the caller per attempt).
 * This function does NOT open or close the page — that is the caller's responsibility.
 *
 * @param {import('playwright').Page} page
 * @param {string}      pnr
 * @param {string}      matchedName
 * @param {number|null} refundAmount  - Pre-fetched from itnry.RefundAmount (MySQL)
 * @param {string|null} currency      - Pre-fetched from itnry.Currency (MySQL)
 *
 * @returns {Promise<AutomationResult>}
 *
 * @throws {Error} Propagates unrecoverable errors so the retry layer can decide
 *                 whether to retry. Always-recoverable outcomes (Already_Refunded)
 *                 are returned as result objects instead of exceptions.
 */
const runIndigoAutomation = async (page, pnr, matchedName, refundAmount = null, currency = null) => {
  // console.log(page);
  logger.debug(`page details: ${page}`);
  // ── Disable default timeouts — wait indefinitely for every action ─────────
  // Individual steps use timeout: 0 explicitly. Setting the page-level defaults
  // to 0 ensures any Playwright action not already covered also has no cap.
  page.setDefaultNavigationTimeout(0);
  page.setDefaultTimeout(0);

  // ── Step 1: Navigate ──────────────────────────────────────────────────────
  await navigateToBookingPage(page);

  // ── Step 2: Dismiss cookie banner ─────────────────────────────────────────
  await dismissCookieBanner(page);

  // ── Step 3: Fill form + submit ────────────────────────────────────────────
  await fillBookingForm(page, pnr, matchedName);

  // ── Step 4: Wait for itinerary page (will throw on booking error) ─────────
  // await waitForItineraryPage(page);

  console.log("At step 5: clicking on Noshow button");
  // ── Step 5: Click no-show button ──────────────────────────────────────────
  const noShowResult = await clickNoShowButton(page, pnr, matchedName);
  // console.log(`noShowResult: ${noShowResult}`);
  logger.debug(`noShowResult: ${noShowResult}`);

  if (!noShowResult.found) {
    // Button absent = refund already processed by another means, or not applicable
    return {
      refundValue: null,
      currency: null,
      refund_status: REFUND_STATUS.ALREADY_REFUNDED,
      message: noShowResult.reason,
      rawPopupText: "",
    };
  }

  // ── Step 6: Extract popup text + detect red/blue type ────────────────────
  const { text: rawPopupText, popupType } = await extractPopupText(page, pnr, matchedName);
  logger.info(
    `Popup text: "${rawPopupText.substring(0, 120)}${rawPopupText.length > 120 ? "..." : ""}" | type: ${popupType}`,
  );
  console.log(`Raw popup text: ${rawPopupText} | type: ${popupType}`);

  // ── Step 7: Map popup colour → outcome ───────────────────────────────────

  // Red popup — IndiGo returned an explicit error; save the message and stop.
  if (popupType === "error") {
    return {
      refundValue: null,
      currency: null,
      refund_status: REFUND_STATUS.ERROR_RESPONSE,
      message: rawPopupText,
      rawPopupText,
      popupType,
    };
  }

  // Check if the popup itself says it's already been refunded
  if (isAlreadyRefundedText(rawPopupText)) {
    return {
      refundValue: null,
      currency: null,
      refund_status: REFUND_STATUS.ALREADY_REFUNDED,
      message: `Popup indicated already refunded: "${rawPopupText.substring(0, 200)}"`,
      rawPopupText,
      popupType,
    };
  }

  // Blue (success) or unknown — use RefundAmount / Currency from the itnry table.
  // Fall back to parsing the popup text only when the record had no pre-fetched values.
  let finalAmount = refundAmount;
  let finalCurrency = currency;
  if (finalAmount === null) {
    const parsed = parseRefundText(rawPopupText);
    finalAmount = parsed.amount;
    finalCurrency = parsed.currency;
  }

  if (finalAmount === null) {
    // No amount from either source — throw to trigger retry
    throw new Error(
      `Popup appeared but no refund amount found (itnry table empty, popup: "${rawPopupText.substring(0, 200)}")`,
    );
  }

  // ── Success ───────────────────────────────────────────────────────────────
  return {
    refundValue: finalAmount,
    currency: finalCurrency,
    refund_status: REFUND_STATUS.COMPLETE,
    message: `Refund of ${finalCurrency} ${finalAmount} confirmed via popup`,
    rawPopupText,
    popupType,
  };
};

module.exports = {
  runIndigoAutomation,
  // Exported for unit testing individual steps
  navigateToBookingPage,
  dismissCookieBanner,
  fillBookingForm,
  waitForItineraryPage,
  clickNoShowButton,
  extractPopupText,
};
