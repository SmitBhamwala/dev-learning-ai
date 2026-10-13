import { z } from "zod";

/**
 * Version-aware knowledge. A version scope says which releases a question,
 * concept or study request applies to. Version numbers are never invented:
 * "latest" stays symbolic until a provider resolves it from a verified source.
 */

export const VersionScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agnostic") }),
  z.object({ kind: z.literal("current") }),
  z.object({ kind: z.literal("latest") }),
  z.object({ kind: z.literal("specific"), version: z.string().min(1) }),
  z.object({ kind: z.literal("range"), from: z.string().min(1), to: z.string().min(1) }),
  z.object({ kind: z.literal("migration"), from: z.string().min(1), to: z.string().min(1) }),
  z.object({ kind: z.literal("comparison"), versions: z.array(z.string().min(1)).min(2) }),
]);
export type VersionScope = z.infer<typeof VersionScopeSchema>;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

export function parseVersion(raw: string): ParsedVersion | undefined {
  const m = /^\s*[v=^~]?\s*(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(raw);
  if (!m) return undefined;
  const num = (s: string | undefined) => (s === undefined || s === "x" || s === "*" ? 0 : Number(s));
  return { major: Number(m[1]), minor: num(m[2]), patch: num(m[3]), raw: raw.trim() };
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return a.localeCompare(b);
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

export function majorOf(raw: string): number | undefined {
  return parseVersion(raw)?.major;
}

/**
 * Whether a concept or question that applies to `applies` is relevant for a
 * learner whose requested scope is `requested`. `installed` is the project's
 * verified version, used to resolve the "current" scope.
 */
export function scopeIncludes(
  requested: VersionScope,
  applies: VersionScope | undefined,
  installed?: string,
): boolean {
  if (!applies || applies.kind === "agnostic") return true;
  const majors = appliesMajors(applies);
  if (majors === "any") return true;
  const wanted = requestedMajors(requested, installed);
  if (wanted === "any") return true;
  if (wanted === "none") return false;
  return majors.some((m) => wanted.includes(m));
}

function appliesMajors(scope: VersionScope): number[] | "any" {
  switch (scope.kind) {
    case "agnostic":
    case "current":
    case "latest":
      return "any";
    case "specific":
      return [majorOf(scope.version) ?? -1];
    case "range":
    case "migration":
      return majorRange(scope.from, scope.to);
    case "comparison":
      return scope.versions.map((v) => majorOf(v) ?? -1);
  }
}

function requestedMajors(scope: VersionScope, installed?: string): number[] | "any" | "none" {
  switch (scope.kind) {
    case "agnostic":
    case "latest":
      return "any";
    case "current": {
      if (!installed) return "any";
      const m = majorOf(installed);
      return m === undefined ? "any" : [m];
    }
    case "specific":
      return [majorOf(scope.version) ?? -1];
    case "range":
    case "migration":
      return majorRange(scope.from, scope.to);
    case "comparison":
      return scope.versions.map((v) => majorOf(v) ?? -1);
  }
}

function majorRange(from: string, to: string): number[] {
  const a = majorOf(from);
  const b = majorOf(to);
  if (a === undefined || b === undefined) return [];
  const out: number[] = [];
  for (let m = Math.min(a, b); m <= Math.max(a, b); m++) out.push(m);
  return out;
}

export function describeScope(scope: VersionScope | undefined): string {
  if (!scope) return "all versions";
  switch (scope.kind) {
    case "agnostic":
      return "version-agnostic";
    case "current":
      return "the project's installed version";
    case "latest":
      return "the latest stable release (resolved from verified docs only)";
    case "specific":
      return scope.version;
    case "range":
      return `${scope.from}–${scope.to}`;
    case "migration":
      return `migration ${scope.from} → ${scope.to}`;
    case "comparison":
      return `comparison of ${scope.versions.join(", ")}`;
  }
}

export interface StudyRequest {
  technology?: string;
  scope: VersionScope;
  focus?: string;
}

const TECH_ALIASES: Record<string, string> = {
  react: "react",
  "react.js": "react",
  reactjs: "react",
  angular: "angular",
  vue: "vue",
  typescript: "typescript",
  ts: "typescript",
  javascript: "javascript",
  js: "javascript",
  node: "nodejs",
  "node.js": "nodejs",
  nodejs: "nodejs",
  postgres: "postgresql",
  postgresql: "postgresql",
  sql: "sql",
  docker: "docker",
  python: "python",
  go: "go",
  http: "http",
  security: "security",
};

/**
 * Parses study requests such as "Quiz me on React 18 and 19", "Prepare me for
 * Angular 7–10", "Focus on changes between Node.js 20 and 22" or "latest stable
 * TypeScript". Deterministic; no model call.
 */
export function parseStudyRequest(text: string): StudyRequest {
  const lower = text.toLowerCase().replace(/[–—]/g, "-");
  let technology: string | undefined;
  let techIndex = -1;
  for (const [alias, id] of Object.entries(TECH_ALIASES)) {
    const re = new RegExp(`(^|[^a-z.])${alias.replace(/\./g, "\\.")}(?=$|[^a-z])`);
    const m = re.exec(lower);
    if (m && (techIndex === -1 || alias.length > 2)) {
      technology = id;
      techIndex = m.index;
      if (alias.length > 2) break;
    }
  }
  const tail = techIndex >= 0 ? lower.slice(techIndex) : lower;
  const focus = /fundamental|basics/.test(lower) ? "fundamentals" : undefined;

  if (/latest|newest|most recent/.test(lower)) return { technology, scope: { kind: "latest" }, focus };
  if (/(current|this|my) (codebase|project|repo)/.test(lower))
    return { technology, scope: { kind: "current" }, focus };

  const between = /between\s+(?:[a-z.]+\s+)?v?(\d+(?:\.\d+)*)\s+(?:and|to|&)\s+v?(\d+(?:\.\d+)*)/.exec(lower);
  if (between) {
    const isMigration = /migrat|upgrad|changes/.test(lower);
    return {
      technology,
      scope: isMigration
        ? { kind: "migration", from: between[1]!, to: between[2]! }
        : { kind: "comparison", versions: [between[1]!, between[2]!] },
      focus,
    };
  }
  const range = /v?(\d+(?:\.\d+)*)\s*(?:-|to|through)\s*v?(\d+(?:\.\d+)*)/.exec(tail);
  if (range) {
    if (/migrat|upgrad/.test(lower))
      return { technology, scope: { kind: "migration", from: range[1]!, to: range[2]! }, focus };
    return { technology, scope: { kind: "range", from: range[1]!, to: range[2]! }, focus };
  }
  const pair = /v?(\d+(?:\.\d+)*)\s*(?:and|&|,|vs\.?|versus)\s*v?(\d+(?:\.\d+)*)/.exec(tail);
  if (pair) return { technology, scope: { kind: "comparison", versions: [pair[1]!, pair[2]!] }, focus };
  const single = /v?(\d+(?:\.\d+)*)/.exec(tail);
  if (single && technology) return { technology, scope: { kind: "specific", version: single[1]! }, focus };
  return { technology, scope: { kind: "agnostic" }, focus };
}
