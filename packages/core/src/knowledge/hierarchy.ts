import { round } from "../domain/ids.js";
import type { Concept, Dimension, KnowledgeState } from "../domain/model.js";
import type { ConceptCatalog } from "./catalog.js";

/**
 * Builds the technology knowledge hierarchy and aggregates scores with the
 * documented policy `agnostic-first@1`:
 *
 * - Groups: version-agnostic concepts (fundamentals, architecture, performance,
 *   testing, security), one branch per major version, version transitions, and
 *   project-specific concepts.
 * - A group's score is the evidence-weighted mean of its *assessed* concepts.
 *   Unassessed concepts are reported as coverage gaps, never as zero: lack of
 *   exposure is not lack of ability.
 * - The technology's overall score weights version-agnostic concepts at 1.0 and
 *   version-specific/transition concepts at 0.25, so a gap in a new release
 *   does not reduce the fundamentals score (which is shown on its own) and only
 *   lightly affects the overall figure.
 */

export const AGGREGATION_POLICY = "agnostic-first@1";
const VERSION_WEIGHT = 0.25;

export interface ConceptNode {
  kind: "concept";
  concept: Concept;
  state?: KnowledgeState;
  score?: number;
  evidence: number;
}

export interface GroupNode {
  kind: "group";
  id: string;
  label: string;
  score?: number;
  assessed: number;
  total: number;
  children: ConceptNode[];
}

export interface TechnologyTree {
  technology: string;
  label: string;
  overall?: number;
  policy: string;
  assessed: number;
  total: number;
  groups: GroupNode[];
}

function conceptScore(
  state: KnowledgeState | undefined,
  dim: Dimension,
): { score?: number; evidence: number } {
  if (!state) return { evidence: 0 };
  const d = state.dimensions[dim];
  if (!d || d.evidence === 0) return { evidence: 0 };
  return { score: d.value, evidence: d.evidence };
}

function weightedMean(items: { score?: number; evidence: number; weight?: number }[]): number | undefined {
  let num = 0;
  let den = 0;
  for (const i of items) {
    if (i.score === undefined) continue;
    const w = (i.weight ?? 1) * Math.min(5, Math.max(1, i.evidence));
    num += i.score * w;
    den += w;
  }
  return den === 0 ? undefined : round(num / den);
}

function groupOf(c: Concept): { id: string; label: string; isVersioned: boolean } {
  if (c.projectId) return { id: "project", label: "Project-specific", isVersioned: false };
  if (c.category === "transition" || c.versionScope?.kind === "migration") {
    return { id: "transitions", label: "Version transitions", isVersioned: true };
  }
  const vs = c.versionScope;
  if (vs && vs.kind !== "agnostic") {
    const from =
      vs.kind === "specific"
        ? vs.version
        : vs.kind === "range"
          ? vs.from
          : vs.kind === "comparison"
            ? vs.versions[0]!
            : undefined;
    const label = from ?? "?";
    return { id: `v${label}`, label: `Version ${label}`, isVersioned: true };
  }
  const cat = c.category;
  if (cat === "architecture")
    return { id: "architecture", label: "Architecture and patterns", isVersioned: false };
  if (cat === "performance") return { id: "performance", label: "Performance", isVersioned: false };
  if (cat === "testing") return { id: "testing", label: "Testing", isVersioned: false };
  if (cat === "security") return { id: "security", label: "Security", isVersioned: false };
  return { id: "fundamentals", label: "Version-agnostic fundamentals", isVersioned: false };
}

export function buildTechnologyTree(
  catalog: ConceptCatalog,
  technology: string,
  states: Map<string, KnowledgeState>,
  opts: { dimension?: Dimension; projectId?: string } = {},
): TechnologyTree {
  const dim = opts.dimension ?? "mastery";
  const root = catalog.get(technology);
  const concepts = catalog
    .visibleTo(opts.projectId)
    .filter((c) => c.technology === technology && c.id !== technology);
  const groups = new Map<string, GroupNode & { isVersioned: boolean }>();
  for (const c of concepts) {
    const g = groupOf(c);
    const node = groups.get(g.id) ?? {
      kind: "group" as const,
      id: g.id,
      label: g.label,
      assessed: 0,
      total: 0,
      children: [],
      isVersioned: g.isVersioned,
    };
    const s = conceptScore(states.get(c.id), dim);
    node.children.push({
      kind: "concept",
      concept: c,
      state: states.get(c.id),
      score: s.score,
      evidence: s.evidence,
    });
    node.total++;
    if (s.score !== undefined) node.assessed++;
    groups.set(g.id, node);
  }
  const order = ["fundamentals", "architecture", "performance", "testing", "security"];
  const sorted = [...groups.values()].sort((a, b) => {
    const ia = order.indexOf(a.id);
    const ib = order.indexOf(b.id);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    if (a.id === "project") return 1;
    if (b.id === "project") return -1;
    if (a.id === "transitions") return 1;
    if (b.id === "transitions") return -1;
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });
  for (const g of sorted) g.score = weightedMean(g.children);
  const overall = weightedMean(
    sorted.flatMap((g) =>
      g.children.map((c) => ({
        score: c.score,
        evidence: c.evidence,
        weight: g.isVersioned ? VERSION_WEIGHT : 1,
      })),
    ),
  );
  return {
    technology,
    label: root?.label ?? technology,
    overall,
    policy: AGGREGATION_POLICY,
    assessed: sorted.reduce((s, g) => s + g.assessed, 0),
    total: sorted.reduce((s, g) => s + g.total, 0),
    groups: sorted.map(({ isVersioned: _v, ...g }) => g),
  };
}

export function renderTree(tree: TechnologyTree): string {
  const pct = (n?: number) => (n === undefined ? "not yet assessed" : `${Math.round(n * 100)}%`);
  const lines = [
    `${tree.label} — overall ${pct(tree.overall)} (${tree.assessed}/${tree.total} concepts assessed, policy ${tree.policy})`,
  ];
  tree.groups.forEach((g, gi) => {
    const last = gi === tree.groups.length - 1;
    lines.push(`${last ? "└──" : "├──"} ${g.label} — ${pct(g.score)} (${g.assessed}/${g.total})`);
    g.children.forEach((c, ci) => {
      const cl = ci === g.children.length - 1;
      lines.push(`${last ? "    " : "│   "}${cl ? "└──" : "├──"} ${c.concept.label} — ${pct(c.score)}`);
    });
  });
  return lines.join("\n");
}
