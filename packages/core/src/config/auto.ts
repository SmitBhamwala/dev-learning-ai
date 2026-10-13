import type { Config, Mode } from "./schema.js";

/**
 * Resolution of `auto` settings. Every resolution is deterministic and
 * returns the reason, so `status` and the dashboard can show why.
 */

export interface Resolved<T> {
  value: T;
  reason: string;
  isAuto: boolean;
}

export interface ModeContext {
  urgency?: "normal" | "urgent" | "incident";
  /** Changed lines in the task, a rough complexity signal. */
  changedLines?: number;
  /** Mean mastery (0..1) of the concepts the task touched, when known. */
  conceptMastery?: number;
  /** Remaining model calls in the session budget. */
  remainingModelCalls?: number;
  /** User paused learning for the current task. */
  pausedForTask?: boolean;
}

export function resolveMode(config: Config, ctx: ModeContext = {}): Resolved<Mode | "paused" | "disabled"> {
  if (!config.learning.enabled)
    return { value: "disabled", reason: "learning.enabled is false", isAuto: false };
  if (ctx.pausedForTask)
    return { value: "paused", reason: "learning was paused for this task", isAuto: false };
  if (ctx.urgency === "incident" || ctx.urgency === "urgent") {
    return {
      value: "observe",
      reason: `task marked ${ctx.urgency}: never interrupt urgent work (explicit mode is ignored too)`,
      isAuto: config.learning.mode === "auto",
    };
  }
  if (config.learning.mode !== "auto") {
    return { value: config.learning.mode, reason: "set explicitly in configuration", isAuto: false };
  }
  if ((ctx.changedLines ?? 0) > 400) {
    return {
      value: "observe",
      reason: "large change set: record now, assess at a calmer boundary",
      isAuto: true,
    };
  }
  if (ctx.conceptMastery !== undefined && ctx.conceptMastery < 0.35 && (ctx.changedLines ?? 0) < 200) {
    return {
      value: "teach",
      reason: "low demonstrated mastery on a small task: guided help is worthwhile",
      isAuto: true,
    };
  }
  return {
    value: "collaborate",
    reason: "default for ordinary tasks: optional questions after the work",
    isAuto: true,
  };
}

export function resolveDifficulty(config: Config, conceptMastery?: number): Resolved<number> {
  const d = config.learning.difficulty;
  if (d !== "auto") return { value: d, reason: "set explicitly", isAuto: false };
  if (config.learning.interview_mode)
    return { value: 4, reason: "interview mode raises difficulty", isAuto: true };
  if (conceptMastery === undefined)
    return { value: 2, reason: "no evidence yet: start below the middle", isAuto: true };
  const value = Math.max(1, Math.min(5, Math.round(1 + conceptMastery * 4)));
  return {
    value,
    reason: `matches demonstrated mastery (${Math.round(conceptMastery * 100)}%)`,
    isAuto: true,
  };
}

export function questionsForTask(config: Config, ctx: ModeContext = {}): Resolved<number> {
  const base = config.learning.questions_per_task;
  if (ctx.urgency && ctx.urgency !== "normal")
    return { value: 0, reason: "urgent task: no questions", isAuto: false };
  if (config.ai.token_budget === "minimal") {
    return { value: Math.min(base, 2), reason: "minimal token budget caps questions at 2", isAuto: true };
  }
  return { value: base, reason: "learning.questions_per_task", isAuto: false };
}
