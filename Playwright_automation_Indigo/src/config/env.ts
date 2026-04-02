import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

export const ENV = {
  // MongoDB
  MONGO_URI: process.env.MONGO_URI || "mongodb://localhost:27017",
  DB_NAME: process.env.DB_NAME || "test",

  // Browser
  BROWSER_HEADLESS: process.env.BROWSER_HEADLESS === "true",
  BROWSER_SLOW_MO_MS: parseInt(process.env.BROWSER_SLOW_MO_MS || "0", 10),

  // Worker
  MAX_RETRIES: parseInt(process.env.MAX_RETRIES || "2", 10),
  INTER_RECORD_DELAY_MS: parseInt(
    process.env.INTER_RECORD_DELAY_MS || "20000",
    10
  ),

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || "info",
  LOG_DIR: process.env.LOG_DIR || "logs",
} as const;
