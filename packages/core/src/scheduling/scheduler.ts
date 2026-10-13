import { DAY_MS, clamp01, round } from "../domain/ids.js";
import type { ReviewState } from "../domain/model.js";

/**
 * Review scheduling. The algorithm is replaceable through `ReviewScheduler`;
 * the default is SM-2 (Wozniak, 1990) with three documented adjustments:
 *
 * 1. Grades come from `evaluateAnswer` (0–5), where a correct guess or a
 *    correct answer with low confidence earns 3, so it is reviewed sooner.
 * 2. A missed review never resets mastery; overdue items are simply due.
 *    When an overdue item is recalled successfully, the elapsed time counts
 *    toward the next interval (capped at 2× the scheduled interval).
 * 3. Intervals are capped (default 180 days) so knowledge is revalidated.
 *
 * Retention is estimated with an exponential forgetting curve whose half-life
 * equals the current interval: R(t) = 2^(−t / interval). It is an estimate and
 * is labelled as one wherever shown.
 */

export interface ReviewScheduler {
  readonly id: string;
  readonly description: string;
  initial(now: Date): ReviewState;
  next(state: ReviewState, grade: number, now: Date): ReviewState;
  retention(state: ReviewState, now: Date): number;
}

export interface Sm2Options {
  maxIntervalDays?: number;
  firstIntervalDays?: number;
  secondIntervalDays?: number;
}

export class Sm2Scheduler implements ReviewScheduler {
  readonly id = "sm2";
  readonly description =
    "SM-2 with confidence-aware grades, no penalty for missed reviews, and capped intervals";
  private readonly max: number;
  private readonly first: number;
  private readonly second: number;

  constructor(opts: Sm2Options = {}) {
    this.max = opts.maxIntervalDays ?? 180;
    this.first = opts.firstIntervalDays ?? 1;
    this.second = opts.secondIntervalDays ?? 4;
  }

  initial(now: Date): ReviewState {
    return {
      algorithm: this.id,
      easiness: 2.5,
      repetitions: 0,
      intervalDays: 0,
      nextReviewAt: now.toISOString(),
      lapses: 0,
      suspended: false,
      reason: "new concept",
    };
  }

  next(state: ReviewState, grade: number, now: Date): ReviewState {
    const q = Math.max(0, Math.min(5, Math.round(grade)));
    const easiness = Math.max(1.3, state.easiness + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
    let repetitions: number;
    let interval: number;
    let lapses = state.lapses;
    let reason: string;
    if (q < 3) {
      repetitions = 0;
      interval = this.first;
      lapses += 1;
      reason = "not recalled: review again tomorrow with a different question";
    } else {
      repetitions = state.repetitions + 1;
      if (repetitions === 1) interval = this.first;
      else if (repetitions === 2) interval = this.second;
      else {
        const scheduled = state.intervalDays;
        const elapsed = state.lastReviewedAt
          ? (now.getTime() - new Date(state.lastReviewedAt).getTime()) / DAY_MS
          : scheduled;
        const effective = Math.min(Math.max(scheduled, elapsed), scheduled * 2);
        interval = effective * easiness;
      }
      if (q === 3) interval = Math.min(interval, Math.max(this.first, state.intervalDays));
      reason =
        q === 3
          ? "recalled with low confidence or weak reasoning: interval held"
          : `recalled (grade ${q}): interval grows ×${round(easiness, 2)}`;
    }
    interval = round(Math.min(this.max, interval), 2);
    return {
      ...state,
      algorithm: this.id,
      easiness: round(easiness, 3),
      repetitions,
      intervalDays: interval,
      lastReviewedAt: now.toISOString(),
      lastSuccessAt: q >= 3 ? now.toISOString() : state.lastSuccessAt,
      nextReviewAt: new Date(now.getTime() + interval * DAY_MS).toISOString(),
      lapses,
      postponedUntil: undefined,
      reason,
    };
  }

  retention(state: ReviewState, now: Date): number {
    if (!state.lastSuccessAt) return 0;
    const t = (now.getTime() - new Date(state.lastSuccessAt).getTime()) / DAY_MS;
    const halfLife = Math.max(0.5, state.intervalDays || this.first);
    return round(clamp01(2 ** (-t / halfLife)));
  }
}

export function isDue(state: ReviewState | undefined, now: Date): boolean {
  if (!state || state.suspended) return false;
  const at = state.postponedUntil ?? state.nextReviewAt;
  return new Date(at).getTime() <= now.getTime();
}

export function postpone(state: ReviewState, days: number, now: Date): ReviewState {
  return {
    ...state,
    postponedUntil: new Date(now.getTime() + days * DAY_MS).toISOString(),
    reason: `postponed by the learner for ${days} day(s)`,
  };
}

const registry = new Map<string, () => ReviewScheduler>([
  ["sm2", () => new Sm2Scheduler()],
  ["default", () => new Sm2Scheduler()],
]);

export function registerScheduler(id: string, factory: () => ReviewScheduler): void {
  registry.set(id, factory);
}

export function createScheduler(id = "sm2"): ReviewScheduler {
  const f = registry.get(id);
  if (!f) throw new Error(`Unknown review scheduler "${id}". Known: ${[...registry.keys()].join(", ")}`);
  return f();
}
