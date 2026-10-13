import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTechnologyTree } from "@dev-learning-ai/core";
import { createBackup, handleAgentRequest, registerProject, restoreBackup } from "@dev-learning-ai/runtime";
import { main } from "../../apps/cli/src/cli.js";
import {
  fakeRepo,
  openService,
  taskEvent,
  tempDir,
  FakeModelProvider,
} from "../../packages/runtime/test/helpers.js";

/**
 * The end-to-end flow from the specification (section 24), step by step,
 * against real files in a temporary data directory. Questions are generated
 * at runtime by a scripted provider standing in for the model.
 */
describe("end-to-end", () => {
  it("runs the full learning lifecycle across two projects", async () => {
    const home = await tempDir("e2e-home-");
    const fake = new FakeModelProvider();

    // 1. Install the product (global installation via the CLI).
    process.env.DEV_LEARNING_AI_HOME = home;
    const logs: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => (
      logs.push(String(chunk)), true
    )) as typeof process.stdout.write;
    try {
      expect(await main(["node", "dla", "init", "--json"])).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    expect(JSON.parse(logs.join("")).created).toBe(true);
    const svc = await openService(home, [fake]);
    await svc.config.set("ai.provider", "fake", "global", { actor: "cli", ctx: {}, confirm: true });

    // 2. Register Project A.
    const repoA = await fakeRepo(await tempDir("e2e-a-"), {
      name: "acme-ledger",
      remote: "git@github.com:acme/ledger.git",
    });
    const a = await registerProject(svc.store, repoA, { name: "acme-ledger" });

    // 3. Observe a representative coding task (through the agent protocol, as the mod does).
    const ingested = await handleAgentRequest(svc, {
      op: "ingest",
      work: { cwd: repoA },
      events: [
        taskEvent({
          taskId: "a-1",
          root: repoA,
          paths: ["src/ledger/LedgerLock.tsx"],
          symbols: ["useEffect", "Promise.allSettled", "AbortController"],
        }),
      ],
    });
    expect(ingested.ok).toBe(true);

    // 4. Generate an assessment (questions written at runtime).
    const prepared = await svc.prepareAssessment({ kind: "task", taskId: "a-1", count: 2 }, { cwd: repoA });
    expect(prepared.status).toBe("in-progress");
    const q1 = prepared.question!;

    // 5–6. Answer with reasoning and confidence; receive immediate feedback.
    const full = (await svc.store.read()).questions[q1.question.id]!;
    const r1 = await svc.answer(
      prepared.assessmentId,
      q1.question.id,
      {
        choiceIds: full.correct,
        reasoning: full.reasoningSignals.map((g) => g[0]).join(" because "),
        confidence: "high",
      },
      { cwd: repoA },
    );
    expect(r1.isCorrect).toBe(true);
    expect(r1.feedback.length).toBeGreaterThan(0);
    expect(r1.explanation.length).toBeGreaterThan(10);
    const q2 = r1.next!;
    const full2 = (await svc.store.read()).questions[q2.question.id]!;
    const r2 = await svc.answer(
      prepared.assessmentId,
      q2.question.id,
      full2.choices ? { choiceIds: full2.correct, confidence: "medium" } : { text: "x" },
      { cwd: repoA },
    );

    // 7. Persist the result (a fresh service over the same files sees it).
    expect(r2.summary?.lines.length).toBeGreaterThan(0);
    const reopened = await openService(home, [fake]);
    const session = (await reopened.store.read()).sessions[prepared.assessmentId]!;
    expect(session.status).toBe("completed");

    // 8. Inspect the knowledge hierarchy.
    const states = await reopened.knowledgeStates({ cwd: repoA });
    const catalog = await reopened.catalog();
    const tech = catalog.get(q1.question.conceptId)!.technology;
    const tree = buildTechnologyTree(catalog, tech, states.global);
    expect(tree.assessed).toBeGreaterThan(0);

    // 9. Schedule a review.
    expect(r2.summary!.nextReviews.length).toBeGreaterThan(0);

    // 10. Register Project B.
    const repoB = await fakeRepo(await tempDir("e2e-b-"), {
      name: "side-project",
      remote: "git@github.com:me/side.git",
    });
    await registerProject(reopened.store, repoB);

    // 11. Developer-wide knowledge is retained in Project B.
    const fromB = await reopened.knowledgeStates({ cwd: repoB });
    expect(fromB.global.get(q1.question.conceptId)?.dimensions.mastery.value).toBeGreaterThan(0);

    // 12. Project A's private details do not leak into Project B.
    expect(fromB.project.size).toBe(0);
    fake.requests.length = 0;
    await reopened.prepareAssessment(
      { kind: "review", conceptIds: [q1.question.conceptId], count: 1 },
      { cwd: repoB },
    );
    const sentToModel = fake.requests.map((r) => `${r.system}\n${r.prompt}`).join("\n");
    expect(sentToModel).not.toMatch(/acme-ledger|LedgerLock|src\/ledger/);
    const bView = await handleAgentRequest(reopened, { op: "status", work: { cwd: repoB } });
    expect(JSON.stringify(bView)).not.toContain(a.project.id);

    // 13. Export and restore learning data.
    const backup = await createBackup(reopened);
    const before = Object.keys((await reopened.store.read()).knowledge).length;
    await reopened.store.transact((db) => {
      db.knowledge = {};
    });
    await restoreBackup(reopened, backup);
    expect(Object.keys((await reopened.store.read()).knowledge).length).toBe(before);
    const md = await reopened.syncVault({ cwd: repoA });
    expect("written" in md && md.written.length > 0).toBe(true);
    if ("root" in md)
      expect(await readFile(join(md.root, "Index.md"), "utf8")).toContain("dla_managed: true");

    // 14. Disable learning: ordinary work is unaffected and nothing is recorded.
    await reopened.config.set("learning.enabled", "false", "global", {
      actor: "cli",
      ctx: {},
      confirm: true,
    });
    const off = await handleAgentRequest(reopened, {
      op: "ingest",
      work: { cwd: repoA },
      events: [taskEvent({ taskId: "a-2", root: repoA })],
    });
    expect(off.ok).toBe(true);
    expect((await reopened.store.read()).tasks["a-2"]).toBeUndefined();

    delete process.env.DEV_LEARNING_AI_HOME;
    await rm(home, { recursive: true, force: true });
  });
});
