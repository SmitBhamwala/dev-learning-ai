#!/usr/bin/env node
/**
 * Project lint rules that encode this repository's safety and architecture
 * constraints (run in CI with `pnpm lint`). Each rule exists because a
 * requirement depends on it; see docs/architecture.md.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const problems = [];

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git", ".dev-data", "types"].includes(e.name) && e.isDirectory()) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const rules = [
  {
    name: "core-is-provider-and-node-independent",
    applies: (p) => p.includes("packages/core/src/"),
    test: (src) =>
      /from\s+["']node:|from\s+["'](fs|path|os|child_process)["']|@anthropic-ai\/sdk|claude-code/.test(src),
    message: "packages/core must not import Node built-ins, vendor SDKs or Claude Code APIs",
  },
  {
    name: "no-innerHTML-in-dashboard",
    applies: (p) => p.includes("packages/dashboard/public/") && p.endsWith(".js"),
    test: (src) => /\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(src),
    message: "dashboard must build DOM with textContent/createElement only (XSS safety)",
  },
  {
    name: "no-shell-execution",
    applies: (p) => /packages\/(core|runtime|dashboard)\/src\//.test(p),
    test: (src) => /from\s+["'](node:)?child_process["']/.test(src),
    message:
      "engine code must not execute shell commands (doctor's --check-agents is the only, explicit exception)",
    allow: ["packages/runtime/src/doctor.ts"],
  },
  {
    name: "no-console-log-in-libraries",
    applies: (p) => /packages\/(core|runtime)\/src\//.test(p),
    test: (src) => /console\.log\(/.test(src),
    message: "library packages must not print; return data to the caller",
  },
  {
    name: "no-fixture-bank-in-product",
    applies: (p) => /(packages|apps|integrations)\/[^/]+\/(src|hooks)\//.test(p),
    test: (src) => /FIXTURE_QUESTIONS|fixtures\/bank/.test(src),
    message: "the hand-written question set is a test fixture; product questions are generated at runtime",
  },
];

for await (const file of walk(root)) {
  const rel = relative(root, file).split("\\").join("/");
  if (!/\.(ts|tsx|js|mjs)$/.test(rel)) continue;
  const src = await readFile(file, "utf8");
  for (const r of rules) {
    if (!r.applies(rel) || r.allow?.includes(rel)) continue;
    if (r.test(src)) problems.push(`${rel}: [${r.name}] ${r.message}`);
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`lint: ${rules.length} rules passed`);
