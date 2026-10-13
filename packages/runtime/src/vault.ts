import { access, constants, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DIMENSION_INFO,
  buildTechnologyTree,
  describeScope,
  renderTree,
  scopeKey,
  type Concept,
  type ConceptCatalog,
  type Dimension,
  type KnowledgeState,
  type Project,
} from "@dev-learning-ai/core";
import { atomicWrite, exists, readTextFile } from "./fsutil.js";
import type { Database } from "./store.js";

/**
 * Markdown and Obsidian knowledge vaults: synchronised, human-readable views of
 * the structured store (which remains the source of truth for scoring and
 * scheduling).
 *
 * Ownership: every note this tool writes has `dla_managed: true` in its
 * frontmatter and keeps its generated content between BEGIN/END markers.
 * Text outside the markers is the user's and is preserved on every sync. A
 * note at the target path WITHOUT the marker is user-authored: it is never
 * overwritten; the generated note is written beside it with a suffix and a
 * conflict is reported.
 */

export const BEGIN =
  "<!-- dev-learning-ai:begin (generated; edits inside this block are replaced on sync) -->";
export const END = "<!-- dev-learning-ai:end -->";

export interface VaultTarget {
  provider: "markdown" | "obsidian";
  root: string;
  folder: string;
}

export interface VaultCheck {
  ok: boolean;
  path: string;
  isObsidianVault: boolean;
  problems: string[];
  hints: string[];
}

export interface SyncReport {
  written: string[];
  unchanged: number;
  conflicts: { path: string; writtenTo: string }[];
  root: string;
}

export async function checkVault(target: VaultTarget): Promise<VaultCheck> {
  const path = resolve(target.root);
  const problems: string[] = [];
  const hints: string[] = [];
  let isObsidianVault = false;
  if (!(await exists(path))) {
    if (target.provider === "obsidian") {
      problems.push(`Vault folder ${path} does not exist or is not mounted.`);
      hints.push("Open the vault in Obsidian once, or set knowledge.vault_path to the vault's folder.");
    } else hints.push(`${path} will be created on first sync.`);
    return { ok: target.provider !== "obsidian", path, isObsidianVault, problems, hints };
  }
  isObsidianVault = await exists(join(path, ".obsidian"));
  if (target.provider === "obsidian" && !isObsidianVault) {
    hints.push(
      "No .obsidian folder found: this may not be an Obsidian vault (notes will still be written as Markdown).",
    );
  }
  try {
    await access(path, constants.W_OK);
  } catch {
    problems.push(`No write permission for ${path}.`);
    hints.push("Grant your user write access to the vault folder, or choose another vault_path.");
  }
  return { ok: problems.length === 0, path, isObsidianVault, problems, hints };
}

function frontmatter(fields: Record<string, unknown>): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(
      ([k, v]) =>
        `${k}: ${Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(", ")}]` : JSON.stringify(v)}`,
    );
  return `---\n${lines.join("\n")}\n---\n`;
}

const safeName = (s: string) =>
  s
    .replace(/[\\/:*?"<>|#^[\]]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
const pct = (n: number | undefined) => (n === undefined ? "—" : `${Math.round(n * 100)}%`);

export class VaultWriter {
  private readonly base: string;
  private readonly isObsidian: boolean;
  readonly report: SyncReport;

  constructor(target: VaultTarget) {
    this.base = join(resolve(target.root), target.folder);
    this.isObsidian = target.provider === "obsidian";
    this.report = { written: [], unchanged: 0, conflicts: [], root: this.base };
  }

  link(path: string, label: string): string {
    return this.isObsidian
      ? `[[${path}|${label}]]`
      : `[${label}](${encodeURI(`${path}.md`).replace(/^/, this.relPrefix(path))})`;
  }

  private relPrefix(_path: string): string {
    return "/";
  }

  /** Writes a managed note, preserving user text outside the generated block. */
  async writeNote(relPath: string, meta: Record<string, unknown>, body: string): Promise<void> {
    const file = join(this.base, `${relPath}.md`);
    const block = `${BEGIN}\n${body.trim()}\n${END}`;
    const fm = frontmatter({ ...meta, dla_managed: true });
    const existing = await readTextFile(file);
    let next: string;
    if (existing === undefined) {
      next = `${fm}\n${block}\n`;
    } else if (!existing.includes("dla_managed: true")) {
      const alt = join(this.base, `${relPath} (dev-learning-ai).md`);
      await mkdir(join(alt, ".."), { recursive: true });
      const altExisting = await readTextFile(alt);
      const altNext = `${fm}\n${block}\n`;
      if (altExisting !== altNext) await atomicWrite(alt, altNext);
      this.report.conflicts.push({ path: file, writtenTo: alt });
      return;
    } else {
      const start = existing.indexOf(BEGIN);
      const end = existing.indexOf(END);
      const fmEnd = existing.startsWith("---") ? existing.indexOf("\n---", 3) + 4 : 0;
      if (start === -1 || end === -1 || end < start) {
        next = `${fm}\n${block}\n\n${existing.slice(fmEnd).trim()}\n`;
      } else {
        const userBefore = existing.slice(fmEnd, start).replace(/^\n+/, "");
        const userAfter = existing.slice(end + END.length);
        next = `${fm}\n${userBefore}${block}${userAfter}`;
      }
    }
    if (existing === next) {
      this.report.unchanged++;
      return;
    }
    await atomicWrite(file, next);
    this.report.written.push(file);
  }
}

export interface SyncInput {
  db: Database;
  catalog: ConceptCatalog;
  target: VaultTarget;
  now: Date;
  /** Only this project's project-scoped data is written; others are excluded. */
  projectIds?: string[];
}

function stateFor(db: Database, conceptId: string, scope: string): KnowledgeState | undefined {
  return db.knowledge[`${scope}|${conceptId}`];
}

function dimTable(state: KnowledgeState | undefined): string {
  const rows = (Object.keys(DIMENSION_INFO) as Dimension[]).map((d) => {
    const v = state?.dimensions[d];
    const info = DIMENSION_INFO[d];
    return `| ${info.label}${info.isEstimate ? " (estimate)" : ""} | ${v && v.evidence > 0 ? pct(v.value) : "not assessed"} | ${v?.evidence ?? 0} |`;
  });
  return ["| Dimension | Value | Evidence |", "|---|---|---|", ...rows].join("\n");
}

export async function syncVault(input: SyncInput): Promise<SyncReport> {
  const { db, catalog, now } = input;
  const w = new VaultWriter(input.target);
  const projects = Object.values(db.projects).filter(
    (p) => !input.projectIds || input.projectIds.includes(p.id),
  );
  const extraConcepts = Object.values(db.concepts);
  const concepts: Concept[] = [...catalog.all(), ...extraConcepts.filter((c) => !catalog.has(c.id))];

  // Concept notes (developer-wide)
  const assessed = new Set(Object.values(db.knowledge).map((k) => k.conceptId));
  for (const c of concepts.filter((c) => !c.projectId && assessed.has(c.id))) {
    const s = stateFor(db, c.id, "global");
    const evidence = Object.values(db.evidence).filter(
      (e) => e.conceptId === c.id && e.scope.kind === "global",
    );
    const changes = db.changes
      .filter((ch) => ch.conceptId === c.id && ch.scope.kind === "global" && ch.dimension === "mastery")
      .slice(-8);
    const body = [
      `# ${c.label}`,
      "",
      c.summary,
      "",
      `Technology: ${w.link(`Technologies/${safeName(catalog.get(c.technology)?.label ?? c.technology)}/Index`, catalog.get(c.technology)?.label ?? c.technology)} · Scope: ${describeScope(c.versionScope)}${c.interviewCritical ? " · interview-critical" : ""}`,
      "",
      "## Developer-wide knowledge",
      "",
      dimTable(s),
      "",
      s?.review
        ? `Next review: ${s.review.nextReviewAt.slice(0, 10)} — ${s.review.reason ?? ""}`
        : "No review scheduled.",
      "",
      "## Recent mastery changes",
      "",
      ...(changes.length
        ? changes.map(
            (ch) =>
              `- ${ch.at.slice(0, 10)}: ${pct(ch.before)} → ${pct(ch.after)} — ${ch.explanation} (${ch.ruleVersion})`,
          )
        : ["- none yet"]),
      "",
      `Evidence records: ${evidence.length} (observed). Retention and freshness are estimates.`,
      ...(c.related.length
        ? [
            "",
            "## Related",
            "",
            ...c.related.map((r) => `- ${w.link(`Concepts/${r}`, catalog.get(r)?.label ?? r)}`),
          ]
        : []),
    ].join("\n");
    await w.writeNote(
      `Concepts/${c.id}`,
      {
        dla_id: c.id,
        dla_type: "concept",
        technology: c.technology,
        tags: ["dev-learning-ai", c.technology],
      },
      body,
    );
  }

  // Technology notes with the hierarchy
  const globalStates = new Map(
    Object.values(db.knowledge)
      .filter((k) => k.scope.kind === "global")
      .map((k) => [k.conceptId, k]),
  );
  for (const tech of catalog.technologies()) {
    const tree = buildTechnologyTree(catalog, tech, globalStates);
    if (tree.assessed === 0) continue;
    const body = [
      `# ${tree.label}`,
      "",
      "```text",
      renderTree(tree),
      "```",
      "",
      `Overall uses the \`${tree.policy}\` policy: version-specific branches are shown separately and weigh 25% in the overall figure, so a gap in a new release never lowers your fundamentals score.`,
      "",
      ...tree.groups.flatMap((g) => [
        `## ${g.label}`,
        "",
        ...g.children.map(
          (c) => `- ${w.link(`Concepts/${c.concept.id}`, c.concept.label)} — ${pct(c.score)}`,
        ),
        "",
      ]),
    ].join("\n");
    await w.writeNote(
      `Technologies/${safeName(tree.label)}/Index`,
      { dla_id: `tech:${tech}`, dla_type: "technology" },
      body,
    );
  }

  // Project notes (each project's data only in its own note)
  for (const p of projects) {
    const key = scopeKey({ kind: "project", projectId: p.id });
    const states = Object.values(db.knowledge).filter((k) => scopeKey(k.scope) === key);
    const tasks = Object.values(db.tasks)
      .filter((t) => t.projectId === p.id)
      .slice(-10);
    const body = [
      `# ${p.name}`,
      "",
      `Project id: \`${p.id}\`${p.productGroup ? ` · product: ${p.productGroup}` : ""}${p.isMonorepo ? " · monorepo" : ""}`,
      "",
      "## Technologies",
      "",
      ...p.technologies.map(
        (t) =>
          `- ${t.technology}${t.version ? ` ${t.version}` : t.declaredRange ? ` (declared ${t.declaredRange})` : ""} — ${t.provenance[0]?.source ?? "?"}${t.correctedByUser ? " (corrected by you)" : ""}`,
      ),
      "",
      "## Project-specific knowledge",
      "",
      ...(states.length
        ? states.map(
            (s) =>
              `- ${w.link(`Concepts/${s.conceptId}`, catalog.get(s.conceptId)?.label ?? s.conceptId)} — application ${pct(s.dimensions.application.evidence ? s.dimensions.application.value : undefined)}, mastery ${pct(s.dimensions.mastery.evidence ? s.dimensions.mastery.value : undefined)}`,
          )
        : ["- none yet"]),
      "",
      "## Recent AI-assisted tasks",
      "",
      ...(tasks.length
        ? tasks.map(
            (t) =>
              `- ${t.startedAt.slice(0, 10)} ${t.title ?? t.id} — ${t.opportunities.map((o) => o.label).join(", ") || t.skippedReason || "no learning opportunity"}`,
          )
        : ["- none yet"]),
    ].join("\n");
    await w.writeNote(`Projects/${safeName(p.name)}`, { dla_id: p.id, dla_type: "project" }, body);
  }

  // Assessments
  const sessions = Object.values(db.sessions)
    .filter(
      (s) =>
        s.status === "completed" &&
        (!s.projectId || !input.projectIds || input.projectIds.includes(s.projectId)),
    )
    .slice(-50);
  for (const s of sessions) {
    const body = [
      `# Assessment ${s.createdAt.slice(0, 16).replace("T", " ")}`,
      "",
      `Origin: ${s.origin.kind}${s.projectId ? ` · project ${db.projects[s.projectId]?.name ?? s.projectId}` : ""}`,
      "",
      ...s.items.flatMap((it, i) => [
        `## ${i + 1}. ${catalog.get(it.conceptId)?.label ?? it.conceptId}`,
        "",
        it.evaluation
          ? `${it.evaluation.headline} (${Math.round(it.evaluation.correctness * 100)}%) · ${it.evaluation.calibration}`
          : it.skipped
            ? "Skipped"
            : "Not answered",
        it.answer?.confidence ? `Confidence: ${it.answer.confidence}` : "",
        it.answer?.reasoning ? `Reasoning: ${it.answer.reasoning}` : "",
        "",
        it.evaluation?.explanation ?? "",
        "",
      ]),
      ...(s.summary ? ["## Summary", "", ...s.summary.lines.map((l) => `- ${l}`)] : []),
    ].join("\n");
    await w.writeNote(
      `Assessments/${s.createdAt.slice(0, 10)} ${s.id.slice(-8)}`,
      { dla_id: s.id, dla_type: "assessment" },
      body,
    );
  }

  // Reviews
  const due = Object.values(db.knowledge)
    .filter((k) => k.review && !k.review.suspended)
    .sort((a, b) => (a.review!.nextReviewAt < b.review!.nextReviewAt ? -1 : 1))
    .slice(0, 100);
  await w.writeNote(
    "Reviews/Schedule",
    { dla_id: "reviews", dla_type: "reviews", updated: now.toISOString() },
    [
      "# Review schedule",
      "",
      "| Concept | Scope | Next review | Why |",
      "|---|---|---|---|",
      ...due.map(
        (k) =>
          `| ${w.link(`Concepts/${k.conceptId}`, catalog.get(k.conceptId)?.label ?? k.conceptId)} | ${k.scope.kind === "global" ? "developer-wide" : (db.projects[(k.scope as { projectId: string }).projectId]?.name ?? "project")} | ${k.review!.nextReviewAt.slice(0, 10)} | ${k.review!.reason ?? ""} |`,
      ),
    ].join("\n"),
  );

  await w.writeNote(
    "Index",
    { dla_id: "index", dla_type: "index" },
    [
      "# Developer knowledge",
      "",
      "Generated by dev-learning-ai. Notes are views of the local learning database; text you add outside the generated blocks is kept.",
      "",
      "## Technologies",
      "",
      ...catalog
        .technologies()
        .filter((t) => buildTechnologyTree(catalog, t, globalStates).assessed > 0)
        .map(
          (t) =>
            `- ${w.link(`Technologies/${safeName(catalog.get(t)?.label ?? t)}/Index`, catalog.get(t)?.label ?? t)}`,
        ),
      "",
      "## Projects",
      "",
      ...projects.map((p: Project) => `- ${w.link(`Projects/${safeName(p.name)}`, p.name)}`),
      "",
      `- ${w.link("Reviews/Schedule", "Review schedule")}`,
    ].join("\n"),
  );
  return w.report;
}

export async function listVaultNotes(target: VaultTarget): Promise<string[]> {
  const base = join(resolve(target.root), target.folder);
  const out: string[] = [];
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".md")) out.push(p);
    }
  };
  await walk(base);
  return out;
}
