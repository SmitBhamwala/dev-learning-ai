import { randomUUID } from "node:crypto";
import { open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AssessmentSessionSchema,
  ConceptSchema,
  EvidenceSchema,
  KnowledgeStateSchema,
  ProjectSchema,
  QuestionSchema,
  ScoreChangeSchema,
  newId,
  type AssessmentSession,
  type Concept,
  type Evidence,
  type KnowledgeState,
  type LearningEvent,
  type LearningOpportunity,
  type Project,
  type Question,
  type RawLayer,
  type ScoreChange,
} from "@dev-learning-ai/core";
import { z } from "zod";
import { atomicWrite, ensureDir, readJsonFile, renameWithRetry, withLock } from "./fsutil.js";

/**
 * Structured persistence: the source of truth for transactional learning
 * state (Markdown/Obsidian are synchronised views). A small document store of
 * one JSON file per collection, chosen so the product has no native
 * dependency and its data stays inspectable and portable.
 *
 * Consistency: every write runs under an inter-process lock. Changed
 * collections are written to temp files, then a journal names them, then
 * they are renamed into place and the journal removed. On open, a journal
 * left by a crash is rolled forward, and orphaned temp files are discarded,
 * so a crash never leaves a half-applied transaction.
 *
 * Scale: designed for one developer's history (tens of thousands of records).
 * The StorageBackend boundary is where a SQLite backend would plug in.
 */

export const DB_SCHEMA_VERSION = 2;

export interface TaskRecord {
  id: string;
  projectId?: string;
  providerId: string;
  sessionId?: string;
  title?: string;
  urgency: "normal" | "urgent" | "incident";
  status: "in-progress" | "completed" | "aborted";
  startedAt: string;
  completedAt?: string;
  changedPaths: string[];
  changedLines: number;
  symbols: string[];
  technologies: { technology: string; version?: string }[];
  opportunities: LearningOpportunity[];
  skippedReason?: string;
  assessmentSessionId?: string;
  learningPaused?: boolean;
  offer?: "pending" | "accepted" | "deferred" | "declined" | "none";
}

export interface EventRecord {
  key: string;
  eventId: string;
  type: string;
  providerId: string;
  projectId?: string;
  taskId?: string;
  receivedAt: string;
  /** Minimal copy of the event; never includes snippets unless privacy allows. */
  event: LearningEvent;
}

export interface Meta {
  schemaVersion: number;
  developerId: string;
  createdAt: string;
  activeProjectId?: string;
  migrations: { version: number; at: string }[];
}

export interface Database {
  meta: Meta;
  projects: Record<string, Project>;
  knowledge: Record<string, KnowledgeState>;
  evidence: Record<string, Evidence>;
  evidenceKeys: Record<string, string>;
  changes: ScoreChange[];
  sessions: Record<string, AssessmentSession>;
  events: Record<string, EventRecord>;
  tasks: Record<string, TaskRecord>;
  questions: Record<string, Question>;
  concepts: Record<string, Concept>;
  sessionOverrides: Record<string, { layer: RawLayer; at: string }>;
}

export type CollectionName = keyof Database;
const COLLECTIONS: CollectionName[] = [
  "meta",
  "projects",
  "knowledge",
  "evidence",
  "evidenceKeys",
  "changes",
  "sessions",
  "events",
  "tasks",
  "questions",
  "concepts",
  "sessionOverrides",
];

const recordOf = <T extends z.ZodTypeAny>(s: T) => z.record(z.string(), s);
const VALIDATORS: Partial<Record<CollectionName, z.ZodTypeAny>> = {
  projects: recordOf(ProjectSchema),
  knowledge: recordOf(KnowledgeStateSchema),
  evidence: recordOf(EvidenceSchema),
  changes: z.array(ScoreChangeSchema),
  sessions: recordOf(AssessmentSessionSchema),
  questions: recordOf(QuestionSchema),
  concepts: recordOf(ConceptSchema),
};

export function knowledgeKey(scopeKey: string, conceptId: string): string {
  return `${scopeKey}|${conceptId}`;
}

function emptyDb(now: Date): Database {
  return {
    meta: {
      schemaVersion: DB_SCHEMA_VERSION,
      developerId: newId("dev"),
      createdAt: now.toISOString(),
      migrations: [],
    },
    projects: {},
    knowledge: {},
    evidence: {},
    evidenceKeys: {},
    changes: [],
    sessions: {},
    events: {},
    tasks: {},
    questions: {},
    concepts: {},
    sessionOverrides: {},
  };
}

/** Ordered migrations. Each upgrades the database by one version and must be idempotent. */
export const MIGRATIONS: { version: number; description: string; up(db: Database): void }[] = [
  {
    version: 2,
    description: "add evidenceKeys index and sessionOverrides",
    up(db) {
      db.evidenceKeys ??= {};
      for (const e of Object.values(db.evidence ?? {})) db.evidenceKeys[e.key] = e.id;
      db.sessionOverrides ??= {};
    },
  },
];

export interface StoreDiagnostics {
  recoveredJournal: boolean;
  removedTempFiles: number;
  quarantined: string[];
}

export class Store {
  private readonly dir: string;
  readonly diagnostics: StoreDiagnostics = { recoveredJournal: false, removedTempFiles: 0, quarantined: [] };
  private opened = false;

  constructor(
    dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.dir = dir;
  }

  get directory(): string {
    return this.dir;
  }

  private file(c: CollectionName): string {
    return join(this.dir, `${c}.json`);
  }

  private get lockFile(): string {
    return join(this.dir, ".lock");
  }

  private get journalFile(): string {
    return join(this.dir, "journal.json");
  }

  /** Recovers from interrupted writes, creates the database if absent and runs migrations. */
  async open(): Promise<void> {
    if (this.opened) return;
    await ensureDir(this.dir);
    await withLock(this.lockFile, async () => {
      await this.recover();
      const meta = await readJsonFile<Meta>(this.file("meta"));
      if (!meta) {
        await this.writeAll(emptyDb(this.now()), COLLECTIONS);
      } else if (meta.schemaVersion < DB_SCHEMA_VERSION) {
        const db = await this.load();
        this.migrate(db);
        await this.writeAll(db, COLLECTIONS);
      } else if (meta.schemaVersion > DB_SCHEMA_VERSION) {
        throw new Error(
          `The database was written by a newer version (schema ${meta.schemaVersion} > ${DB_SCHEMA_VERSION}). Upgrade dev-learning-ai.`,
        );
      }
    });
    this.opened = true;
  }

  private migrate(db: Database): void {
    for (const m of MIGRATIONS) {
      if (db.meta.schemaVersion < m.version) {
        m.up(db);
        db.meta.schemaVersion = m.version;
        db.meta.migrations = [
          ...(db.meta.migrations ?? []),
          { version: m.version, at: this.now().toISOString() },
        ];
      }
    }
  }

  private async recover(): Promise<void> {
    const journal = await readJsonFile<{ files: { tmp: string; target: string }[] }>(this.journalFile);
    if (journal) {
      for (const f of journal.files) {
        try {
          await renameWithRetry(f.tmp, f.target);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
      await rm(this.journalFile, { force: true });
      this.diagnostics.recoveredJournal = true;
    }
    for (const name of await readdir(this.dir)) {
      if (name.endsWith(".tmp")) {
        await rm(join(this.dir, name), { force: true });
        this.diagnostics.removedTempFiles++;
      }
    }
  }

  async load(): Promise<Database> {
    const db = emptyDb(this.now()) as unknown as Record<CollectionName, unknown>;
    for (const c of COLLECTIONS) {
      const value = await readJsonFile<unknown>(this.file(c));
      if (value === undefined) continue;
      const v = VALIDATORS[c];
      if (v) {
        const parsed = v.safeParse(value);
        if (!parsed.success) {
          const quarantine = `${this.file(c)}.corrupt-${Date.now()}`;
          await renameWithRetry(this.file(c), quarantine);
          this.diagnostics.quarantined.push(quarantine);
          continue;
        }
        db[c] = parsed.data;
      } else db[c] = value;
    }
    return db as unknown as Database;
  }

  /** A consistent snapshot for reading. Mutations to it are not persisted. */
  async read(): Promise<Database> {
    await this.open();
    return this.load();
  }

  /**
   * Runs `fn` against a fresh copy under the write lock and persists the
   * collections it changed atomically. Returns fn's result.
   */
  async transact<T>(fn: (db: Database) => T | Promise<T>): Promise<T> {
    await this.open();
    return withLock(this.lockFile, async () => {
      const db = await this.load();
      const before = new Map(COLLECTIONS.map((c) => [c, JSON.stringify(db[c])]));
      const result = await fn(db);
      const dirty = COLLECTIONS.filter((c) => JSON.stringify(db[c]) !== before.get(c));
      if (dirty.length) await this.writeAll(db, dirty);
      return result;
    });
  }

  private async writeAll(db: Database, collections: CollectionName[]): Promise<void> {
    await ensureDir(this.dir);
    const files: { tmp: string; target: string }[] = [];
    for (const c of collections) {
      const target = this.file(c);
      const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
      const fh = await open(tmp, "w");
      try {
        await fh.writeFile(JSON.stringify(db[c], null, c === "meta" ? 2 : 0), "utf8");
        await fh.sync();
      } finally {
        await fh.close();
      }
      files.push({ tmp, target });
    }
    if (files.length === 1) {
      await renameWithRetry(files[0]!.tmp, files[0]!.target);
      return;
    }
    await atomicWrite(this.journalFile, JSON.stringify({ files }));
    for (const f of files) await renameWithRetry(f.tmp, f.target);
    await rm(this.journalFile, { force: true });
  }

  /** Full export of every collection, for backup and portability. */
  async exportAll(): Promise<Database> {
    return this.read();
  }

  /** Replaces the whole database (used by restore after validation). */
  async replaceAll(db: Database): Promise<void> {
    await this.open();
    await withLock(this.lockFile, async () => {
      this.migrate(db);
      await this.writeAll(db, COLLECTIONS);
    });
  }
}
