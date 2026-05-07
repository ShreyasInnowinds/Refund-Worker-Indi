import { MongoClient, Db } from 'mongodb';
import mongoose from 'mongoose';
import { logger } from '../utils/logger';

let client: MongoClient;
let db: Db;

export async function connectDB(uri: string, dbName: string): Promise<void> {
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbName);
  logger.info(`Native MongoClient connected — database: ${dbName}`);

  // Mongoose models in repositories still rely on this connection.
  await mongoose.connect(uri, { dbName });
  logger.info(`Mongoose connected — database: ${dbName}`);
}

export function getDB(): Db {
  if (!db) throw new Error('Database not initialized. Call connectDB first.');
  return db;
}

export async function closeDB(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (client) await client.close();
}
