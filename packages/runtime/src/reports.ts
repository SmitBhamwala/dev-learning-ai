import {
  DAY_MS,
  buildTechnologyTree,
  learningHealth,
  scopeKey,
  type ConceptCatalog,
  type HealthReport,
} from "@dev-learning-ai/core";
import type { Database } from "./store.js";
import { visibleStates } from "./service.js";

/**
 * Reports. Each section separates what was observed (answers, tasks, review
 * outcomes) from what is estimated (retention, freshness, trends). Project
 * reports only include that project's data plus developer-wide knowledge.
 */

export interface ReportSection {
  heading: string;
  observed: string[];
  estimated: string[];
}

export interface Report {
  kind: "weekly" | "monthly" | "session" | "custom";
  title: string;
  period: { from: string; to: string };
  sections: ReportSection[];
  health?: HealthReport;
}

const pct = (n: number | undefined) => (n === undefined ? "n/a" : `${Math.round(n * 100)}%`);

export function buildReport(
  db: Database,
  catalog: ConceptCatalog,
  opts: {
    kind: Report["kind"];
    now: Date;
    days?: number;
    projectId?: string;
    includeHealth?: boolean;
    dependencyInsights?: boolean;
  },
): Report {
  const days = opts.days ?? (opts.kind === "monthly" ? 30 : 7);
  const from = new Date(opts.now.getTime() - days * DAY_MS).toISOString();
  const to = opts.now.toISOString();
  const pk = opts.projectId ? scopeKey({ kind: "project", projectId: opts.projectId }) : undefined;
  const inScope = (sk: string) => sk === "global" || sk === pk;

  const sessions = Object.values(db.sessions).filter(
    (s) => s.createdAt >= from && (!opts.projectId || !s.projectId || s.projectId === opts.projectId),
  );
  const completed = sessions.filter((s) => s.status === "completed");
  const answered = completed.flatMap((s) => s.items.filter((i) => i.evaluation));
  const correct = answered.filter((i) => i.evaluation!.isCorrect).length;
  const tasks = Object.values(db.tasks).filter(
    (t) => t.startedAt >= from && (!opts.projectId || t.projectId === opts.projectId),
  );
  const changes = db.changes.filter(
    (c) => c.at >= from && c.dimension === "mastery" && inScope(scopeKey(c.scope)),
  );

  const byConcept = new Map<string, { before: number; after: number }>();
  for (const c of changes) {
    const prev = byConcept.get(c.conceptId);
    byConcept.set(c.conceptId, { before: prev?.before ?? c.before, after: c.after });
  }
  const improved = [...byConcept]
    .filter(([, v]) => v.after - v.before >= 0.05)
    .sort((a, b) => b[1].after - b[1].before - (a[1].after - a[1].before));
  const declined = [...byConcept].filter(([, v]) => v.before - v.after >= 0.05);
  const label = (id: string) => catalog.get(id)?.label ?? id;

  const sections: ReportSection[] = [
    {
      heading: "Activity",
      observed: [
        `${tasks.length} AI-assisted task(s) observed; ${tasks.filter((t) => t.opportunities.length).length} had learning opportunities.`,
        `${completed.length} assessment(s) completed, ${answered.length} question(s) answered, ${correct} correct.`,
        `${sessions.filter((s) => s.status === "deferred").length} assessment(s) deferred (no model available or budget reached); their evidence was kept.`,
      ],
      estimated: [],
    },
    {
      heading: "What moved",
      observed: [
        ...improved.slice(0, 8).map(([id, v]) => `${label(id)}: ${pct(v.before)} → ${pct(v.after)}`),
        ...declined.slice(0, 5).map(([id, v]) => `${label(id)} dipped: ${pct(v.before)} → ${pct(v.after)}`),
        ...(byConcept.size === 0 ? ["No mastery changes in this period."] : []),
      ],
      estimated: [],
    },
  ];

  const states = visibleStates(db, opts.projectId);
  const techs = catalog
    .technologies()
    .map((t) => buildTechnologyTree(catalog, t, states))
    .filter((t) => t.assessed > 0);
  if (techs.length) {
    sections.push({
      heading: "Technologies",
      observed: techs.map((t) => `${t.label}: ${t.assessed}/${t.total} concepts assessed`),
      estimated: techs.map(
        (t) =>
          `${t.label} overall ${pct(t.overall)} (${t.policy}; version branches shown separately in the knowledge explorer)`,
      ),
    });
  }
  const reviewStates = [...states.values()].filter((s) => s.review);
  const dueSoon = reviewStates.filter(
    (s) => new Date(s.review!.nextReviewAt).getTime() < opts.now.getTime() + 7 * DAY_MS,
  );
  sections.push({
    heading: "Retention and reviews",
    observed: [
      `${reviewStates.length} concept(s) on a review schedule; ${dueSoon.length} due within 7 days.`,
    ],
    estimated: [
      `Retention is estimated from review history with a forgetting curve; it is not a measurement.`,
    ],
  });
  const weak = [...states.values()]
    .filter((s) => s.dimensions.mastery.evidence > 0 && s.dimensions.mastery.value < 0.6)
    .sort((a, b) => a.dimensions.mastery.value - b.dimensions.mastery.value)
    .slice(0, 6);
  if (weak.length) {
    sections.push({
      heading: "Suggested focus",
      observed: weak.map(
        (s) =>
          `${label(s.conceptId)} — mastery ${pct(s.dimensions.mastery.value)} from ${s.dimensions.mastery.evidence} answer(s)`,
      ),
      estimated: [],
    });
  }
  const interview = [...states.values()].filter(
    (s) => catalog.get(s.conceptId)?.interviewCritical && s.dimensions.mastery.evidence > 0,
  );
  if (interview.length) {
    const ready = interview.filter((s) => s.dimensions.mastery.value >= 0.75).length;
    sections.push({
      heading: "Interview readiness",
      observed: [`${ready} of ${interview.length} assessed interview-critical concepts are at 75%+ mastery.`],
      estimated: [],
    });
  }

  let health: HealthReport | undefined;
  if (opts.includeHealth) {
    const encounters = new Map<string, number>();
    for (const t of tasks)
      for (const o of t.opportunities) encounters.set(o.conceptId, (encounters.get(o.conceptId) ?? 0) + 1);
    health = learningHealth({
      aiAssistedTasks: tasks.length,
      encounters,
      states,
      concepts: new Map(catalog.all().map((c) => [c.id, c])),
    });
    if (!opts.dependencyInsights)
      health.insights = health.insights.filter((i) => i.kind !== "needs-evidence");
    sections.push({
      heading: "Learning health",
      observed: health.insights.filter((i) => i.basis === "observed").map((i) => i.message),
      estimated: health.insights.filter((i) => i.basis === "estimated").map((i) => i.message),
    });
  }

  return {
    kind: opts.kind,
    title: `${opts.kind === "weekly" ? "Weekly" : opts.kind === "monthly" ? "Monthly" : "Learning"} report${opts.projectId ? ` — ${db.projects[opts.projectId]?.name ?? opts.projectId}` : ""}`,
    period: { from, to },
    sections,
    health,
  };
}

export function reportToMarkdown(r: Report): string {
  const lines = [
    `# ${r.title}`,
    "",
    `Period: ${r.period.from.slice(0, 10)} → ${r.period.to.slice(0, 10)}`,
    "",
  ];
  for (const s of r.sections) {
    lines.push(`## ${s.heading}`, "");
    if (s.observed.length) lines.push("**Observed**", "", ...s.observed.map((o) => `- ${o}`), "");
    if (s.estimated.length) lines.push("**Estimated**", "", ...s.estimated.map((o) => `- ${o}`), "");
  }
  if (r.health) lines.push(`_${r.health.disclaimer}_`, "");
  return lines.join("\n");
}
