/**
 * Development only: starts the dashboard against a scratch data directory
 * seeded with DEMO data produced through the real service (tasks, runtime
 * question generation via the scripted test provider, answers, reviews).
 * Never touches your real ~/.dev-learning-ai.
 *
 *   pnpm dev:dashboard            (port 4317, data in .dev-data/)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HostModelProvider, ProviderRegistry } from "../packages/core/src/index.js";
import { LearningService, registerProject } from "../packages/runtime/src/index.js";
import { startDashboard } from "../packages/dashboard/src/index.js";
import { FakeModelProvider } from "../packages/core/test/fixtures/fake-provider.js";

const root = resolve(process.env.DLA_DEV_DATA ?? ".dev-data");
const home = join(root, "home");
const registry = new ProviderRegistry([new HostModelProvider(), new FakeModelProvider()]);
const svc = await LearningService.open({ home, registry, env: {} });

const db = await svc.store.read();
if (Object.keys(db.projects).length === 0) {
  const repo = join(root, "demo-repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(
    join(repo, ".git", "config"),
    '[remote "origin"]\n\turl = git@github.com:demo/storefront.git\n',
  );
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({
      name: "demo-storefront",
      dependencies: { react: "^19.1.0", "react-dom": "^19.1.0", pg: "^8.13.0" },
      devDependencies: { typescript: "^5.8.3", vitest: "^3.2.4" },
    }),
  );
  await writeFile(
    join(repo, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "node_modules/react": { version: "19.1.0" },
        "node_modules/react-dom": { version: "19.1.0" },
        "node_modules/typescript": { version: "5.8.3" },
        "node_modules/pg": { version: "8.13.1" },
      },
    }),
  );
  await writeFile(join(repo, "tsconfig.json"), "{}");
  await registerProject(svc.store, repo, { name: "demo-storefront (demo data)" });
  await svc.config.apply(
    [
      { path: "ai.provider", value: "fake", layer: "global" },
      { path: "knowledge.provider", value: "markdown", layer: "global" },
      { path: "knowledge.vault_path", value: join(root, "vault"), layer: "global" },
    ],
    { actor: "setup", ctx: {}, confirm: true, note: "demo data seed" },
  );
  const tasks = [
    {
      id: "demo-1",
      title: "Fix double-submit in checkout form",
      symbols: ["useActionState", "useEffect", "AbortController"],
      paths: ["src/checkout/Form.tsx"],
      right: true,
    },
    {
      id: "demo-2",
      title: "Add retry with backoff to payment client",
      symbols: ["retry", "backoff", "Idempotency-Key", "Promise.allSettled"],
      paths: ["src/payments/client.ts"],
      right: false,
    },
    {
      id: "demo-3",
      title: "Lock seat rows during booking",
      symbols: ["BEGIN", "FOR UPDATE", "transaction"],
      paths: ["db/migrations/004_lock.sql", "src/booking/reserve.ts"],
      right: true,
    },
  ];
  for (const t of tasks) {
    await svc.ingest(
      {
        id: `${t.id}-done`,
        schemaVersion: 1,
        type: "task.completed",
        timestamp: new Date().toISOString(),
        source: { providerId: "claude-code", sessionId: "demo" },
        developerId: "demo",
        repository: { root: repo },
        task: { id: t.id, title: t.title, status: "completed" },
        changes: t.paths.map((p) => ({ path: p, kind: "modified", linesAdded: 48, symbols: t.symbols })),
      },
      { cwd: repo },
    );
    const p = await svc.prepareAssessment({ kind: "task", taskId: t.id, count: 3 }, { cwd: repo });
    let q = p.question;
    let i = 0;
    while (q) {
      const full = (await svc.store.read()).questions[q.question.id]!;
      const wrong = !t.right && i % 2 === 0;
      const answer = full.choices
        ? {
            choiceIds: wrong ? [full.choices.find((c) => !full.correct!.includes(c.id))!.id] : full.correct,
            confidence: (wrong ? "high" : i % 2 ? "medium" : "high") as "high" | "medium",
            reasoning: wrong ? "seems right" : full.reasoningSignals.map((g) => g[0]).join(", "),
          }
        : {
            text: full
              .rubric!.slice(0, 2)
              .map((c) => c.anyOf[0]!.join(" "))
              .join(". "),
          };
      const r = await svc.answer(p.assessmentId, q.question.id, answer, { cwd: repo });
      q = r.next;
      i++;
    }
  }
  await svc.syncVault({ cwd: repo });
  console.log(`Seeded demo data in ${home}`);
}

const repo = join(root, "demo-repo");
const server = await startDashboard(svc, {
  host: "127.0.0.1",
  port: Number(process.env.PORT ?? 4317),
  cwd: repo,
});
console.log(`Dashboard: ${server.url}`);
