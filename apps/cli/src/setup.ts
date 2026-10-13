import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  checkVault,
  discoverTechnologies,
  exists,
  locateRoot,
  registerProject,
  runDoctor,
  summarizeTechnologies,
  type LearningService,
} from "@dev-learning-ai/runtime";
import { CliExit, EXIT, ask, c, confirm, isInteractive, type GlobalOpts } from "./ui.js";

const exec = promisify(execFile);

export interface SetupOptions extends GlobalOpts {
  vault?: string;
  vaultProvider?: "obsidian" | "markdown" | "none";
  allowHostModel?: boolean;
  installMod?: boolean;
  dryRun?: boolean;
}

/** Where the Claude Code mod ships inside this package (or the repository). */
export function modDirectory(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, "..", "claude-code-mod"), join(here, "..", "..", "..", "integrations", "claude-code")]
    .map((p) => resolve(p))
    .find((p) => existsSync(join(p, ".claude-plugin", "plugin.json")));
}

async function hasClaude(): Promise<string | undefined> {
  try {
    const { stdout } = await exec("claude", ["--version"], {
      timeout: 10_000,
      windowsHide: true,
      shell: process.platform === "win32",
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * The guided setup. Explains every change first, asks before consequential
 * ones, reuses an existing installation, never edits agent configuration or
 * source code silently, and ends with a completion report.
 */
export async function runSetup(svc: LearningService, o: SetupOptions): Promise<void> {
  const log = (s = "") => !o.json && console.log(s);
  const report: { step: string; result: string }[] = [];
  const cwd = resolve(o.cwd ?? process.cwd());

  // 1–3. Inspect environment, repository and agent.
  const root = await locateRoot(cwd);
  const discovery = await discoverTechnologies(root);
  const claude = await hasClaude();
  const db = await svc.store.read();
  const alreadyRegistered = Object.values(db.projects).find((p) => p.paths.includes(root));
  const cfg = (await svc.resolved({ cwd })).config;

  let vaultProvider = o.vaultProvider ?? (o.vault ? "obsidian" : cfg.knowledge.provider);
  let vaultPath = o.vault ? resolve(o.vault) : cfg.knowledge.vault_path || svc.paths.defaultVault;
  let allowHost = o.allowHostModel ?? cfg.ai.allow_host_model;
  if (isInteractive(o) && !o.yes) {
    if (!o.vault && !o.vaultProvider) {
      const a = await ask(`Knowledge vault folder (Enter for ${vaultPath}; type "none" to skip): `);
      if (a.toLowerCase() === "none") vaultProvider = "none";
      else if (a) {
        vaultPath = resolve(a);
        vaultProvider = "obsidian";
      }
    }
    if (o.allowHostModel === undefined && !cfg.ai.allow_host_model) {
      log(
        c.dim(
          "Questions are written by an AI model at runtime from your task's evidence (file names, symbols, detected concepts; never whole files).",
        ),
      );
      allowHost = (await ask("Let your coding agent's own model write them? [Y/n] ")).toLowerCase() !== "n";
    }
  }

  log(c.bold("dev-learning-ai setup"));
  log(`  Node.js ${process.versions.node} · repository ${root}`);
  log(
    `  Detected: ${summarizeTechnologies(discovery.technologies) || "no known technologies"}${discovery.isMonorepo ? ` · monorepo (${discovery.workspaces.length} workspaces)` : ""}`,
  );
  log(
    `  Coding agent: ${claude ? `Claude Code ${claude}` : "Claude Code not found on PATH (the CLI and dashboard work without it)"}`,
  );
  log("");
  log(c.bold("Planned changes:"));
  const plan = [
    `${svc.createdOnOpen ? "Create" : "Reuse"} the global installation at ${svc.paths.home}`,
    alreadyRegistered
      ? `Refresh the registration of ${alreadyRegistered.name}`
      : `Register ${root} and write .dev-learning-ai/project.yaml (an id only; safe to commit)`,
    vaultProvider === "none"
      ? "No knowledge vault"
      : `Use ${vaultProvider === "obsidian" ? "the Obsidian vault" : "Markdown notes"} at ${vaultPath} (notes go in a DeveloperKnowledge/ folder; existing notes are never overwritten)`,
    allowHost
      ? "Allow the coding agent's own model to write questions (ai.allow_host_model: true)"
      : "Do not allow model use yet (learning will defer until you enable it)",
    o.installMod
      ? claude
        ? "Register the Claude Code mod (runs `claude plugin` commands; asks first)"
        : "Skip the Claude Code mod (Claude Code not found)"
      : "Leave Claude Code configuration untouched (instructions printed at the end)",
  ];
  for (const p of plan) log(`  • ${p}`);
  log(c.dim("  Nothing in your application's source code or dependencies is changed."));
  if (o.dryRun) {
    if (o.json) console.log(JSON.stringify({ dryRun: true, plan }, null, 2));
    return;
  }
  if (!(await confirm(o, "Proceed?")))
    throw new CliExit(EXIT.needsConfirmation, "Setup cancelled; nothing was changed.");

  // 6, 13, 15. Installation, storage, migrations.
  const init = await svc.init();
  report.push({
    step: "Global installation",
    result: svc.createdOnOpen ? `created at ${init.home}` : `reused ${init.home}`,
  });

  // 7, 11, 12. Registration and technology profile.
  const reg = await registerProject(svc.store, root);
  report.push({
    step: "Project",
    result: `${reg.created ? "registered" : "refreshed"} ${reg.project.name} (${reg.project.id})`,
  });
  report.push({
    step: "Technology profile",
    result: summarizeTechnologies(reg.project.technologies) || "none detected",
  });
  const ctx = (await svc.locate({ cwd })).ctx;

  // 9. Vault.
  const ops: { path: string; value: unknown; layer: "global" }[] = [
    { path: "knowledge.provider", value: vaultProvider, layer: "global" },
  ];
  if (vaultProvider !== "none") {
    if (!(await exists(vaultPath))) await mkdir(vaultPath, { recursive: true });
    if (vaultProvider === "obsidian" && !(await exists(join(vaultPath, ".obsidian"))))
      await mkdir(join(vaultPath, ".obsidian"), { recursive: true });
    ops.push({ path: "knowledge.vault_path", value: vaultPath, layer: "global" });
  }
  ops.push({ path: "ai.allow_host_model", value: allowHost, layer: "global" });
  // 14. Validated, recorded configuration change (with rollback).
  const applied = await svc.config.apply(ops, {
    actor: "setup",
    ctx,
    confirm: true,
    note: "dev-learning-ai setup",
  });
  report.push({
    step: "Configuration",
    result: applied.diff.length
      ? `${applied.diff.length} setting(s) changed (undo: dev-learning-ai config rollback ${applied.historyId})`
      : "unchanged",
  });
  if (vaultProvider !== "none") {
    const v = await checkVault({ provider: vaultProvider, root: vaultPath, folder: "DeveloperKnowledge" });
    report.push({
      step: "Vault",
      result: v.ok
        ? `${vaultPath}${v.isObsidianVault ? " (Obsidian)" : ""}`
        : `problem: ${v.problems.join(" ")}`,
    });
    const synced = await svc.syncVault({ cwd });
    if ("written" in synced) report.push({ step: "Vault notes", result: `${synced.written.length} written` });
  }

  // 10. Claude Code mod (only with explicit opt-in and confirmation).
  const mod = modDirectory();
  if (o.installMod && claude && mod) {
    log("");
    log(
      `This will run: claude plugin marketplace add "${mod}"  and  claude plugin install dev-learning-ai@dev-learning-ai`,
    );
    if (await confirm(o, "Register the mod with Claude Code now?")) {
      try {
        await exec("claude", ["plugin", "marketplace", "add", mod], {
          timeout: 60_000,
          windowsHide: true,
          shell: process.platform === "win32",
        });
        await exec("claude", ["plugin", "install", "dev-learning-ai@dev-learning-ai"], {
          timeout: 60_000,
          windowsHide: true,
          shell: process.platform === "win32",
        });
        report.push({
          step: "Claude Code mod",
          result: "installed (start a new Claude Code session to load it)",
        });
      } catch (err) {
        report.push({
          step: "Claude Code mod",
          result: `not installed: ${(err as Error).message.split("\n")[0]}`,
        });
      }
    } else report.push({ step: "Claude Code mod", result: "skipped by you" });
  } else {
    report.push({
      step: "Claude Code mod",
      result: `not changed. To add it: claude plugin marketplace add "${mod}" then /plugin install dev-learning-ai@dev-learning-ai`,
    });
  }

  // 16–17. Verify.
  const checks = await runDoctor(svc, { cwd });
  const failures = checks.filter((x) => x.status === "fail");
  report.push({
    step: "Verification",
    result: failures.length
      ? `${failures.length} problem(s): ${failures.map((f) => f.name).join(", ")}`
      : "all checks passed",
  });

  // 18. Completion report.
  if (o.json) {
    console.log(JSON.stringify({ report, checks }, null, 2));
    return;
  }
  log("");
  log(c.bold("Setup complete"));
  for (const r of report) log(`  ${c.green("✓")} ${r.step.padEnd(20)} ${r.result}`);
  log("");
  log("Next:");
  log("  • Work with your agent as usual; after a meaningful task you'll be offered a few questions.");
  log("  • dev-learning-ai assess React 18     — study a topic now");
  log("  • dev-learning-ai dashboard           — explore your knowledge");
}
