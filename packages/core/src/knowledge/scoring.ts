import { DAY_MS, clamp01, newId, round } from "../domain/ids.js";
import {
  DIMENSIONS,
  type Dimension,
  type DimensionValue,
  type Evidence,
  type KnowledgeScope,
  type KnowledgeState,
  type ScoreChange,
} from "../domain/model.js";
import type { ReviewScheduler } from "../scheduling/scheduler.js";

/**
 * Transparent, versioned scoring. Every dimension has a defined meaning,
 * range (0..1), update rule and evidence count. Every change is recorded as
 * a ScoreChange with the rule and its version, so history is auditable and
 * a future rule version can be migrated or replayed.
 *
 * Meanings:
 *  mastery      – demonstrated understanding, weighted by difficulty, confidence and reasoning
 *  recall       – ability to retrieve the right answer, regardless of reasoning
 *  reasoning    – quality of the explanation given, when one is given
 *  application  – applying the concept in scenarios or real work (practical evidence is capped)
 *  calibration  – how well stated confidence matches actual correctness (1 = well calibrated)
 *  retention    – estimated probability of recall now (forgetting-curve estimate)
 *  freshness    – how recently the knowledge was validated (separate from mastery)
 *  exposure     – how often the concept was encountered in work; NOT ability
 */

export const SCORING_RULES_VERSION = "scoring@1";

export const DIMENSION_INFO: Record<Dimension, { label: string; meaning: string; isEstimate: boolean }> = {
  mastery: { label: "Mastery", meaning: "Demonstrated understanding across assessments", isEstimate: false },
  recall: {
    label: "Recall",
    meaning: "Retrieved the right answer, regardless of reasoning",
    isEstimate: false,
  },
  reasoning: { label: "Reasoning", meaning: "Quality of explanations you gave", isEstimate: false },
  application: {
    label: "Application",
    meaning: "Applied the concept to scenarios or real work",
    isEstimate: false,
  },
  calibration: { label: "Calibration", meaning: "Confidence matched correctness", isEstimate: false },
  retention: { label: "Retention", meaning: "Estimated chance you'd recall it today", isEstimate: true },
  freshness: { label: "Freshness", meaning: "How recently this knowledge was validated", isEstimate: true },
  exposure: {
    label: "Exposure",
    meaning: "How often you encountered it in work (not ability)",
    isEstimate: false,
  },
};

const CONF_NUM = { guessing: 0.25, low: 0.5, medium: 0.75, high: 0.95 } as const;
const APPLICATION_TYPES = new Set([
  "scenario",
  "practical",
  "debug",
  "code-review",
  "tradeoff",
  "migration",
  "failure-mode",
]);
const PRACTICAL_CAP = 0.6;

export function emptyState(conceptId: string, scope: KnowledgeScope, now: Date): KnowledgeState {
  const dims = {} as Record<Dimension, DimensionValue>;
  for (const d of DIMENSIONS) dims[d] = { value: 0, evidence: 0 };
  return {
    conceptId,
    scope,
    dimensions: dims,
    seenQuestionIds: [],
    firstSeenAt: now.toISOString(),
    updatedAt: now.toISOString(),
    sources: [],
  };
}

export interface ApplyContext {
  now: Date;
  scheduler: ReviewScheduler;
  /** The question type, when the evidence comes from an assessment. */
  questionType?: string;
  grade?: number;
}

export interface ApplyResult {
  state: KnowledgeState;
  changes: ScoreChange[];
}

export function applyEvidence(
  prev: KnowledgeState | undefined,
  evidence: Evidence,
  ctx: ApplyContext,
): ApplyResult {
  const state: KnowledgeState = structuredClone(
    prev ?? emptyState(evidence.conceptId, evidence.scope, ctx.now),
  );
  const changes: ScoreChange[] = [];
  const at = ctx.now.toISOString();

  const set = (dim: Dimension, next: number, rule: string, explanation: string, countEvidence = true) => {
    const cur = state.dimensions[dim];
    const after = round(clamp01(next));
    const before = cur.value;
    state.dimensions[dim] = { value: after, evidence: cur.evidence + (countEvidence ? 1 : 0), updatedAt: at };
    if (after !== before) {
      changes.push({
        id: newId("chg"),
        conceptId: state.conceptId,
        scope: state.scope,
        dimension: dim,
        before,
        after,
        evidenceId: evidence.id,
        rule,
        ruleVersion: SCORING_RULES_VERSION,
        explanation,
        at,
      });
    }
  };
  const ewma = (dim: Dimension, target: number, weight: number, firstIsTarget = false) => {
    const cur = state.dimensions[dim];
    if (cur.evidence === 0 && firstIsTarget) return target;
    const w = cur.evidence === 0 ? Math.max(weight, 0.5) : weight;
    return cur.value + w * (target - cur.value);
  };

  // Exposure: saturating count of encounters. Never treated as ability.
  if (evidence.kind === "exposure" || evidence.kind === "practical-work") {
    set("exposure", ewma("exposure", 1, 0.25), "exposure.saturating", "encountered in an AI-assisted task");
  }

  if (evidence.kind === "practical-work") {
    const cur = state.dimensions.application.value;
    if (cur < PRACTICAL_CAP) {
      const next = Math.min(PRACTICAL_CAP, cur + 0.1 * evidence.reliability);
      set(
        "application",
        next,
        "application.practical-capped",
        `practical work involving this concept (capped at ${PRACTICAL_CAP * 100}% until assessed)`,
      );
    }
  }

  const o = evidence.outcome;
  if ((evidence.kind === "assessment" || evidence.kind === "review") && o) {
    const d = evidence.difficulty ?? 3;
    const isRight = o.correctness >= 0.8;
    const difficultyWeight = isRight ? 0.7 + 0.15 * (d - 1) : 1.3 - 0.15 * (d - 1);
    const novelty = evidence.isNovelVariant ? 1.2 : 1;
    const weight = Math.min(0.6, 0.35 * evidence.reliability * difficultyWeight * novelty);
    const confFactor = o.confidence ? { guessing: 0.35, low: 0.7, medium: 0.9, high: 1 }[o.confidence] : 0.85;
    const reasoningFactor = o.reasoning === undefined ? 0.9 : o.reasoning >= 0.5 ? 1 : 0.85;
    const credit = clamp01(o.correctness * confFactor * reasoningFactor);

    set(
      "mastery",
      ewma("mastery", credit, weight),
      "mastery.ewma",
      `${isRight ? "answered correctly" : o.correctness >= 0.4 ? "partially correct" : "answered incorrectly"} on a difficulty-${d} ${evidence.isNovelVariant ? "new-variant " : ""}question${o.confidence === "guessing" ? " (a guess earns limited credit)" : ""}`,
    );
    const recallTarget = o.confidence === "guessing" ? o.correctness * 0.3 : o.correctness;
    set("recall", ewma("recall", recallTarget, weight), "recall.ewma", "retrieval of the right answer");
    if (o.reasoning !== undefined) {
      set(
        "reasoning",
        ewma("reasoning", o.reasoning, weight),
        "reasoning.ewma",
        "quality of the reasoning you gave",
      );
    }
    if (ctx.questionType && APPLICATION_TYPES.has(ctx.questionType)) {
      set(
        "application",
        ewma("application", credit, weight),
        "application.scenario",
        `applied the concept in a ${ctx.questionType} question`,
      );
    }
    if (o.confidence) {
      const calibrationTarget = 1 - Math.abs(CONF_NUM[o.confidence] - o.correctness);
      set(
        "calibration",
        ewma("calibration", calibrationTarget, 0.3, true),
        "calibration.abs-error",
        "stated confidence vs correctness",
      );
    }

    const review = state.review ?? ctx.scheduler.initial(ctx.now);
    state.review = ctx.scheduler.next(review, ctx.grade ?? (isRight ? 4 : 1), ctx.now);
    set(
      "retention",
      ctx.scheduler.retention(state.review, ctx.now),
      "retention.forgetting-curve",
      "estimated from your review history",
    );
    set("freshness", 1, "freshness.validated", "validated now");
  }

  state.updatedAt = at;
  return { state, changes };
}

/** Read-time decay of the time-dependent estimates. Mastery is never decayed. */
export function withCurrentEstimates(
  state: KnowledgeState,
  now: Date,
  scheduler: ReviewScheduler,
): KnowledgeState {
  const out = structuredClone(state);
  if (state.review) out.dimensions.retention.value = scheduler.retention(state.review, now);
  const last = state.dimensions.freshness.updatedAt;
  if (last) {
    const days = (now.getTime() - new Date(last).getTime()) / DAY_MS;
    out.dimensions.freshness.value = round(days <= 90 ? 1 : Math.max(0.3, 1 - ((days - 90) / 275) * 0.7));
  }
  return out;
}

/** Plain-language explanation of a set of changes, e.g. for a session summary. */
export function explainChanges(label: string, changes: ScoreChange[]): string | undefined {
  const mastery = changes.filter((c) => c.dimension === "mastery");
  if (mastery.length === 0) return undefined;
  const before = mastery[0]!.before;
  const after = mastery[mastery.length - 1]!.after;
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const verb = after > before ? "increased" : after < before ? "decreased" : "held";
  const reasons = [...new Set(mastery.map((c) => c.explanation))].slice(0, 3).join("; ");
  return `${label} mastery ${verb} from ${pct(before)} to ${pct(after)} because you ${reasons}.`;
}
