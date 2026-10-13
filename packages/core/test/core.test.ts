import { describe, expect, it } from "vitest";
import {
  ConceptCatalog,
  ConfigSchema,
  GLOBAL_SCOPE,
  ProviderRegistry,
  HostModelProvider,
  Sm2Scheduler,
  applyEvidence,
  buildGenerationRequest,
  buildTechnologyTree,
  classifyCalibration,
  coerceValue,
  deepMerge,
  detectOpportunities,
  diffConfigs,
  emptyState,
  eventIdempotencyKey,
  evaluateAnswer,
  globToRegExp,
  isDue,
  newId,
  normalizeEvent,
  parseConfigIntent,
  parseGeneratedQuestions,
  parseStudyRequest,
  redactSecrets,
  resolveConfig,
  resolveMode,
  resolveProvider,
  scopeIncludes,
  selectQuestion,
  stripProjectDetail,
  validateQuestion,
  type Evidence,
  type KnowledgeState,
} from "../src/index.js";
import { FIXTURE_QUESTIONS } from "./fixtures/bank.js";
import { FakeModelProvider, fakeReply } from "./fixtures/fake-provider.js";

const catalog = new ConceptCatalog();
const q = (id: string) => FIXTURE_QUESTIONS.find((x) => x.id === id)!;
const at = (iso: string) => new Date(iso);

describe("configuration", () => {
  it("applies precedence defaults < global < project < workspace < session < managed", () => {
    const r = resolveConfig({
      global: { learning: { questions_per_task: 5, mode: "teach" } },
      project: { learning: { questions_per_task: 4 } },
      workspace: { learning: { questions_per_task: 2 } },
      session: { learning: { mode: "observe" } },
      managed: { ai: { allow_remote_analysis: false } },
    });
    expect(r.config.learning.questions_per_task).toBe(2);
    expect(r.config.learning.mode).toBe("observe");
    expect(r.origins["learning.questions_per_task"]).toBe("workspace");
    expect(r.origins["learning.enabled"]).toBe("defaults");
    expect(r.locked).toContain("ai.allow_remote_analysis");
  });

  it("rejects invalid combinations", () => {
    expect(() => resolveConfig({ global: { dashboard: { host: "0.0.0.0" } } })).toThrow(
      /allow_remote_access/,
    );
    expect(() => resolveConfig({ global: { knowledge: { provider: "obsidian" } } })).toThrow(/vault_path/);
    expect(() =>
      resolveConfig({ global: { learning: { interview_mode: true, reasoning_prompts: "off" } } }),
    ).toThrow(/Interview/);
    expect(() => resolveConfig({ global: { learning: { questions_per_task: 0 } } })).toThrow();
  });

  it("ignores prototype-pollution keys when merging", () => {
    const merged = deepMerge({}, JSON.parse('{"__proto__": {"polluted": true}, "a": 1}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(merged.a).toBe(1);
  });

  it("coerces CLI values by the schema's type", () => {
    expect(coerceValue("learning.enabled", "off")).toBe(false);
    expect(coerceValue("learning.questions_per_task", "4")).toBe(4);
    expect(coerceValue("learning.difficulty", "auto")).toBe("auto");
    expect(coerceValue("learning.difficulty", "3")).toBe(3);
    expect(coerceValue("resources.trusted_domains", "a.com, b.org")).toEqual(["a.com", "b.org"]);
  });

  it("marks sensitive keys in diffs", () => {
    const d = diffConfigs(
      ConfigSchema.parse({}),
      ConfigSchema.parse({ ai: { allow_remote_analysis: true }, learning: { questions_per_task: 4 } }),
    );
    expect(d.find((x) => x.path === "ai.allow_remote_analysis")?.sensitive).toBe(true);
    expect(d.find((x) => x.path === "learning.questions_per_task")?.sensitive).toBe(false);
  });

  it("parses natural-language configuration into validated operations", () => {
    const a = parseConfigIntent("Set difficulty to auto");
    expect(a.operations).toEqual([expect.objectContaining({ path: "learning.difficulty", value: "auto" })]);
    const b = parseConfigIntent("Disable learning for this repository");
    expect(b.operations[0]).toMatchObject({ path: "learning.enabled", value: false, layer: "project" });
    expect(b.needsConfirmation).toBe(true);
    const c = parseConfigIntent("Require reasoning in interview mode");
    expect(c.operations.map((o) => o.path).sort()).toEqual([
      "learning.interview_mode",
      "learning.reasoning_prompts",
    ]);
    const d = parseConfigIntent(
      "Reduce the number of questions per task to 2. Disable external resource lookup",
    );
    expect(d.operations.map((o) => o.path)).toContain("learning.questions_per_task");
    expect(d.operations.map((o) => o.path)).toContain("resources.external_lookup");
    expect(parseConfigIntent("make it purple").unparsed).toEqual(["make it purple"]);
  });

  it("never switches to teaching during an incident, even when teach is configured", () => {
    const cfg = ConfigSchema.parse({ learning: { mode: "teach" } });
    expect(resolveMode(cfg, { urgency: "incident" }).value).toBe("observe");
    expect(resolveMode(cfg, { pausedForTask: true }).value).toBe("paused");
    expect(resolveMode(ConfigSchema.parse({ learning: { enabled: false } })).value).toBe("disabled");
  });
});

describe("version scopes", () => {
  it("parses study requests without inventing versions", () => {
    expect(parseStudyRequest("Quiz me on React 18")).toMatchObject({
      technology: "react",
      scope: { kind: "specific", version: "18" },
    });
    expect(parseStudyRequest("Quiz me on React 18 and 19").scope).toEqual({
      kind: "comparison",
      versions: ["18", "19"],
    });
    expect(parseStudyRequest("Prepare me for Angular 7–10")).toMatchObject({
      technology: "angular",
      scope: { kind: "range", from: "7", to: "10" },
    });
    expect(parseStudyRequest("Focus on changes between Node.js 20 and 22")).toMatchObject({
      technology: "nodejs",
      scope: { kind: "migration", from: "20", to: "22" },
    });
    expect(parseStudyRequest("Teach me the latest stable TypeScript features").scope).toEqual({
      kind: "latest",
    });
    expect(parseStudyRequest("Quiz me on React fundamentals")).toMatchObject({
      scope: { kind: "agnostic" },
      focus: "fundamentals",
    });
    expect(parseStudyRequest("Assess my current codebase's version-specific knowledge").scope).toEqual({
      kind: "current",
    });
  });

  it("matches concept scopes against the installed version", () => {
    const react19 = { kind: "specific" as const, version: "19" };
    expect(scopeIncludes({ kind: "current" }, react19, "18.3.1")).toBe(false);
    expect(scopeIncludes({ kind: "current" }, react19, "19.0.0")).toBe(true);
    expect(scopeIncludes({ kind: "range", from: "18", to: "19" }, react19)).toBe(true);
    expect(scopeIncludes({ kind: "current" }, undefined, "18.3.1")).toBe(true);
  });
});

describe("events", () => {
  const base = {
    id: "e1",
    schemaVersion: 1,
    type: "task.completed",
    timestamp: "2026-10-01T10:00:00.000Z",
    source: { providerId: "claude-code", sessionId: "s1" },
    developerId: "dev",
    task: { id: "t1" },
    changes: [{ path: "src/a.ts", symbols: ["Promise.all"] }],
    metadata: { prompt: "secret prompt", note: "ok" },
  };
  it("validates, strips forbidden metadata and keeps idempotency across retries", () => {
    const e = normalizeEvent(base);
    expect(e.metadata).toEqual({ note: "ok" });
    const retry = normalizeEvent({ ...base, id: "e2" });
    expect(eventIdempotencyKey(retry)).toBe(eventIdempotencyKey(e));
    expect(() => normalizeEvent({ ...base, timestamp: "yesterday" })).toThrow(/Invalid learning event/);
  });
});

describe("question validation and runtime generation", () => {
  it("rejects malformed and contradictory questions", () => {
    const good = q("js-pc-1");
    expect(validateQuestion(good).ok).toBe(true);
    expect(validateQuestion({ ...good, correct: ["z"] }).ok).toBe(false);
    expect(validateQuestion({ ...good, correct: ["a", "b"] }).ok).toBe(false);
    expect(
      validateQuestion({
        ...good,
        choices: [
          { id: "a", text: "Same" },
          { id: "b", text: "same" },
        ],
      }).ok,
    ).toBe(false);
    expect(validateQuestion({ ...good, type: "open", rubric: undefined }).ok).toBe(false);
    expect(validateQuestion({ ...good, provenance: { kind: "generated", evidence: [] } }).ok).toBe(false);
  });

  it("builds a provider-neutral request that carries evidence, version scope and prior prompts", () => {
    const concept = catalog.get("react.19.actions")!;
    const req = buildGenerationRequest({
      concept,
      evidence: [
        "files: src/Form.tsx",
        "observed: useActionState",
        "token sk-ant-abcdefghijklmnopqrstuvwxyz",
      ],
      count: 2,
      difficulty: 3,
      installedVersion: "19.1.0",
      avoidPrompts: ["Old prompt about forms"],
      preferChoice: true,
      purpose: "post-task",
    });
    expect(req.prompt).toContain("react.19.actions");
    expect(req.prompt).toContain("19.1.0");
    expect(req.prompt).toContain("Old prompt about forms");
    expect(req.prompt).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz");
    expect(req.system).toMatch(/Never invent version numbers/);
  });

  it("parses model replies, tolerating fences, and rejects invalid or duplicate questions", () => {
    const concept = catalog.get("javascript.async.promise-combinators")!;
    const reply = fakeReply({ prompt: `Concept: x (${concept.id})\nWrite 2 question(s)` });
    const parsed = parseGeneratedQuestions("Here you go:\n```json\n" + reply + "\n```", {
      concept,
      evidence: ["files: src/a.ts"],
      source: "fake",
      existing: [],
      at: at("2026-10-01T00:00:00Z"),
    });
    expect(parsed.questions).toHaveLength(2);
    expect(parsed.questions[0]!.provenance.kind).toBe("generated");
    expect(parsed.questions[0]!.conceptId).toBe(concept.id);

    const dup = parseGeneratedQuestions(reply, {
      concept,
      evidence: ["e"],
      source: "fake",
      existing: parsed.questions,
      at: at("2026-10-02T00:00:00Z"),
    });
    expect(dup.questions).toHaveLength(0);
    expect(dup.rejected[0]!.issues[0]).toMatch(/duplicate/);

    const bad = parseGeneratedQuestions(
      '{"questions":[{"type":"single","prompt":"x?","choices":[{"id":"a","text":"1"}],"correct":["a"]}]}',
      {
        concept,
        evidence: ["e"],
        source: "fake",
        existing: [],
        at: at("2026-10-01T00:00:00Z"),
      },
    );
    expect(bad.questions).toHaveLength(0);
    expect(
      parseGeneratedQuestions("no json here", {
        concept,
        evidence: [],
        source: "f",
        existing: [],
        at: new Date(),
      }).rejected,
    ).toHaveLength(1);
  });
});

describe("evaluation", () => {
  it("separates correctness, reasoning and confidence (calibration matrix)", () => {
    const question = q("js-pc-1");
    const strong = evaluateAnswer(question, {
      choiceIds: ["b"],
      reasoning: "allSettled reports every result even when one rejects",
      confidence: "high",
    });
    expect(strong.calibration).toBe("strong");
    expect(strong.grade).toBe(5);
    const falseConf = evaluateAnswer(question, {
      choiceIds: ["b"],
      reasoning: "seems right",
      confidence: "high",
    });
    expect(falseConf.calibration).toBe("possible-false-confidence");
    const guess = evaluateAnswer(question, { choiceIds: ["b"], confidence: "guessing" });
    expect(guess.calibration).toBe("uncertain-recall");
    expect(guess.masteryCredit).toBeLessThan(0.5);
    const misconception = evaluateAnswer(question, { choiceIds: ["a"], confidence: "high" });
    expect(misconception.calibration).toBe("misconception");
    expect(misconception.grade).toBe(0);
    const gap = evaluateAnswer(question, { choiceIds: ["a"], confidence: "low" });
    expect(gap.calibration).toBe("likely-gap");
    const check = evaluateAnswer(question, {
      choiceIds: ["a"],
      reasoning: "allSettled handles each result when some fail or reject",
    });
    expect(check.calibration).toBe("check-question");
  });

  it("gives partial credit for multi-select and rubric answers", () => {
    const multi = q("cc-rc-3");
    expect(evaluateAnswer(multi, { choiceIds: ["a", "b", "d"] }).correctness).toBe(1);
    expect(evaluateAnswer(multi, { choiceIds: ["a", "b"] }).correctness).toBeCloseTo(0.667, 2);
    expect(evaluateAnswer(multi, { choiceIds: ["a", "c"] }).correctness).toBe(0);
    const open = q("js-pc-4");
    const partial = evaluateAnswer(open, {
      text: "Run them concurrently with Promise.all and add a timeout via AbortController.",
    });
    expect(partial.correctness).toBeGreaterThan(0.3);
    expect(partial.correctness).toBeLessThan(0.8);
    expect(partial.criteria.filter((c) => c.met).map((c) => c.id)).toEqual(["concurrency", "timeout"]);
  });

  it("covers every calibration branch deterministically", () => {
    expect(classifyCalibration(0.5, { quality: "absent", matched: [] })).toBe("partial");
    expect(classifyCalibration(1, { quality: "absent", matched: [] })).toBe("unrated");
  });
});

describe("scoring and scheduling", () => {
  const scheduler = new Sm2Scheduler();
  const now = at("2026-10-01T09:00:00Z");
  const ev = (o: Partial<Evidence> & { outcome?: Evidence["outcome"] }): Evidence => ({
    id: newId("ev"),
    key: newId("k"),
    kind: "assessment",
    conceptId: "react.rendering",
    scope: GLOBAL_SCOPE,
    at: now.toISOString(),
    reliability: 1,
    difficulty: 3,
    isNovelVariant: false,
    ref: {},
    ...o,
  });

  it("a correct guess does not count as full mastery", () => {
    const confident = applyEvidence(
      undefined,
      ev({ outcome: { correctness: 1, reasoning: 0.9, confidence: "high" } }),
      { now, scheduler, grade: 5 },
    );
    const guessed = applyEvidence(undefined, ev({ outcome: { correctness: 1, confidence: "guessing" } }), {
      now,
      scheduler,
      grade: 3,
    });
    expect(guessed.state.dimensions.mastery.value).toBeLessThan(confident.state.dimensions.mastery.value / 2);
    expect(confident.changes.some((c) => c.dimension === "mastery" && c.ruleVersion === "scoring@1")).toBe(
      true,
    );
  });

  it("practical work raises exposure and application only up to a cap", () => {
    let state: KnowledgeState | undefined;
    for (let i = 0; i < 20; i++)
      state = applyEvidence(state, ev({ kind: "practical-work", reliability: 1 }), { now, scheduler }).state;
    expect(state!.dimensions.application.value).toBeLessThanOrEqual(0.6);
    expect(state!.dimensions.mastery.evidence).toBe(0);
    expect(state!.dimensions.exposure.value).toBeGreaterThan(0.9);
  });

  it("schedules reviews further out after successful recall and never erases mastery for a missed review", () => {
    let s = scheduler.initial(now);
    s = scheduler.next(s, 5, now);
    expect(s.intervalDays).toBe(1);
    s = scheduler.next(s, 5, at("2026-10-02T09:00:00Z"));
    expect(s.intervalDays).toBe(4);
    s = scheduler.next(s, 5, at("2026-10-06T09:00:00Z"));
    expect(s.intervalDays).toBeGreaterThan(4);
    expect(isDue(s, at("2026-12-01T00:00:00Z"))).toBe(true);
    const lowConf = scheduler.next(s, 3, at("2026-10-20T09:00:00Z"));
    expect(lowConf.intervalDays).toBeLessThanOrEqual(s.intervalDays);
    const failed = scheduler.next(s, 1, at("2026-10-20T09:00:00Z"));
    expect(failed.repetitions).toBe(0);
    expect(failed.lapses).toBe(1);
    const state = applyEvidence(
      undefined,
      ev({ outcome: { correctness: 1, confidence: "high", reasoning: 1 } }),
      { now, scheduler, grade: 5 },
    ).state;
    // Months later, mastery is unchanged; only the retention estimate decays.
    expect(state.dimensions.mastery.value).toBeGreaterThan(0);
    expect(scheduler.retention(state.review!, at("2027-03-01T00:00:00Z"))).toBeLessThan(0.1);
  });
});

describe("knowledge hierarchy", () => {
  it("keeps fundamentals separate from a weak newer version branch", () => {
    const now = at("2026-10-01T00:00:00Z");
    const scheduler = new Sm2Scheduler();
    const states = new Map<string, KnowledgeState>();
    const put = (conceptId: string, correctness: number) => {
      let s: KnowledgeState | undefined;
      for (let i = 0; i < 4; i++) {
        s = applyEvidence(
          s,
          {
            id: newId(),
            key: newId(),
            kind: "assessment",
            conceptId,
            scope: GLOBAL_SCOPE,
            at: now.toISOString(),
            reliability: 1,
            difficulty: 3,
            isNovelVariant: true,
            outcome: { correctness, confidence: "high", reasoning: correctness },
            ref: {},
          },
          { now, scheduler, grade: correctness > 0.5 ? 5 : 1 },
        ).state;
      }
      states.set(conceptId, s!);
    };
    put("react.rendering", 1);
    put("react.hooks.effect-dependencies", 1);
    put("react.19.actions", 0);
    const tree = buildTechnologyTree(catalog, "react", states);
    const fundamentals = tree.groups.find((g) => g.id === "fundamentals")!;
    const v19 = tree.groups.find((g) => g.id === "v19")!;
    expect(fundamentals.score!).toBeGreaterThan(0.8);
    expect(v19.score!).toBeLessThan(0.2);
    // Overall is not a simple average of the three concepts (which would be ~0.6).
    expect(tree.overall!).toBeGreaterThan(0.75);
    // Unassessed concepts are not zero; they are coverage gaps.
    expect(tree.groups.find((g) => g.id === "performance")!.score).toBeUndefined();
  });
});

describe("selection and anti-repetition", () => {
  it("prefers unseen variants of a different type and never repeats the most recent question", () => {
    const pool = FIXTURE_QUESTIONS.filter((x) => x.conceptId === "javascript.async.promise-combinators");
    const state = {
      ...emptyState("javascript.async.promise-combinators", GLOBAL_SCOPE, new Date()),
      seenQuestionIds: ["js-pc-1"],
      lastQuestionType: "single",
    };
    const pick = selectQuestion(pool, state, { targetDifficulty: 3 })!;
    expect(pick.question.id).not.toBe("js-pc-1");
    expect(pick.question.type).not.toBe("single");
    expect(pick.isNovelVariant).toBe(true);
    const allSeen = { ...state, seenQuestionIds: pool.map((p) => p.id) };
    const again = selectQuestion(pool, allSeen, { targetDifficulty: 3 })!;
    expect(again.isNovelVariant).toBe(false);
    expect(again.question.id).not.toBe(pool[pool.length - 1]!.id);
  });
});

describe("opportunity detection", () => {
  const states = new Map<string, KnowledgeState>();
  it("skips trivial work", () => {
    expect(
      detectOpportunities(catalog, {
        changes: [{ path: "pnpm-lock.yaml", kind: "modified", symbols: [] }],
        technologies: [],
        states,
      }).skipped,
    ).toMatch(/lockfile/);
    expect(
      detectOpportunities(catalog, {
        changes: [{ path: "README.md", kind: "modified", symbols: [] }],
        technologies: [],
        states,
      }).skipped,
    ).toMatch(/documentation/);
    expect(
      detectOpportunities(catalog, {
        changes: [{ path: "src/a.ts", kind: "modified", linesAdded: 2, symbols: ["Promise.all"] }],
        technologies: [],
        states,
      }).skipped,
    ).toMatch(/small change/);
  });
  it("finds concepts from symbols and paths, respecting the installed version", () => {
    const r = detectOpportunities(catalog, {
      changes: [
        {
          path: "src/components/Form.tsx",
          kind: "modified",
          linesAdded: 40,
          symbols: ["useEffect", "useActionState", "Promise.allSettled"],
        },
      ],
      technologies: [{ technology: "react", version: "18.3.1" }],
      states,
    });
    const ids = r.opportunities.map((o) => o.conceptId);
    expect(ids).toContain("react.hooks.effect-dependencies");
    expect(ids).toContain("javascript.async.promise-combinators");
    expect(ids).not.toContain("react.19.actions");
  });
  it("matches globs", () => {
    expect(globToRegExp("**/*.tsx").test("src/a/B.tsx")).toBe(true);
    expect(globToRegExp("**/migrations/**").test("db/migrations/001.sql")).toBe(true);
    expect(globToRegExp("**/Dockerfile").test("Dockerfile")).toBe(true);
  });
});

describe("privacy", () => {
  it("redacts common secret formats", () => {
    const text = [
      "key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
      "AKIAABCDEFGHIJKLMNOP",
      "postgres://user:hunter2@db.example.com/app",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      'password: "correct-horse-battery"',
      "ghp_" + "a".repeat(36),
    ].join("\n");
    const r = redactSecrets(text);
    expect(r.text).not.toMatch(/hunter2|correct-horse|AKIAABCDEFGHIJKLMNOP|sk-ant-api03|ghp_a/);
    expect(r.text).toContain("postgres://user:[REDACTED]@db.example.com/app");
  });
  it("strips project names and paths before reuse elsewhere", () => {
    expect(stripProjectDetail("In acme-billing, src/payments/ledger.ts uses a lock", ["acme-billing"])).toBe(
      "In [project], [path] uses a lock",
    );
  });
});

describe("provider resolution", () => {
  it("uses the host model only when allowed and an agent integration is present", async () => {
    const reg = new ProviderRegistry([new HostModelProvider()]);
    const off = await resolveProvider(ConfigSchema.parse({}), reg, { hostAvailable: true });
    expect(off.provider).toBeUndefined();
    expect(off.unavailable).toMatch(/allow_host_model/);
    const on = await resolveProvider(ConfigSchema.parse({ ai: { allow_host_model: true } }), reg, {
      hostAvailable: true,
    });
    expect(on.provider?.id).toBe("host");
    const cli = await resolveProvider(ConfigSchema.parse({ ai: { allow_host_model: true } }), reg, {
      hostAvailable: false,
    });
    expect(cli.provider).toBeUndefined();
  });
  it("requires authorisation for remote providers and reports unsupported effort", async () => {
    const reg = new ProviderRegistry([new HostModelProvider(), new FakeModelProvider({ isRemote: true })]);
    const denied = await resolveProvider(ConfigSchema.parse({ ai: { provider: "fake" } }), reg, {
      hostAvailable: false,
    });
    expect(denied.unavailable).toMatch(/allow_remote_analysis/);
    const ok = await resolveProvider(
      ConfigSchema.parse({ ai: { provider: "fake", allow_remote_analysis: true, effort: "max" } }),
      reg,
      { hostAvailable: false },
    );
    expect(ok.provider?.id).toBe("fake");
    expect(ok.model.value).toBe("fake-1");
    expect(ok.effort.value).toBe("low");
    expect(ok.warnings.join(" ")).toMatch(/not supported/);
  });
});
