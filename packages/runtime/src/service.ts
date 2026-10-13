import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  BUILTIN_CONCEPTS,
  ConceptCatalog,
  GLOBAL_SCOPE,
  ModelBudget,
  ProviderRegistry,
  HostModelProvider,
  UnimplementedProvider,
  applyEvidence,
  buildGenerationRequest,
  createScheduler,
  currentItem,
  detectOpportunities,
  eventIdempotencyKey,
  evaluateAnswer,
  explainChanges,
  isDue,
  isFinished,
  minimizeExcerpt,
  mergeProviderGrade,
  buildGradingRequest,
  parseGrade,
  newId,
  normalizeEvent,
  parseGeneratedQuestions,
  postpone,
  progressLabel,
  questionsForTask,
  resolveDifficulty,
  resolveMode,
  resolveProvider,
  scopeIncludes,
  scopeKey,
  stripProjectDetail,
  toPublicQuestion,
  withCurrentEstimates,
  OPEN_TYPES,
  type Answer,
  type AssessmentSession,
  type Concept,
  type Config,
  type Evidence,
  type KnowledgeScope,
  type KnowledgeState,
  type LearningEvent,
  type LearningOpportunity,
  type Project,
  type PublicQuestion,
  type Question,
  type ResolvedConfig,
  type ResolvedProvider,
  type ReviewScheduler,
  type StudyRequest,
} from "@dev-learning-ai/core";
import { ConfigService, type ConfigContext } from "./config-service.js";
import { ensureDir, readJsonFile } from "./fsutil.js";
import { globalPaths, resolveHome, type GlobalPaths } from "./paths.js";
import { findProjectForPath } from "./projects.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { Store, knowledgeKey, type Database, type TaskRecord } from "./store.js";
import { checkVault, syncVault, type SyncReport, type VaultTarget } from "./vault.js";

export interface ServiceOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  registry?: ProviderRegistry;
}

export interface WorkContext {
  cwd?: string;
  /** The coding agent's session id, for session-scoped overrides and budgets. */
  sessionId?: string;
  /** True when the caller can execute host model requests (an agent integration). */
  hostAvailable?: boolean;
}

export interface Located {
  project?: Project;
  root?: string;
  workspace?: string;
  ctx: ConfigContext;
}

export interface Offer {
  taskId: string;
  projectId?: string;
  mode: string;
  modeReason: string;
  concepts: { conceptId: string; label: string; why: string; isNew: boolean }[];
  questionCount: number;
  message: string;
}

export interface IngestResult {
  duplicate: boolean;
  eventKey: string;
  taskId?: string;
  opportunities?: LearningOpportunity[];
  skipped?: string;
  offer?: Offer;
}

export interface GenerationRequestOut {
  requestKey: string;
  conceptId: string;
  system: string;
  prompt: string;
  maxTokens: number;
}

export interface PreparedAssessment {
  assessmentId: string;
  status: AssessmentSession["status"];
  /** For host-delegated generation: run these on the host model and submit the replies. */
  requests: GenerationRequestOut[];
  question?: QuestionView;
  reason?: string;
  warnings: string[];
}

export interface QuestionView {
  assessmentId: string;
  question: PublicQuestion;
  conceptLabel: string;
  progress: string;
  index: number;
  total: number;
  requireReasoning: boolean;
  requireConfidence: boolean;
  askReasoning: boolean;
  askConfidence: boolean;
}

export interface AnswerResult {
  assessmentId: string;
  questionId: string;
  headline: string;
  isCorrect: boolean;
  correctness: number;
  calibration: string;
  feedback: string[];
  explanation: string;
  next?: QuestionView;
  summary?: AssessmentSession["summary"];
  replayed: boolean;
}

export class ServiceError extends Error {
  constructor(
    message: string,
    readonly code: "not-found" | "invalid" | "conflict" | "disabled" | "unavailable" = "invalid",
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

const PRACTICAL_RELIABILITY = 0.3;

export class LearningService {
  readonly paths: GlobalPaths;
  readonly store: Store;
  readonly config: ConfigService;
  readonly registry: ProviderRegistry;
  readonly now: () => Date;
  readonly env: NodeJS.ProcessEnv;
  private catalogCache?: ConceptCatalog;

  private constructor(opts: ServiceOptions) {
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? (() => new Date());
    this.paths = globalPaths(opts.home ?? resolveHome(this.env), this.env);
    this.store = new Store(this.paths.database, this.now);
    this.config = new ConfigService(this.paths, this.store, this.now);
    this.registry =
      opts.registry ??
      new ProviderRegistry([
        new HostModelProvider(),
        new AnthropicProvider({ env: this.env }),
        new UnimplementedProvider("openai", "OpenAI"),
        new UnimplementedProvider("gemini", "Google Gemini"),
      ]);
  }

  /** True when this process created the global installation (first run). */
  createdOnOpen = false;

  static async open(opts: ServiceOptions = {}): Promise<LearningService> {
    const s = new LearningService(opts);
    s.createdOnOpen = (await s.init()).created;
    return s;
  }

  /** Creates the global installation if needed. Idempotent; reuses an existing installation. */
  async init(): Promise<{ created: boolean; home: string }> {
    const existed = (await readJsonFile(join(this.paths.database, "meta.json"))) !== undefined;
    for (const d of [
      this.paths.config,
      this.paths.database,
      this.paths.cache,
      this.paths.logs,
      this.paths.projects,
      this.paths.inbox,
      this.paths.backups,
    ]) {
      await ensureDir(d);
    }
    await this.store.open();
    return { created: !existed, home: this.paths.home };
  }

  // ── Context ──────────────────────────────────────────────────────────

  async locate(work: WorkContext = {}): Promise<Located> {
    const db = await this.store.read();
    const found = work.cwd ? await findProjectForPath(db, work.cwd) : undefined;
    const project =
      found?.project ??
      (db.meta.activeProjectId && !work.cwd ? db.projects[db.meta.activeProjectId] : undefined);
    const root = found?.root ?? project?.paths[0];
    return {
      project,
      root,
      workspace: found?.workspace,
      ctx: { projectRoot: root, workspacePath: found?.workspace, sessionId: work.sessionId },
    };
  }

  async resolved(work: WorkContext = {}): Promise<ResolvedConfig & Located> {
    const loc = await this.locate(work);
    return { ...(await this.config.resolve(loc.ctx)), ...loc };
  }

  async catalog(): Promise<ConceptCatalog> {
    const db = await this.store.read();
    const extra = Object.values(db.concepts);
    if (!this.catalogCache || this.catalogCache.all().length !== BUILTIN_CONCEPTS.length + extra.length) {
      const cat = new ConceptCatalog();
      for (const c of extra) if (!cat.has(c.id)) cat.add(c);
      this.catalogCache = cat;
    }
    return this.catalogCache;
  }

  scheduler(config: Config): ReviewScheduler {
    return createScheduler(
      config.learning.spaced_repetition.algorithm === "default"
        ? "sm2"
        : config.learning.spaced_repetition.algorithm,
    );
  }

  async provider(config: Config, work: WorkContext): Promise<ResolvedProvider> {
    return resolveProvider(config, this.registry, { hostAvailable: Boolean(work.hostAvailable) });
  }

  // ── Event ingestion ──────────────────────────────────────────────────

  /**
   * Ingests one normalized event. Idempotent: a replayed event (same logical
   * key) is acknowledged and ignored. Never throws for a disabled or excluded
   * project; it simply records nothing.
   */
  async ingest(raw: unknown, work: WorkContext = {}): Promise<IngestResult> {
    const event = normalizeEvent(raw);
    const key = eventIdempotencyKey(event);
    const cfg = await this.resolved({ ...work, cwd: work.cwd ?? event.repository?.root });
    const config = cfg.config;
    const projectId = event.projectId ?? cfg.project?.id;
    if (!config.learning.enabled) return { duplicate: false, eventKey: key, skipped: "learning is disabled" };
    if (cfg.project?.excludedFromLearning)
      return { duplicate: false, eventKey: key, skipped: "project excluded from learning" };
    if (
      config.events.sampling_rate < 1 &&
      event.type === "task.progressed" &&
      Math.random() > config.events.sampling_rate
    ) {
      return { duplicate: false, eventKey: key, skipped: "sampled out" };
    }
    const catalog = await this.catalog();
    const now = this.now();
    const scheduler = this.scheduler(config);

    const minimized: LearningEvent = {
      ...event,
      projectId,
      changes: event.changes?.map((c) => ({
        ...c,
        excerpt: minimizeExcerpt(
          c.excerpt,
          config.privacy.store_code_snippets,
          config.privacy.redact_secrets,
        ),
      })),
    };

    return this.store.transact((db) => {
      if (db.events[key]) return { duplicate: true, eventKey: key, taskId: db.events[key]!.taskId };
      const taskId = event.task?.id ?? event.correlationId;
      db.events[key] = {
        key,
        eventId: event.id,
        type: event.type,
        providerId: event.source.providerId,
        projectId,
        taskId,
        receivedAt: now.toISOString(),
        event: minimized,
      };
      trimEvents(db, config.events.max_queue * 10);
      if (!taskId) return { duplicate: false, eventKey: key };

      const task: TaskRecord = db.tasks[taskId] ?? {
        id: taskId,
        projectId,
        providerId: event.source.providerId,
        sessionId: event.source.sessionId,
        title: event.task?.title,
        urgency: event.task?.urgency ?? "normal",
        status: "in-progress",
        startedAt: event.timestamp,
        changedPaths: [],
        changedLines: 0,
        symbols: [],
        technologies: [],
        opportunities: [],
        offer: "none",
      };
      if (event.task?.title) task.title = event.task.title;
      if (event.task?.urgency) task.urgency = event.task.urgency;
      for (const c of minimized.changes ?? []) {
        if (!task.changedPaths.includes(c.path)) task.changedPaths.push(c.path);
        task.changedLines += (c.linesAdded ?? 0) + (c.linesRemoved ?? 0);
        for (const s of c.symbols)
          if (!task.symbols.includes(s) && task.symbols.length < 200) task.symbols.push(s);
      }
      task.changedPaths = task.changedPaths.slice(-300);
      const projectTechs = projectId ? (db.projects[projectId]?.technologies ?? []) : [];
      task.technologies = mergeTechs(task.technologies, [
        ...(event.technologies ?? []),
        // Root-level facts first, then sub-projects (polyglot repos such as frontend/ + backend/).
        ...[...projectTechs]
          .sort((a, b) => Number(Boolean(a.workspace)) - Number(Boolean(b.workspace)))
          .map((t) => ({ technology: t.technology, version: t.version })),
      ]);
      db.tasks[taskId] = task;

      if (event.type !== "task.completed") return { duplicate: false, eventKey: key, taskId };
      if (task.status === "completed")
        return { duplicate: false, eventKey: key, taskId, opportunities: task.opportunities };
      task.status = event.task?.status === "aborted" ? "aborted" : "completed";
      task.completedAt = event.timestamp;

      const states = visibleStates(db, projectId);
      const detected = detectOpportunities(catalog, {
        task: event.task,
        changes: task.changedPaths
          .map((p) => ({ path: p, kind: "modified" as const, symbols: [] as string[] }))
          .map((c, i) => (i === 0 ? { ...c, symbols: task.symbols, linesAdded: task.changedLines } : c)),
        technologies: task.technologies,
        states,
        projectId,
        minChangedLines: config.learning.min_changed_lines_for_assessment,
      });
      task.opportunities = detected.opportunities;
      task.skippedReason = detected.skipped;

      // Practical-work evidence: a code change shows exposure and some application, never full mastery.
      for (const o of detected.opportunities) {
        for (const scope of evidenceScopes(config, projectId, catalog.get(o.conceptId))) {
          recordEvidence(
            db,
            {
              id: newId("ev"),
              key: `practical|${taskId}|${o.conceptId}|${scopeKey(scope)}`,
              kind: "practical-work",
              conceptId: o.conceptId,
              scope,
              at: now.toISOString(),
              reliability: PRACTICAL_RELIABILITY * o.confidence,
              isNovelVariant: false,
              ref: { taskId },
            },
            { now, scheduler },
          );
        }
      }

      if (!detected.opportunities.length)
        return { duplicate: false, eventKey: key, taskId, opportunities: [], skipped: detected.skipped };
      const mastery = avg(
        detected.opportunities.map((o) => states.get(o.conceptId)?.dimensions.mastery.value),
      );
      const mode = resolveMode(config, {
        urgency: task.urgency,
        changedLines: task.changedLines,
        conceptMastery: mastery,
        pausedForTask: task.learningPaused,
      });
      const count = questionsForTask(config, { urgency: task.urgency });
      if (
        !config.learning.post_task_assessment ||
        mode.value === "disabled" ||
        mode.value === "paused" ||
        count.value === 0
      ) {
        return {
          duplicate: false,
          eventKey: key,
          taskId,
          opportunities: detected.opportunities,
          skipped: count.value === 0 ? count.reason : mode.reason,
        };
      }
      task.offer = "pending";
      const offer: Offer = {
        taskId,
        projectId,
        mode: mode.value,
        modeReason: mode.reason,
        concepts: detected.opportunities.map((o) => ({
          conceptId: o.conceptId,
          label: o.label,
          why: o.why,
          isNew: o.isNew,
        })),
        questionCount: count.value,
        message: `This task touched ${detected.opportunities
          .slice(0, 3)
          .map((o) => o.label.toLowerCase())
          .join(", ")}. ${count.value} quick question${count.value === 1 ? "" : "s"}?`,
      };
      return { duplicate: false, eventKey: key, taskId, opportunities: detected.opportunities, offer };
    });
  }

  /** Imports events an agent integration dropped into the inbox folder (no running service needed). */
  async drainInbox(
    work: WorkContext = {},
  ): Promise<{ processed: number; failed: { file: string; error: string }[]; offers: Offer[] }> {
    let names: string[] = [];
    try {
      names = (await readdir(this.paths.inbox)).filter((n) => n.endsWith(".json")).sort();
    } catch {
      return { processed: 0, failed: [], offers: [] };
    }
    const failed: { file: string; error: string }[] = [];
    const offers: Offer[] = [];
    let processed = 0;
    for (const n of names.slice(0, 500)) {
      const file = join(this.paths.inbox, n);
      try {
        const payload = await readJsonFile<unknown>(file);
        const events = Array.isArray(payload) ? payload : [payload];
        for (const e of events) {
          const r = await this.ingest(e, work);
          if (r.offer) offers.push(r.offer);
        }
        processed++;
        await rm(file, { force: true });
      } catch (err) {
        failed.push({ file: n, error: (err as Error).message.slice(0, 300) });
        await rm(file, { force: true }).catch(() => undefined);
      }
    }
    return { processed, failed, offers };
  }

  async setTaskOffer(taskId: string, offer: "deferred" | "declined"): Promise<void> {
    await this.store.transact((db) => {
      const t = db.tasks[taskId];
      if (!t) throw new ServiceError(`No task ${taskId}`, "not-found");
      t.offer = offer;
    });
  }

  async pauseTask(taskId: string): Promise<void> {
    await this.store.transact((db) => {
      const t = db.tasks[taskId];
      if (t) t.learningPaused = true;
    });
  }

  // ── Assessments ──────────────────────────────────────────────────────

  /**
   * Creates an assessment and prepares question generation. With a direct
   * provider the questions are generated now; with the host provider the
   * requests are returned for the agent integration to run; with neither,
   * the assessment is deferred and its evidence kept.
   */
  async prepareAssessment(
    spec: {
      kind: "task" | "review" | "manual" | "interview";
      taskId?: string;
      conceptIds?: string[];
      study?: StudyRequest;
      count?: number;
    },
    work: WorkContext = {},
  ): Promise<PreparedAssessment> {
    const cfg = await this.resolved(work);
    const config = cfg.config;
    if (!config.learning.enabled)
      throw new ServiceError("Learning is disabled (learning.enabled: false)", "disabled");
    const catalog = await this.catalog();
    const db = await this.store.read();
    const now = this.now();
    let projectId = cfg.project?.id;
    let opportunities: LearningOpportunity[] = [];
    let task: TaskRecord | undefined;

    if (spec.taskId) {
      task = db.tasks[spec.taskId];
      if (!task) throw new ServiceError(`No task ${spec.taskId}`, "not-found");
      if (task.assessmentSessionId && db.sessions[task.assessmentSessionId]) {
        const existing = db.sessions[task.assessmentSessionId]!;
        if (existing.status !== "abandoned") return this.preparedView(existing, catalog, []);
      }
      projectId = task.projectId ?? projectId;
      opportunities = task.opportunities;
    }
    let conceptIds = spec.conceptIds ?? opportunities.map((o) => o.conceptId);
    if (spec.study?.technology && conceptIds.length === 0) {
      const study = spec.study;
      const installed = installedVersion(cfg.project, study.technology ?? "");
      const candidates = catalog
        .visibleTo(projectId)
        .filter((c) => c.technology === study.technology && c.parent)
        .filter((c) => (study.focus === "fundamentals" ? !c.versionScope : true))
        .filter((c) => scopeIncludes(study.scope, c.versionScope, installed));
      // A version-scoped request ("React 18", "Node 20 → 22") targets that version's concepts first.
      const isVersioned =
        !["agnostic", "current", "latest"].includes(study.scope.kind) ||
        (study.scope.kind === "current" && installed);
      const versioned = candidates.filter((c) => c.versionScope && c.versionScope.kind !== "agnostic");
      conceptIds = (isVersioned && versioned.length ? versioned : candidates).map((c) => c.id);
    }
    if (spec.kind === "review" && conceptIds.length === 0) {
      conceptIds = (await this.dueReviews(work)).map((d) => d.conceptId);
    }
    conceptIds = [...new Set(conceptIds)].filter((id) => catalog.has(id));
    if (conceptIds.length === 0) throw new ServiceError("Nothing to assess: no matching concepts", "invalid");

    const states = visibleStates(db, projectId);
    const scope: KnowledgeScope = projectId ? { kind: "project", projectId } : GLOBAL_SCOPE;
    const total = Math.max(1, Math.min(spec.count ?? questionsForTask(config).value, 20));
    // Spread questions over concepts: weakest/newest first.
    const ordered = [...conceptIds].sort(
      (a, b) =>
        (states.get(a)?.dimensions.mastery.value ?? -1) - (states.get(b)?.dimensions.mastery.value ?? -1),
    );
    const perConcept = new Map<string, number>();
    for (let i = 0; i < total; i++) {
      const id = ordered[i % ordered.length]!;
      perConcept.set(id, (perConcept.get(id) ?? 0) + 1);
    }
    const projectTerms = otherProjectTerms(db, projectId);
    const pending: AssessmentSession["pending"] = [];
    for (const [conceptId, count] of perConcept) {
      const concept = catalog.get(conceptId)!;
      const opp = opportunities.find((o) => o.conceptId === conceptId);
      const st = states.get(conceptId);
      const evidence = opp ? opp.evidence : [];
      const installed =
        task?.technologies.find((t) => t.technology === concept.technology)?.version ??
        installedVersion(cfg.project, concept.technology);
      const avoid = priorPrompts(db, conceptId, projectId).map((p) => stripProjectDetail(p, projectTerms));
      const req = buildGenerationRequest({
        concept,
        why: opp?.why,
        evidence,
        count,
        difficulty: resolveDifficulty(
          config,
          st?.dimensions.mastery.evidence ? st.dimensions.mastery.value : undefined,
        ).value,
        installedVersion: installed,
        avoidPrompts: avoid,
        lastType: st?.lastQuestionType,
        preferChoice: !config.learning.interview_mode,
        purpose:
          spec.kind === "task"
            ? "post-task"
            : spec.kind === "interview"
              ? "interview"
              : spec.kind === "review"
                ? "review"
                : "study",
      });
      pending.push({
        requestKey: req.requestKey,
        conceptId,
        count,
        system: req.system,
        prompt: req.prompt,
        maxTokens: req.maxTokens,
        evidence,
      });
    }

    const session: AssessmentSession = {
      id: newId("asm"),
      schemaVersion: 1,
      projectId,
      scope,
      origin: {
        kind: spec.kind,
        taskId: spec.taskId,
        providerId: task?.providerId,
        sessionId: work.sessionId ?? task?.sessionId,
      },
      mode: resolveMode(config, { urgency: task?.urgency }).value,
      status: "generating",
      requestedScope: spec.study?.scope,
      items: [],
      cursor: 0,
      requireReasoning: config.learning.reasoning_prompts === "required" || config.learning.interview_mode,
      requireConfidence: config.learning.confidence_tracking === "required",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      pending,
      generation: { calls: 0, inputTokens: 0, outputTokens: 0, rejected: [] },
    };

    const resolvedProvider = await this.provider(config, work);
    const warnings = [...resolvedProvider.warnings];
    const budget = ModelBudget.fromConfig(config);
    const used = usageFor(db, spec.taskId, session.origin.sessionId);
    const estimate = pending.reduce((s, p) => s + p.maxTokens + 800, 0);
    const budgetCheck = budget.check(used, estimate);

    let reason: string | undefined;
    if (!resolvedProvider.provider) reason = resolvedProvider.unavailable;
    else if (!budgetCheck.ok) reason = `${budgetCheck.reason}; learning deferred and evidence kept`;
    if (reason) {
      session.status = "deferred";
      session.deferredReason = reason;
      await this.saveSession(session, spec.taskId, "deferred");
      if (config.ai.fallback === "fail") throw new ServiceError(reason, "unavailable");
      return { assessmentId: session.id, status: "deferred", requests: [], reason, warnings };
    }
    const p = resolvedProvider.provider!;
    session.generation.providerId = p.id;
    session.generation.model = resolvedProvider.model.value;
    await this.saveSession(session, spec.taskId, "accepted");

    if ((await p.capabilities()).isHostDelegated) {
      return {
        assessmentId: session.id,
        status: "generating",
        requests: pending.map(toRequestOut),
        warnings,
      };
    }
    // Direct provider: run now, bounded by the timeout and an abort signal.
    const replies: {
      requestKey: string;
      text: string;
      usage?: { inputTokens: number; outputTokens: number };
    }[] = [];
    for (const req of pending) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.ai.timeout_ms);
      try {
        const r = await p.complete!(
          { system: req.system, prompt: req.prompt, maxTokens: req.maxTokens, requestKey: req.requestKey },
          {
            model: resolvedProvider.model.value,
            effort: resolvedProvider.effort.value,
            signal: controller.signal,
            timeoutMs: config.ai.timeout_ms,
          },
        );
        replies.push({
          requestKey: req.requestKey,
          text: r.text,
          usage: { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens },
        });
      } catch (err) {
        warnings.push(`${p.displayName}: ${(err as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
    }
    if (replies.length === 0) {
      const deferredReason = `question generation failed (${warnings.at(-1) ?? "unknown error"}); evidence kept`;
      await this.store.transact((d) => {
        const s = d.sessions[session.id]!;
        s.status = "deferred";
        s.deferredReason = deferredReason;
      });
      return { assessmentId: session.id, status: "deferred", requests: [], reason: deferredReason, warnings };
    }
    const result = await this.submitGenerated(session.id, replies, {
      source: p.id,
      model: resolvedProvider.model.value,
    });
    return { ...result, warnings: [...warnings, ...result.warnings] };
  }

  private async saveSession(
    session: AssessmentSession,
    taskId: string | undefined,
    offer: "accepted" | "deferred",
  ): Promise<void> {
    await this.store.transact((db) => {
      db.sessions[session.id] = session;
      if (taskId && db.tasks[taskId]) {
        db.tasks[taskId]!.assessmentSessionId = session.id;
        db.tasks[taskId]!.offer = offer;
      }
    });
  }

  /** Validates model replies, stores the accepted questions and starts the assessment. */
  async submitGenerated(
    assessmentId: string,
    replies: { requestKey: string; text: string; usage?: { inputTokens: number; outputTokens: number } }[],
    meta: { source: string; model?: string } = { source: "host" },
  ): Promise<PreparedAssessment> {
    const catalog = await this.catalog();
    const now = this.now();
    const session = await this.store.transact((db) => {
      const s = db.sessions[assessmentId];
      if (!s) throw new ServiceError(`No assessment ${assessmentId}`, "not-found");
      if (s.status !== "generating") return s;
      const existing = Object.values(db.questions);
      const items: AssessmentSession["items"] = [];
      for (const reply of replies) {
        const req = s.pending.find((p) => p.requestKey === reply.requestKey);
        if (!req) continue;
        const concept = catalog.get(req.conceptId)!;
        const parsed = parseGeneratedQuestions(reply.text, {
          concept,
          evidence: req.evidence,
          source: meta.source,
          model: meta.model,
          existing,
          at: now,
        });
        s.generation.calls += 1;
        s.generation.inputTokens += reply.usage?.inputTokens ?? 0;
        s.generation.outputTokens += reply.usage?.outputTokens ?? 0;
        for (const r of parsed.rejected)
          s.generation.rejected.push(`${req.conceptId}#${r.index}: ${r.issues.join("; ")}`.slice(0, 400));
        for (const q of parsed.questions.slice(0, req.count)) {
          db.questions[q.id] = q;
          existing.push(q);
          const st =
            db.knowledge[knowledgeKey(scopeKey(s.scope), q.conceptId)] ??
            db.knowledge[knowledgeKey("global", q.conceptId)];
          items.push({
            questionId: q.id,
            conceptId: q.conceptId,
            isNovelVariant: Boolean(st && st.seenQuestionIds.length > 0),
            selectionReason:
              st && st.seenQuestionIds.length > 0
                ? "new variant of a concept you've seen"
                : "first question on this concept",
            skipped: false,
          });
        }
        s.pending = s.pending.filter((p) => p.requestKey !== reply.requestKey);
      }
      s.items.push(...items);
      s.updatedAt = now.toISOString();
      if (s.items.length > 0) s.status = "in-progress";
      else if (s.pending.length === 0) {
        s.status = "deferred";
        s.deferredReason = "the model's questions did not pass validation; evidence kept";
      }
      return s;
    });
    const warnings = session.generation.rejected.length
      ? [`${session.generation.rejected.length} generated question(s) were rejected by validation`]
      : [];
    return this.preparedView(session, catalog, warnings);
  }

  private async preparedView(
    s: AssessmentSession,
    catalog: ConceptCatalog,
    warnings: string[],
  ): Promise<PreparedAssessment> {
    return {
      assessmentId: s.id,
      status: s.status,
      requests: s.status === "generating" ? s.pending.map(toRequestOut) : [],
      question: s.status === "in-progress" ? await this.questionView(s, catalog) : undefined,
      reason: s.deferredReason,
      warnings,
    };
  }

  private async questionView(
    s: AssessmentSession,
    catalog?: ConceptCatalog,
  ): Promise<QuestionView | undefined> {
    const item = currentItem(s);
    if (!item) return undefined;
    const db = await this.store.read();
    const q = db.questions[item.questionId];
    if (!q) return undefined;
    const cat = catalog ?? (await this.catalog());
    const config = (await this.config.resolve({})).config;
    return {
      assessmentId: s.id,
      question: toPublicQuestion(q),
      conceptLabel: cat.get(q.conceptId)?.label ?? q.conceptId,
      progress: progressLabel(s),
      index: s.cursor,
      total: s.items.length,
      requireReasoning: s.requireReasoning,
      requireConfidence: s.requireConfidence,
      askReasoning: config.learning.reasoning_prompts !== "off",
      askConfidence: config.learning.confidence_tracking !== "off",
    };
  }

  async getAssessment(id: string): Promise<{ session: AssessmentSession; question?: QuestionView }> {
    const db = await this.store.read();
    const s = db.sessions[id];
    if (!s) throw new ServiceError(`No assessment ${id}`, "not-found");
    return { session: s, question: s.status === "in-progress" ? await this.questionView(s) : undefined };
  }

  /** In-progress assessments that survived a restart, newest first. */
  async resumable(work: WorkContext = {}): Promise<AssessmentSession[]> {
    const db = await this.store.read();
    const loc = await this.locate(work);
    return Object.values(db.sessions)
      .filter(
        (s) =>
          (s.status === "in-progress" || s.status === "generating") &&
          (!loc.project || !s.projectId || s.projectId === loc.project.id),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Records an answer, evaluates it immediately and updates knowledge. A
   * second submission for an already answered item returns the stored result.
   */
  async answer(
    assessmentId: string,
    questionId: string,
    answer: Answer,
    work: WorkContext = {},
  ): Promise<AnswerResult> {
    const cfg = await this.resolved(work);
    const config = cfg.config;
    const catalog = await this.catalog();
    const scheduler = this.scheduler(config);
    const now = this.now();
    const pre = await this.store.read();
    const session = pre.sessions[assessmentId];
    if (!session) throw new ServiceError(`No assessment ${assessmentId}`, "not-found");
    const question = pre.questions[questionId];
    if (!question) throw new ServiceError(`No question ${questionId}`, "not-found");
    const already = session.items.find((i) => i.questionId === questionId && i.evaluation);
    if (already?.evaluation) {
      return {
        assessmentId,
        questionId,
        headline: already.evaluation.headline,
        isCorrect: already.evaluation.isCorrect,
        correctness: already.evaluation.correctness,
        calibration: already.evaluation.calibration,
        feedback: already.evaluation.feedback,
        explanation: already.evaluation.explanation,
        next: session.status === "in-progress" ? await this.questionView(session, catalog) : undefined,
        summary: session.summary,
        replayed: true,
      };
    }
    if (session.status !== "in-progress")
      throw new ServiceError(`Assessment is ${session.status}`, "conflict");
    if (currentItem(session)?.questionId !== questionId)
      throw new ServiceError("That is not the current question", "conflict");
    if (session.requireReasoning && !answer.reasoning?.trim() && !OPEN_TYPES.includes(question.type)) {
      throw new ServiceError("Reasoning is required in this mode", "invalid");
    }
    if (session.requireConfidence && !answer.confidence)
      throw new ServiceError("Confidence is required in this mode", "invalid");

    let evaluation = evaluateAnswer(question, answer);
    // Open answers: a direct provider may refine the rubric grade, bounded and within budget.
    if (OPEN_TYPES.includes(question.type) && answer.text) {
      const rp = await this.provider(config, { ...work, hostAvailable: false });
      if (rp.provider?.complete && session.generation.calls < config.ai.max_model_calls_per_task) {
        const req = buildGradingRequest(question, answer.text, answer.reasoning);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.ai.timeout_ms);
        try {
          const r = await rp.provider.complete(req, {
            model: rp.model.value,
            effort: rp.effort.value,
            signal: controller.signal,
            timeoutMs: config.ai.timeout_ms,
          });
          evaluation = mergeProviderGrade(evaluation, parseGrade(r.text));
        } catch {
          /* rubric grade stands */
        } finally {
          clearTimeout(timer);
        }
      }
    }

    const result = await this.store.transact((db) => {
      const s = db.sessions[assessmentId]!;
      const item = s.items.find((i) => i.questionId === questionId)!;
      if (item.evaluation) return s;
      item.answer = answer;
      item.answeredAt = now.toISOString();
      item.evaluation = {
        correctness: evaluation.correctness,
        isCorrect: evaluation.isCorrect,
        reasoningScore: evaluation.reasoning.score,
        reasoningQuality: evaluation.reasoning.quality,
        calibration: evaluation.calibration,
        grade: evaluation.grade,
        headline: evaluation.headline,
        feedback: evaluation.feedback,
        explanation: evaluation.explanation,
        gradedBy: evaluation.gradedBy,
        rulesVersion: evaluation.rulesVersion,
      };
      const concept = catalog.get(question.conceptId);
      for (const scope of evidenceScopes(config, s.projectId, concept)) {
        const key = knowledgeKey(scopeKey(scope), question.conceptId);
        recordEvidence(
          db,
          {
            id: newId("ev"),
            key: `answer|${assessmentId}|${questionId}|${scopeKey(scope)}`,
            kind: s.origin.kind === "review" ? "review" : "assessment",
            conceptId: question.conceptId,
            scope,
            at: now.toISOString(),
            reliability: question.provenance.kind === "generated" ? 0.9 : 1,
            difficulty: question.difficulty,
            isNovelVariant: item.isNovelVariant,
            outcome: {
              correctness: evaluation.correctness,
              reasoning: evaluation.reasoning.score,
              confidence: answer.confidence,
              calibration: evaluation.calibration,
            },
            ref: { sessionId: assessmentId, questionId, taskId: s.origin.taskId },
          },
          { now, scheduler, questionType: question.type, grade: evaluation.grade },
        );
        const st = db.knowledge[key];
        if (st) {
          st.seenQuestionIds = [...st.seenQuestionIds.filter((x) => x !== questionId), questionId].slice(-50);
          st.lastQuestionType = question.type;
        }
      }
      s.cursor += 1;
      s.updatedAt = now.toISOString();
      if (isFinished(s)) this.finish(db, s, catalog);
      return s;
    });
    return {
      assessmentId,
      questionId,
      headline: evaluation.headline,
      isCorrect: evaluation.isCorrect,
      correctness: evaluation.correctness,
      calibration: evaluation.calibration,
      feedback: evaluation.feedback,
      explanation: evaluation.explanation,
      next: result.status === "in-progress" ? await this.questionView(result, catalog) : undefined,
      summary: result.summary,
      replayed: false,
    };
  }

  async skipQuestion(
    assessmentId: string,
  ): Promise<{ next?: QuestionView; summary?: AssessmentSession["summary"] }> {
    const catalog = await this.catalog();
    const s = await this.store.transact((db) => {
      const s = db.sessions[assessmentId];
      if (!s || s.status !== "in-progress")
        throw new ServiceError("No in-progress assessment with that id", "not-found");
      const item = currentItem(s);
      if (item) item.skipped = true;
      s.cursor += 1;
      s.updatedAt = this.now().toISOString();
      if (isFinished(s)) this.finish(db, s, catalog);
      return s;
    });
    return {
      next: s.status === "in-progress" ? await this.questionView(s, catalog) : undefined,
      summary: s.summary,
    };
  }

  async endAssessment(assessmentId: string, how: "deferred" | "abandoned"): Promise<AssessmentSession> {
    const catalog = await this.catalog();
    return this.store.transact((db) => {
      const s = db.sessions[assessmentId];
      if (!s) throw new ServiceError(`No assessment ${assessmentId}`, "not-found");
      if (s.items.some((i) => i.evaluation)) this.finish(db, s, catalog);
      else s.status = how;
      s.updatedAt = this.now().toISOString();
      return s;
    });
  }

  private finish(db: Database, s: AssessmentSession, catalog: ConceptCatalog): void {
    s.status = "completed";
    s.completedAt = this.now().toISOString();
    const answered = s.items.filter((i) => i.evaluation);
    const correct = answered.filter((i) => i.evaluation!.isCorrect).length;
    const lines: string[] = [
      `${correct} of ${answered.length} answered correctly${s.items.length > answered.length ? ` (${s.items.length - answered.length} skipped)` : ""}.`,
    ];
    const conceptIds = [...new Set(answered.map((i) => i.conceptId))];
    const nextReviews: { conceptId: string; at: string; reason?: string }[] = [];
    for (const id of conceptIds) {
      const label = catalog.get(id)?.label ?? id;
      const changes = db.changes.filter(
        (c) =>
          c.conceptId === id &&
          c.evidenceId &&
          scopeKey(c.scope) === scopeKey(s.scope) &&
          c.at >= s.createdAt,
      );
      const line = explainChanges(label, changes);
      if (line) lines.push(line);
      const st = db.knowledge[knowledgeKey(scopeKey(s.scope), id)];
      if (st?.review)
        nextReviews.push({ conceptId: id, at: st.review.nextReviewAt, reason: st.review.reason });
    }
    const misconceptions = answered
      .filter((i) => i.evaluation!.calibration === "misconception")
      .map((i) => catalog.get(i.conceptId)?.label ?? i.conceptId);
    if (misconceptions.length) lines.push(`Worth a closer look: ${[...new Set(misconceptions)].join(", ")}.`);
    s.summary = { lines, correct, answered: answered.length, nextReviews };
  }

  // ── Reviews ──────────────────────────────────────────────────────────

  async dueReviews(work: WorkContext = {}, opts: { includeUpcoming?: boolean } = {}) {
    const cfg = await this.resolved(work);
    const db = await this.store.read();
    const catalog = await this.catalog();
    const scheduler = this.scheduler(cfg.config);
    const now = this.now();
    const states = [...visibleStates(db, cfg.project?.id).values()];
    return states
      .filter((s) => s.review && (opts.includeUpcoming || isDue(s.review, now)) && !s.review.suspended)
      .map((s) => ({
        conceptId: s.conceptId,
        label: catalog.get(s.conceptId)?.label ?? s.conceptId,
        scope: s.scope,
        due: s.review!.postponedUntil ?? s.review!.nextReviewAt,
        reason: s.review!.reason ?? "",
        retention: scheduler.retention(s.review!, now),
        mastery: s.dimensions.mastery.value,
        interviewCritical: catalog.get(s.conceptId)?.interviewCritical ?? false,
      }))
      .sort((a, b) => a.due.localeCompare(b.due))
      .slice(0, opts.includeUpcoming ? 200 : cfg.config.learning.spaced_repetition.max_reviews_per_day);
  }

  async updateReview(
    conceptId: string,
    action: { postponeDays?: number; suspend?: boolean; resume?: boolean },
    work: WorkContext = {},
  ) {
    const loc = await this.locate(work);
    const now = this.now();
    return this.store.transact((db) => {
      const keys = [
        knowledgeKey("global", conceptId),
        ...(loc.project
          ? [knowledgeKey(scopeKey({ kind: "project", projectId: loc.project.id }), conceptId)]
          : []),
      ];
      let changed = 0;
      for (const k of keys) {
        const st = db.knowledge[k];
        if (!st?.review) continue;
        if (action.postponeDays) st.review = postpone(st.review, action.postponeDays, now);
        if (action.suspend) st.review = { ...st.review, suspended: true, reason: "suspended by the learner" };
        if (action.resume) st.review = { ...st.review, suspended: false, reason: "resumed by the learner" };
        changed++;
      }
      if (!changed) throw new ServiceError(`No review scheduled for ${conceptId}`, "not-found");
      return changed;
    });
  }

  /** Clears a concept's assessment history in the visible scopes. Callers must confirm first. */
  async resetConcept(conceptId: string, work: WorkContext = {}) {
    const loc = await this.locate(work);
    const scopes = [
      "global",
      ...(loc.project ? [scopeKey({ kind: "project", projectId: loc.project.id })] : []),
    ];
    return this.store.transact((db) => {
      let removed = 0;
      for (const sk of scopes) {
        if (db.knowledge[knowledgeKey(sk, conceptId)]) {
          delete db.knowledge[knowledgeKey(sk, conceptId)];
          removed++;
        }
      }
      for (const [id, e] of Object.entries(db.evidence)) {
        if (e.conceptId === conceptId && scopes.includes(scopeKey(e.scope))) {
          delete db.evidence[id];
          delete db.evidenceKeys[e.key];
        }
      }
      db.changes = db.changes.filter(
        (c) => !(c.conceptId === conceptId && scopes.includes(scopeKey(c.scope))),
      );
      return removed;
    });
  }

  // ── Knowledge views ──────────────────────────────────────────────────

  async knowledgeStates(work: WorkContext = {}): Promise<{
    global: Map<string, KnowledgeState>;
    project: Map<string, KnowledgeState>;
    projectId?: string;
  }> {
    const cfg = await this.resolved(work);
    const db = await this.store.read();
    const scheduler = this.scheduler(cfg.config);
    const now = this.now();
    const global = new Map<string, KnowledgeState>();
    const project = new Map<string, KnowledgeState>();
    const pk = cfg.project ? scopeKey({ kind: "project", projectId: cfg.project.id }) : undefined;
    for (const s of Object.values(db.knowledge)) {
      const cur = withCurrentEstimates(s, now, scheduler);
      if (s.scope.kind === "global") global.set(s.conceptId, cur);
      else if (pk && scopeKey(s.scope) === pk) project.set(s.conceptId, cur);
    }
    return { global, project, projectId: cfg.project?.id };
  }

  async explainConcept(conceptId: string, work: WorkContext = {}) {
    const loc = await this.locate(work);
    const db = await this.store.read();
    const catalog = await this.catalog();
    const scopes = new Set([
      "global",
      ...(loc.project ? [scopeKey({ kind: "project", projectId: loc.project.id })] : []),
    ]);
    return {
      concept: catalog.get(conceptId),
      states: Object.values(db.knowledge).filter(
        (k) => k.conceptId === conceptId && scopes.has(scopeKey(k.scope)),
      ),
      evidence: Object.values(db.evidence)
        .filter((e) => e.conceptId === conceptId && scopes.has(scopeKey(e.scope)))
        .sort((a, b) => a.at.localeCompare(b.at)),
      changes: db.changes.filter((c) => c.conceptId === conceptId && scopes.has(scopeKey(c.scope))),
    };
  }

  async weakTopics(work: WorkContext = {}, limit = 10) {
    const { global, project } = await this.knowledgeStates(work);
    const catalog = await this.catalog();
    // One row per concept: developer-wide state wins; project-only concepts use the project state.
    const byConcept = new Map<string, KnowledgeState>(project);
    for (const [id, s] of global) byConcept.set(id, s);
    const all = [...byConcept.values()].filter((s) => s.dimensions.mastery.evidence > 0);
    return all
      .map((s) => ({
        conceptId: s.conceptId,
        label: catalog.get(s.conceptId)?.label ?? s.conceptId,
        scope: s.scope.kind,
        mastery: s.dimensions.mastery.value,
        calibration: s.dimensions.calibration.evidence >= 3 ? s.dimensions.calibration.value : undefined,
        retention: s.dimensions.retention.value,
        evidence: s.dimensions.mastery.evidence,
      }))
      .filter((t) => t.mastery < 0.6 || (t.calibration !== undefined && t.calibration < 0.55))
      .sort((a, b) => a.mastery - b.mastery)
      .slice(0, limit);
  }

  // ── Vault ────────────────────────────────────────────────────────────

  vaultTarget(config: Config): VaultTarget | undefined {
    if (config.knowledge.provider === "none") return undefined;
    return {
      provider: config.knowledge.provider,
      root: config.knowledge.vault_path || this.paths.defaultVault,
      folder: config.knowledge.vault_folder,
    };
  }

  async syncVault(work: WorkContext = {}): Promise<SyncReport | { skipped: string }> {
    const cfg = await this.resolved(work);
    const target = this.vaultTarget(cfg.config);
    if (!target) return { skipped: "knowledge.provider is none" };
    const check = await checkVault(target);
    if (!check.ok) return { skipped: `vault unavailable: ${check.problems.join(" ")}` };
    return syncVault({ db: await this.store.read(), catalog: await this.catalog(), target, now: this.now() });
  }

  async addConcept(concept: Concept): Promise<void> {
    const catalog = await this.catalog();
    catalog.add(concept);
    await this.store.transact((db) => {
      db.concepts[concept.id] = concept;
    });
    this.catalogCache = undefined;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function toRequestOut(p: AssessmentSession["pending"][number]): GenerationRequestOut {
  return {
    requestKey: p.requestKey,
    conceptId: p.conceptId,
    system: p.system,
    prompt: p.prompt,
    maxTokens: p.maxTokens,
  };
}

/** The verified version of a technology in a project: the root-level fact, else any sub-project's. */
function installedVersion(project: Project | undefined, technology: string): string | undefined {
  const facts = project?.technologies.filter((t) => t.technology === technology && t.version) ?? [];
  return (facts.find((t) => !t.workspace) ?? facts[0])?.version;
}

function avg(values: (number | undefined)[]): number | undefined {
  const v = values.filter((x): x is number => x !== undefined);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined;
}

function mergeTechs(
  a: { technology: string; version?: string }[],
  b: { technology: string; version?: string }[],
) {
  const m = new Map(a.map((t) => [t.technology, t]));
  for (const t of b)
    if (!m.has(t.technology) || (!m.get(t.technology)!.version && t.version)) m.set(t.technology, t);
  return [...m.values()];
}

function trimEvents(db: Database, max: number): void {
  const keys = Object.keys(db.events);
  if (keys.length <= max) return;
  const sorted = keys.sort((a, b) => db.events[a]!.receivedAt.localeCompare(db.events[b]!.receivedAt));
  for (const k of sorted.slice(0, keys.length - max)) delete db.events[k];
}

/**
 * Where evidence lands. Project work updates the project's scope; it also
 * updates developer-wide knowledge when cross-project reuse is allowed and the
 * concept is not project-specific. Project-specific concepts never reach the
 * global scope.
 */
export function evidenceScopes(
  config: Config,
  projectId: string | undefined,
  concept: Concept | undefined,
): KnowledgeScope[] {
  if (concept?.projectId) return [{ kind: "project", projectId: concept.projectId }];
  if (!projectId) return [GLOBAL_SCOPE];
  const scopes: KnowledgeScope[] = [{ kind: "project", projectId }];
  if (config.knowledge.allow_cross_project_reuse) scopes.push(GLOBAL_SCOPE);
  return scopes;
}

/** States visible from a project: developer-wide ones, overlaid by that project's own. Never another project's. */
export function visibleStates(db: Database, projectId?: string): Map<string, KnowledgeState> {
  const out = new Map<string, KnowledgeState>();
  for (const s of Object.values(db.knowledge)) if (s.scope.kind === "global") out.set(s.conceptId, s);
  if (projectId) {
    for (const s of Object.values(db.knowledge)) {
      if (s.scope.kind === "project" && s.scope.projectId === projectId && !out.has(s.conceptId))
        out.set(s.conceptId, s);
    }
  }
  return out;
}

function recordEvidence(
  db: Database,
  ev: Evidence,
  ctx: { now: Date; scheduler: ReviewScheduler; questionType?: string; grade?: number },
): boolean {
  if (db.evidenceKeys[ev.key]) return false;
  const key = knowledgeKey(scopeKey(ev.scope), ev.conceptId);
  const { state, changes } = applyEvidence(db.knowledge[key], ev, ctx);
  db.knowledge[key] = state;
  db.evidence[ev.id] = ev;
  db.evidenceKeys[ev.key] = ev.id;
  db.changes.push(...changes);
  if (db.changes.length > 20000) db.changes.splice(0, db.changes.length - 20000);
  return true;
}

/** Earlier question prompts for a concept that this project may see (its own and non-project ones). */
function priorPrompts(db: Database, conceptId: string, projectId?: string): string[] {
  const allowed = new Set<string>();
  for (const s of Object.values(db.sessions)) {
    if (!s.projectId || s.projectId === projectId)
      for (const i of s.items) if (i.conceptId === conceptId) allowed.add(i.questionId);
  }
  return [...allowed].map((id) => db.questions[id]?.prompt).filter((p): p is string => Boolean(p));
}

/** Names and paths of other projects, stripped from anything reused outside them. */
function otherProjectTerms(db: Database, projectId?: string): string[] {
  return Object.values(db.projects)
    .filter((p) => p.id !== projectId)
    .flatMap((p) => [p.name, ...p.paths]);
}

function usageFor(db: Database, taskId: string | undefined, sessionId: string | undefined) {
  let taskCalls = 0;
  let taskTokens = 0;
  let sessionCalls = 0;
  for (const s of Object.values(db.sessions)) {
    if (taskId && s.origin.taskId === taskId) {
      taskCalls += s.generation.calls;
      taskTokens += s.generation.inputTokens + s.generation.outputTokens;
    }
    if (sessionId && s.origin.sessionId === sessionId) sessionCalls += s.generation.calls;
  }
  return { taskCalls, taskTokens, sessionCalls };
}

export type { Question };
