import { z } from "zod";
import { stableHash } from "../domain/ids.js";

/**
 * The normalized, provider-agnostic event contract. Every agent adapter
 * (Claude Code Mods, manual CLI ingestion, future Codex/Cursor adapters)
 * converts its native signals into these events.
 *
 * Generic metadata may not carry secrets, whole source files, full prompts or
 * transcripts: `sanitizeEvent` enforces size and key limits.
 */

export const EVENT_SCHEMA_VERSION = 1;

export const EventTypeSchema = z.enum([
  "session.started",
  "session.ended",
  "task.started",
  "task.progressed",
  "task.completed",
  "code.changed",
  "test.completed",
  "pr.created",
  "pr.reviewed",
  "assessment.started",
  "assessment.completed",
]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const ChangeKindSchema = z.enum(["added", "modified", "deleted", "renamed"]);

export const CodeChangeSummarySchema = z.object({
  path: z.string().max(500),
  kind: ChangeKindSchema.default("modified"),
  linesAdded: z.number().int().min(0).optional(),
  linesRemoved: z.number().int().min(0).optional(),
  language: z.string().max(40).optional(),
  /** Short identifiers/keywords observed in the change (never whole lines unless privacy allows). */
  symbols: z.array(z.string().max(80)).max(50).default([]),
  /** Optional redacted excerpt; dropped unless privacy.store_code_snippets permits it. */
  excerpt: z.string().max(2000).optional(),
});
export type CodeChangeSummary = z.infer<typeof CodeChangeSummarySchema>;

export const RepositoryContextSchema = z.object({
  root: z.string().optional(),
  branch: z.string().max(200).optional(),
  remote: z.string().max(500).optional(),
  workspace: z.string().max(200).optional(),
});
export type RepositoryContext = z.infer<typeof RepositoryContextSchema>;

export const TaskContextSchema = z.object({
  id: z.string().min(1).max(200),
  /** One-line, redacted title. Full prompts are never stored by default. */
  title: z.string().max(300).optional(),
  urgency: z.enum(["normal", "urgent", "incident"]).default("normal"),
  turns: z.number().int().min(0).default(0),
  toolCalls: z.record(z.string(), z.number().int().min(0)).default({}),
  tests: z
    .object({ ran: z.number().int().min(0).default(0), failed: z.number().int().min(0).default(0) })
    .default({ ran: 0, failed: 0 }),
  status: z.enum(["in-progress", "completed", "aborted"]).default("in-progress"),
});
export type TaskContext = z.infer<typeof TaskContextSchema>;

export const TechnologyContextSchema = z.object({
  technology: z.string().max(80),
  version: z.string().max(80).optional(),
});

export const LearningEventSchema = z.object({
  id: z.string().min(1).max(200),
  schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
  type: EventTypeSchema,
  timestamp: z.string().datetime({ offset: true }),
  source: z.object({
    providerId: z.string().min(1).max(80),
    providerVersion: z.string().max(80).optional(),
    sessionId: z.string().max(200).optional(),
  }),
  developerId: z.string().min(1).max(200),
  projectId: z.string().max(200).optional(),
  /** Correlates the events of one task across turns, restarts and compaction. */
  correlationId: z.string().max(200).optional(),
  repository: RepositoryContextSchema.optional(),
  task: TaskContextSchema.optional(),
  changes: z.array(CodeChangeSummarySchema).max(500).optional(),
  technologies: z.array(TechnologyContextSchema).max(100).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type LearningEvent = z.infer<typeof LearningEventSchema>;
export type LearningEventInput = z.input<typeof LearningEventSchema>;

const FORBIDDEN_METADATA_KEYS =
  /^(prompt|transcript|messages|source|content|file_content|env|token|secret|password|api_?key)$/i;
const MAX_METADATA_BYTES = 4096;

export class EventValidationError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = "EventValidationError";
  }
}

/** Validates, strips forbidden metadata and bounds the payload. Throws on invalid input. */
export function normalizeEvent(input: unknown): LearningEvent {
  const parsed = LearningEventSchema.safeParse(input);
  if (!parsed.success) {
    throw new EventValidationError(
      "Invalid learning event",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return sanitizeEvent(parsed.data);
}

export function sanitizeEvent(event: LearningEvent): LearningEvent {
  if (!event.metadata) return event;
  const metadata: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event.metadata)) {
    if (FORBIDDEN_METADATA_KEYS.test(k)) continue;
    if (typeof v === "string" && v.length > 500) continue;
    metadata[k] = v;
  }
  if (JSON.stringify(metadata).length > MAX_METADATA_BYTES)
    return { ...event, metadata: { truncated: true } };
  return { ...event, metadata };
}

/**
 * Idempotency key. Two deliveries of the same logical event (a retry, a
 * replayed hook after a restart) produce the same key even with new ids.
 */
export function eventIdempotencyKey(event: LearningEvent): string {
  const changes = (event.changes ?? []).map((c) => `${c.kind}:${c.path}`).sort();
  return stableHash(
    JSON.stringify([
      event.type,
      event.source.providerId,
      event.source.sessionId ?? "",
      event.correlationId ?? event.task?.id ?? event.id,
      event.projectId ?? "",
      changes,
    ]),
  );
}
