import winston from "winston";
import path from "path";
import { ENV } from "../config/env";

const LOG_DIR = path.resolve(__dirname, "../../", ENV.LOG_DIR);

export const logger = winston.createLogger({
  level: ENV.LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack }) => {
      return stack
        ? `${timestamp} [${level.toUpperCase()}] ${message}\n${stack}`
        : `${timestamp} [${level.toUpperCase()}] ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, stack }) => {
          return stack
            ? `${timestamp} ${level}: ${message}\n${stack}`
            : `${timestamp} ${level}: ${message}`;
        })
      ),
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, "combined.log"),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, "error.log"),
      level: "error",
      maxsize: 10 * 1024 * 1024,
      maxFiles: 3,
    }),
  ],
});
