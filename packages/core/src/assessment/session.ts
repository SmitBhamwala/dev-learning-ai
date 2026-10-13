import { z } from "zod";
import { KnowledgeScopeSchema } from "../domain/model.js";
import { VersionScopeSchema } from "../domain/version.js";

/**
 * The assessment session: a durable, checkpointed record of one learning
 * interaction. It is persisted after every step so a restart, a compaction
 * or a crashed hook never loses an in-progress assessment, and answering the
 * same item twice (a replayed event) is a no-op.
 */

export const AnswerRecordSchema = z.object({
  choiceIds: z.array(z.string()).optional(),
  text: z.string().max(5000).optional(),
  reasoning: z.string().max(5000).optional(),
  confidence: z.enum(["guessing", "low", "medium", "high"]).optional(),
});

export const EvaluationRecordSchema = z.object({
  correctness: z.number(),
  isCorrect: z.boolean(),
  reasoningScore: z.number().optional(),
  reasoningQuality: z.enum(["sound", "weak", "absent"]),
  calibration: z.string(),
  grade: z.number(),
  headline: z.string(),
  feedback: z.array(z.string()),
  explanation: z.string(),
  gradedBy: z.enum(["deterministic", "provider"]),
  rulesVersion: z.string(),
});

export const AssessmentItemSchema = z.object({
  questionId: z.string(),
  conceptId: z.string(),
  isNovelVariant: z.boolean(),
  selectionReason: z.string(),
  answer: AnswerRecordSchema.optional(),
  evaluation: EvaluationRecordSchema.optional(),
  answeredAt: z.string().optional(),
  skipped: z.boolean().default(false),
});
export type AssessmentItem = z.infer<typeof AssessmentItemSchema>;

export const AssessmentSessionSchema = z.object({
  id: z.string(),
  schemaVersion: z.literal(1).default(1),
  projectId: z.string().optional(),
  scope: KnowledgeScopeSchema,
  origin: z.object({
    kind: z.enum(["task", "review", "manual", "interview"]),
    taskId: z.string().optional(),
    providerId: z.string().optional(),
    sessionId: z.string().optional(),
  }),
  mode: z.string(),
  status: z.enum(["offered", "generating", "in-progress", "deferred", "skipped", "completed", "abandoned"]),
  /** Generation requests awaiting a model reply (host-delegated or retried). */
  pending: z
    .array(
      z.object({
        requestKey: z.string(),
        conceptId: z.string(),
        count: z.number().int().min(1),
        system: z.string(),
        prompt: z.string(),
        maxTokens: z.number().int(),
        evidence: z.array(z.string()),
      }),
    )
    .default([]),
  generation: z
    .object({
      providerId: z.string().optional(),
      model: z.string().optional(),
      calls: z.number().int().min(0).default(0),
      inputTokens: z.number().int().min(0).default(0),
      outputTokens: z.number().int().min(0).default(0),
      rejected: z.array(z.string()).default([]),
    })
    .default({}),
  deferredReason: z.string().optional(),
  requestedScope: VersionScopeSchema.optional(),
  items: z.array(AssessmentItemSchema),
  cursor: z.number().int().min(0),
  requireReasoning: z.boolean().default(false),
  requireConfidence: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
  summary: z
    .object({
      lines: z.array(z.string()),
      correct: z.number(),
      answered: z.number(),
      nextReviews: z.array(
        z.object({ conceptId: z.string(), at: z.string(), reason: z.string().optional() }),
      ),
    })
    .optional(),
});
export type AssessmentSession = z.infer<typeof AssessmentSessionSchema>;

export function currentItem(s: AssessmentSession): AssessmentItem | undefined {
  return s.items[s.cursor];
}

export function isFinished(s: AssessmentSession): boolean {
  return s.cursor >= s.items.length;
}

export function progressLabel(s: AssessmentSession): string {
  return `Question ${Math.min(s.cursor + 1, s.items.length)} of ${s.items.length}`;
}
