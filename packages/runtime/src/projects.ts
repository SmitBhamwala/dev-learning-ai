import { rm } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { newId, scopeKey, type Project } from "@dev-learning-ai/core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { discoverTechnologies } from "./discovery.js";
import { atomicWrite, exists, readTextFile } from "./fsutil.js";
import { canonicalPath, findRepoRoot, readGitInfo } from "./git.js";
import { PROJECT_FILE, projectDir } from "./paths.js";
import type { Database, Store } from "./store.js";

/**
 * Project identity and registration.
 *
 * - The stable id lives in `<repo>/.dev-learning-ai/project.yaml` (safe to
 *   commit; it holds no personal data) and in the global database. It never
 *   depends on the absolute path or the repository name.
 * - A path is canonicalised (symlinks, case of drive letters) before
 *   comparison, so one checkout is never registered twice.
 * - Git worktrees of the same repository share a project automatically.
 * - A second checkout carrying an id that is already registered elsewhere
 *   (a clone, a fork, a copy) is only joined to that project when a remote
 *   matches or the user says so; otherwise registration stops and asks.
 *   `--new-project` gives the checkout its own id in a local, uncommitted file.
 * - Removing a registration keeps learning history; deleting data is separate
 *   and explicit.
 */

export class ProjectIdentityConflict extends Error {
  constructor(
    message: string,
    readonly existing: Project,
    readonly path: string,
  ) {
    super(message);
    this.name = "ProjectIdentityConflict";
  }
}

interface ProjectFile {
  id: string;
  name?: string;
  product_group?: string;
}

const LOCAL_IDENTITY = join("local-state", "identity.yaml");

async function readProjectFile(root: string): Promise<{ file?: ProjectFile; local?: ProjectFile }> {
  const read = async (p: string) => {
    const text = await readTextFile(p);
    if (!text) return undefined;
    const doc = parseYaml(text) as ProjectFile | null;
    return doc && typeof doc.id === "string" ? doc : undefined;
  };
  return {
    file: await read(join(projectDir(root), PROJECT_FILE)),
    local: await read(join(projectDir(root), LOCAL_IDENTITY)),
  };
}

export interface RegisterOptions {
  name?: string;
  productGroup?: string;
  /** Write .dev-learning-ai/project.yaml into the repository (default true). */
  writeProjectFile?: boolean;
  /** Resolve an identity conflict: join the existing project, or create a new one. */
  identity?: "same" | "new";
  now?: Date;
}

export interface RegisterResult {
  project: Project;
  created: boolean;
  root: string;
  wroteFiles: string[];
  notes: string[];
}

export async function locateRoot(path: string): Promise<string> {
  return (await findRepoRoot(path)) ?? (await canonicalPath(path));
}

export async function registerProject(
  store: Store,
  path: string,
  opts: RegisterOptions = {},
): Promise<RegisterResult> {
  const now = (opts.now ?? new Date()).toISOString();
  const root = await locateRoot(path);
  const git = await readGitInfo(root);
  const ids = await readProjectFile(root);
  const declared = ids.local ?? ids.file;
  const discovery = await discoverTechnologies(root);
  const notes: string[] = [...discovery.notes];
  const wroteFiles: string[] = [];

  const db = await store.read();
  const all = Object.values(db.projects);
  let target: Project | undefined = all.find((p) => p.paths.includes(root));
  let created = false;

  if (!target && declared) {
    const existing = db.projects[declared.id];
    if (existing) {
      const livePaths = [];
      for (const p of existing.paths) if (await exists(p)) livePaths.push(p);
      const remotesOverlap = git?.remotes.some((r) => existing.remotes.includes(r)) ?? false;
      const sameRepo = await sharesGitDir(existing.paths, git?.commonDir);
      if (opts.identity === "new") {
        target = undefined;
      } else if (livePaths.length === 0) {
        notes.push(`Project moved: ${existing.paths.join(", ")} → ${root}`);
        target = { ...existing, paths: [root] };
      } else if (opts.identity === "same" || sameRepo || remotesOverlap) {
        notes.push(
          sameRepo
            ? "Git worktree of an already registered repository."
            : "Another checkout of an already registered repository.",
        );
        target = { ...existing, paths: [...existing.paths, root] };
      } else {
        throw new ProjectIdentityConflict(
          `This checkout carries project id ${declared.id} ("${existing.name}"), which is registered at ${existing.paths[0]}, ` +
            "and no git remote matches. If it is the same project (a clone), re-run with --same-project. " +
            "If it is a fork or an unrelated copy, re-run with --new-project to give it its own identity.",
          existing,
          root,
        );
      }
    }
  }
  if (!target && !declared && git) {
    // A worktree without the project file (not yet committed) still belongs to its repository.
    for (const p of all) {
      if (await sharesGitDir(p.paths, git.commonDir)) {
        target = { ...p, paths: [...p.paths, root] };
        notes.push("Git worktree of an already registered repository.");
        break;
      }
    }
  }
  if (!target) {
    const id = opts.identity === "new" || !declared || db.projects[declared.id] ? newId("prj") : declared.id;
    created = true;
    target = {
      id,
      name: opts.name ?? declared?.name ?? basename(root),
      paths: [root],
      remotes: git?.remotes ?? [],
      productGroup: opts.productGroup ?? declared?.product_group,
      isMonorepo: discovery.isMonorepo,
      workspaces: [],
      technologies: [],
      registeredAt: now,
      updatedAt: now,
      status: "active",
      excludedFromLearning: false,
    };
    if (opts.writeProjectFile !== false) {
      const isLocal = Boolean(declared);
      const file = join(projectDir(root), isLocal ? LOCAL_IDENTITY : PROJECT_FILE);
      const body: ProjectFile = {
        id,
        name: target.name,
        ...(target.productGroup ? { product_group: target.productGroup } : {}),
      };
      await atomicWrite(
        file,
        `# dev-learning-ai project identity. ${isLocal ? "Local to this checkout; do not commit." : "Safe to commit: contains no personal data."}\n${stringifyYaml(body)}`,
      );
      wroteFiles.push(file);
      if (isLocal) {
        const ignore = join(projectDir(root), ".gitignore");
        if (!(await exists(ignore))) {
          await atomicWrite(ignore, "local-state/\n");
          wroteFiles.push(ignore);
        }
      }
    }
  }

  const project: Project = {
    ...target,
    name: opts.name ?? target.name,
    productGroup: opts.productGroup ?? target.productGroup,
    remotes: [...new Set([...(target.remotes ?? []), ...(git?.remotes ?? [])])],
    isMonorepo: discovery.isMonorepo,
    workspaces: discovery.workspaces.map((w) => ({
      name: w.name,
      path: w.path,
      technologies: discovery.technologies.filter((t) => t.workspace === w.path).map((t) => t.technology),
    })),
    technologies: mergeUserCorrections(target.technologies ?? [], discovery.technologies),
    status: "active",
    updatedAt: now,
  };
  await store.transact((d) => {
    d.projects[project.id] = project;
    d.meta.activeProjectId ??= project.id;
  });
  return { project, created, root, wroteFiles, notes };
}

/** User-corrected facts survive re-discovery. */
function mergeUserCorrections(
  prev: Project["technologies"],
  fresh: Project["technologies"],
): Project["technologies"] {
  const corrected = prev.filter((t) => t.correctedByUser);
  const keep = fresh.filter(
    (f) => !corrected.some((c) => c.technology === f.technology && c.workspace === f.workspace),
  );
  return [...corrected, ...keep];
}

async function sharesGitDir(paths: string[], commonDir: string | undefined): Promise<boolean> {
  if (!commonDir) return false;
  for (const p of paths) {
    const info = await readGitInfo(p);
    if (info && info.commonDir === commonDir) return true;
  }
  return false;
}

export async function findProjectForPath(
  db: Database,
  path: string,
): Promise<{ project: Project; root: string; workspace?: string } | undefined> {
  const root = await locateRoot(path);
  const project = Object.values(db.projects).find((p) => p.status === "active" && p.paths.includes(root));
  if (!project) return undefined;
  const cwd = await canonicalPath(path);
  const rel = relative(root, cwd).replace(/\\/g, "/");
  const workspace = project.workspaces
    .filter((w) => rel === w.path || rel.startsWith(`${w.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]?.path;
  return { project, root, workspace };
}

export async function setTechnologyFact(
  store: Store,
  projectId: string,
  technology: string,
  version: string | undefined,
): Promise<Project> {
  return store.transact((db) => {
    const p = db.projects[projectId];
    if (!p) throw new Error(`No project ${projectId}`);
    const now = new Date().toISOString();
    const others = p.technologies.filter((t) => !(t.technology === technology && !t.workspace));
    p.technologies = [
      ...others,
      {
        technology,
        version,
        provenance: [{ source: "user", confidence: 1, detectedAt: now, detail: "corrected by the user" }],
        correctedByUser: true,
      },
    ];
    p.updatedAt = now;
    return p;
  });
}

/** Unregisters a project but keeps all learning history (it can be re-registered later). */
export async function removeProject(store: Store, projectId: string): Promise<Project> {
  return store.transact((db) => {
    const p = db.projects[projectId];
    if (!p) throw new Error(`No project ${projectId}`);
    p.status = "removed";
    p.updatedAt = new Date().toISOString();
    if (db.meta.activeProjectId === projectId) db.meta.activeProjectId = undefined;
    return p;
  });
}

/** Deletes project-scoped learning data. Developer-wide (global) knowledge is untouched. */
export async function deleteProjectData(
  store: Store,
  projectId: string,
  opts: { removeRepoFiles?: boolean } = {},
) {
  const key = scopeKey({ kind: "project", projectId });
  const counts = await store.transact((db) => {
    const c = { knowledge: 0, evidence: 0, sessions: 0, tasks: 0, concepts: 0, events: 0, changes: 0 };
    for (const [k, v] of Object.entries(db.knowledge))
      if (scopeKey(v.scope) === key) delete db.knowledge[k], c.knowledge++;
    for (const [k, v] of Object.entries(db.evidence)) {
      if (scopeKey(v.scope) === key) {
        delete db.evidence[k];
        delete db.evidenceKeys[v.key];
        c.evidence++;
      }
    }
    const before = db.changes.length;
    db.changes = db.changes.filter((ch) => scopeKey(ch.scope) !== key);
    c.changes = before - db.changes.length;
    for (const [k, v] of Object.entries(db.sessions))
      if (v.projectId === projectId) delete db.sessions[k], c.sessions++;
    for (const [k, v] of Object.entries(db.tasks))
      if (v.projectId === projectId) delete db.tasks[k], c.tasks++;
    for (const [k, v] of Object.entries(db.events))
      if (v.projectId === projectId) delete db.events[k], c.events++;
    for (const [k, v] of Object.entries(db.concepts))
      if (v.projectId === projectId) delete db.concepts[k], c.concepts++;
    const p = db.projects[projectId];
    delete db.projects[projectId];
    if (db.meta.activeProjectId === projectId) db.meta.activeProjectId = undefined;
    return { ...c, paths: p?.paths ?? [] };
  });
  if (opts.removeRepoFiles)
    for (const p of counts.paths) await rm(projectDir(p), { recursive: true, force: true });
  return counts;
}
