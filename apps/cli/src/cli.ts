import { realpathSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Command, Option } from "commander";
import {
  ConceptCatalog,
  DIMENSION_INFO,
  buildTechnologyTree,
  describeScope,
  flatten,
  formatDiff,
  getPath,
  knownPaths,
  parseStudyRequest,
  renderTree,
  type Dimension,
} from "@dev-learning-ai/core";
import {
  ConfigError,
  LearningService,
  ProjectIdentityConflict,
  ServiceError,
  atomicWrite,
  buildReport,
  checkVault,
  createBackup,
  deleteProjectData,
  handleAgentRequest,
  listBackups,
  loadExtensions,
  recommendResources,
  registerProject,
  resolveHome,
  summarizeTechnologies,
  removeProject,
  reportToMarkdown,
  restoreBackup,
  runDoctor,
  setTechnologyFact,
  syncVault,
  type WorkContext,
  type WritableLayer,
} from "@dev-learning-ai/runtime";
import { runInteractive, printSummary } from "./interactive.js";
import { runSetup } from "./setup.js";
import {
  CliExit,
  EXIT,
  c,
  closePrompts,
  confirm,
  isInteractive,
  out,
  pct,
  table,
  type GlobalOpts,
} from "./ui.js";

export const VERSION = "0.1.0";

async function svcFor(): Promise<LearningService> {
  return LearningService.open();
}

function workFrom(opts: GlobalOpts & { session?: string }): WorkContext {
  return { cwd: resolve(opts.cwd ?? process.cwd()), sessionId: opts.session };
}

function globals(cmd: Command): GlobalOpts & { session?: string } {
  return cmd.optsWithGlobals() as GlobalOpts & { session?: string };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("dev-learning-ai")
    .description(
      "AI can write your code. This tool helps you understand it, remember it, and become better at building software.",
    )
    .version(VERSION)
    .option("--json", "machine-readable JSON output")
    .option("-y, --yes", "confirm consequential changes without prompting")
    .option("-C, --cwd <path>", "run as if started in <path>")
    .option("--session <id>", "agent session id (session-scoped settings and budgets)")
    .option("--no-interactive", "never prompt")
    .showHelpAfterError();

  // ── installation ──────────────────────────────────────────────────
  program
    .command("init")
    .description("create (or reuse) the global installation")
    .action(async (_o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      const r = { ...(await svc.init()), created: svc.createdOnOpen };
      out(g, { ...r, paths: svc.paths }, () => [
        r.created
          ? c.green(`Created the global installation at ${r.home}`)
          : `Reusing the existing installation at ${r.home}`,
        c.dim(
          "Next: run `dev-learning-ai register` inside a repository, or `dev-learning-ai setup` for guided setup.",
        ),
      ]);
    });

  program
    .command("setup")
    .description("guided setup for this repository: install check, registration, vault, agent integration")
    .option("--vault <path>", "knowledge vault folder (an Obsidian vault or any folder)")
    .addOption(
      new Option("--vault-provider <provider>", "vault format").choices(["obsidian", "markdown", "none"]),
    )
    .option(
      "--allow-host-model",
      "let the coding agent's own model write questions (sends file names/symbols of each task)",
    )
    .option("--install-mod", "also register the Claude Code mod (asks before changing agent configuration)")
    .option("--dry-run", "show what would change without changing anything")
    .action(async (o, cmd: Command) => {
      await runSetup(await svcFor(), { ...globals(cmd), ...o });
    });

  program
    .command("register [path]")
    .description("register a repository (the current one by default)")
    .option("--name <name>", "display name")
    .option(
      "--product-group <group>",
      "group separate repositories of one product (never merges their knowledge)",
    )
    .option("--same-project", "this checkout is another copy of an already registered project")
    .option("--new-project", "give this checkout its own identity (forks, unrelated copies)")
    .option("--no-project-file", "do not write .dev-learning-ai/project.yaml into the repository")
    .action(async (path: string | undefined, o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      const target = resolve(path ?? g.cwd ?? process.cwd());
      try {
        const r = await registerProject(svc.store, target, {
          name: o.name,
          productGroup: o.productGroup,
          identity: o.sameProject ? "same" : o.newProject ? "new" : undefined,
          writeProjectFile: o.projectFile,
        });
        out(g, r, () => [
          `${r.created ? c.green("Registered") : "Updated"} ${c.bold(r.project.name)} ${c.dim(r.project.id)}`,
          `  root: ${r.root}${r.project.isMonorepo ? ` · monorepo with ${r.project.workspaces.length} workspace(s)` : ""}`,
          `  technologies: ${summarizeTechnologies(r.project.technologies) || "none detected"}`,
          ...r.notes.map((n) => c.dim(`  ${n}`)),
          ...r.wroteFiles.map((f) => c.dim(`  wrote ${f}`)),
        ]);
      } catch (err) {
        if (err instanceof ProjectIdentityConflict) throw new CliExit(EXIT.usage, err.message);
        throw err;
      }
    });

  // ── projects ──────────────────────────────────────────────────────
  const projects = program.command("projects").description("registered projects");
  projects
    .command("list")
    .option("--all", "include removed registrations")
    .action(async (o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      const db = await svc.store.read();
      const list = Object.values(db.projects).filter((p) => o.all || p.status === "active");
      out(g, list, () =>
        list.length
          ? table(
              list.map((p) => [
                p.id === db.meta.activeProjectId ? c.green("●") : " ",
                p.name,
                p.id,
                p.paths[0] ?? "",
                p.status === "removed" ? c.dim("removed") : "",
              ]),
              ["", "name", "id", "path", ""],
            )
          : "No projects registered. Run `dev-learning-ai register` in a repository.",
      );
    });
  projects.command("inspect [id]").action(async (id: string | undefined, _o, cmd: Command) => {
    const g = globals(cmd);
    const svc = await svcFor();
    const p = id ? (await svc.store.read()).projects[id] : (await svc.locate(workFrom(g))).project;
    if (!p)
      throw new CliExit(
        EXIT.notFound,
        "Project not found (pass an id, or run inside a registered repository).",
      );
    out(g, p, () =>
      [
        `${c.bold(p.name)} ${c.dim(p.id)} ${p.status === "removed" ? c.yellow("(removed)") : ""}`,
        `paths: ${p.paths.join(", ")}`,
        `remotes: ${p.remotes.join(", ") || "none"}`,
        p.productGroup ? `product group: ${p.productGroup}` : "",
        p.isMonorepo ? `workspaces: ${p.workspaces.map((w) => w.path).join(", ")}` : "",
        "technologies:",
        ...p.technologies.map(
          (t) =>
            `  ${t.technology}${t.workspace ? ` [${t.workspace}]` : ""} ${t.version ?? (t.declaredRange ? `declared ${t.declaredRange}` : "")} ${c.dim(`(${t.provenance.map((x) => `${x.source}:${x.file ?? ""} ${Math.round(x.confidence * 100)}%`).join(", ")})`)}`,
        ),
      ].filter(Boolean),
    );
  });
  projects
    .command("switch <id>")
    .description("set the active project for commands run outside a repository")
    .action(async (id: string, _o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      await svc.store.transact((db) => {
        if (!db.projects[id]) throw new CliExit(EXIT.notFound, `No project ${id}`);
        db.meta.activeProjectId = id;
      });
      out(g, { active: id }, () => `Active project: ${id}`);
    });
  projects
    .command("remove <id>")
    .description("unregister a project (keeps its learning history)")
    .action(async (id: string, _o, cmd: Command) => {
      const g = globals(cmd);
      const p = await removeProject((await svcFor()).store, id);
      out(
        g,
        p,
        () =>
          `Unregistered ${p.name}. Its learning history is kept; re-register to continue, or use \`projects delete-data\`.`,
      );
    });
  projects
    .command("delete-data <id>")
    .description("permanently delete a project's learning data (developer-wide knowledge is kept)")
    .option("--remove-repo-files", "also delete .dev-learning-ai/ from the repository")
    .action(async (id: string, o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      const p = (await svc.store.read()).projects[id];
      if (!p) throw new CliExit(EXIT.notFound, `No project ${id}`);
      if (!(await confirm(g, `Permanently delete all project-specific learning data for "${p.name}"?`)))
        throw new CliExit(EXIT.needsConfirmation, "Cancelled.");
      const r = await deleteProjectData(svc.store, id, { removeRepoFiles: o.removeRepoFiles });
      out(
        g,
        r,
        () =>
          `Deleted ${r.knowledge} knowledge records, ${r.evidence} evidence records, ${r.sessions} assessments and ${r.tasks} tasks for ${p.name}.`,
      );
    });
  projects
    .command("rebuild [path]")
    .description("re-read repository metadata after a move, rename or dependency change")
    .action(async (path: string | undefined, _o, cmd: Command) => {
      const g = globals(cmd);
      const r = await registerProject((await svcFor()).store, resolve(path ?? g.cwd ?? process.cwd()));
      out(g, r.project, () => [`Rebuilt ${r.project.name}`, ...r.notes.map((n) => c.dim(`  ${n}`))]);
    });
  projects
    .command("set-tech <technology> [version]")
    .description("correct a detected technology version (omit version to mark it unknown)")
    .action(async (tech: string, version: string | undefined, _o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      const p = (await svc.locate(workFrom(g))).project;
      if (!p) throw new CliExit(EXIT.notFound, "Run inside a registered repository.");
      await setTechnologyFact(svc.store, p.id, tech, version);
      out(
        g,
        { technology: tech, version },
        () => `Recorded ${tech}${version ? ` ${version}` : ""} for ${p.name} (marked as your correction).`,
      );
    });

  // ── status ────────────────────────────────────────────────────────
  program
    .command("status")
    .description("what is configured and what needs attention")
    .action(async (_o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      const work = workFrom(g);
      await svc.drainInbox(work);
      const r = await svc.resolved(work);
      const due = await svc.dueReviews(work);
      const resumable = await svc.resumable(work);
      const gen = await svc.provider(r.config, work);
      const genHost = await svc.provider(r.config, { ...work, hostAvailable: true });
      const db = await svc.store.read();
      const data = {
        home: svc.paths.home,
        project: r.project ? { id: r.project.id, name: r.project.name, workspace: r.workspace } : null,
        learning: {
          enabled: r.config.learning.enabled,
          mode: r.config.learning.mode,
          questionsPerTask: r.config.learning.questions_per_task,
        },
        generation: {
          cli: gen.provider?.id ?? null,
          cliReason: gen.unavailable ?? gen.reason,
          agent: genHost.provider?.id ?? null,
          agentReason: genHost.unavailable ?? genHost.reason,
        },
        dueReviews: due.length,
        resumable: resumable.map((s) => s.id),
        knowledgeRecords: Object.keys(db.knowledge).length,
        vault: svc.vaultTarget(r.config) ?? null,
      };
      out(g, data, () => [
        `${c.bold("dev-learning-ai")} ${VERSION} · data in ${svc.paths.home}`,
        `Project: ${r.project ? `${r.project.name}${r.workspace ? ` / ${r.workspace}` : ""}` : c.dim("none (run `dev-learning-ai register`)")}`,
        `Learning: ${r.config.learning.enabled ? c.green("on") : c.yellow("off")} · mode ${r.config.learning.mode}${r.config.learning.mode === "auto" ? c.dim(" (resolved per task)") : ""} · ${r.config.learning.questions_per_task} question(s) per task`,
        `Question generation — in your agent: ${genHost.provider ? c.green(genHost.provider.displayName) : c.yellow(genHost.unavailable ?? "unavailable")}`,
        `Question generation — in the CLI: ${gen.provider ? c.green(gen.provider.displayName) : c.dim(gen.unavailable ?? "unavailable")}`,
        `Reviews due: ${due.length}${resumable.length ? ` · ${resumable.length} assessment(s) to resume` : ""}`,
        `Vault: ${data.vault ? `${data.vault.provider} at ${data.vault.root}` : "off"}`,
      ]);
    });

  // ── config ────────────────────────────────────────────────────────
  const layerOpt = () =>
    new Option("--layer <layer>", "configuration layer")
      .choices(["global", "project", "workspace", "session"])
      .default("global");
  const config = program
    .command("config")
    .description("view and change configuration (same service as the dashboard)");
  config
    .command("get [key]")
    .option("--origins", "show which layer supplied each value")
    .action(async (key: string | undefined, o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      const r = await svc.resolved(workFrom(g));
      if (key) {
        const e = svc.config.explain(r, key);
        if (e.value === undefined && !knownPaths().includes(key))
          throw new CliExit(EXIT.notFound, `Unknown setting ${key}`);
        out(
          g,
          { key, ...e },
          () =>
            `${key} = ${JSON.stringify(e.value)} ${c.dim(`(${e.origin}${e.locked ? ", locked by organization" : ""})`)}`,
        );
        return;
      }
      const flat = flatten(r.config);
      out(g, o.origins ? { config: r.config, origins: r.origins, locked: r.locked } : r.config, () =>
        Object.entries(flat).map(
          ([k, v]) =>
            `${k} = ${JSON.stringify(v)}${o.origins ? c.dim(`  (${r.origins[k] ?? "defaults"})`) : ""}`,
        ),
      );
    });
  config
    .command("set <key> <value>")
    .addOption(layerOpt())
    .option("--dry-run", "show the diff only")
    .action(async (key: string, value: string, o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      const loc = await svc.locate(workFrom(g));
      const run = (confirmed: boolean) =>
        svc.config.set(key, value, o.layer as WritableLayer, {
          actor: "cli",
          ctx: loc.ctx,
          confirm: confirmed,
          dryRun: o.dryRun,
        });
      let r = await run(Boolean(g.yes));
      if (!r.applied && r.needsConfirmation && !o.dryRun) {
        if (!g.json) console.log(formatDiff(r.diff));
        for (const m of r.messages) if (!g.json) console.log(c.yellow(m));
        if (await confirm(g, "Apply this change?")) r = await run(true);
        else throw new CliExit(EXIT.needsConfirmation, "Not applied.");
      }
      out(g, r, () => [
        formatDiff(r.diff),
        r.applied
          ? c.green(`Saved (${r.historyId}). Undo with: dev-learning-ai config rollback ${r.historyId}`)
          : c.dim("Not applied (dry run)."),
      ]);
    });
  config
    .command("unset <key>")
    .addOption(layerOpt())
    .action(async (key: string, o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      const loc = await svc.locate(workFrom(g));
      const r = await svc.config.unset(key, o.layer as WritableLayer, {
        actor: "cli",
        ctx: loc.ctx,
        confirm: true,
      });
      out(g, r, () => [formatDiff(r.diff), c.green("Saved.")]);
    });
  config
    .command("ask <request...>")
    .description(
      'AI-assisted configuration, e.g. config ask "use a lower-cost model for routine assessments"',
    )
    .action(async (words: string[], _o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      const loc = await svc.locate(workFrom(g));
      const text = words.join(" ");
      const preview = await svc.config.applyNaturalLanguage(text, { ctx: loc.ctx, dryRun: true });
      if (preview.operations.length === 0) {
        out(g, preview, () => [
          c.yellow("No configuration change recognised."),
          c.dim(`Unrecognised: ${preview.unparsed.join(" | ")}`),
          c.dim("Try `dev-learning-ai config get` to see settings, then `config set <key> <value>`."),
        ]);
        throw new CliExit(EXIT.usage, "Nothing applied.");
      }
      if (!g.json) {
        console.log(c.bold("Proposed change:"));
        for (const op of preview.operations)
          console.log(`  ${op.layer}: ${op.path} = ${JSON.stringify(op.value)} ${c.dim(`— ${op.why}`)}`);
        console.log(formatDiff(preview.diff));
        if (preview.unparsed.length)
          console.log(c.dim(`Not understood (ignored): ${preview.unparsed.join(" | ")}`));
      }
      if (!(await confirm(g, "Apply?"))) throw new CliExit(EXIT.needsConfirmation, "Not applied.");
      const r = await svc.config.applyNaturalLanguage(text, { ctx: loc.ctx, confirm: true });
      out(g, r, () =>
        c.green(`Applied (${r.historyId}). Undo with: dev-learning-ai config rollback ${r.historyId}`),
      );
    });
  config
    .command("history")
    .option("-n, --limit <n>", "entries", "20")
    .action(async (o, cmd: Command) => {
      const g = globals(cmd);
      const h = await (await svcFor()).config.history(Number(o.limit));
      out(g, h, () =>
        h.length
          ? h.map(
              (e) =>
                `${c.dim(e.at.slice(0, 19))} ${e.id} ${e.actor}/${e.layer} ${e.diff.map((d) => `${d.path}=${JSON.stringify(d.after)}`).join(", ")}${e.note ? c.dim(` — ${e.note}`) : ""}`,
            )
          : "No configuration changes recorded.",
      );
    });
  config.command("rollback <historyId>").action(async (id: string, _o, cmd: Command) => {
    const g = globals(cmd);
    const svc = await svcFor();
    const loc = await svc.locate(workFrom(g));
    if (!(await confirm(g, `Restore the configuration from before change ${id}?`)))
      throw new CliExit(EXIT.needsConfirmation, "Cancelled.");
    const r = await svc.config.rollback(id, loc.ctx);
    out(g, r, () => [formatDiff(r.diff), c.green(r.messages.join(" "))]);
  });
  config
    .command("path")
    .description("where each configuration layer lives")
    .action(async (_o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      const loc = await svc.locate(workFrom(g));
      const data = {
        global: svc.paths.configFile,
        managed: svc.paths.managedConfigFile,
        project: svc.config.layerFile("project", loc.ctx) ?? null,
        workspace: svc.config.layerFile("workspace", loc.ctx) ?? null,
      };
      out(g, data, () => Object.entries(data).map(([k, v]) => `${k.padEnd(9)} ${v ?? c.dim("n/a")}`));
    });

  // ── assessments ───────────────────────────────────────────────────
  const assess = program
    .command("assess [topic...]")
    .description('assess your understanding: of a task, concepts, or a topic such as "React 18 and 19"')
    .option("--task <id>", "assess a recorded task")
    .option("--concept <ids...>", "assess specific concept ids")
    .option("-n, --count <n>", "number of questions")
    .option("--resume <assessmentId>", "resume an interrupted assessment")
    .option("--interview", "interview mode: harder questions, reasoning required")
    .action(async (topic: string[], o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      const work = workFrom(g);
      await svc.drainInbox(work);
      if (o.resume) {
        const { session, question } = await svc.getAssessment(o.resume);
        if (!question) {
          if (session.summary) printSummary(session.summary.lines);
          out(g, session, () => `Assessment ${session.id} is ${session.status}.`);
          return;
        }
        await runInteractive(
          svc,
          { assessmentId: session.id, status: session.status, requests: [], question, warnings: [] },
          work,
        );
        return;
      }
      const study = topic.length ? parseStudyRequest(topic.join(" ")) : undefined;
      if (study && !study.technology && !o.concept)
        throw new CliExit(
          EXIT.usage,
          `Couldn't tell which technology "${topic.join(" ")}" refers to. Try e.g. "React 18" or --concept <id>.`,
        );
      if (!o.task && !o.concept && !study) {
        const db = await svc.store.read();
        const loc = await svc.locate(work);
        const last = Object.values(db.tasks)
          .filter((t) => t.offer === "pending" || t.offer === "deferred")
          .filter((t) => !loc.project || t.projectId === loc.project.id)
          .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))[0];
        if (!last)
          throw new CliExit(
            EXIT.usage,
            "Nothing pending. Pass a topic (e.g. `assess React 18`), --concept, or --task.",
          );
        o.task = last.id;
      }
      const prepared = await svc.prepareAssessment(
        {
          kind: o.interview ? "interview" : o.task ? "task" : "manual",
          taskId: o.task,
          conceptIds: o.concept,
          study,
          count: o.count ? Number(o.count) : undefined,
        },
        work,
      );
      if (study && !g.json) console.log(c.dim(`Scope: ${study.technology} · ${describeScope(study.scope)}`));
      if (!isInteractive(g)) {
        if (prepared.status === "deferred")
          throw new CliExit(EXIT.unavailable, `Deferred: ${prepared.reason ?? "no model available"}`);
        out(
          g,
          prepared,
          () =>
            `Assessment ${prepared.assessmentId}: ${prepared.status}. Resume with: dev-learning-ai assess --resume ${prepared.assessmentId}`,
        );
        return;
      }
      await runInteractive(svc, prepared, work);
      closePrompts();
    });
  void assess;

  program
    .command("interview [topic...]")
    .description("interview practice: interview-critical concepts, reasoning required")
    .option("-n, --count <n>", "questions", "5")
    .action(async (topic: string[], o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      const work = workFrom(g);
      const catalog = await svc.catalog();
      const study = topic.length ? parseStudyRequest(topic.join(" ")) : undefined;
      const conceptIds = catalog
        .all()
        .filter((c2) => c2.interviewCritical && (!study?.technology || c2.technology === study.technology))
        .map((c2) => c2.id);
      const prepared = await svc.prepareAssessment(
        { kind: "interview", conceptIds, count: Number(o.count) },
        work,
      );
      if (!isInteractive(g))
        return out(g, prepared, () => `Assessment ${prepared.assessmentId}: ${prepared.status}`);
      await runInteractive(svc, prepared, work);
      closePrompts();
    });

  const session = program.command("session").description("learning sessions (assessments)");
  session
    .command("start [topic...]")
    .description("start a learning session on a topic or on your due reviews")
    .action(async (topic: string[], _o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      const work = workFrom(g);
      const study = topic.length ? parseStudyRequest(topic.join(" ")) : undefined;
      const prepared = await svc.prepareAssessment(
        study ? { kind: "manual", study } : { kind: "review" },
        work,
      );
      if (!isInteractive(g))
        return out(g, prepared, () => `Assessment ${prepared.assessmentId}: ${prepared.status}`);
      await runInteractive(svc, prepared, work);
      closePrompts();
    });
  session
    .command("stop [assessmentId]")
    .description("stop the current session (answers so far are kept)")
    .action(async (id: string | undefined, _o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      const target = id ?? (await svc.resumable(workFrom(g)))[0]?.id;
      if (!target) throw new CliExit(EXIT.notFound, "No session in progress.");
      const s = await svc.endAssessment(target, "deferred");
      out(g, s, () => (s.summary ? s.summary.lines : `Session ${s.id} ${s.status}.`));
    });
  session.command("summary [assessmentId]").action(async (id: string | undefined, _o, cmd: Command) => {
    const g = globals(cmd);
    const svc = await svcFor();
    const db = await svc.store.read();
    const s = id
      ? db.sessions[id]
      : Object.values(db.sessions)
          .filter((x) => x.status === "completed")
          .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))[0];
    if (!s) throw new CliExit(EXIT.notFound, "No completed session.");
    out(g, s, () => s.summary?.lines ?? [`Session ${s.id} is ${s.status}.`]);
  });
  session.command("list").action(async (_o, cmd: Command) => {
    const g = globals(cmd);
    const svc = await svcFor();
    const list = Object.values((await svc.store.read()).sessions)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 30);
    out(
      g,
      list.map((s) => ({
        id: s.id,
        status: s.status,
        origin: s.origin.kind,
        created: s.createdAt,
        answered: s.items.filter((i) => i.evaluation).length,
        total: s.items.length,
      })),
      () =>
        table(
          list.map((s) => [
            s.createdAt.slice(0, 16).replace("T", " "),
            s.id,
            s.origin.kind,
            s.status,
            `${s.items.filter((i) => i.evaluation).length}/${s.items.length}`,
          ]),
          ["created", "id", "origin", "status", "answered"],
        ),
    );
  });

  // ── reviews ───────────────────────────────────────────────────────
  const review = program
    .command("review")
    .description("review concepts that are due, with new questions (never the same one again)")
    .option("-n, --count <n>", "questions")
    .option("--weak", "review weak topics instead of due ones")
    .option("--interview-critical", "only interview-critical concepts")
    .action(async (o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      const work = workFrom(g);
      const catalog = await svc.catalog();
      let conceptIds = o.weak
        ? (await svc.weakTopics(work)).map((t) => t.conceptId)
        : (await svc.dueReviews(work)).map((d) => d.conceptId);
      if (o.interviewCritical) conceptIds = conceptIds.filter((id) => catalog.get(id)?.interviewCritical);
      if (!conceptIds.length) return out(g, { due: 0 }, () => c.green("Nothing due. Nice."));
      const prepared = await svc.prepareAssessment(
        { kind: "review", conceptIds, count: o.count ? Number(o.count) : Math.min(conceptIds.length, 5) },
        work,
      );
      if (!isInteractive(g))
        return out(g, prepared, () => `Assessment ${prepared.assessmentId}: ${prepared.status}`);
      await runInteractive(svc, prepared, work);
      closePrompts();
    });
  review
    .command("due")
    .option("--upcoming", "include reviews that are not yet due")
    .action(async (o, cmd: Command) => {
      const g = globals(cmd);
      const list = await (await svcFor()).dueReviews(workFrom(g), { includeUpcoming: o.upcoming });
      out(g, list, () =>
        list.length
          ? table(
              list.map((d) => [
                d.label,
                d.scope.kind === "global" ? "developer" : "project",
                d.due.slice(0, 10),
                pct(d.retention),
                c.dim(d.reason),
              ]),
              ["concept", "scope", "due", "retention*", "why"],
            ) + c.dim("\n* estimated")
          : "No reviews due.",
      );
    });
  review.command("postpone <conceptId> <days>").action(async (id: string, days: string, _o, cmd: Command) => {
    const g = globals(cmd);
    await (await svcFor()).updateReview(id, { postponeDays: Number(days) }, workFrom(g));
    out(g, { conceptId: id, postponedDays: Number(days) }, () => `Postponed ${id} by ${days} day(s).`);
  });
  review.command("suspend <conceptId>").action(async (id: string, _o, cmd: Command) => {
    const g = globals(cmd);
    await (await svcFor()).updateReview(id, { suspend: true }, workFrom(g));
    out(g, { conceptId: id, suspended: true }, () => `Suspended reviews of ${id}.`);
  });
  review.command("resume <conceptId>").action(async (id: string, _o, cmd: Command) => {
    const g = globals(cmd);
    await (await svcFor()).updateReview(id, { resume: true }, workFrom(g));
    out(g, { conceptId: id, suspended: false }, () => `Resumed reviews of ${id}.`);
  });
  review
    .command("reset <conceptId>")
    .description("clear a concept's assessment history")
    .action(async (id: string, _o, cmd: Command) => {
      const g = globals(cmd);
      if (!(await confirm(g, `Erase the assessment history of ${id} (developer-wide and this project)?`)))
        throw new CliExit(EXIT.needsConfirmation, "Cancelled.");
      const n = await (await svcFor()).resetConcept(id, workFrom(g));
      out(g, { conceptId: id, removed: n }, () => `Reset ${id} (${n} scope(s)).`);
    });
  review
    .command("why <conceptId>")
    .description("why a review was scheduled")
    .action(async (id: string, _o, cmd: Command) => {
      const g = globals(cmd);
      const e = await (await svcFor()).explainConcept(id, workFrom(g));
      const rows = e.states
        .filter((s) => s.review)
        .map((s) => ({
          scope: s.scope.kind,
          next: s.review!.nextReviewAt,
          interval: s.review!.intervalDays,
          reason: s.review!.reason,
          lapses: s.review!.lapses,
        }));
      out(g, rows, () =>
        rows.length
          ? rows.map(
              (r) =>
                `${r.scope}: next ${r.next.slice(0, 10)} (interval ${r.interval}d, lapses ${r.lapses}) — ${r.reason}`,
            )
          : `No review scheduled for ${id}.`,
      );
    });

  program
    .command("weak-topics")
    .option("-n, --limit <n>", "", "10")
    .action(async (o, cmd: Command) => {
      const g = globals(cmd);
      const list = await (await svcFor()).weakTopics(workFrom(g), Number(o.limit));
      out(g, list, () =>
        list.length
          ? table(
              list.map((t) => [t.label, t.scope, pct(t.mastery), pct(t.calibration), String(t.evidence)]),
              ["concept", "scope", "mastery", "calibration", "answers"],
            )
          : "No weak topics with enough evidence yet.",
      );
    });

  // ── knowledge ─────────────────────────────────────────────────────
  program
    .command("knowledge [technology]")
    .description("the knowledge hierarchy (developer-wide, plus this project's own)")
    .addOption(
      new Option("--dimension <d>", "dimension to show")
        .choices(Object.keys(DIMENSION_INFO))
        .default("mastery"),
    )
    .action(async (tech: string | undefined, o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      const catalog = await svc.catalog();
      const { global, project, projectId } = await svc.knowledgeStates(workFrom(g));
      const techs = tech
        ? [tech]
        : catalog.technologies().filter((t) => buildTechnologyTree(catalog, t, global).assessed > 0);
      const trees = techs.map((t) =>
        buildTechnologyTree(catalog, t, global, { dimension: o.dimension as Dimension, projectId }),
      );
      const projectRows = [...project.values()].map((s) => ({
        concept: catalog.get(s.conceptId)?.label ?? s.conceptId,
        application: s.dimensions.application.value,
        mastery: s.dimensions.mastery.evidence ? s.dimensions.mastery.value : undefined,
      }));
      out(g, { trees, project: projectRows }, () =>
        [
          ...(trees.length
            ? trees.map(renderTree)
            : [
                "No assessed knowledge yet. Finish a task with your agent, or run `dev-learning-ai assess React 18`.",
              ]),
          ...(projectRows.length
            ? [
                "",
                c.bold("This project (application of concepts here)"),
                ...projectRows.map(
                  (r) => `  ${r.concept}: application ${pct(r.application)}, mastery ${pct(r.mastery)}`,
                ),
              ]
            : []),
        ].join("\n\n"),
      );
    });
  program
    .command("explain <conceptId>")
    .description("the evidence and rules behind a concept's scores")
    .action(async (id: string, _o, cmd: Command) => {
      const g = globals(cmd);
      const e = await (await svcFor()).explainConcept(id, workFrom(g));
      if (!e.concept) throw new CliExit(EXIT.notFound, `Unknown concept ${id}`);
      out(g, e, () => [
        `${c.bold(e.concept!.label)} ${c.dim(e.concept!.id)} — ${e.concept!.summary}`,
        `scope: ${describeScope(e.concept!.versionScope)}`,
        ...e.states.flatMap((s) => [
          "",
          c.bold(s.scope.kind === "global" ? "Developer-wide" : "This project"),
          ...(Object.keys(DIMENSION_INFO) as Dimension[]).map(
            (d) =>
              `  ${DIMENSION_INFO[d].label.padEnd(12)} ${s.dimensions[d].evidence ? pct(s.dimensions[d].value) : c.dim("not assessed")} ${c.dim(`(${s.dimensions[d].evidence} evidence${DIMENSION_INFO[d].isEstimate ? ", estimate" : ""})`)}`,
          ),
        ]),
        "",
        c.bold("Score history"),
        ...e.changes
          .slice(-12)
          .map(
            (ch) =>
              `  ${ch.at.slice(0, 10)} ${ch.dimension} ${pct(ch.before)} → ${pct(ch.after)} ${c.dim(`${ch.rule} ${ch.ruleVersion}`)} — ${ch.explanation}`,
          ),
      ]);
    });

  program
    .command("resources [conceptIds...]")
    .description("official learning resources for your gaps")
    .option("--refresher", "include introductory material")
    .action(async (ids: string[], o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      const { global, project } = await svc.knowledgeStates(workFrom(g));
      const states = new Map([...global, ...project]);
      const recs = recommendResources(await svc.catalog(), states, {
        conceptIds: ids,
        refresher: o.refresher,
      });
      out(g, recs, () =>
        recs.length
          ? recs.flatMap((r) => [
              `${c.bold(r.title)} ${c.dim(`[${r.trust}, ${r.depth}${r.versionScope ? `, ${r.versionScope}` : ""}]`)}`,
              `  ${r.url}`,
              `  ${r.why}`,
              c.dim(`  source: curated official link (not fetched)`),
            ])
          : "No recommendations yet: they follow from assessed gaps.",
      );
    });

  // ── reports ───────────────────────────────────────────────────────
  const report = program
    .command("report [kind]")
    .description("weekly or monthly report (observed evidence kept apart from estimates)")
    .option("--days <n>", "custom period length in days")
    .option("--out <file>", "write Markdown to a file")
    .option("--all-projects", "developer-wide only, not scoped to the current project")
    .action(async (kind: string | undefined, o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      const r0 = await svc.resolved(workFrom(g));
      const r = buildReport(await svc.store.read(), await svc.catalog(), {
        kind: kind === "monthly" ? "monthly" : kind === "weekly" || !kind ? "weekly" : "custom",
        now: svc.now(),
        days: o.days ? Number(o.days) : undefined,
        projectId: o.allProjects ? undefined : r0.project?.id,
        includeHealth: r0.config.learning.knowledge_health.enabled,
        dependencyInsights: r0.config.learning.knowledge_health.dependency_insights,
      });
      const md = reportToMarkdown(r);
      if (o.out) await atomicWrite(resolve(o.out), md);
      out(g, r, () => (o.out ? `Wrote ${o.out}` : md));
    });
  void report;

  // ── vault ─────────────────────────────────────────────────────────
  const vault = program.command("vault").description("Markdown / Obsidian knowledge vault");
  vault.command("sync").action(async (_o, cmd: Command) => {
    const g = globals(cmd);
    const r = await (await svcFor()).syncVault(workFrom(g));
    out(g, r, () =>
      "skipped" in r
        ? c.yellow(`Skipped: ${r.skipped}`)
        : [
            `Synced to ${r.root}: ${r.written.length} written, ${r.unchanged} unchanged.`,
            ...r.conflicts.map((x) => c.yellow(`  kept your note ${x.path}; wrote ${x.writtenTo}`)),
          ],
    );
  });
  vault.command("check").action(async (_o, cmd: Command) => {
    const g = globals(cmd);
    const svc = await svcFor();
    const t = svc.vaultTarget((await svc.resolved(workFrom(g))).config);
    if (!t) return out(g, { provider: "none" }, () => "Vault disabled (knowledge.provider: none).");
    const r = await checkVault(t);
    out(g, r, () => [
      `${r.ok ? c.green("OK") : c.red("Problem")} ${r.path}${r.isObsidianVault ? " (Obsidian vault)" : ""}`,
      ...r.problems.map((p) => c.red(`  ${p}`)),
      ...r.hints.map((h) => c.dim(`  ${h}`)),
    ]);
  });

  // ── data ──────────────────────────────────────────────────────────
  program
    .command("export")
    .description("export your learning data")
    .addOption(new Option("--format <f>", "format").choices(["json", "markdown"]).default("json"))
    .requiredOption("--out <path>", "file (json) or folder (markdown)")
    .action(async (o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      if (o.format === "json") {
        await atomicWrite(resolve(o.out), JSON.stringify(await svc.store.exportAll(), null, 2));
        return out(g, { written: o.out }, () => `Exported to ${o.out}`);
      }
      const r = await syncVault({
        db: await svc.store.read(),
        catalog: await svc.catalog(),
        target: { provider: "markdown", root: resolve(o.out), folder: "DeveloperKnowledge" },
        now: svc.now(),
      });
      out(g, r, () => `Exported ${r.written.length} Markdown notes to ${r.root}`);
    });
  program
    .command("backup")
    .option("--out <file>", "backup file path")
    .action(async (o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      const file = await createBackup(svc, o.out ? resolve(o.out) : undefined);
      out(g, { file }, () => `Backup written to ${file}`);
    });
  program
    .command("restore [file]")
    .description("restore from a backup (a safety backup of the current data is taken first)")
    .action(async (file: string | undefined, _o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      const target = file ? resolve(file) : (await listBackups(svc))[0];
      if (!target) throw new CliExit(EXIT.notFound, "No backup file given and none found.");
      if (!(await confirm(g, `Replace all current learning data with ${target}?`)))
        throw new CliExit(EXIT.needsConfirmation, "Cancelled.");
      const r = await restoreBackup(svc, target);
      out(g, r, () => `Restored from ${r.restoredFrom}. Previous data saved to ${r.safetyBackup}.`);
    });

  // ── integrations ──────────────────────────────────────────────────
  program
    .command("ingest")
    .description("manual event ingestion for agents without a native adapter")
    .option("--file <path>", "a JSON file with one event or an array of events")
    .option("--stdin", "read events from standard input")
    .option("--inbox", "import events integrations left in the inbox folder")
    .action(async (o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      const work = workFrom(g);
      if (o.inbox) {
        const r = await svc.drainInbox(work);
        return out(
          g,
          r,
          () =>
            `Imported ${r.processed} file(s); ${r.failed.length} failed; ${r.offers.length} learning offer(s).`,
        );
      }
      const text = o.file ? await readFile(resolve(o.file), "utf8") : o.stdin ? await readStdin() : undefined;
      if (!text) throw new CliExit(EXIT.usage, "Pass --file, --stdin or --inbox.");
      const payload = JSON.parse(text) as unknown;
      const results: Awaited<ReturnType<LearningService["ingest"]>>[] = [];
      for (const e of Array.isArray(payload) ? payload : [payload]) results.push(await svc.ingest(e, work));
      out(g, results, () =>
        results.map(
          (r) =>
            `${r.duplicate ? c.dim("duplicate") : c.green("ok")} ${r.taskId ?? ""} ${r.offer ? `→ ${r.offer.message} (dev-learning-ai assess --task ${r.taskId})` : (r.skipped ?? "")}`,
        ),
      );
    });

  program
    .command("agent")
    .description("integration protocol for coding agents (JSON request on stdin, JSON reply on stdout)")
    .command("rpc")
    .action(async () => {
      const svc = await svcFor();
      let reply;
      try {
        reply = await handleAgentRequest(svc, JSON.parse(await readStdin()));
      } catch (err) {
        reply = {
          ok: false,
          version: 1,
          error: { code: "invalid", message: `bad request: ${(err as Error).message}` },
        };
      }
      process.stdout.write(`${JSON.stringify(reply)}\n`);
    });

  program
    .command("adapters")
    .description("agent integrations and their verified status")
    .action(async (_o, cmd: Command) => {
      const g = globals(cmd);
      const list = [
        {
          id: "claude-code-mods",
          status: "implemented",
          detail:
            "Claude Code Mods (function hooks), verified against Claude Code 2.1.295 types; see integrations/claude-code",
        },
        {
          id: "manual-cli",
          status: "implemented",
          detail: "dev-learning-ai ingest --file/--stdin with the normalized event schema (docs/events.md)",
        },
        ...[
          "codex",
          "cursor",
          "gemini-cli",
          "github-copilot",
          "cline",
          "roo-code",
          "aider",
          "windsurf",
          "continue",
          "opencode",
        ].map((id) => ({
          id,
          status: "not implemented",
          detail: "use manual ingestion; adapter contributions welcome (docs/adapters.md)",
        })),
      ];
      out(g, list, () =>
        table(
          list.map((a) => [
            a.id,
            a.status === "implemented" ? c.green(a.status) : c.dim(a.status),
            c.dim(a.detail),
          ]),
          ["adapter", "status", ""],
        ),
      );
    });
  program
    .command("plugins")
    .description("enabled extensions and their permissions")
    .action(async (_o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      const r = await svc.resolved(workFrom(g));
      const loaded = await loadExtensions(svc, r.config, r.root ?? process.cwd());
      out(
        g,
        {
          ...loaded,
          exporters: loaded.exporters.map((e) => e.id),
          resourceProviders: loaded.resourceProviders.map((p) => p.id),
          permissions: r.config.plugins.permissions,
        },
        () =>
          r.config.plugins.enabled.length
            ? [
                ...loaded.loaded.map(
                  (l) =>
                    `${c.green("loaded")} ${l.id} ${l.version} ${c.dim(`permissions: ${(r.config.plugins.permissions[l.id] ?? []).join(", ") || "none"}`)}`,
                ),
                ...loaded.failed.map((f) => `${c.red("failed")} ${f.spec}: ${f.error}`),
              ]
            : "No extensions enabled (plugins.enabled).",
      );
    });

  program
    .command("doctor")
    .option("--check-agents", "also look for coding agents on PATH")
    .action(async (o, cmd: Command) => {
      const g = globals(cmd);
      const checks = await runDoctor(await svcFor(), workFrom(g), { checkAgents: o.checkAgents });
      out(g, checks, () =>
        checks.map(
          (x) =>
            `${x.status === "ok" ? c.green("✓") : x.status === "warn" ? c.yellow("!") : x.status === "fail" ? c.red("✗") : c.dim("·")} ${x.name.padEnd(36)} ${x.detail}${x.fix ? c.dim(`\n    fix: ${x.fix}`) : ""}`,
        ),
      );
      if (checks.some((x) => x.status === "fail")) process.exitCode = EXIT.error;
    });

  program
    .command("dashboard")
    .description("open the local dashboard (loopback only by default)")
    .option("--port <port>", "port (default: auto)")
    .option("--no-open", "do not print the open hint")
    .action(async (o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      const { startDashboard } = await import("@dev-learning-ai/dashboard");
      const r = await svc.resolved(workFrom(g));
      if (!r.config.dashboard.enabled)
        throw new CliExit(EXIT.usage, "The dashboard is disabled (dashboard.enabled: false).");
      const server = await startDashboard(svc, {
        host: r.config.dashboard.host,
        port: o.port ? Number(o.port) : r.config.dashboard.port === "auto" ? 0 : r.config.dashboard.port,
        cwd: workFrom(g).cwd,
      });
      out(g, { url: server.url }, () => [
        c.green(`Dashboard running at ${server.url}`),
        c.dim("The link carries a one-time access token. Press Ctrl+C to stop."),
      ]);
      const stop = async () => {
        await server.close();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });

  program
    .command("uninstall")
    .description("explain and perform removal steps (nothing is deleted without confirmation)")
    .option("--integration", "remove the Claude Code mod registration (prints the command)")
    .option("--project-registration <id>", "unregister a project (keeps history)")
    .option("--caches", "delete local caches")
    .option("--all-data", "delete ALL learning history, configuration and backups in the data directory")
    .action(async (o, cmd: Command) => {
      const g = globals(cmd);
      const svc = await svcFor();
      const { rm } = await import("node:fs/promises");
      const did: string[] = [];
      if (!o.integration && !o.projectRegistration && !o.caches && !o.allData) {
        return out(
          g,
          { steps: ["--integration", "--project-registration <id>", "--caches", "--all-data"] },
          () => [
            c.bold("Uninstall options (each is separate):"),
            "  Remove the Claude Code integration:  dev-learning-ai uninstall --integration",
            "  Remove the CLI:                      npm uninstall -g dev-learning-ai",
            "  Unregister a project (keeps data):   dev-learning-ai uninstall --project-registration <id>",
            "  Delete local caches:                 dev-learning-ai uninstall --caches",
            "  Delete ALL learning history:         dev-learning-ai uninstall --all-data",
            "  Remove files in a repository:        delete its .dev-learning-ai/ folder",
            c.dim(
              `Your knowledge vault is never deleted by these commands. Data directory: ${svc.paths.home}`,
            ),
          ],
        );
      }
      if (o.integration)
        did.push(
          "Run in a terminal: claude plugin uninstall dev-learning-ai  (this tool does not edit agent configuration itself)",
        );
      if (o.projectRegistration) {
        await removeProject(svc.store, o.projectRegistration);
        did.push(`Unregistered ${o.projectRegistration} (history kept).`);
      }
      if (o.caches) {
        await rm(svc.paths.cache, { recursive: true, force: true });
        did.push("Deleted caches.");
      }
      if (o.allData) {
        if (
          !(await confirm(
            g,
            `Permanently delete everything in ${svc.paths.home} (learning history, configuration, backups)? Your vault is not touched.`,
          ))
        ) {
          throw new CliExit(EXIT.needsConfirmation, "Cancelled.");
        }
        await rm(svc.paths.home, { recursive: true, force: true });
        did.push(`Deleted ${svc.paths.home}.`);
      }
      out(g, { done: did }, () => did);
    });

  program
    .command("concepts [technology]")
    .description("list known concepts and their ids")
    .action(async (tech: string | undefined, _o, cmd: Command) => {
      const g = globals(cmd);
      const catalog: ConceptCatalog = await (await svcFor()).catalog();
      const list = catalog.all().filter((x) => x.parent && (!tech || x.technology === tech));
      out(g, list, () =>
        table(
          list.map((x) => [x.id, x.label, describeScope(x.versionScope)]),
          ["id", "concept", "scope"],
        ),
      );
    });

  program
    .command("completion")
    .description("print a bash/zsh completion script")
    .action(() => {
      const cmds = program.commands.map((x) => x.name()).join(" ");
      process.stdout.write(
        `# dev-learning-ai completion (bash/zsh): eval "$(dev-learning-ai completion)"\n_dla() { COMPREPLY=($(compgen -W "${cmds}" -- "\${COMP_WORDS[1]}")); }\ncomplete -F _dla dev-learning-ai dla\n`,
      );
    });

  void getPath;
  return program;
}

/**
 * Records where this CLI and its Node.js runtime live (`<data>/cli.json`), so
 * agent integrations can run it by absolute path. Apps such as the Claude
 * desktop app often have a different PATH from your terminal. Best effort.
 */
export async function recordLocation(home = resolveHome()): Promise<void> {
  try {
    const bin = argvBinPath();
    if (!bin) return;
    const record = JSON.stringify({ node: process.execPath, bin, version: VERSION });
    const file = join(home, "cli.json");
    if ((await readFile(file, "utf8").catch(() => "")) === record) return;
    await mkdir(home, { recursive: true });
    await atomicWrite(file, record);
  } catch {
    /* never fail a command over this */
  }
}

function argvBinPath(): string | undefined {
  const script = process.argv[1];
  if (!script || !/bin\.(js|ts)$/.test(script)) return undefined;
  try {
    return realpathSync(script);
  } catch {
    return resolve(script);
  }
}

export async function main(argv: string[]): Promise<number> {
  await recordLocation();
  const program = buildProgram();
  program.exitOverride();
  try {
    await program.parseAsync(argv);
    return typeof process.exitCode === "number" ? process.exitCode : EXIT.ok;
  } catch (err) {
    const e = err as { code?: string; exitCode?: number };
    if (e.code === "commander.helpDisplayed" || e.code === "commander.version" || e.code === "commander.help")
      return EXIT.ok;
    if (typeof e.code === "string" && e.code.startsWith("commander.")) return EXIT.usage;
    const json = argv.includes("--json");
    const report = (code: number, message: string) => {
      if (json) process.stdout.write(`${JSON.stringify({ error: { code, message } })}\n`);
      else process.stderr.write(`${c.red("error")} ${message}\n`);
      return code;
    };
    if (err instanceof CliExit) return report(err.code, err.message);
    if (err instanceof ConfigError) return report(EXIT.usage, err.message);
    if (err instanceof ServiceError) {
      return report(
        err.code === "not-found"
          ? EXIT.notFound
          : err.code === "unavailable" || err.code === "disabled"
            ? EXIT.unavailable
            : EXIT.error,
        err.message,
      );
    }
    return report(
      EXIT.error,
      (err as Error).stack && process.env.DEV_LEARNING_AI_DEBUG
        ? (err as Error).stack!
        : (err as Error).message,
    );
  } finally {
    closePrompts();
  }
}
