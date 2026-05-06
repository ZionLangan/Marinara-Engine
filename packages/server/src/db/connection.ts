// ──────────────────────────────────────────────
// Database Connection
// ──────────────────────────────────────────────
import { logger } from "../lib/logger.js";
import * as schema from "./schema/index.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  getDatabaseDriver,
  getDatabaseFilePath,
  getLegacyDatabaseImportPaths,
  isFileStorageBackend,
} from "../config/runtime-config.js";
import { createFileNativeDB, type FileNativeStoreController } from "./file-backed-store.js";

type DbCleanup = () => void | Promise<void>;
type DrizzleDB = ReturnType<typeof import("drizzle-orm/libsql").drizzle<typeof schema>>;

let dbPromise: Promise<DB> | null = null;
let dbCleanup: DbCleanup | null = null;
let fileStore: FileNativeStoreController | null = null;

async function createWithLibsql(dbPath: string): Promise<DB> {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");

  const client = createClient({ url: `file:${dbPath}` });
  try {
    await client.execute("PRAGMA journal_mode=WAL");
    await client.execute("PRAGMA synchronous=NORMAL");
    await client.execute("PRAGMA busy_timeout=5000");
    await client.execute("PRAGMA foreign_keys=ON");
  } catch (err) {
    client.close();
    throw err;
  }

  dbCleanup = () => client.close();
  return drizzle(client, { schema }) as unknown as DB;
}

async function createDB(dbPath: string): Promise<DB> {
  mkdirSync(dirname(dbPath), { recursive: true });

  const driver = getDatabaseDriver();
  if (driver && driver !== "libsql") {
    throw new Error(
      `DATABASE_DRIVER=${driver} is no longer bundled. Marinara v1.5.7 uses file storage by default; ` +
        `legacy STORAGE_BACKEND=sqlite only supports DATABASE_DRIVER=libsql.`,
    );
  }

  return createWithLibsql(dbPath);
}

async function createWithFileStorage(dbPaths: string[]): Promise<DB> {
  const db = await createFileNativeDB(dbPaths);
  fileStore = db._fileStore;
  dbCleanup = async () => {
    await fileStore?.close();
    fileStore = null;
  };
  return db as unknown as DB;
}

export async function getDB() {
  if (!dbPromise) {
    const dbPath = getDatabaseFilePath();
    if (isFileStorageBackend()) {
      dbPromise = createWithFileStorage(getLegacyDatabaseImportPaths());
      return dbPromise;
    }
    if (!dbPath) {
      throw new Error("DATABASE_URL must resolve to a legacy SQLite file when STORAGE_BACKEND=sqlite");
    }
    dbPromise = createDB(dbPath);
  }
  return dbPromise;
}

export async function flushDB() {
  await fileStore?.flush();
}

export async function closeDB() {
  const activePromise = dbPromise;
  if (!activePromise) {
    return;
  }

  dbPromise = null;

  try {
    await activePromise;
  } catch (err) {
    logger.error(err, "[db] Failed to initialize database before shutdown");
    dbCleanup = null;
    return;
  }

  const cleanup = dbCleanup;
  dbCleanup = null;
  if (!cleanup) {
    return;
  }

  try {
    await cleanup();
  } catch (err) {
    logger.error(err, "[db] Failed to close database");
  }
}

export type DB = DrizzleDB;
