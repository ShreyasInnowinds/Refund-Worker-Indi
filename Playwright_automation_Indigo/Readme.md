You are a senior backend + automation engineer.

Build a complete production-grade system for automating IndiGo No-Show tax refund processing.

Tech Stack:
- Node.js (TypeScript)
- Playwright (NOT Puppeteer)
- MongoDB (native driver or mongoose)
- dotenv for config

--------------------------------------------------

📌 SYSTEM OVERVIEW

We have an existing MongoDB collection: `itnry`

Each document looks like:

{
  "pnr": "UC322B",
  "matchedName": "A",
  "Status": "NoShow",
  "isRefundProcessed": false,
  "isToShowTaxRefund": true,
  "RefundAmount": 773,
  "Currency": "INR",
  "WorkerStatus": "NEW",
  "batchId": "26-03-2026-7L9A"
}

We need to:

1. Fetch eligible records from `itnry`
2. Run Playwright automation for each
3. Extract popup result (success/error)
4. Store results in new collection: `refund_book`

--------------------------------------------------

📌 INPUT

BatchId will be passed via CLI:

Example:
npm run start -- --batchId=26-03-2026-7L9A

--------------------------------------------------

📌 FILTER CONDITIONS (VERY IMPORTANT)

Fetch only records where:

- Status = "NoShow"
- WorkerStatus = "NEW" or "IN_PROGRESS"
- batchId = CLI batchId

--------------------------------------------------

📌 OUTPUT COLLECTION: refund_book

Each processed record must be stored like:

{
  pnr,
  matchedName,
  batchId,
  RefundAmt_from_itnry,
  Refund_Amt_from_UI_message,
  currency_from_itnry,
  currency_from_UI_message,
  finalStatus: "Success" | "Error" | "Already_Refunded",
  rawMessage,
  processedAt: Date
}

--------------------------------------------------

📌 AUTOMATION FLOW

Refer to this existing logic (important reference):
- navigateToBookingPage
- dismissCookieBanner
- fillBookingForm
- clickNoShowButton
- extractPopupText

Use this as base but IMPROVE it.

IMPORTANT CHANGES:

❌ Do NOT use Puppeteer
✅ Use Playwright properly

--------------------------------------------------

📌 CRITICAL REQUIREMENT (POPUP HANDLING)

Popup appears only for 2–3 seconds.

You MUST:

1. Start listening BEFORE clicking NoShow button
2. Capture popup instantly

Target DOM:

.skyplus-design-toast-container li.desc

Fallback:
- document.body.innerText

--------------------------------------------------

📌 POPUP TYPES

1. ERROR:
- "Something went wrong"
→ finalStatus = "Error"

2. SUCCESS (Refund processed):
- "Refund of INR XXXX is processed"
→ extract amount + currency

3. OTHER BUSINESS CASES:
- Already claimed
- Refund unavailable
- Old PNR

→ classify as "Success" or "Error" or "OTHER BUSINESS CASES"

--------------------------------------------------

📌 PARSING RULES

Extract:

Refund_Amt_from_UI_message:
- From "Refund of INR 2200"

currency_from_UI_message:
- INR / ₹ / $

If not found → null

--------------------------------------------------

📌 SYSTEM DESIGN

Structure the project cleanly:

src/
  config/
    env.ts
    db.ts

  services/
    indigo.service.ts
    popup.service.ts
    worker.service.ts

  repositories/
    itnry.repo.ts
    refund.repo.ts

  utils/
    parser.ts
    logger.ts

  scripts/
    runWorker.ts

--------------------------------------------------

📌 WORKER LOGIC

- Process records sequentially or with limited concurrency (max 3–5)
- For each record:
  - Lock it (set WorkerStatus = "PROCESSING")
  - Run automation
  - Save result to refund_book
  - Update itnry:
      WorkerStatus = "PROCESSED"

--------------------------------------------------

📌 ERROR HANDLING

- Retry ONLY for system errors (max 2 retries)
- Do NOT retry business errors

--------------------------------------------------

📌 PLAYWRIGHT BEST PRACTICES

- Use browser reuse (not launch per record)
- Use context per record
- Use timeout: 0 for critical waits
- Avoid unnecessary waitForTimeout

--------------------------------------------------

📌 LOGGING

Log:
- start/end of each PNR
- popup captured
- errors

--------------------------------------------------

📌 ENV VARIABLES (.env)

MONGO_URI=
DB_NAME=

--------------------------------------------------

📌 EXPECTED OUTPUT

Claude should generate:

1. Full TypeScript project
2. Modular clean architecture
3. Working Playwright automation
4. MongoDB integration
5. CLI runner

--------------------------------------------------

📌 IMPORTANT

Focus on:
- Reliability (popup capture)
- Clean architecture
- Production readiness

Do NOT give pseudo code.
Generate complete working code.
