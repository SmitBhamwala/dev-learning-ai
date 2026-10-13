/**
 * Secret redaction applied before anything is persisted or sent to a provider.
 * Pattern-based and well tested, but NOT a guarantee: novel secret formats can
 * slip through. Data minimisation (not storing snippets at all) is the
 * primary control; redaction is the second line.
 */

export interface RedactionResult {
  text: string;
  redactions: { kind: string; count: number }[];
}

const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "stripe-key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: "connection-string", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@[^\s'"]+/gi },
  { kind: "bearer-token", re: /\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/g },
  {
    kind: "assignment",
    re: /\b((?:api[_-]?key|secret|password|passwd|pwd|token|auth[_-]?token|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*)(["']?)[^\s"',;]{6,}\2/gi,
  },
];

export function redactSecrets(input: string): RedactionResult {
  let text = input;
  const counts = new Map<string, number>();
  for (const { kind, re } of PATTERNS) {
    text = text.replace(re, (...args: unknown[]) => {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      if (kind === "assignment") return `${String(args[1])}${String(args[2])}[REDACTED]${String(args[2])}`;
      if (kind === "bearer-token") return `${String(args[1])} [REDACTED]`;
      if (kind === "connection-string")
        return (args[0] as string).replace(/:\/\/([^\s:/@]+):[^\s@/]+@/, "://$1:[REDACTED]@");
      return `[REDACTED:${kind}]`;
    });
  }
  return { text, redactions: [...counts].map(([kind, count]) => ({ kind, count })) };
}

export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value).text as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /^(password|secret|token|api[_-]?key|authorization|cookie)$/i.test(k)
        ? "[REDACTED]"
        : redactDeep(v);
    }
    return out as T;
  }
  return value;
}

export type SnippetPolicy = "none" | "minimal" | "full";

/** Applies the snippet retention policy to an excerpt before it is stored. */
export function minimizeExcerpt(
  excerpt: string | undefined,
  policy: SnippetPolicy,
  redact = true,
): string | undefined {
  if (!excerpt || policy === "none") return undefined;
  const clean = redact ? redactSecrets(excerpt).text : excerpt;
  if (policy === "minimal") return clean.split("\n").slice(0, 12).join("\n").slice(0, 600);
  return clean.slice(0, 2000);
}

/** Strips project-identifying detail from text before it is reused outside its project. */
export function stripProjectDetail(text: string, projectTerms: string[]): string {
  let out = text;
  for (const term of projectTerms.filter((t) => t.length >= 3)) {
    out = out.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[project]");
  }
  return out.replace(/(?:[A-Za-z]:)?[\w.-]*(?:[\\/][\w.-]+)+/g, "[path]");
}
