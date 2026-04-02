import mongoose from "mongoose";
import { ENV } from "./env";
import { logger } from "../utils/logger";

let isConnected = false;

export async function connectDB(): Promise<void> {
  if (isConnected) {
    logger.warn("MongoDB already connected — skipping");
    return;
  }

  const uri = `${ENV.MONGO_URI}/${ENV.DB_NAME}`;
  logger.info(`Connecting to MongoDB: ${ENV.MONGO_URI}/${ENV.DB_NAME}`);

  await mongoose.connect(uri, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });

  isConnected = true;
  logger.info("MongoDB connected successfully");
}

export async function disconnectDB(): Promise<void> {
  if (!isConnected) return;

  await mongoose.disconnect();
  isConnected = false;
  logger.info("MongoDB disconnected");
}
