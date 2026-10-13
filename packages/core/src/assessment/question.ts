import { z } from "zod";
import { VersionScopeSchema } from "../domain/version.js";

export const QUESTION_TYPES = [
  "single",
  "multi",
  "output",
  "debug",
  "failure-mode",
  "code-review",
  "tradeoff",
  "scenario",
  "version-compare",
  "migration",
  "explain-change",
  "open",
  "practical",
] as const;
export const QuestionTypeSchema = z.enum(QUESTION_TYPES);
export type QuestionType = z.infer<typeof QuestionTypeSchema>;

/** Types answered by picking choices; the rest are graded with a rubric. */
export const MULTI_ANSWER_TYPES: readonly QuestionType[] = ["multi"];
export const OPEN_TYPES: readonly QuestionType[] = ["explain-change", "open", "practical"];

export const RubricCriterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  weight: z.number().positive(),
  /** Alternatives: the criterion is met when every term of any one inner list appears in the answer. */
  anyOf: z.array(z.array(z.string().min(1)).min(1)).min(1),
});
export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;

export const ProvenanceSchema = z.object({
  kind: z.enum(["builtin", "generated", "project-evidence", "extension", "user"]),
  source: z.string().optional(),
  url: z.string().url().optional(),
  version: z.string().optional(),
  retrievedAt: z.string().optional(),
  evidence: z.array(z.string()).default([]),
});

export const QuestionSchema = z
  .object({
    id: z.string().min(1),
    conceptId: z.string().min(1),
    type: QuestionTypeSchema,
    difficulty: z.number().int().min(1).max(5),
    objective: z.string().min(5),
    prompt: z.string().min(5),
    code: z.string().optional(),
    codeLanguage: z.string().optional(),
    choices: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) })).optional(),
    correct: z.array(z.string()).optional(),
    rubric: z.array(RubricCriterionSchema).optional(),
    /** Signal groups for sound reasoning. Each inner list is synonyms; coverage = groups hit / groups. */
    reasoningSignals: z.array(z.array(z.string().min(1)).min(1)).default([]),
    explanation: z.string().min(10),
    versionScope: VersionScopeSchema.optional(),
    provenance: ProvenanceSchema,
    ambiguity: z.string().optional(),
    tags: z.array(z.string()).default([]),
  })
  .superRefine((q, ctx) => {
    const isOpen = OPEN_TYPES.includes(q.type);
    if (isOpen) {
      if (!q.rubric || q.rubric.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rubric"],
          message: "open questions need a scoring rubric",
        });
      }
      return;
    }
    if (!q.choices || q.choices.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["choices"],
        message: "choice questions need at least two choices",
      });
      return;
    }
    const ids = q.choices.map((c) => c.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["choices"], message: "choice ids must be unique" });
    }
    const texts = q.choices.map((c) => c.text.trim().toLowerCase());
    if (new Set(texts).size !== texts.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["choices"],
        message: "distractors must be distinguishable",
      });
    }
    if (!q.correct || q.correct.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["correct"],
        message: "a verified correct answer is required",
      });
      return;
    }
    for (const c of q.correct) {
      if (!ids.includes(c)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["correct"],
          message: `correct answer ${c} is not a choice`,
        });
      }
    }
    if (!MULTI_ANSWER_TYPES.includes(q.type) && q.correct.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["correct"],
        message: `${q.type} questions have exactly one answer`,
      });
    }
    if (q.correct.length === q.choices.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["correct"],
        message: "at least one choice must be wrong",
      });
    }
  });
export type Question = z.infer<typeof QuestionSchema>;
export type QuestionInput = z.input<typeof QuestionSchema>;

export interface QuestionValidation {
  ok: boolean;
  question?: Question;
  issues: string[];
}

/** Rejects malformed, contradictory or unsupported questions (generated ones included). */
export function validateQuestion(input: unknown, knownConcepts?: ReadonlySet<string>): QuestionValidation {
  const parsed = QuestionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  const issues: string[] = [];
  if (knownConcepts && !knownConcepts.has(parsed.data.conceptId))
    issues.push(`unknown concept ${parsed.data.conceptId}`);
  if (parsed.data.provenance.kind === "generated" && parsed.data.provenance.evidence.length === 0) {
    issues.push("generated questions must cite the task evidence they were built from");
  }
  return issues.length ? { ok: false, issues } : { ok: true, question: parsed.data, issues: [] };
}

/** A question as shown to the learner: no answer key, no rubric. */
export interface PublicQuestion {
  id: string;
  conceptId: string;
  type: QuestionType;
  difficulty: number;
  prompt: string;
  code?: string;
  codeLanguage?: string;
  choices?: { id: string; text: string }[];
  isMultiSelect: boolean;
  isOpen: boolean;
  objective: string;
}

export function toPublicQuestion(q: Question): PublicQuestion {
  return {
    id: q.id,
    conceptId: q.conceptId,
    type: q.type,
    difficulty: q.difficulty,
    prompt: q.prompt,
    code: q.code,
    codeLanguage: q.codeLanguage,
    choices: q.choices,
    isMultiSelect: MULTI_ANSWER_TYPES.includes(q.type),
    isOpen: OPEN_TYPES.includes(q.type),
    objective: q.objective,
  };
}
