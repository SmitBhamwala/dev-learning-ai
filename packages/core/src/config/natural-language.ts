import { isSensitiveKey } from "./schema.js";

/**
 * AI-assisted configuration, deterministic half. Recognised phrasings map to
 * explicit configuration operations; anything unrecognised is returned as
 * `unparsed` so an AI provider (if configured) can propose operations, which
 * then go through exactly the same validation, diff and confirmation path.
 * Model output can never bypass validation or managed settings.
 */

export interface ConfigOperation {
  path: string;
  value: unknown;
  /** Which layer the change targets. */
  layer: "global" | "project" | "session";
  why: string;
}

export interface ParsedConfigIntent {
  operations: ConfigOperation[];
  unparsed: string[];
  needsConfirmation: boolean;
}

type Rule = {
  re: RegExp;
  build: (m: RegExpExecArray, scope: "global" | "project" | "session") => ConfigOperation[];
};

const num = (s: string | undefined): number => {
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  if (!s) return NaN;
  return words[s.toLowerCase()] ?? Number(s);
};

const RULES: Rule[] = [
  {
    re: /\b(disable|turn off|stop|pause)\b.*\blearning\b.*\b(this (repo|repository|project))\b/i,
    build: () => [
      {
        path: "learning.enabled",
        value: false,
        layer: "project",
        why: "disable learning for this repository",
      },
    ],
  },
  {
    re: /\b(enable|turn on|resume)\b.*\blearning\b.*\b(this (repo|repository|project))\b/i,
    build: () => [
      { path: "learning.enabled", value: true, layer: "project", why: "enable learning for this repository" },
    ],
  },
  {
    re: /\b(disable|turn off)\b.*\blearning\b/i,
    build: (_m, s) => [{ path: "learning.enabled", value: false, layer: s, why: "disable learning" }],
  },
  {
    re: /\b(enable|turn on)\b.*\blearning\b/i,
    build: (_m, s) => [{ path: "learning.enabled", value: true, layer: s, why: "enable learning" }],
  },
  {
    re: /\bdifficulty\b.*\b(to|=|at)\s*(auto|automatic|\d)\b/i,
    build: (m, s) => [
      {
        path: "learning.difficulty",
        value: /auto/i.test(m[2]!) ? "auto" : Number(m[2]),
        layer: s,
        why: "set difficulty",
      },
    ],
  },
  {
    re: /\b(observe|collaborate|teach|auto(?:matic)?)\s+mode\b|\bmode\b.*\b(to|=)\s*(observe|collaborate|teach|auto)\b/i,
    build: (m, s) => {
      const raw = (m[1] ?? m[3] ?? "").toLowerCase();
      return [
        {
          path: "learning.mode",
          value: raw.startsWith("auto") ? "auto" : raw,
          layer: s,
          why: "set learning mode",
        },
      ];
    },
  },
  {
    re: /\b(reduce|set|change|lower|increase|raise)\b.*\b(number of )?questions( per task)?\b.*\b(to|=)\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i,
    build: (m, s) => [
      { path: "learning.questions_per_task", value: num(m[5]), layer: s, why: "questions per task" },
    ],
  },
  {
    re: /\b(reduce|fewer)\b.*\bquestions\b/i,
    build: (_m, s) => [
      { path: "learning.questions_per_task", value: 2, layer: s, why: "fewer questions per task" },
    ],
  },
  {
    re: /\brequire\b.*\breasoning\b/i,
    build: (m, s) => {
      const ops: ConfigOperation[] = [
        { path: "learning.reasoning_prompts", value: "required", layer: s, why: "require reasoning" },
      ];
      if (/interview/i.test(m.input)) {
        ops.push({ path: "learning.interview_mode", value: true, layer: s, why: "interview mode" });
      }
      return ops;
    },
  },
  {
    re: /\b(enable|turn on|start)\b.*\binterview mode\b/i,
    build: (_m, s) => [
      { path: "learning.interview_mode", value: true, layer: s, why: "enable interview mode" },
    ],
  },
  {
    re: /\b(disable|turn off|stop)\b.*\binterview mode\b/i,
    build: (_m, s) => [
      { path: "learning.interview_mode", value: false, layer: s, why: "disable interview mode" },
    ],
  },
  {
    re: /\b(disable|turn off|no)\b.*\b(external|web|online)\b.*\b(resource|lookup|search)/i,
    build: (_m, s) => [
      {
        path: "resources.external_lookup",
        value: "never",
        layer: s,
        why: "disable external resource lookup",
      },
      {
        path: "privacy.external_resource_lookup",
        value: "never",
        layer: s,
        why: "disable external resource lookup",
      },
    ],
  },
  {
    re: /\b(lower[- ]cost|cheaper|cheap|budget)\b.*\bmodel\b/i,
    build: (_m, s) => [
      {
        path: "ai.token_budget",
        value: "minimal",
        layer: s,
        why: "prefer a lower-cost model for routine assessments",
      },
      {
        path: "ai.effort",
        value: "low",
        layer: s,
        why: "lower effort reduces cost where the provider supports it",
      },
    ],
  },
  {
    re: /\b(?:vault|knowledge vault)\b.*\b(?:to|at)\s+["']?([^"']+?)["']?\s*$/i,
    build: (m, s) => [
      {
        path: "knowledge.vault_path",
        value: m[1]!.trim(),
        layer: s === "session" ? "global" : s,
        why: "change the knowledge vault",
      },
    ],
  },
  {
    re: /\buse obsidian\b/i,
    build: (_m, s) => [
      {
        path: "knowledge.provider",
        value: "obsidian",
        layer: s === "session" ? "global" : s,
        why: "use Obsidian",
      },
    ],
  },
  {
    re: /\b(disable|turn off|stop)\b.*\bcross[- ]project\b/i,
    build: (_m, s) => [
      {
        path: "knowledge.allow_cross_project_reuse",
        value: false,
        layer: s,
        why: "disable cross-project reuse",
      },
    ],
  },
  {
    re: /\b(disable|turn off)\b.*\b(spaced repetition|reviews)\b/i,
    build: (_m, s) => [
      {
        path: "learning.spaced_repetition.enabled",
        value: false,
        layer: s,
        why: "disable spaced repetition",
      },
    ],
  },
];

export function parseConfigIntent(
  text: string,
  defaultLayer: "global" | "project" | "session" = "global",
): ParsedConfigIntent {
  const operations: ConfigOperation[] = [];
  const unparsed: string[] = [];
  const clauses = text
    .split(/(?:[.;\n]|,\s*and\s+|\band then\b|\balso\b)/i)
    .map((c) => c.trim())
    .filter(Boolean);
  for (const clause of clauses) {
    const layer: "global" | "project" | "session" = /\b(this (repo|repository|project))\b/i.test(clause)
      ? "project"
      : /\b(this session|for now|today)\b/i.test(clause)
        ? "session"
        : defaultLayer;
    const rule = RULES.find((r) => r.re.test(clause));
    if (!rule) {
      unparsed.push(clause);
      continue;
    }
    const m = rule.re.exec(clause)!;
    operations.push(...rule.build(m, layer));
  }
  const deduped = new Map<string, ConfigOperation>();
  for (const op of operations) deduped.set(`${op.layer}:${op.path}`, op);
  const ops = [...deduped.values()];
  return {
    operations: ops,
    unparsed,
    needsConfirmation: ops.some((o) => isSensitiveKey(o.path) || o.path === "learning.enabled"),
  };
}
