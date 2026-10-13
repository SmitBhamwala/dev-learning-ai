import type { KnowledgeState } from "../domain/model.js";
import { scopeIncludes, type VersionScope } from "../domain/version.js";
import type { Question } from "./question.js";

/**
 * Question selection with anti-repetition. The concept is the stable unit of
 * learning; questions are interchangeable instruments. A question already
 * answered is only reused when no unseen variant exists, and then the caller
 * is told (`isNovelVariant: false`) so it can ask a provider for a fresh
 * variant instead, and so scoring does not over-count a memorized answer.
 */

export interface SelectionOptions {
  targetDifficulty: number;
  requestedScope?: VersionScope;
  installedVersion?: string;
  /** Question ids already used in the current session (never repeated within one). */
  sessionQuestionIds?: ReadonlySet<string>;
}

export interface Selection {
  question: Question;
  isNovelVariant: boolean;
  reason: string;
}

export function selectQuestion(
  pool: Question[],
  state: KnowledgeState | undefined,
  opts: SelectionOptions,
): Selection | undefined {
  const requested = opts.requestedScope ?? { kind: "current" as const };
  const eligible = pool.filter(
    (q) =>
      scopeIncludes(requested, q.versionScope, opts.installedVersion) && !opts.sessionQuestionIds?.has(q.id),
  );
  if (eligible.length === 0) return undefined;
  const seen = new Set(state?.seenQuestionIds ?? []);
  const unseen = eligible.filter((q) => !seen.has(q.id));
  const lastType = state?.lastQuestionType;

  const rank = (q: Question) =>
    Math.abs(q.difficulty - opts.targetDifficulty) * 2 +
    (lastType && q.type === lastType ? 1.5 : 0) +
    tieBreak(q.id);

  if (unseen.length > 0) {
    const question = [...unseen].sort((a, b) => rank(a) - rank(b))[0]!;
    const reason =
      seen.size === 0
        ? "first question on this concept"
        : `new variant (${question.type}) of a concept you've seen before${lastType && question.type !== lastType ? `, different from last time's ${lastType}` : ""}`;
    return { question, isNovelVariant: seen.size > 0, reason };
  }
  // Every eligible variant has been seen: reuse the one seen longest ago, never the most recent.
  const order = state?.seenQuestionIds ?? [];
  const candidates = eligible.filter((q) => q.id !== order[order.length - 1]);
  const pick = (candidates.length ? candidates : eligible).sort(
    (a, b) => order.indexOf(a.id) - order.indexOf(b.id),
  )[0]!;
  return {
    question: pick,
    isNovelVariant: false,
    reason: "all built-in variants used: repeating the oldest one",
  };
}

function tieBreak(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 1000) / 10000;
}

/** Duplicate detection for generated questions: same concept and near-identical prompt. */
export function isDuplicateQuestion(
  candidate: Pick<Question, "conceptId" | "prompt">,
  existing: Question[],
): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const target = new Set(norm(candidate.prompt).split(" "));
  return existing.some((q) => {
    if (q.conceptId !== candidate.conceptId) return false;
    const words = new Set(norm(q.prompt).split(" "));
    const inter = [...target].filter((w) => words.has(w)).length;
    const union = new Set([...target, ...words]).size;
    return union > 0 && inter / union > 0.8;
  });
}
