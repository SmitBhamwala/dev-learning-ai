import { round } from "../domain/ids.js";
import type { Concept, KnowledgeState } from "../domain/model.js";
import type { VersionScope } from "../domain/version.js";
import type { CodeChangeSummary, TaskContext } from "../events/events.js";
import type { ConceptCatalog } from "./catalog.js";

/**
 * Deterministic learning-opportunity detection. Runs before (and usually
 * instead of) any model call: path globs, observed symbols/keywords and the
 * project's verified technologies decide which concepts a task touched.
 * Trivial work (lockfile churn, generated files, formatting, docs) is skipped.
 */

export const OPPORTUNITY_RULES_VERSION = "opportunity@1";

export interface LearningOpportunity {
  conceptId: string;
  label: string;
  technology: string;
  versionScope?: VersionScope;
  why: string;
  evidence: string[];
  confidence: number;
  depth: "refresher" | "standard" | "deep";
  isNew: boolean;
  isProjectSpecific: boolean;
  /** Rough model-token estimate for generating questions about it. */
  estimatedTokens: number;
}

export interface OpportunityInput {
  task?: TaskContext;
  changes: CodeChangeSummary[];
  technologies: { technology: string; version?: string }[];
  states: Map<string, KnowledgeState>;
  projectId?: string;
  minChangedLines?: number;
  /** Explicit request bypasses the triviality filter. */
  isExplicit?: boolean;
  limit?: number;
}

export interface OpportunityResult {
  opportunities: LearningOpportunity[];
  skipped?: string;
  rulesVersion: string;
}

const LOCKFILES =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum|uv\.lock)$/i;
const GENERATED =
  /(^|\/)(dist|build|out|coverage|node_modules|\.next|\.turbo|vendor|__generated__|generated)\/|\.min\.(js|css)$|\.snap$|\.d\.ts\.map$|\.map$/i;
const DOCS = /\.(md|mdx|txt|rst|adoc)$|(^|\/)(LICENSE|CHANGELOG|AUTHORS)$/i;

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

const globCache = new Map<string, RegExp>();
export function matchesGlob(path: string, glob: string): boolean {
  let re = globCache.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    globCache.set(glob, re);
  }
  return re.test(path.replace(/\\/g, "/"));
}

export function classifyChanges(changes: CodeChangeSummary[]): {
  meaningful: CodeChangeSummary[];
  lines: number;
  reason?: string;
} {
  const meaningful = changes.filter((c) => {
    const p = c.path.replace(/\\/g, "/");
    return !LOCKFILES.test(p) && !GENERATED.test(p) && !DOCS.test(p);
  });
  const lines = meaningful.reduce((s, c) => s + (c.linesAdded ?? 0) + (c.linesRemoved ?? 0), 0);
  if (changes.length > 0 && meaningful.length === 0) {
    const all = changes.map((c) => c.path.replace(/\\/g, "/"));
    if (all.every((p) => LOCKFILES.test(p))) return { meaningful, lines, reason: "only lockfile changes" };
    if (all.every((p) => GENERATED.test(p)))
      return { meaningful, lines, reason: "only generated files changed" };
    return { meaningful, lines, reason: "only documentation changed" };
  }
  return { meaningful, lines };
}

export function detectOpportunities(catalog: ConceptCatalog, input: OpportunityInput): OpportunityResult {
  const base = { rulesVersion: OPPORTUNITY_RULES_VERSION };
  const { meaningful, lines, reason } = classifyChanges(input.changes);
  if (!input.isExplicit) {
    if (reason) return { ...base, opportunities: [], skipped: reason };
    if (meaningful.length === 0) return { ...base, opportunities: [], skipped: "no code changes observed" };
    const hasLineCounts = meaningful.some((c) => c.linesAdded !== undefined || c.linesRemoved !== undefined);
    const min = input.minChangedLines ?? 10;
    if (hasLineCounts && lines < min)
      return { ...base, opportunities: [], skipped: `small change (${lines} lines < ${min})` };
    if (input.task?.urgency === "incident")
      return { ...base, opportunities: [], skipped: "incident: learning deferred" };
  }

  const techs = new Map(input.technologies.map((t) => [t.technology, t.version]));
  const text = [input.task?.title ?? "", ...meaningful.flatMap((c) => [...c.symbols, c.excerpt ?? ""])]
    .join("\n")
    .toLowerCase();
  const paths = meaningful.map((c) => c.path.replace(/\\/g, "/"));

  const scored: LearningOpportunity[] = [];
  for (const concept of catalog.visibleTo(input.projectId)) {
    if (concept.id === concept.technology || !concept.parent) continue;
    const evidence: string[] = [];
    let score = 0;
    const pathHits = paths.filter((p) => concept.signals.paths.some((g) => matchesGlob(p, g)));
    if (pathHits.length) {
      score += 0.25;
      evidence.push(`files: ${pathHits.slice(0, 3).join(", ")}`);
    }
    const kwHits = concept.signals.keywords.filter((k) => text.includes(k.toLowerCase()));
    if (kwHits.length) {
      score += Math.min(0.6, 0.3 + 0.1 * (kwHits.length - 1));
      evidence.push(`observed: ${kwHits.slice(0, 4).join(", ")}`);
    }
    const importHits = concept.signals.imports.filter((i) => text.includes(i.toLowerCase()));
    if (importHits.length) {
      score += 0.2;
      evidence.push(`imports: ${importHits.join(", ")}`);
    }
    const parentTechInProject = techs.has(concept.technology);
    if (score > 0 && parentTechInProject) {
      score += 0.15;
      evidence.push(
        `${concept.technology}${techs.get(concept.technology) ? ` ${techs.get(concept.technology)}` : ""} is used in this project`,
      );
    }
    if (!versionApplies(concept, techs.get(concept.technology))) continue;
    if (score < 0.35) continue;

    const state = input.states.get(concept.id);
    const mastery = state?.dimensions.mastery;
    const isNew = !mastery || mastery.evidence === 0;
    const depth: LearningOpportunity["depth"] = isNew
      ? "standard"
      : mastery!.value >= 0.8
        ? "refresher"
        : "deep";
    scored.push({
      conceptId: concept.id,
      label: concept.label,
      technology: concept.technology,
      versionScope: concept.versionScope,
      why: whyFor(concept, kwHits, pathHits),
      evidence,
      confidence: round(Math.min(1, score)),
      depth,
      isNew,
      isProjectSpecific: Boolean(concept.projectId),
      estimatedTokens: 1200,
    });
  }
  scored.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      Number(b.isNew) - Number(a.isNew) ||
      a.conceptId.localeCompare(b.conceptId),
  );
  return { ...base, opportunities: scored.slice(0, input.limit ?? 5) };
}

/** A version-specific concept is only relevant when the installed version is unknown or within its scope. */
function versionApplies(concept: Concept, installed: string | undefined): boolean {
  const vs = concept.versionScope;
  if (!vs || !installed) return true;
  const major = Number(/(\d+)/.exec(installed)?.[1]);
  if (!Number.isFinite(major)) return true;
  const toMajor = (v: string) => Number(/(\d+)/.exec(v)?.[1]);
  switch (vs.kind) {
    case "specific":
      return toMajor(vs.version) === major;
    case "range":
      return major >= toMajor(vs.from) && major <= toMajor(vs.to);
    case "migration":
      return major === toMajor(vs.from) || major === toMajor(vs.to);
    default:
      return true;
  }
}

function whyFor(concept: Concept, keywords: string[], paths: string[]): string {
  if (keywords.length)
    return `The task used ${keywords.slice(0, 2).join(" and ")}, which relies on ${concept.label.toLowerCase()}.`;
  if (paths.length) return `The task changed ${paths[0]}, where ${concept.label.toLowerCase()} matters.`;
  return `Related to ${concept.label.toLowerCase()}.`;
}
