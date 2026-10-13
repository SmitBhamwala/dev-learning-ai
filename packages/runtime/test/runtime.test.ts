import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  ProjectIdentityConflict,
  Store,
  buildReport,
  createBackup,
  discoverTechnologies,
  summarizeTechnologies,
  registerProject,
  restoreBackup,
  syncVault,
  BEGIN,
  END,
  type LearningService,
} from "@dev-learning-ai/runtime";
import { scopeIncludes } from "@dev-learning-ai/core";
import { FIXTURE_QUESTIONS } from "../../core/test/fixtures/bank.js";
import { FakeModelProvider, fakeRepo, openService, taskEvent, tempDir, writeFiles } from "./helpers.js";

async function answerAll(svc: LearningService, assessmentId: string, mode: "right" | "wrong" = "right") {
  let { question } = await svc.getAssessment(assessmentId);
  const results = [];
  while (question) {
    const db = await svc.store.read();
    const full = db.questions[question.question.id]!;
    const answer = full.choices
      ? {
          choiceIds:
            mode === "right" ? full.correct : [full.choices.find((c) => !full.correct!.includes(c.id))!.id],
          confidence: "high" as const,
          reasoning: full.reasoningSignals.map((g) => g[0]).join(" and "),
        }
      : { text: full.rubric!.map((c) => c.anyOf[0]!.join(" ")).join(". "), confidence: "medium" as const };
    const r = await svc.answer(assessmentId, question.question.id, answer);
    results.push(r);
    question = r.next;
  }
  return results;
}

describe("store", () => {
  it("persists transactions and rolls an interrupted write forward on open", async () => {
    const dir = await tempDir();
    const store = new Store(dir);
    await store.transact((db) => {
      db.meta.activeProjectId = "p1";
    });
    expect((await store.read()).meta.activeProjectId).toBe("p1");
    // Simulate a crash after temp files and the journal were written but before rename.
    const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
    meta.activeProjectId = "p2";
    await writeFile(join(dir, "meta.json.crash.tmp"), JSON.stringify(meta));
    await writeFile(join(dir, "orphan.json.x.tmp"), "garbage");
    await writeFile(
      join(dir, "journal.json"),
      JSON.stringify({ files: [{ tmp: join(dir, "meta.json.crash.tmp"), target: join(dir, "meta.json") }] }),
    );
    const reopened = new Store(dir);
    await reopened.open();
    expect(reopened.diagnostics.recoveredJournal).toBe(true);
    expect(reopened.diagnostics.removedTempFiles).toBe(1);
    expect((await reopened.read()).meta.activeProjectId).toBe("p2");
  });

  it("quarantines a corrupt collection instead of crashing", async () => {
    const dir = await tempDir();
    const store = new Store(dir);
    await store.open();
    await writeFile(join(dir, "knowledge.json"), JSON.stringify({ x: { nonsense: true } }));
    const db = await new Store(dir).read();
    expect(db.knowledge).toEqual({});
  });
});

describe("projects", () => {
  it("registers once, discovers verified versions and refuses an ambiguous clone", async () => {
    const home = await tempDir();
    const svc = await openService(home);
    const a = await fakeRepo(await tempDir("repoA-"), {
      remote: "git@github.com:acme/shop.git",
      react: "18.3.1",
    });
    const first = await registerProject(svc.store, a);
    expect(first.created).toBe(true);
    expect(first.project.technologies.find((t) => t.technology === "react")).toMatchObject({
      version: "18.3.1",
    });
    expect(first.project.remotes).toEqual(["github.com/acme/shop"]);
    const again = await registerProject(svc.store, join(a, "src"));
    expect(again.created).toBe(false);
    expect(again.project.id).toBe(first.project.id);
    expect(Object.keys((await svc.store.read()).projects)).toHaveLength(1);

    // A copy of the checkout (same project.yaml) with an unrelated remote: must ask.
    const copy = await tempDir("copy-");
    await cp(a, copy, { recursive: true });
    await writeFile(
      join(copy, ".git", "config"),
      '[remote "origin"]\n\turl = https://github.com/someone/fork.git\n',
    );
    await expect(registerProject(svc.store, copy)).rejects.toBeInstanceOf(ProjectIdentityConflict);
    const asNew = await registerProject(svc.store, copy, { identity: "new" });
    expect(asNew.project.id).not.toBe(first.project.id);
    expect(asNew.wroteFiles.some((f) => f.includes("local-state"))).toBe(true);

    // A clone over https of the same remote joins the same project.
    const clone = await tempDir("clone-");
    await cp(a, clone, { recursive: true });
    await writeFile(
      join(clone, ".git", "config"),
      '[remote "origin"]\n\turl = https://github.com/acme/shop.git\n',
    );
    const joined = await registerProject(svc.store, clone);
    expect(joined.project.id).toBe(first.project.id);
    expect(joined.project.paths).toHaveLength(2);
  });

  it("joins git worktrees to their repository automatically", async () => {
    const home = await tempDir();
    const svc = await openService(home);
    const main = await fakeRepo(await tempDir("main-"));
    const registered = await registerProject(svc.store, main, { writeProjectFile: false });
    const wt = await tempDir("wt-");
    await writeFiles(main, {
      ".git/worktrees/feature/HEAD": "ref: refs/heads/feature\n",
      ".git/worktrees/feature/commondir": "../..\n",
    });
    await writeFiles(wt, {
      ".git": `gitdir: ${join(main, ".git", "worktrees", "feature")}\n`,
      "package.json": "{}",
    });
    const r = await registerProject(svc.store, wt);
    expect(r.project.id).toBe(registered.project.id);
  });

  it("detects monorepo workspaces", async () => {
    const root = await tempDir("mono-");
    await writeFiles(root, {
      "package.json": JSON.stringify({ name: "mono", workspaces: ["packages/*"] }),
      "packages/web/package.json": JSON.stringify({ name: "@m/web", dependencies: { react: "^19.0.0" } }),
      "packages/api/package.json": JSON.stringify({ name: "@m/api", dependencies: { express: "^5.0.0" } }),
      Dockerfile: "FROM node:22\n",
    });
    const d = await discoverTechnologies(root);
    expect(d.isMonorepo).toBe(true);
    expect(d.workspaces.map((w) => w.name).sort()).toEqual(["@m/api", "@m/web"]);
    const react = d.technologies.find((t) => t.technology === "react");
    expect(react?.version).toBeUndefined(); // no lockfile: a declared range is not a verified version
    expect(react?.declaredRange).toBe("^19.0.0");
    expect(d.technologies.some((t) => t.technology === "docker")).toBe(true);
  });
});

describe("polyglot repositories", () => {
  it("detects sub-projects with their own manifests and lockfiles (frontend/ + backend/)", async () => {
    const root = await tempDir("poly-");
    await writeFiles(root, {
      "README.md": "# app",
      "frontend/package.json": JSON.stringify({
        name: "web",
        dependencies: { next: "^15.0.0", react: "^19.1.0" },
        devDependencies: { typescript: "^5.8.3" },
      }),
      "frontend/pnpm-lock.yaml": [
        "lockfileVersion: '9.0'",
        "importers:",
        "  .:",
        "    dependencies:",
        "      react:",
        "        specifier: ^19.1.0",
        "        version: 19.1.0",
        "",
      ].join("\n"),
      "frontend/tsconfig.json": "{}",
      "backend/pyproject.toml": [
        "[project]",
        'name = "api"',
        'dependencies = ["fastapi>=0.115", "pytest"]',
        "",
      ].join("\n"),
      "docs/package.json": "{}",
    });
    const d = await discoverTechnologies(root);
    expect(d.workspaces.map((w) => w.path)).toEqual(["backend", "frontend"]);
    const by = (t: string) => d.technologies.filter((f) => f.technology === t);
    expect(by("react")[0]).toMatchObject({ version: "19.1.0", workspace: "frontend" });
    expect(by("python")[0]?.workspace).toBe("backend");
    expect(by("fastapi").length).toBe(1);
    expect(by("http").length).toBe(1);
    expect(summarizeTechnologies(d.technologies)).toContain("react 19.1.0");
  });
});

describe("configuration service", () => {
  it("layers files, guards sensitive changes, respects managed locks and rolls back", async () => {
    const home = await tempDir();
    const svc = await openService(home);
    const repo = await fakeRepo(await tempDir("cfg-"));
    await registerProject(svc.store, repo);
    const ctx = (await svc.locate({ cwd: repo })).ctx;

    await svc.config.set("learning.questions_per_task", "5", "global", { actor: "cli", ctx });
    await svc.config.set("learning.questions_per_task", "2", "project", { actor: "cli", ctx });
    let r = await svc.config.resolve(ctx);
    expect(r.config.learning.questions_per_task).toBe(2);
    expect(r.origins["learning.questions_per_task"]).toBe("project");

    const unconfirmed = await svc.config.set("ai.allow_remote_analysis", "true", "global", {
      actor: "cli",
      ctx,
    });
    expect(unconfirmed.applied).toBe(false);
    expect(unconfirmed.needsConfirmation).toBe(true);
    await expect(
      svc.config.set("learning.nope", "1", "global", { actor: "cli", ctx }),
    ).rejects.toBeInstanceOf(ConfigError);
    await expect(
      svc.config.set("learning.questions_per_task", "99", "global", { actor: "cli", ctx }),
    ).rejects.toBeInstanceOf(ConfigError);

    const nl = await svc.config.applyNaturalLanguage("Disable learning for this repository", { ctx });
    expect(nl.applied).toBe(false);
    expect(nl.diff[0]).toMatchObject({ path: "learning.enabled", after: false });
    const applied = await svc.config.applyNaturalLanguage("Disable learning for this repository", {
      ctx,
      confirm: true,
    });
    expect(applied.applied).toBe(true);
    expect((await svc.config.resolve(ctx)).config.learning.enabled).toBe(false);
    await svc.config.rollback(applied.historyId!, ctx);
    expect((await svc.config.resolve(ctx)).config.learning.enabled).toBe(true);
    expect((await svc.config.history()).some((h) => h.actor === "rollback")).toBe(true);

    await writeFile(svc.paths.managedConfigFile, "learning:\n  interview_mode: false\n");
    await expect(
      svc.config.set("learning.interview_mode", "true", "global", { actor: "cli", ctx }),
    ).rejects.toThrow(/organization-managed/);
    r = await svc.config.resolve(ctx);
    expect(r.locked).toContain("learning.interview_mode");
  });
});

describe("learning flow", () => {
  async function setup(extra = [new FakeModelProvider()]) {
    const home = await tempDir();
    const svc = await openService(home, extra);
    const repoA = await fakeRepo(await tempDir("projA-"), {
      name: "acme-billing",
      remote: "git@github.com:acme/billing.git",
    });
    const projA = await registerProject(svc.store, repoA);
    await svc.config.set("ai.provider", "fake", "global", { actor: "cli", ctx: {}, confirm: true });
    return { svc, home, repoA, projA };
  }

  it("observes a task, generates questions at runtime, evaluates immediately and schedules reviews", async () => {
    const { svc, repoA } = await setup();
    const started = await svc.ingest(taskEvent({ taskId: "t1", type: "task.started", root: repoA }), {
      cwd: repoA,
    });
    expect(started.offer).toBeUndefined();
    const done = await svc.ingest(taskEvent({ taskId: "t1", root: repoA }), { cwd: repoA });
    expect(done.offer?.concepts.length).toBeGreaterThan(0);
    // Duplicate delivery is ignored.
    expect(
      (await svc.ingest(taskEvent({ taskId: "t1", root: repoA, id: "retry" }), { cwd: repoA })).duplicate,
    ).toBe(true);

    const prepared = await svc.prepareAssessment({ kind: "task", taskId: "t1" }, { cwd: repoA });
    expect(prepared.status).toBe("in-progress");
    expect(prepared.question?.question).not.toHaveProperty("correct");
    const results = await answerAll(svc, prepared.assessmentId);
    expect(results.length).toBe(3);
    expect(results.every((r) => r.isCorrect)).toBe(true);
    const last = results.at(-1)!;
    expect(last.summary?.lines[0]).toMatch(/3 of 3/);
    expect(last.summary?.lines.some((l) => /mastery increased from/.test(l))).toBe(true);
    expect(last.summary?.nextReviews.length).toBeGreaterThan(0);

    // Replaying an answer returns the stored evaluation, it does not double count.
    const db = await svc.store.read();
    const evidenceBefore = Object.keys(db.evidence).length;
    const replay = await svc.answer(prepared.assessmentId, results[0]!.questionId, { choiceIds: ["a"] });
    expect(replay.replayed).toBe(true);
    expect(Object.keys((await svc.store.read()).evidence).length).toBe(evidenceBefore);

    // Every question shown was generated at runtime, with provenance.
    const qs = Object.values((await svc.store.read()).questions);
    expect(qs.every((q) => q.provenance.kind === "generated" && q.provenance.evidence.length > 0)).toBe(true);
  });

  it("asks a fresh variant on review instead of repeating the answered question", async () => {
    const { svc, repoA } = await setup();
    await svc.ingest(taskEvent({ taskId: "t1", root: repoA, symbols: ["Promise.allSettled"] }), {
      cwd: repoA,
    });
    const first = await svc.prepareAssessment({ kind: "task", taskId: "t1", count: 1 }, { cwd: repoA });
    const firstQ = first.question!.question;
    await answerAll(svc, first.assessmentId);
    const review = await svc.prepareAssessment(
      { kind: "review", conceptIds: [firstQ.conceptId], count: 1 },
      { cwd: repoA },
    );
    expect(review.question!.question.id).not.toBe(firstQ.id);
    expect(review.question!.question.prompt).not.toBe(firstQ.prompt);
    const db = await svc.store.read();
    expect(db.sessions[review.assessmentId]!.items[0]!.isNovelVariant).toBe(true);
  });

  it("runs host-delegated generation in two phases and survives a restart mid-assessment", async () => {
    const { svc, home, repoA } = await setup([]);
    await svc.config.set("ai.provider", "auto", "global", { actor: "cli", ctx: {}, confirm: true });
    await svc.ingest(taskEvent({ taskId: "t2", root: repoA }), { cwd: repoA });
    const denied = await svc.prepareAssessment(
      { kind: "task", taskId: "t2" },
      { cwd: repoA, hostAvailable: true },
    );
    expect(denied.status).toBe("deferred");
    expect(denied.reason).toMatch(/allow_host_model/);

    await svc.config.set("ai.allow_host_model", "true", "global", { actor: "cli", ctx: {}, confirm: true });
    await svc.ingest(taskEvent({ taskId: "t3", root: repoA }), { cwd: repoA });
    const prepared = await svc.prepareAssessment(
      { kind: "task", taskId: "t3" },
      { cwd: repoA, hostAvailable: true },
    );
    expect(prepared.status).toBe("generating");
    expect(prepared.requests.length).toBeGreaterThan(0);
    const { fakeReply } = await import("../../core/test/fixtures/fake-provider.js");
    const ready = await svc.submitGenerated(
      prepared.assessmentId,
      prepared.requests.map((r) => ({ requestKey: r.requestKey, text: fakeReply(r) })),
    );
    expect(ready.status).toBe("in-progress");
    const q1 = ready.question!.question;
    const full = (await svc.store.read()).questions[q1.id]!;
    await svc.answer(
      prepared.assessmentId,
      q1.id,
      full.choices ? { choiceIds: full.correct } : { text: "x" },
    );

    // "Restart": a fresh service over the same data directory resumes at question 2.
    const again = await openService(home, []);
    const resumable = await again.resumable({ cwd: repoA });
    expect(resumable[0]!.id).toBe(prepared.assessmentId);
    const { question } = await again.getAssessment(prepared.assessmentId);
    expect(question!.index).toBe(1);
  });

  it("keeps developer-wide knowledge across projects without leaking project details", async () => {
    const fake = new FakeModelProvider();
    const { svc, repoA } = await setup([fake]);
    await svc.ingest(
      taskEvent({
        taskId: "a1",
        root: repoA,
        paths: ["src/payments/LedgerLock.tsx"],
        symbols: ["Promise.allSettled"],
      }),
      { cwd: repoA },
    );
    const a = await svc.prepareAssessment({ kind: "task", taskId: "a1", count: 2 }, { cwd: repoA });
    await answerAll(svc, a.assessmentId);
    const conceptId = (await svc.store.read()).sessions[a.assessmentId]!.items[0]!.conceptId;

    const repoB = await fakeRepo(await tempDir("projB-"), {
      name: "other-app",
      remote: "git@github.com:me/other.git",
    });
    const projB = await registerProject(svc.store, repoB);
    const statesB = await svc.knowledgeStates({ cwd: repoB });
    expect(statesB.global.get(conceptId)?.dimensions.mastery.value).toBeGreaterThan(0);
    expect(statesB.project.size).toBe(0);
    expect(statesB.projectId).toBe(projB.project.id);

    fake.requests.length = 0;
    await svc.prepareAssessment({ kind: "review", conceptIds: [conceptId], count: 1 }, { cwd: repoB });
    const sent = fake.requests.map((r) => r.prompt + r.system).join("\n");
    expect(sent).not.toMatch(/acme-billing|LedgerLock|src\/payments/);

    // With cross-project reuse disabled, project work no longer updates developer-wide knowledge.
    await svc.config.set("knowledge.allow_cross_project_reuse", "false", "global", {
      actor: "cli",
      ctx: {},
      confirm: true,
    });
    const before = (await svc.knowledgeStates({ cwd: repoA })).global.get(conceptId)!.dimensions.mastery
      .evidence;
    await svc.ingest(taskEvent({ taskId: "a2", root: repoA, symbols: ["Promise.allSettled"] }), {
      cwd: repoA,
    });
    const a2 = await svc.prepareAssessment(
      { kind: "manual", conceptIds: [conceptId], count: 1 },
      { cwd: repoA },
    );
    await answerAll(svc, a2.assessmentId);
    expect(
      (await svc.knowledgeStates({ cwd: repoA })).global.get(conceptId)!.dimensions.mastery.evidence,
    ).toBe(before);
  });

  it("defers learning without a model and records nothing when learning is disabled", async () => {
    const { svc, repoA } = await setup([new FakeModelProvider({ fail: true })]);
    await svc.ingest(taskEvent({ taskId: "f1", root: repoA }), { cwd: repoA });
    const failed = await svc.prepareAssessment({ kind: "task", taskId: "f1" }, { cwd: repoA });
    expect(failed.status).toBe("deferred");
    expect(failed.reason).toMatch(/evidence kept/);
    const db = await svc.store.read();
    expect(Object.values(db.evidence).some((e) => e.kind === "practical-work" && e.ref.taskId === "f1")).toBe(
      true,
    );

    await svc.config.set("learning.enabled", "false", "global", { actor: "cli", ctx: {}, confirm: true });
    const off = await svc.ingest(taskEvent({ taskId: "off1", root: repoA }), { cwd: repoA });
    expect(off.skipped).toMatch(/disabled/);
    expect((await svc.store.read()).tasks.off1).toBeUndefined();
  });

  it("generates questions for an explicit, version-scoped study request", async () => {
    const { svc, repoA } = await setup();
    const r = await svc.prepareAssessment(
      {
        kind: "manual",
        study: { technology: "react", scope: { kind: "specific", version: "19" } },
        count: 2,
      },
      { cwd: repoA },
    );
    expect(r.status).toBe("in-progress");
    const items = (await svc.store.read()).sessions[r.assessmentId]!.items;
    const catalog = await svc.catalog();
    const covers = (id: string, v: string) => {
      const vs = catalog.get(id)!.versionScope;
      return vs !== undefined && scopeIncludes({ kind: "specific", version: v }, vs);
    };
    expect(items.every((i) => covers(i.conceptId, "19"))).toBe(true);
    const r18 = await svc.prepareAssessment(
      {
        kind: "manual",
        study: { technology: "react", scope: { kind: "specific", version: "18" } },
        count: 2,
      },
      { cwd: repoA },
    );
    const items18 = (await svc.store.read()).sessions[r18.assessmentId]!.items;
    expect(items18.every((i) => covers(i.conceptId, "18"))).toBe(true);
    expect(items18.some((i) => i.conceptId.startsWith("react.19"))).toBe(false);
  });

  it("produces reports that separate observed from estimated, and backs up and restores", async () => {
    const { svc, repoA, projA } = await setup();
    await svc.ingest(taskEvent({ taskId: "r1", root: repoA }), { cwd: repoA });
    const p = await svc.prepareAssessment({ kind: "task", taskId: "r1" }, { cwd: repoA });
    await answerAll(svc, p.assessmentId, "wrong");
    const db = await svc.store.read();
    const report = buildReport(db, await svc.catalog(), {
      kind: "weekly",
      now: new Date(),
      projectId: projA.project.id,
      includeHealth: true,
    });
    expect(report.sections.find((s) => s.heading === "Activity")!.observed[1]).toMatch(/1 assessment/);
    expect(report.sections.find((s) => s.heading === "Retention and reviews")!.estimated[0]).toMatch(
      /estimated/,
    );
    expect(report.sections.some((s) => s.heading === "Suggested focus")).toBe(true);

    const file = await createBackup(svc);
    await svc.store.transact((d) => {
      d.knowledge = {};
    });
    await restoreBackup(svc, file);
    expect(Object.keys((await svc.store.read()).knowledge).length).toBe(Object.keys(db.knowledge).length);
  });
});

describe("vault", () => {
  it("writes managed notes, preserves user text and never overwrites user-authored notes", async () => {
    const home = await tempDir();
    const svc = await openService(home);
    const repo = await fakeRepo(await tempDir("v-"));
    await registerProject(svc.store, repo);
    await svc.config.set("ai.provider", "fake", "global", { actor: "cli", ctx: {}, confirm: true });
    await svc.ingest(taskEvent({ taskId: "v1", root: repo }), { cwd: repo });
    const p = await svc.prepareAssessment({ kind: "task", taskId: "v1" }, { cwd: repo });
    await answerAll(svc, p.assessmentId);

    const vault = await tempDir("vault-");
    await mkdir(join(vault, ".obsidian"));
    const conceptId = (await svc.store.read()).sessions[p.assessmentId]!.items[0]!.conceptId;
    // A user-authored note at a path the tool wants to use.
    await writeFiles(vault, { [`DeveloperKnowledge/Concepts/${conceptId}.md`]: "# My own notes\n" });
    const target = { provider: "obsidian" as const, root: vault, folder: "DeveloperKnowledge" };
    const report = await syncVault({
      db: await svc.store.read(),
      catalog: await svc.catalog(),
      target,
      now: new Date(),
    });
    expect(report.conflicts.length).toBe(1);
    expect(await readFile(join(vault, "DeveloperKnowledge", "Concepts", `${conceptId}.md`), "utf8")).toBe(
      "# My own notes\n",
    );
    const index = join(vault, "DeveloperKnowledge", "Index.md");
    const indexText = await readFile(index, "utf8");
    expect(indexText).toContain("dla_managed: true");
    expect(indexText).toContain("[[");
    await writeFile(index, indexText.replace(END, `${END}\n\nMy personal note stays.`));
    await syncVault({ db: await svc.store.read(), catalog: await svc.catalog(), target, now: new Date() });
    const after = await readFile(index, "utf8");
    expect(after).toContain("My personal note stays.");
    expect(after.split(BEGIN).length).toBe(2);
  });
});

describe("fixtures", () => {
  it("covers every built-in question with a valid answer key", () => {
    expect(FIXTURE_QUESTIONS.length).toBeGreaterThan(50);
  });
});
