import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Git metadata read directly from the repository files (no shell commands).
 * Remotes and branches are identity *hints*, never identity on their own.
 */

export interface GitInfo {
  root: string;
  gitDir: string;
  commonDir: string;
  isWorktree: boolean;
  branch?: string;
  remotes: string[];
}

export async function canonicalPath(p: string): Promise<string> {
  const abs = resolve(p);
  try {
    const real = await realpath(abs);
    return process.platform === "win32" ? real.replace(/^[a-z]:/, (d) => d.toUpperCase()) : real;
  } catch {
    return abs;
  }
}

export async function findRepoRoot(start: string): Promise<string | undefined> {
  let dir = await canonicalPath(start);
  for (;;) {
    try {
      await stat(join(dir, ".git"));
      return dir;
    } catch {
      /* keep walking */
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function readGitInfo(root: string): Promise<GitInfo | undefined> {
  const dotGit = join(root, ".git");
  let gitDir = dotGit;
  let isWorktree = false;
  try {
    const s = await stat(dotGit);
    if (s.isFile()) {
      const content = await readFile(dotGit, "utf8");
      const m = /gitdir:\s*(.+)\s*$/m.exec(content);
      if (!m) return undefined;
      gitDir = isAbsolute(m[1]!.trim()) ? m[1]!.trim() : resolve(root, m[1]!.trim());
      isWorktree = true;
    }
  } catch {
    return undefined;
  }
  let commonDir = gitDir;
  try {
    const c = (await readFile(join(gitDir, "commondir"), "utf8")).trim();
    commonDir = isAbsolute(c) ? c : resolve(gitDir, c);
  } catch {
    /* not a linked worktree */
  }
  let branch: string | undefined;
  try {
    const head = (await readFile(join(gitDir, "HEAD"), "utf8")).trim();
    branch = /^ref: refs\/heads\/(.+)$/.exec(head)?.[1];
  } catch {
    /* detached or unreadable */
  }
  const remotes: string[] = [];
  try {
    const config = await readFile(join(commonDir, "config"), "utf8");
    for (const m of config.matchAll(/^\s*url\s*=\s*(.+)\s*$/gm)) remotes.push(normalizeRemote(m[1]!.trim()));
  } catch {
    /* no config */
  }
  return {
    root,
    gitDir,
    commonDir: await canonicalPath(commonDir),
    isWorktree,
    branch,
    remotes: [...new Set(remotes)],
  };
}

/** Normalises remote URLs so ssh and https spellings of one repository compare equal. Credentials are stripped. */
export function normalizeRemote(url: string): string {
  let u = url
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(u);
  if (scp) return `${scp[1]!.toLowerCase()}/${scp[2]}`;
  try {
    const parsed = new URL(u);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname}`.replace(/\/$/, "");
  } catch {
    u = u.replace(/^[a-z]+:\/\//i, "").replace(/^[^@/]+@/, "");
    return u;
  }
}
