/**
 * Extracts refund amount and currency from IndiGo popup text.
 *
 * Patterns (priority order):
 *  1. "Refund of INR 1227 is processed..."
 *  2. "INR 1227 is processed in your account..."
 *  3. Fallback: any CAPS(2-4) followed by a number
 */

export interface ParsedRefund {
  amount: number | null;
  currency: string | null;
}

const PATTERN_REFUND_OF =
  /refund\s+of\s+([A-Z₹$]{1,4})\s+([\d,]+(?:\.\d+)?)/i;

const PATTERN_CURRENCY_AMOUNT_VERB =
  /\b([A-Z₹$]{1,4})\s+([\d,]+(?:\.\d+)?)\s+(?:is\s+processed|will\s+be\s+credited)/i;

const PATTERN_GENERIC = /\b([A-Z]{2,4})\s+([\d,]+(?:\.\d+)?)\b/;

const CURRENCY_IGNORE = new Set([
  "PNR",
  "REF",
  "OTP",
  "API",
  "URL",
  "ID",
  "PDF",
]);

export function parseRefundText(text: string): ParsedRefund {
  if (!text || typeof text !== "string") {
    return { amount: null, currency: null };
  }

  const normalized = text.trim();
  const patterns = [
    PATTERN_REFUND_OF,
    PATTERN_CURRENCY_AMOUNT_VERB,
    PATTERN_GENERIC,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;

    let candidateCurrency = match[1].toUpperCase();
    const rawAmount = match[2];

    // Normalize currency symbols
    if (candidateCurrency === "₹") candidateCurrency = "INR";
    if (candidateCurrency === "$") candidateCurrency = "USD";

    if (CURRENCY_IGNORE.has(candidateCurrency)) continue;

    const amount = parseFloat(rawAmount.replace(/,/g, ""));
    if (isNaN(amount) || amount <= 0) continue;

    return { amount, currency: candidateCurrency };
  }

  return { amount: null, currency: null };
}

export function isAlreadyRefundedText(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes("already refunded") ||
    lower.includes("already processed") ||
    lower.includes("already claimed") ||
    lower.includes("refund has been processed") ||
    lower.includes("no refund applicable") ||
    lower.includes("not eligible") ||
    lower.includes("refund unavailable")
  );
}

export function isErrorText(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes("something went wrong") ||
    lower.includes("error") ||
    lower.includes("failed") ||
    lower.includes("try again") ||
    lower.includes("unable to process")
  );
}

/**
 * Classify popup text into a finalStatus.
 */
export function classifyPopupText(
  text: string
): "Success" | "Error" | "Already_Refunded" {
  if (isAlreadyRefundedText(text)) return "Already_Refunded";
  if (isErrorText(text)) return "Error";

  // If it contains refund amount info, it's success
  const parsed = parseRefundText(text);
  if (parsed.amount !== null) return "Success";

  // Default: treat unknown text as error for safety
  return "Error";
}
