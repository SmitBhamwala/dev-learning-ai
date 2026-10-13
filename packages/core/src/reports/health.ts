import type { Concept, KnowledgeState } from "../domain/model.js";

/**
 * Learning-health indicators. Neutral and evidence-based: they describe what
 * was observed and what is missing, and never claim that AI usage causes
 * anything. No streaks, no scores-as-judgement, no punitive language.
 */

export interface HealthInput {
  aiAssistedTasks: number;
  /** conceptId → number of tasks in which the concept was encountered. */
  encounters: Map<string, number>;
  states: Map<string, KnowledgeState>;
  concepts: Map<string, Concept>;
  /** Recent correctness on novel variants per concept (oldest first). */
  novelVariantHistory?: Map<string, number[]>;
}

export interface HealthInsight {
  kind: "needs-evidence" | "overconfident" | "declining-on-new-variants" | "revalidate" | "strong-practice";
  conceptId: string;
  label: string;
  message: string;
  basis: "observed" | "estimated";
}

export interface HealthReport {
  aiAssistedTasks: number;
  conceptsEncountered: number;
  conceptsAssessed: number;
  demonstratedUnderstanding: number;
  strongPracticalEvidence: number;
  insights: HealthInsight[];
  disclaimer: string;
}

export function learningHealth(input: HealthInput): HealthReport {
  const insights: HealthInsight[] = [];
  let assessed = 0;
  let demonstrated = 0;
  let practical = 0;
  for (const [conceptId, count] of input.encounters) {
    const s = input.states.get(conceptId);
    const c = input.concepts.get(conceptId);
    const label = c?.label ?? conceptId;
    const m = s?.dimensions.mastery;
    if (m && m.evidence > 0) assessed++;
    if (m && m.evidence > 0 && m.value >= 0.7) demonstrated++;
    if (s && s.dimensions.application.value >= 0.5) practical++;
    if (count >= 3 && (!m || m.evidence === 0)) {
      insights.push({
        kind: "needs-evidence",
        conceptId,
        label,
        basis: "observed",
        message: `You have completed ${count} tasks involving ${label.toLowerCase()} with AI assistance, but there is little assessment evidence for it yet. Consider a short review.`,
      });
    }
  }
  for (const [conceptId, s] of input.states) {
    const c = input.concepts.get(conceptId);
    const label = c?.label ?? conceptId;
    const cal = s.dimensions.calibration;
    if (cal.evidence >= 3 && cal.value < 0.55 && s.dimensions.recall.value < 0.6) {
      insights.push({
        kind: "overconfident",
        conceptId,
        label,
        basis: "observed",
        message: `For ${label.toLowerCase()}, stated confidence has tended to exceed correctness. A few reasoning-focused questions may help.`,
      });
    }
    if (s.dimensions.freshness.evidence > 0 && s.dimensions.freshness.value < 0.6) {
      insights.push({
        kind: "revalidate",
        conceptId,
        label,
        basis: "estimated",
        message: `${label} was last validated a while ago. Your earlier results still stand; a quick check would confirm they're current.`,
      });
    }
  }
  for (const [conceptId, history] of input.novelVariantHistory ?? []) {
    if (history.length >= 3) {
      const recent = history.slice(-3);
      if (recent[0]! > recent[1]! && recent[1]! > recent[2]!) {
        const label = input.concepts.get(conceptId)?.label ?? conceptId;
        insights.push({
          kind: "declining-on-new-variants",
          conceptId,
          label,
          basis: "observed",
          message: `Results on new questions about ${label.toLowerCase()} have dipped across the last three attempts.`,
        });
      }
    }
  }
  return {
    aiAssistedTasks: input.aiAssistedTasks,
    conceptsEncountered: input.encounters.size,
    conceptsAssessed: assessed,
    demonstratedUnderstanding: demonstrated,
    strongPracticalEvidence: practical,
    insights,
    disclaimer:
      "These indicators describe the evidence collected so far. They do not measure ability, and correlation with AI usage is not causation.",
  };
}
