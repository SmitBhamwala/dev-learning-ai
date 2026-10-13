import { z } from "zod";
import { VersionScopeSchema } from "./version.js";

/**
 * Provider-independent domain entities. Nothing here knows about Claude Code,
 * a model vendor, Obsidian or the filesystem.
 */

/** Where a piece of knowledge lives. Project scope never leaks into another project. */
export const KnowledgeScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({ kind: z.literal("project"), projectId: z.string().min(1) }),
]);
export type KnowledgeScope = z.infer<typeof KnowledgeScopeSchema>;

export const GLOBAL_SCOPE: KnowledgeScope = { kind: "global" };

export function scopeKey(scope: KnowledgeScope): string {
  return scope.kind === "global" ? "global" : `project:${scope.projectId}`;
}

export const ConceptCategorySchema = z.enum([
  "fundamentals",
  "architecture",
  "performance",
  "testing",
  "security",
  "version-specific",
  "transition",
  "project",
]);
export type ConceptCategory = z.infer<typeof ConceptCategorySchema>;

export const ConceptSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9.\-/@]*$/, "concept ids are lowercase dotted paths"),
  technology: z.string().min(1),
  label: z.string().min(1),
  summary: z.string().min(1),
  category: ConceptCategorySchema,
  versionScope: VersionScopeSchema.optional(),
  /** Parent concept id, forming the technology hierarchy. */
  parent: z.string().optional(),
  related: z.array(z.string()).default([]),
  interviewCritical: z.boolean().default(false),
  /** Deterministic detection hints: path globs, import names and keywords. */
  signals: z
    .object({
      paths: z.array(z.string()).default([]),
      imports: z.array(z.string()).default([]),
      keywords: z.array(z.string()).default([]),
    })
    .default({}),
  /** Project-specific concepts are owned by one project and never shared. */
  projectId: z.string().optional(),
});
export type Concept = z.infer<typeof ConceptSchema>;
export type ConceptInput = z.input<typeof ConceptSchema>;

export const FactProvenanceSchema = z.object({
  source: z.enum(["manifest", "lockfile", "config", "runtime", "import", "docs", "user", "inferred"]),
  file: z.string().optional(),
  detail: z.string().optional(),
  confidence: z.number().min(0).max(1),
  detectedAt: z.string(),
});
export type FactProvenance = z.infer<typeof FactProvenanceSchema>;

export const TechnologyFactSchema = z.object({
  technology: z.string(),
  /** Exact installed version when a lockfile or manifest verifies it. */
  version: z.string().optional(),
  /** The declared range from a manifest, kept apart from the resolved version. */
  declaredRange: z.string().optional(),
  workspace: z.string().optional(),
  provenance: z.array(FactProvenanceSchema).min(1),
  correctedByUser: z.boolean().default(false),
});
export type TechnologyFact = z.infer<typeof TechnologyFactSchema>;

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Known checkout locations. One project may live at several paths (worktrees, clones). */
  paths: z.array(z.string()).min(1),
  remotes: z.array(z.string()).default([]),
  /** Product grouping for separate repos of one product. Grouping never merges knowledge. */
  productGroup: z.string().optional(),
  isMonorepo: z.boolean().default(false),
  workspaces: z
    .array(z.object({ name: z.string(), path: z.string(), technologies: z.array(z.string()).default([]) }))
    .default([]),
  technologies: z.array(TechnologyFactSchema).default([]),
  registeredAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(["active", "removed"]).default("active"),
  excludedFromLearning: z.boolean().default(false),
});
export type Project = z.infer<typeof ProjectSchema>;

/** The eight independent dimensions. Each is 0..1 with its own evidence count. */
export const DIMENSIONS = [
  "mastery",
  "recall",
  "reasoning",
  "application",
  "calibration",
  "retention",
  "freshness",
  "exposure",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const DimensionValueSchema = z.object({
  value: z.number().min(0).max(1),
  evidence: z.number().int().min(0),
  updatedAt: z.string().optional(),
});
export type DimensionValue = z.infer<typeof DimensionValueSchema>;

export const ReviewStateSchema = z.object({
  algorithm: z.string(),
  easiness: z.number(),
  repetitions: z.number().int().min(0),
  intervalDays: z.number().min(0),
  nextReviewAt: z.string(),
  lastReviewedAt: z.string().optional(),
  lastSuccessAt: z.string().optional(),
  lapses: z.number().int().min(0).default(0),
  suspended: z.boolean().default(false),
  postponedUntil: z.string().optional(),
  reason: z.string().optional(),
});
export type ReviewState = z.infer<typeof ReviewStateSchema>;

export const KnowledgeStateSchema = z.object({
  conceptId: z.string(),
  scope: KnowledgeScopeSchema,
  dimensions: z.object({
    mastery: DimensionValueSchema,
    recall: DimensionValueSchema,
    reasoning: DimensionValueSchema,
    application: DimensionValueSchema,
    calibration: DimensionValueSchema,
    retention: DimensionValueSchema,
    freshness: DimensionValueSchema,
    exposure: DimensionValueSchema,
  }),
  review: ReviewStateSchema.optional(),
  seenQuestionIds: z.array(z.string()).default([]),
  lastQuestionType: z.string().optional(),
  firstSeenAt: z.string(),
  updatedAt: z.string(),
  /** Origins of reused knowledge, for traceability across projects. */
  sources: z.array(z.object({ scope: z.string(), at: z.string() })).default([]),
});
export type KnowledgeState = z.infer<typeof KnowledgeStateSchema>;

export const EvidenceKindSchema = z.enum([
  "assessment",
  "practical-work",
  "review",
  "self-report",
  "exposure",
]);

export const EvidenceSchema = z.object({
  id: z.string(),
  /** Idempotency key: the same underlying evidence is never counted twice. */
  key: z.string(),
  kind: EvidenceKindSchema,
  conceptId: z.string(),
  scope: KnowledgeScopeSchema,
  at: z.string(),
  reliability: z.number().min(0).max(1),
  difficulty: z.number().min(1).max(5).optional(),
  isNovelVariant: z.boolean().default(false),
  outcome: z
    .object({
      correctness: z.number().min(0).max(1),
      reasoning: z.number().min(0).max(1).optional(),
      confidence: z.enum(["guessing", "low", "medium", "high"]).optional(),
      calibration: z.string().optional(),
    })
    .optional(),
  ref: z
    .object({
      sessionId: z.string().optional(),
      questionId: z.string().optional(),
      taskId: z.string().optional(),
    })
    .default({}),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ScoreChangeSchema = z.object({
  id: z.string(),
  conceptId: z.string(),
  scope: KnowledgeScopeSchema,
  dimension: z.enum(DIMENSIONS),
  before: z.number(),
  after: z.number(),
  evidenceId: z.string(),
  rule: z.string(),
  ruleVersion: z.string(),
  explanation: z.string(),
  at: z.string(),
});
export type ScoreChange = z.infer<typeof ScoreChangeSchema>;
