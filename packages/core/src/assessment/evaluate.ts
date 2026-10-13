import { clamp01, round } from "../domain/ids.js";
import { MULTI_ANSWER_TYPES, OPEN_TYPES, type Question, type RubricCriterion } from "./question.js";

/**
 * Deterministic answer evaluation. Correctness, reasoning and confidence are
 * evaluated separately and then combined through an explicit calibration
 * matrix. Open answers are graded with a weighted rubric (partial credit), never
 * a single opaque score. An AI provider may refine reasoning/open grading, but
 * its output goes through `mergeProviderGrade`, which bounds its influence.
 */

export const EVALUATION_RULES_VERSION = "evaluate@1";

export const CONFIDENCE_LEVELS = ["guessing", "low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  guessing: "Guessing",
  low: "Not confident",
  medium: "Somewhat confident",
  high: "Very confident",
};

export interface Answer {
  choiceIds?: string[];
  text?: string;
  reasoning?: string;
  confidence?: Confidence;
}

export type Calibration =
  | "strong"
  | "possible-false-confidence"
  | "uncertain-recall"
  | "check-question"
  | "misconception"
  | "likely-gap"
  | "partial"
  | "unrated";

export interface CriterionResult {
  id: string;
  description: string;
  met: boolean;
  weight: number;
}

export interface Evaluation {
  questionId: string;
  conceptId: string;
  correctness: number;
  isCorrect: boolean;
  reasoning: { score?: number; quality: "sound" | "weak" | "absent"; matched: string[] };
  confidence?: Confidence;
  calibration: Calibration;
  criteria: CriterionResult[];
  /** 0–5 quality grade for the review scheduler. */
  grade: number;
  /** How much this answer should move mastery (0..1). A correct guess earns little. */
  masteryCredit: number;
  headline: string;
  feedback: string[];
  explanation: string;
  rulesVersion: string;
  gradedBy: "deterministic" | "provider";
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

/** Reasoning signal groups are synonym lists: a group is met when any of its terms appears. */
export function scoreReasoning(question: Question, reasoning: string | undefined): Evaluation["reasoning"] {
  const text = reasoning?.trim() ?? "";
  if (text.length === 0) return { quality: "absent", matched: [] };
  const groups = question.reasoningSignals;
  if (groups.length === 0) {
    return {
      score: text.length >= 25 ? 0.6 : 0.3,
      quality: text.length >= 25 ? "sound" : "weak",
      matched: [],
    };
  }
  const t = norm(text);
  const matched: string[] = [];
  let hits = 0;
  for (const group of groups) {
    const hit = group.find((term) => t.includes(norm(term)));
    if (hit) {
      hits++;
      matched.push(hit);
    }
  }
  const coverage = hits / groups.length;
  const lengthFactor = text.length < 15 ? 0.6 : 1;
  const score = round(clamp01(coverage * lengthFactor));
  return { score, quality: score >= 0.5 ? "sound" : "weak", matched };
}

/** Rubric criteria: met when every term of any one alternative appears in the answer. */
export function scoreRubric(
  rubric: RubricCriterion[],
  text: string,
): { score: number; criteria: CriterionResult[] } {
  const t = norm(text);
  const criteria = rubric.map((c) => ({
    id: c.id,
    description: c.description,
    weight: c.weight,
    met: c.anyOf.some((alt) => alt.every((term) => t.includes(norm(term)))),
  }));
  const total = criteria.reduce((s, c) => s + c.weight, 0);
  const got = criteria.filter((c) => c.met).reduce((s, c) => s + c.weight, 0);
  return { score: total === 0 ? 0 : round(got / total), criteria };
}

export function scoreChoices(question: Question, selected: string[]): number {
  const correct = new Set(question.correct ?? []);
  const picked = new Set(selected);
  if (!MULTI_ANSWER_TYPES.includes(question.type)) {
    return picked.size === 1 && correct.has([...picked][0]!) ? 1 : 0;
  }
  let right = 0;
  let wrong = 0;
  for (const p of picked) correct.has(p) ? right++ : wrong++;
  return round(clamp01((right - wrong) / correct.size));
}

export function classifyCalibration(
  correctness: number,
  reasoning: Evaluation["reasoning"],
  confidence?: Confidence,
): Calibration {
  const isHigh = confidence === "high" || confidence === "medium";
  const isLow = confidence === "low" || confidence === "guessing";
  if (correctness >= 0.8) {
    if (isLow) return "uncertain-recall";
    if (confidence === "high" && reasoning.quality === "weak") return "possible-false-confidence";
    if (reasoning.quality === "sound" || isHigh) return "strong";
    return "unrated";
  }
  if (correctness >= 0.4) return "partial";
  if (reasoning.quality === "sound") return "check-question";
  if (confidence === "high") return "misconception";
  if (isLow) return "likely-gap";
  return "unrated";
}

const CONFIDENCE_FACTOR: Record<Confidence, number> = { guessing: 0.35, low: 0.7, medium: 0.9, high: 1 };

export function evaluateAnswer(question: Question, answer: Answer): Evaluation {
  const isOpen = OPEN_TYPES.includes(question.type);
  let correctness: number;
  let criteria: CriterionResult[] = [];
  if (isOpen) {
    const graded = scoreRubric(question.rubric ?? [], answer.text ?? "");
    correctness = graded.score;
    criteria = graded.criteria;
  } else {
    correctness = scoreChoices(question, answer.choiceIds ?? []);
  }
  // For open answers the explanation itself is the reasoning.
  const reasoning = scoreReasoning(question, isOpen ? (answer.reasoning ?? answer.text) : answer.reasoning);
  const calibration = classifyCalibration(correctness, reasoning, answer.confidence);
  const grade = gradeFor(correctness, reasoning, answer.confidence);
  const confFactor = answer.confidence ? CONFIDENCE_FACTOR[answer.confidence] : 0.85;
  const reasoningFactor = reasoning.quality === "sound" ? 1 : reasoning.quality === "weak" ? 0.85 : 0.9;
  const masteryCredit = round(clamp01(correctness * confFactor * reasoningFactor));
  const isCorrect = correctness >= 0.8;

  return {
    questionId: question.id,
    conceptId: question.conceptId,
    correctness,
    isCorrect,
    reasoning,
    confidence: answer.confidence,
    calibration,
    criteria,
    grade,
    masteryCredit,
    headline: headlineFor(correctness, isOpen),
    feedback: feedbackFor(question, calibration, reasoning, criteria, answer),
    explanation: question.explanation,
    rulesVersion: EVALUATION_RULES_VERSION,
    gradedBy: "deterministic",
  };
}

function gradeFor(correctness: number, reasoning: Evaluation["reasoning"], confidence?: Confidence): number {
  if (correctness >= 0.8) {
    if (confidence === "guessing") return 3;
    if (confidence === "low") return 3;
    if (reasoning.quality === "weak" && confidence === "high") return 3;
    if (confidence === "medium") return 4;
    return 5;
  }
  if (correctness >= 0.5) return 3;
  if (correctness >= 0.25) return 2;
  return confidence === "high" ? 0 : 1;
}

function headlineFor(correctness: number, isOpen: boolean): string {
  if (correctness >= 0.8) return isOpen ? "Strong answer" : "Correct";
  if (correctness >= 0.4) return "Partially correct";
  return isOpen ? "Key ideas missing" : "Not quite";
}

function feedbackFor(
  question: Question,
  calibration: Calibration,
  reasoning: Evaluation["reasoning"],
  criteria: CriterionResult[],
  answer: Answer,
): string[] {
  const out: string[] = [];
  if (!OPEN_TYPES.includes(question.type) && question.correct && question.choices) {
    const right = question.choices.filter((c) => question.correct!.includes(c.id)).map((c) => c.text);
    out.push(`Answer: ${right.join("; ")}`);
  }
  for (const c of criteria) out.push(`${c.met ? "✓" : "✗"} ${c.description}`);
  switch (calibration) {
    case "strong":
      out.push(
        "Your answer and reasoning both hold up. This concept will come back later in a different form.",
      );
      break;
    case "possible-false-confidence":
      out.push("Right answer, but the reasoning didn't show why. Worth revisiting the explanation.");
      break;
    case "uncertain-recall":
      out.push("You got it right but weren't sure. A review is scheduled soon to firm this up.");
      break;
    case "check-question":
      out.push(
        "Your reasoning touched the right ideas even though the pick was different. The question may be ambiguous; you can flag it.",
      );
      break;
    case "misconception":
      out.push(
        "You were confident, so this may be a misconception worth a closer look. A follow-up is scheduled.",
      );
      break;
    case "likely-gap":
      out.push("This looks like a gap rather than a slip. A short review is scheduled.");
      break;
    case "partial":
      out.push("Part of it is there; the explanation covers the rest.");
      break;
    case "unrated":
      break;
  }
  if (
    reasoning.quality === "absent" &&
    answer.reasoning === undefined &&
    !OPEN_TYPES.includes(question.type)
  ) {
    // Reasoning is optional; say nothing in ordinary mode.
  }
  if (question.ambiguity) out.push(`Note: ${question.ambiguity}`);
  return out;
}

/**
 * Merges a provider's grade for an open answer or the reasoning. The rubric
 * stays authoritative: a provider can move the score by at most ±0.25, and a
 * malformed provider grade is ignored.
 */
export function mergeProviderGrade(
  base: Evaluation,
  provider: { correctness?: number; reasoningScore?: number; notes?: string[] } | undefined,
): Evaluation {
  if (!provider) return base;
  const bound = (b: number, p: number | undefined) =>
    p === undefined || !Number.isFinite(p) ? b : round(clamp01(Math.max(b - 0.25, Math.min(b + 0.25, p))));
  const correctness = bound(base.correctness, provider.correctness);
  const reasoningScore =
    base.reasoning.score === undefined
      ? provider.reasoningScore
      : bound(base.reasoning.score, provider.reasoningScore);
  const reasoning = {
    ...base.reasoning,
    score: reasoningScore,
    quality:
      reasoningScore === undefined
        ? base.reasoning.quality
        : reasoningScore >= 0.5
          ? ("sound" as const)
          : ("weak" as const),
  };
  return {
    ...base,
    correctness,
    isCorrect: correctness >= 0.8,
    reasoning,
    calibration: classifyCalibration(correctness, reasoning, base.confidence),
    feedback: [...base.feedback, ...(provider.notes ?? []).slice(0, 3)],
    gradedBy: "provider",
  };
}
