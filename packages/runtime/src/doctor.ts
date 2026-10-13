import { execFile } from "node:child_process";
import { access, constants, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import type { LearningService, WorkContext } from "./service.js";
import { checkVault } from "./vault.js";

const exec = promisify(execFile);

export interface Check {
  name: string;
  status: "ok" | "warn" | "fail" | "info";
  detail: string;
  fix?: string;
}

/** Diagnostics. Read-only; runs one external command (`claude --version`) only when asked to check agents. */
export async function runDoctor(
  svc: LearningService,
  work: WorkContext = {},
  opts: { checkAgents?: boolean } = {},
): Promise<Check[]> {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  const minor = Number(process.versions.node.split(".")[1]);
  checks.push(
    major > 22 || (major === 22 && minor >= 12)
      ? { name: "Node.js", status: "ok", detail: process.versions.node }
      : {
          name: "Node.js",
          status: "fail",
          detail: `${process.versions.node} (22.12 or newer required)`,
          fix: "Install Node.js 22.12+",
        },
  );
  try {
    await access(svc.paths.home, constants.W_OK);
    checks.push({ name: "Data directory", status: "ok", detail: svc.paths.home });
  } catch {
    checks.push({
      name: "Data directory",
      status: "fail",
      detail: `${svc.paths.home} is not writable`,
      fix: "Fix permissions or set DEV_LEARNING_AI_HOME",
    });
  }
  try {
    const db = await svc.store.read();
    const d = svc.store.diagnostics;
    checks.push({
      name: "Database",
      status: d.quarantined.length ? "warn" : "ok",
      detail: `schema ${db.meta.schemaVersion}; ${Object.keys(db.knowledge).length} knowledge records, ${Object.keys(db.sessions).length} assessments${d.recoveredJournal ? "; recovered an interrupted write" : ""}${d.quarantined.length ? `; quarantined ${d.quarantined.join(", ")}` : ""}`,
      fix: d.quarantined.length ? "Restore from a backup: dev-learning-ai restore <file>" : undefined,
    });
  } catch (err) {
    checks.push({ name: "Database", status: "fail", detail: (err as Error).message });
  }
  let config;
  try {
    const r = await svc.resolved(work);
    config = r.config;
    checks.push({
      name: "Configuration",
      status: "ok",
      detail: `valid; learning ${config.learning.enabled ? "enabled" : "disabled"}, mode ${config.learning.mode}`,
    });
    checks.push(
      r.project
        ? {
            name: "Project",
            status: "ok",
            detail: `${r.project.name} (${r.project.id})${r.workspace ? `, workspace ${r.workspace}` : ""}`,
          }
        : {
            name: "Project",
            status: "info",
            detail: "current directory is not a registered project",
            fix: "dev-learning-ai register",
          },
    );
  } catch (err) {
    checks.push({
      name: "Configuration",
      status: "fail",
      detail: (err as Error).message,
      fix: "dev-learning-ai config history / rollback",
    });
  }
  if (config) {
    const target = svc.vaultTarget(config);
    if (target) {
      const v = await checkVault(target);
      checks.push({
        name: `Vault (${target.provider})`,
        status: v.ok ? (v.hints.length ? "warn" : "ok") : "fail",
        detail: `${v.path}${v.isObsidianVault ? " (Obsidian vault)" : ""}${v.problems.length ? `: ${v.problems.join(" ")}` : ""}`,
        fix: v.hints.join(" ") || undefined,
      });
    } else checks.push({ name: "Vault", status: "info", detail: "disabled (knowledge.provider: none)" });
    for (const host of [false, true]) {
      const p = await svc.provider(config, { ...work, hostAvailable: host });
      checks.push({
        name: host ? "Question generation (inside an agent)" : "Question generation (CLI/dashboard)",
        status: p.provider ? "ok" : "warn",
        detail: p.provider
          ? `${p.provider.displayName}${p.model.value ? `, model ${p.model.value}` : ""}${p.effort.value ? `, effort ${p.effort.value}` : ""}`
          : (p.unavailable ?? "unavailable"),
        fix: p.provider
          ? undefined
          : host
            ? "dev-learning-ai config set ai.allow_host_model true --yes"
            : "Set ANTHROPIC_API_KEY and ai.allow_remote_analysis: true, or answer questions inside Claude Code",
      });
      for (const w of p.warnings) checks.push({ name: "Provider warning", status: "warn", detail: w });
    }
  }
  try {
    const n = (await readdir(svc.paths.inbox)).filter((f) => f.endsWith(".json")).length;
    checks.push({
      name: "Event inbox",
      status: n > 200 ? "warn" : "ok",
      detail: `${n} pending event file(s)`,
      fix: n > 200 ? "dev-learning-ai ingest --inbox" : undefined,
    });
  } catch {
    checks.push({ name: "Event inbox", status: "info", detail: "empty" });
  }
  if (opts.checkAgents) {
    try {
      const { stdout } = await exec("claude", ["--version"], {
        timeout: 10_000,
        windowsHide: true,
        shell: process.platform === "win32",
      });
      checks.push({ name: "Claude Code", status: "ok", detail: stdout.trim() });
    } catch {
      checks.push({
        name: "Claude Code",
        status: "info",
        detail: "not found on PATH (the CLI and dashboard work without it)",
      });
    }
  }
  return checks;
}
