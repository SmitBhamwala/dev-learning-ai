import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, readJsonFile, readTextFile } from "./fsutil.js";
import { DB_SCHEMA_VERSION, type Database } from "./store.js";
import type { LearningService } from "./service.js";

/**
 * Backup and restore. A backup is one portable JSON file holding the whole
 * database and the global configuration. Restore validates the file, takes
 * a safety backup of the current state first, then replaces it.
 */

export const BACKUP_FORMAT = "dev-learning-ai-backup";

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: 1;
  createdAt: string;
  dbSchemaVersion: number;
  db: Database;
  globalConfig?: string;
}

export async function createBackup(svc: LearningService, path?: string): Promise<string> {
  const db = await svc.store.exportAll();
  const createdAt = svc.now().toISOString();
  const file: BackupFile = {
    format: BACKUP_FORMAT,
    version: 1,
    createdAt,
    dbSchemaVersion: db.meta.schemaVersion,
    db,
    globalConfig: await readTextFile(svc.paths.configFile),
  };
  const target = path ?? join(svc.paths.backups, `backup-${createdAt.replace(/[:.]/g, "-")}.json`);
  await atomicWrite(target, JSON.stringify(file));
  return target;
}

export async function readBackup(path: string): Promise<BackupFile> {
  const file = await readJsonFile<BackupFile>(path);
  if (!file || file.format !== BACKUP_FORMAT) throw new Error(`${path} is not a dev-learning-ai backup`);
  if (file.dbSchemaVersion > DB_SCHEMA_VERSION)
    throw new Error("This backup was made by a newer version; upgrade dev-learning-ai first");
  if (!file.db?.meta || typeof file.db.knowledge !== "object")
    throw new Error("Backup is missing required collections");
  return file;
}

export async function restoreBackup(
  svc: LearningService,
  path: string,
): Promise<{ safetyBackup: string; restoredFrom: string }> {
  const file = await readBackup(path);
  const safetyBackup = await createBackup(svc);
  await svc.store.replaceAll(file.db);
  if (file.globalConfig !== undefined) await atomicWrite(svc.paths.configFile, file.globalConfig);
  // Validate what was restored by reading it back through the schema checks.
  const check = await svc.store.read();
  if (svc.store.diagnostics.quarantined.length) {
    throw new Error(
      `Restored data failed validation (quarantined: ${svc.store.diagnostics.quarantined.join(", ")}); the safety backup is ${safetyBackup}`,
    );
  }
  void check;
  return { safetyBackup, restoredFrom: path };
}

export async function listBackups(svc: LearningService): Promise<string[]> {
  try {
    return (await readdir(svc.paths.backups))
      .filter((n) => n.endsWith(".json"))
      .sort()
      .reverse()
      .map((n) => join(svc.paths.backups, n));
  } catch {
    return [];
  }
}
