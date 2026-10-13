import {
  DIMENSION_INFO,
  buildTechnologyTree,
  describeScope,
  getPath,
  isSensitiveKey,
  parseStudyRequest,
  scopeKey,
  toPublicQuestion,
  type Dimension,
} from "@dev-learning-ai/core";
import {
  ConfigError,
  ServiceError,
  buildReport,
  recommendResources,
  reportToMarkdown,
  runDoctor,
  type LearningService,
  type WorkContext,
  type WritableLayer,
} from "@dev-learning-ai/runtime";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** What the configuration screen renders: every control maps to one schema path. */
export interface FieldMeta {
  path: string;
  label: string;
  help: string;
  group: string;
  kind: "boolean" | "select" | "number" | "text" | "auto-number";
  options?: string[];
  min?: number;
  max?: number;
}

const F = (
  group: string,
  path: string,
  label: string,
  kind: FieldMeta["kind"],
  help: string,
  extra: Partial<FieldMeta> = {},
): FieldMeta => ({
  group,
  path,
  label,
  kind,
  help,
  ...extra,
});

export const FIELDS: FieldMeta[] = [
  F(
    "Learning",
    "learning.enabled",
    "Learning",
    "boolean",
    "Turn all learning features on or off. Coding is never affected.",
  ),
  F(
    "Learning",
    "learning.mode",
    "Mode",
    "select",
    "Observe records quietly; collaborate offers questions after tasks; teach guides you during work. Auto picks per task and never interrupts urgent work.",
    { options: ["auto", "observe", "collaborate", "teach"] },
  ),
  F(
    "Learning",
    "learning.post_task_assessment",
    "Offer questions after tasks",
    "boolean",
    "After a meaningful task, offer a few questions you can start, defer or skip.",
  ),
  F(
    "Learning",
    "learning.questions_per_task",
    "Questions per task",
    "number",
    "How many questions a post-task assessment asks.",
    { min: 1, max: 20 },
  ),
  F(
    "Learning",
    "learning.difficulty",
    "Difficulty",
    "auto-number",
    "1 (easy) to 5 (hard). Auto follows your demonstrated mastery.",
    { min: 1, max: 5 },
  ),
  F(
    "Learning",
    "learning.min_changed_lines_for_assessment",
    "Minimum changed lines",
    "number",
    "Smaller changes are recorded but don't trigger questions.",
    { min: 0, max: 10000 },
  ),
  F(
    "Assessment",
    "learning.reasoning_prompts",
    "Ask for reasoning",
    "select",
    "Whether to ask why you chose an answer.",
    { options: ["off", "optional", "required"] },
  ),
  F(
    "Assessment",
    "learning.confidence_tracking",
    "Ask for confidence",
    "select",
    "Confidence lets the tool tell a lucky guess from real recall.",
    { options: ["off", "optional", "required"] },
  ),
  F(
    "Assessment",
    "learning.interview_mode",
    "Interview mode",
    "boolean",
    "Harder questions with reasoning required.",
  ),
  F(
    "Reviews",
    "learning.spaced_repetition.enabled",
    "Spaced repetition",
    "boolean",
    "Schedule reviews with new questions on concepts you've learned.",
  ),
  F(
    "Reviews",
    "learning.spaced_repetition.max_reviews_per_day",
    "Reviews per day",
    "number",
    "Upper bound on due reviews offered per day.",
    { min: 1, max: 200 },
  ),
  F(
    "Reviews",
    "learning.knowledge_health.enabled",
    "Learning health",
    "boolean",
    "Neutral, evidence-based indicators in reports.",
  ),
  F(
    "Reviews",
    "learning.knowledge_health.dependency_insights",
    "AI-usage insights",
    "boolean",
    "Point out concepts you've often worked on with AI but haven't been assessed on.",
  ),
  F(
    "Version scope",
    "learning.version_scope.default",
    "Default version scope",
    "select",
    "Which versions questions target by default. Latest is only used with verified sources.",
    { options: ["current", "agnostic", "latest"] },
  ),
  F(
    "AI model",
    "ai.allow_host_model",
    "Let the coding agent's model write questions",
    "boolean",
    "Sends file names, symbols and detected concepts of a task (never whole files) to the agent session's own model.",
  ),
  F(
    "AI model",
    "ai.allow_remote_analysis",
    "Allow a separate AI provider",
    "boolean",
    "Lets a configured provider such as the Anthropic API receive the same task evidence.",
  ),
  F(
    "AI model",
    "ai.provider",
    "Provider",
    "select",
    "Auto prefers the coding agent's model inside an agent, then a configured provider.",
    { options: ["auto", "host", "anthropic"] },
  ),
  F(
    "AI model",
    "ai.model",
    "Model",
    "text",
    "A model id your provider lists, or auto. Never applies to the agent's own model.",
  ),
  F(
    "AI model",
    "ai.effort",
    "Effort",
    "text",
    "Provider-specific effort level (e.g. low, medium, high) or auto.",
  ),
  F(
    "AI model",
    "ai.token_budget",
    "Token budget",
    "select",
    "Minimal caps questions and effort; generous allows more.",
    { options: ["minimal", "balanced", "generous", "custom"] },
  ),
  F(
    "AI model",
    "ai.max_model_calls_per_task",
    "Model calls per task",
    "number",
    "When reached, learning is deferred and the evidence kept.",
    { min: 0, max: 50 },
  ),
  F(
    "AI model",
    "ai.max_model_calls_per_session",
    "Model calls per session",
    "number",
    "Budget across one agent session.",
    { min: 0, max: 500 },
  ),
  F(
    "AI model",
    "ai.fallback",
    "When no model is available",
    "select",
    "Defer keeps the evidence for later; fail reports an error.",
    { options: ["defer", "fail"] },
  ),
  F(
    "Knowledge vault",
    "knowledge.provider",
    "Vault format",
    "select",
    "Obsidian and Markdown are synchronized views of your learning data.",
    { options: ["markdown", "obsidian", "none"] },
  ),
  F(
    "Knowledge vault",
    "knowledge.vault_path",
    "Vault folder",
    "text",
    "Absolute path of the vault. Existing notes are never overwritten.",
  ),
  F(
    "Knowledge vault",
    "knowledge.vault_folder",
    "Folder inside the vault",
    "text",
    "Generated notes go here.",
  ),
  F(
    "Knowledge vault",
    "knowledge.allow_cross_project_reuse",
    "Reuse knowledge across projects",
    "boolean",
    "Project work also counts toward your developer-wide knowledge. Project details never move between projects.",
  ),
  F(
    "Privacy",
    "privacy.store_code_snippets",
    "Code snippets",
    "select",
    "None stores no code; minimal keeps short redacted excerpts.",
    { options: ["none", "minimal", "full"] },
  ),
  F(
    "Privacy",
    "privacy.redact_secrets",
    "Redact secrets",
    "boolean",
    "Pattern-based redaction before storing or sending. Not a guarantee.",
  ),
  F(
    "Privacy",
    "privacy.store_full_transcripts",
    "Store full transcripts",
    "boolean",
    "Off by default; transcripts are never needed for learning.",
  ),
  F(
    "Privacy",
    "resources.external_lookup",
    "External resource lookup",
    "select",
    "Whether resource providers may look things up online.",
    { options: ["never", "ask", "allow"] },
  ),
  F("Dashboard", "dashboard.port", "Port", "auto-number", "Auto picks a free port each time.", {
    min: 1,
    max: 65535,
  }),
];

interface ApiOptions {
  cwd?: string;
}

export function createApi(svc: LearningService, opts: ApiOptions) {
  const work: WorkContext = { cwd: opts.cwd };
  const routes: {
    method: string;
    re: RegExp;
    fn: (m: RegExpExecArray, q: URLSearchParams, body: unknown) => Promise<unknown>;
  }[] = [];
  const route = (
    method: string,
    pattern: string,
    fn: (m: RegExpExecArray, q: URLSearchParams, body: unknown) => Promise<unknown>,
  ) => routes.push({ method, re: new RegExp(`^${pattern}$`), fn });

  route("GET", "/api/overview", async () => {
    const r = await svc.resolved(work);
    const db = await svc.store.read();
    const catalog = await svc.catalog();
    const due = await svc.dueReviews(work);
    const weak = await svc.weakTopics(work, 6);
    const resumable = await svc.resumable(work);
    const weekAgo = new Date(svc.now().getTime() - 7 * 86_400_000).toISOString();
    const recentSessions = Object.values(db.sessions).filter((s) => s.createdAt >= weekAgo);
    const answers = recentSessions.flatMap((s) => s.items.filter((i) => i.evaluation));
    const changes = db.changes.filter(
      (c) =>
        c.at >= weekAgo &&
        c.dimension === "mastery" &&
        (c.scope.kind === "global" ||
          (r.project && scopeKey(c.scope) === scopeKey({ kind: "project", projectId: r.project.id }))),
    );
    const moved = new Map<string, { before: number; after: number; why: string }>();
    for (const c of changes)
      moved.set(c.conceptId, {
        before: moved.get(c.conceptId)?.before ?? c.before,
        after: c.after,
        why: c.explanation,
      });
    const improved = [...moved]
      .filter(([, v]) => v.after > v.before)
      .sort((a, b) => b[1].after - b[1].before - (a[1].after - a[1].before))
      .slice(0, 6);
    const tasks = Object.values(db.tasks)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 6);
    const assessedIds = new Set(
      Object.values(db.knowledge)
        .filter((k) => k.dimensions.mastery.evidence > 0)
        .map((k) => k.conceptId),
    );
    const encountered = new Set(Object.values(db.knowledge).map((k) => k.conceptId));
    const genAgent = await svc.provider(r.config, { ...work, hostAvailable: true });
    const genHere = await svc.provider(r.config, work);
    return {
      project: r.project ? { id: r.project.id, name: r.project.name } : null,
      learning: {
        enabled: r.config.learning.enabled,
        mode: r.config.learning.mode,
        questionsPerTask: r.config.learning.questions_per_task,
      },
      generation: {
        agent: genAgent.provider?.displayName ?? null,
        agentWhy: genAgent.unavailable,
        here: genHere.provider?.displayName ?? null,
      },
      due: due.slice(0, 8),
      dueCount: due.length,
      weak,
      resumable: resumable.map((s) => ({
        id: s.id,
        answered: s.items.filter((i) => i.evaluation).length,
        total: s.items.length,
        status: s.status,
      })),
      week: {
        answered: answers.length,
        correct: answers.filter((a) => a.evaluation!.isCorrect).length,
        assessments: recentSessions.filter((s) => s.status === "completed").length,
      },
      coverage: { assessed: assessedIds.size, encountered: encountered.size },
      improved: improved.map(([id, v]) => ({ conceptId: id, label: catalog.get(id)?.label ?? id, ...v })),
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title ?? "Untitled task",
        at: t.startedAt,
        concepts: t.opportunities.map((o) => o.label),
        skipped: t.skippedReason,
        offer: t.offer,
        project: t.projectId ? db.projects[t.projectId]?.name : undefined,
      })),
    };
  });

  route("GET", "/api/knowledge", async (_m, q) => {
    const catalog = await svc.catalog();
    const { global, project, projectId } = await svc.knowledgeStates(work);
    const dimension = (q.get("dimension") ?? "mastery") as Dimension;
    if (!(dimension in DIMENSION_INFO)) throw new HttpError(400, "Unknown dimension");
    const technologies = catalog.technologies().map((t) => {
      const tree = buildTechnologyTree(catalog, t, global, { dimension, projectId });
      return {
        technology: t,
        label: tree.label,
        overall: tree.overall,
        assessed: tree.assessed,
        total: tree.total,
        policy: tree.policy,
        groups: tree.groups.map((g) => ({
          id: g.id,
          label: g.label,
          score: g.score,
          assessed: g.assessed,
          total: g.total,
          concepts: g.children.map((c) => ({
            id: c.concept.id,
            label: c.concept.label,
            score: c.score,
            evidence: c.evidence,
            scope: describeScope(c.concept.versionScope),
          })),
        })),
      };
    });
    return {
      dimension,
      dimensions: DIMENSION_INFO,
      technologies,
      project: [...project.values()].map((s) => ({
        conceptId: s.conceptId,
        label: catalog.get(s.conceptId)?.label ?? s.conceptId,
        application: s.dimensions.application.value,
        mastery: s.dimensions.mastery.evidence ? s.dimensions.mastery.value : null,
      })),
    };
  });

  route("GET", "/api/concepts/([a-z0-9.\\-/@]+)", async (m) => {
    const e = await svc.explainConcept(m[1]!, work);
    if (!e.concept) throw new HttpError(404, "Unknown concept");
    return {
      concept: { ...e.concept, scopeLabel: describeScope(e.concept.versionScope) },
      states: e.states.map((s) => ({ scope: s.scope.kind, dimensions: s.dimensions, review: s.review })),
      evidence: e.evidence.slice(-30).map((ev) => ({
        id: ev.id,
        kind: ev.kind,
        at: ev.at,
        scope: ev.scope.kind,
        outcome: ev.outcome,
        reliability: ev.reliability,
        novel: ev.isNovelVariant,
      })),
      changes: e.changes.slice(-40),
    };
  });

  route("GET", "/api/projects", async () => {
    const db = await svc.store.read();
    const loc = await svc.locate(work);
    return Object.values(db.projects).map((p) => ({
      ...p,
      isCurrent: p.id === loc.project?.id,
      tasks: Object.values(db.tasks).filter((t) => t.projectId === p.id).length,
      projectKnowledge: Object.values(db.knowledge).filter(
        (k) => k.scope.kind === "project" && k.scope.projectId === p.id,
      ).length,
    }));
  });

  route("GET", "/api/assessments", async () => {
    const db = await svc.store.read();
    const catalog = await svc.catalog();
    return Object.values(db.sessions)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100)
      .map((s) => ({
        id: s.id,
        status: s.status,
        origin: s.origin.kind,
        project: s.projectId ? (db.projects[s.projectId]?.name ?? s.projectId) : null,
        createdAt: s.createdAt,
        answered: s.items.filter((i) => i.evaluation).length,
        correct: s.items.filter((i) => i.evaluation?.isCorrect).length,
        total: s.items.length,
        concepts: [...new Set(s.items.map((i) => catalog.get(i.conceptId)?.label ?? i.conceptId))],
        deferredReason: s.deferredReason,
      }));
  });

  route("GET", "/api/assessments/([\\w-]+)", async (m) => {
    const db = await svc.store.read();
    const s = db.sessions[m[1]!];
    if (!s) throw new HttpError(404, "No such assessment");
    const catalog = await svc.catalog();
    return {
      ...s,
      pending: undefined,
      items: s.items.map((i) => {
        const q = db.questions[i.questionId];
        // The answer key is only shown for questions already answered or skipped.
        const reveal = Boolean(i.evaluation || i.skipped);
        return {
          ...i,
          concept: catalog.get(i.conceptId)?.label ?? i.conceptId,
          question: q
            ? { ...toPublicQuestion(q), correct: reveal ? q.correct : undefined, provenance: q.provenance }
            : null,
        };
      }),
    };
  });

  route("POST", "/api/assessments/([\\w-]+)/redact", async (m) => {
    await svc.store.transact((db) => {
      const s = db.sessions[m[1]!];
      if (!s) throw new HttpError(404, "No such assessment");
      for (const i of s.items)
        if (i.answer)
          i.answer = {
            choiceIds: i.answer.choiceIds,
            confidence: i.answer.confidence,
            text: i.answer.text ? "[deleted]" : undefined,
            reasoning: i.answer.reasoning ? "[deleted]" : undefined,
          };
    });
    return { ok: true };
  });

  route("POST", "/api/assess", async (_m, _q, body) => {
    const b = (body ?? {}) as { topic?: string; conceptIds?: string[]; kind?: string; count?: number };
    const study = b.topic ? parseStudyRequest(String(b.topic).slice(0, 200)) : undefined;
    return svc.prepareAssessment(
      {
        kind: b.kind === "review" ? "review" : "manual",
        study,
        conceptIds: Array.isArray(b.conceptIds) ? b.conceptIds.slice(0, 20).map(String) : undefined,
        count: typeof b.count === "number" ? b.count : undefined,
      },
      work,
    );
  });
  route("GET", "/api/assess/([\\w-]+)", async (m) => (await svc.getAssessment(m[1]!)).question ?? null);
  route("POST", "/api/assess/([\\w-]+)/answer", async (m, _q, body) => {
    const b = (body ?? {}) as {
      questionId?: string;
      choiceIds?: string[];
      text?: string;
      reasoning?: string;
      confidence?: "guessing" | "low" | "medium" | "high";
    };
    if (!b.questionId) throw new HttpError(400, "questionId is required");
    return svc.answer(
      m[1]!,
      b.questionId,
      {
        choiceIds: b.choiceIds,
        text: b.text?.slice(0, 5000),
        reasoning: b.reasoning?.slice(0, 5000),
        confidence: b.confidence,
      },
      work,
    );
  });
  route("POST", "/api/assess/([\\w-]+)/skip", async (m) => svc.skipQuestion(m[1]!));

  route("GET", "/api/reviews", async () => svc.dueReviews(work, { includeUpcoming: true }));
  route("POST", "/api/reviews/([a-z0-9.\\-/@]+)", async (m, _q, body) => {
    const b = (body ?? {}) as { action?: string; days?: number };
    if (b.action === "postpone")
      return svc.updateReview(m[1]!, { postponeDays: Math.max(1, Math.min(90, Number(b.days ?? 1))) }, work);
    if (b.action === "suspend") return svc.updateReview(m[1]!, { suspend: true }, work);
    if (b.action === "resume") return svc.updateReview(m[1]!, { resume: true }, work);
    throw new HttpError(400, "action must be postpone, suspend or resume");
  });

  route("GET", "/api/reports", async (_m, q) => {
    const r = await svc.resolved(work);
    const kind = q.get("kind") === "monthly" ? "monthly" : "weekly";
    const report = buildReport(await svc.store.read(), await svc.catalog(), {
      kind,
      now: svc.now(),
      projectId: q.get("scope") === "all" ? undefined : r.project?.id,
      includeHealth: r.config.learning.knowledge_health.enabled,
      dependencyInsights: r.config.learning.knowledge_health.dependency_insights,
    });
    return { report, markdown: reportToMarkdown(report) };
  });

  route("GET", "/api/resources", async () => {
    const { global, project } = await svc.knowledgeStates(work);
    return recommendResources(await svc.catalog(), new Map([...global, ...project]), { limit: 20 });
  });

  route("GET", "/api/config", async () => {
    const r = await svc.resolved(work);
    return {
      fields: FIELDS.map((f) => ({
        ...f,
        value: getPath(r.config, f.path),
        origin: r.origins[f.path] ?? "defaults",
        locked: r.locked.includes(f.path),
        sensitive: isSensitiveKey(f.path),
      })),
      hasProject: Boolean(r.project),
      projectName: r.project?.name,
    };
  });
  route("POST", "/api/config", async (_m, _q, body) => {
    const b = (body ?? {}) as {
      changes?: { path: string; value: unknown }[];
      layer?: string;
      confirm?: boolean;
    };
    const layer = (
      ["global", "project", "workspace"].includes(String(b.layer)) ? b.layer : "global"
    ) as WritableLayer;
    const changes = Array.isArray(b.changes) ? b.changes.slice(0, 50) : [];
    const allowed = new Set(FIELDS.map((f) => f.path));
    for (const c of changes)
      if (!allowed.has(c.path)) throw new HttpError(400, `${c.path} cannot be changed from the dashboard`);
    const loc = await svc.locate(work);
    const confirm = b.confirm === true;
    // Two-step: without confirm this is a validated dry run returning the diff.
    return svc.config.apply(
      changes.map((c) => ({ path: c.path, value: c.value, layer })),
      { actor: "dashboard", ctx: loc.ctx, confirm, dryRun: !confirm },
    );
  });
  route("GET", "/api/config/history", async () => svc.config.history(30));
  route("POST", "/api/config/rollback", async (_m, _q, body) => {
    const id = String((body as { id?: string })?.id ?? "");
    if (!/^cfg_[\w-]+$/.test(id)) throw new HttpError(400, "Invalid change id");
    return svc.config.rollback(id, (await svc.locate(work)).ctx);
  });

  route("GET", "/api/integrations", async () => {
    const r = await svc.resolved(work);
    const providers = [];
    for (const p of svc.registry.list()) {
      const s = await p.status();
      providers.push({
        id: p.id,
        name: p.displayName,
        implemented: p.isImplemented,
        available: s.available,
        reason: s.reason,
      });
    }
    return {
      adapters: [
        {
          id: "claude-code-mods",
          name: "Claude Code (Mods)",
          status: "implemented",
          detail: "Verified against Claude Code 2.1.295 function-hook types.",
        },
        {
          id: "manual",
          name: "Manual event ingestion",
          status: "implemented",
          detail: "dev-learning-ai ingest --file / --stdin",
        },
        {
          id: "others",
          name: "Codex, Cursor, Gemini CLI, Copilot, Cline, Aider…",
          status: "not implemented",
          detail: "Use manual ingestion until an adapter exists.",
        },
      ],
      providers,
      gates: { allowHostModel: r.config.ai.allow_host_model, allowRemote: r.config.ai.allow_remote_analysis },
    };
  });
  route("GET", "/api/diagnostics", async () => runDoctor(svc, work));
  route("POST", "/api/vault/sync", async () => svc.syncVault(work));

  return async (method: string, path: string, q: URLSearchParams, body: unknown): Promise<unknown> => {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(path);
      if (m) {
        try {
          return await r.fn(m, q, body);
        } catch (err) {
          if (err instanceof HttpError) throw err;
          if (err instanceof ConfigError) throw new HttpError(400, err.message);
          if (err instanceof ServiceError)
            throw new HttpError(
              err.code === "not-found" ? 404 : err.code === "conflict" ? 409 : 400,
              err.message,
            );
          throw err;
        }
      }
    }
    throw new HttpError(404, "Unknown endpoint");
  };
}
