import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { FactProvenance, TechnologyFact } from "@dev-learning-ai/core";
import { parse as parseYaml } from "yaml";
import { exists, readJsonFile, readTextFile } from "./fsutil.js";

/**
 * Technology and version discovery from repository evidence. Lockfiles give
 * verified resolved versions; manifests give declared ranges; syntax is never
 * used to guess an exact version. Every fact records provenance and confidence.
 */

const NPM_TECH: Record<string, string> = {
  react: "react",
  "react-dom": "react",
  next: "nextjs",
  "@angular/core": "angular",
  vue: "vue",
  svelte: "svelte",
  typescript: "typescript",
  express: "express",
  fastify: "fastify",
  "@nestjs/core": "nestjs",
  prisma: "prisma",
  "@prisma/client": "prisma",
  pg: "postgresql",
  postgres: "postgresql",
  mysql2: "mysql",
  mongodb: "mongodb",
  mongoose: "mongodb",
  redis: "redis",
  ioredis: "redis",
  graphql: "graphql",
  jest: "testing",
  vitest: "testing",
  mocha: "testing",
  "@playwright/test": "testing",
  jsonwebtoken: "security",
  jose: "security",
};

/** Technologies that are concept families rather than versioned products. */
const FAMILY_TECH = new Set(["testing", "security", "http", "sql"]);

/** One entry per technology for display: the root-level fact wins, versions only when verified. */
export function summarizeTechnologies(facts: TechnologyFact[]): string {
  const byTech = new Map<string, TechnologyFact>();
  for (const f of facts) {
    const prev = byTech.get(f.technology);
    if (!prev || (prev.workspace && !f.workspace) || (!prev.version && f.version))
      byTech.set(f.technology, f);
  }
  return [...byTech.values()].map((t) => `${t.technology}${t.version ? ` ${t.version}` : ""}`).join(", ");
}

const PY_TECH: Record<string, string> = {
  django: "django",
  flask: "flask",
  fastapi: "fastapi",
  sqlalchemy: "sql",
  psycopg: "postgresql",
  psycopg2: "postgresql",
  pytest: "testing",
};

export interface WorkspaceInfo {
  name: string;
  path: string;
}

export interface DiscoveryResult {
  technologies: TechnologyFact[];
  isMonorepo: boolean;
  workspaces: WorkspaceInfo[];
  packageManager?: string;
  notes: string[];
}

function prov(
  source: FactProvenance["source"],
  file: string,
  confidence: number,
  detail?: string,
): FactProvenance {
  return { source, file, confidence, detail, detectedAt: new Date().toISOString() };
}

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  packageManager?: string;
}

/** Resolved versions from lockfiles: package name → version. */
async function lockfileVersions(
  root: string,
): Promise<{ file: string; versions: Map<string, string> } | undefined> {
  const npmLock = await readJsonFile<{
    packages?: Record<string, { version?: string }>;
    dependencies?: Record<string, { version?: string }>;
  }>(join(root, "package-lock.json"));
  if (npmLock) {
    const versions = new Map<string, string>();
    for (const [k, v] of Object.entries(npmLock.packages ?? {})) {
      const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(k);
      if (m && v.version) versions.set(m[1]!, v.version);
    }
    for (const [k, v] of Object.entries(npmLock.dependencies ?? {}))
      if (v.version && !versions.has(k)) versions.set(k, v.version);
    return { file: "package-lock.json", versions };
  }
  const pnpm = await readTextFile(join(root, "pnpm-lock.yaml"));
  if (pnpm) {
    const versions = new Map<string, string>();
    try {
      const doc = parseYaml(pnpm) as {
        importers?: Record<string, Record<string, Record<string, { version?: string } | string>>>;
        dependencies?: Record<string, { version?: string } | string>;
      };
      const collect = (deps?: Record<string, { version?: string } | string>) => {
        for (const [name, v] of Object.entries(deps ?? {})) {
          const raw = typeof v === "string" ? v : v.version;
          const ver = raw ? /^(\d+\.\d+\.\d+[^(\s]*)/.exec(raw)?.[1] : undefined;
          if (ver && !versions.has(name)) versions.set(name, ver);
        }
      };
      for (const imp of Object.values(doc.importers ?? {})) {
        collect(imp.dependencies as Record<string, { version?: string }>);
        collect(imp.devDependencies as Record<string, { version?: string }>);
      }
      collect(doc.dependencies);
    } catch {
      return undefined;
    }
    return { file: "pnpm-lock.yaml", versions };
  }
  const yarn = await readTextFile(join(root, "yarn.lock"));
  if (yarn) {
    const versions = new Map<string, string>();
    const re = /^"?((?:@[^@/\s"]+\/)?[^@\s",]+)@[^\n]*\n\s+version:?\s+"?([^"\n]+)"?/gm;
    for (const m of yarn.matchAll(re)) if (!versions.has(m[1]!)) versions.set(m[1]!, m[2]!);
    return { file: "yarn.lock", versions };
  }
  return undefined;
}

async function expandWorkspaceGlobs(root: string, patterns: string[]): Promise<WorkspaceInfo[]> {
  const out: WorkspaceInfo[] = [];
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) continue;
    const clean = pattern.replace(/\/\*\*?$/, "").replace(/\/$/, "");
    const isGlob = /\/\*\*?$/.test(pattern);
    const dirs: string[] = [];
    if (isGlob) {
      try {
        for (const e of await readdir(join(root, clean), { withFileTypes: true }))
          if (e.isDirectory()) dirs.push(join(clean, e.name));
      } catch {
        /* missing folder */
      }
    } else dirs.push(clean);
    for (const d of dirs) {
      const pkg = await readJsonFile<PackageJson>(join(root, d, "package.json"));
      if (pkg) out.push({ name: pkg.name ?? d, path: d.replace(/\\/g, "/") });
    }
  }
  return out;
}

export async function discoverTechnologies(root: string): Promise<DiscoveryResult> {
  const facts = new Map<string, TechnologyFact>();
  const notes: string[] = [];
  const add = (
    tech: string,
    p: FactProvenance,
    version?: string,
    declaredRange?: string,
    workspace?: string,
  ) => {
    const key = workspace ? `${tech}@${workspace}` : tech;
    const prev = facts.get(key);
    if (prev) {
      prev.provenance.push(p);
      if (version && !prev.version) prev.version = version;
      if (declaredRange && !prev.declaredRange) prev.declaredRange = declaredRange;
    } else {
      facts.set(key, {
        technology: tech,
        version,
        declaredRange,
        workspace,
        provenance: [p],
        correctedByUser: false,
      });
    }
  };

  const pkg = await readJsonFile<PackageJson>(join(root, "package.json"));
  let workspaces: WorkspaceInfo[] = [];
  let isMonorepo = false;
  let packageManager: string | undefined;
  const lock = await lockfileVersions(root);
  if (pkg) {
    add("javascript", prov("manifest", "package.json", 1));
    packageManager =
      pkg.packageManager?.split("@")[0] ??
      (lock?.file === "pnpm-lock.yaml"
        ? "pnpm"
        : lock?.file === "yarn.lock"
          ? "yarn"
          : lock
            ? "npm"
            : undefined);
    const scan = async (manifest: PackageJson, file: string, workspace?: string) => {
      const deps = { ...manifest.peerDependencies, ...manifest.devDependencies, ...manifest.dependencies };
      for (const [name, range] of Object.entries(deps)) {
        const tech = NPM_TECH[name];
        if (!tech) continue;
        // Concept families (testing, security) take no version: the version belongs to the library.
        const resolved = FAMILY_TECH.has(tech) ? undefined : lock?.versions.get(name);
        if (resolved)
          add(tech, prov("lockfile", lock!.file, 1, `${name}@${resolved}`), resolved, range, workspace);
        else
          add(
            tech,
            prov("manifest", file, 0.7, `${name}: ${range} (declared range, not a verified version)`),
            undefined,
            FAMILY_TECH.has(tech) ? undefined : range,
            workspace,
          );
      }
      if (manifest.engines?.node)
        add(
          "nodejs",
          prov("manifest", file, 0.6, `engines.node ${manifest.engines.node}`),
          undefined,
          manifest.engines.node,
          workspace,
        );
    };
    await scan(pkg, "package.json");
    const wsPatterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
    const pnpmWs = await readTextFile(join(root, "pnpm-workspace.yaml"));
    if (pnpmWs) {
      try {
        wsPatterns.push(...((parseYaml(pnpmWs) as { packages?: string[] })?.packages ?? []));
      } catch {
        notes.push("pnpm-workspace.yaml could not be parsed");
      }
    }
    if (wsPatterns.length) {
      workspaces = await expandWorkspaceGlobs(root, wsPatterns);
      isMonorepo = workspaces.length > 0;
      for (const ws of workspaces) {
        const wpkg = await readJsonFile<PackageJson>(join(root, ws.path, "package.json"));
        if (wpkg) await scan(wpkg, `${ws.path}/package.json`, ws.path);
      }
    }
  }
  for (const f of ["lerna.json", "nx.json", "turbo.json", "rush.json"]) {
    if (await exists(join(root, f))) {
      isMonorepo = true;
      notes.push(`monorepo tooling detected: ${f}`);
    }
  }
  if (await exists(join(root, "tsconfig.json"))) add("typescript", prov("config", "tsconfig.json", 0.9));
  for (const f of [".nvmrc", ".node-version"]) {
    const v = (await readTextFile(join(root, f)))?.trim();
    if (v)
      add(
        "nodejs",
        prov("runtime", f, 0.9, `pinned runtime ${v}`),
        /^\d/.test(v.replace(/^v/, "")) ? v.replace(/^v/, "") : undefined,
      );
  }
  if (await exists(join(root, "Dockerfile"))) add("docker", prov("config", "Dockerfile", 1));
  for (const f of ["docker-compose.yml", "docker-compose.yaml", "compose.yaml", "compose.yml"]) {
    if (await exists(join(root, f))) add("docker", prov("config", f, 1));
  }
  const prisma = await readTextFile(join(root, "prisma", "schema.prisma"));
  if (prisma) {
    add("prisma", prov("config", "prisma/schema.prisma", 1));
    const provider = /provider\s*=\s*"(postgresql|mysql|sqlite|mongodb|sqlserver)"/.exec(prisma)?.[1];
    if (provider)
      add(
        provider === "sqlserver" ? "sql" : provider,
        prov("config", "prisma/schema.prisma", 0.9, `datasource provider ${provider}`),
      );
    add("sql", prov("config", "prisma/schema.prisma", 0.8));
  }
  for (const d of ["migrations", "db/migrations", "database/migrations"]) {
    if (await exists(join(root, d))) add("sql", prov("config", d, 0.7, "migrations folder"));
  }
  const pyproject = await readTextFile(join(root, "pyproject.toml"));
  const requirements = await readTextFile(join(root, "requirements.txt"));
  if (pyproject || requirements) {
    add("python", prov("manifest", pyproject ? "pyproject.toml" : "requirements.txt", 1));
    const text = `${pyproject ?? ""}\n${requirements ?? ""}`.toLowerCase();
    for (const [name, tech] of Object.entries(PY_TECH)) {
      const m = new RegExp(`(^|["'\\s])${name}\\s*(==|>=|~=|<|\\[|"|'|\\s|$)([\\d.]*)`, "m").exec(text);
      if (m)
        add(
          tech,
          prov("manifest", pyproject ? "pyproject.toml" : "requirements.txt", m[2] === "==" ? 0.9 : 0.6),
          m[2] === "==" ? m[3] : undefined,
          m[3] ? `${m[2]}${m[3]}` : undefined,
        );
    }
  }
  const gomod = await readTextFile(join(root, "go.mod"));
  if (gomod) {
    const v = /^go\s+(\d+\.\d+(?:\.\d+)?)/m.exec(gomod)?.[1];
    add("go", prov("manifest", "go.mod", 1, v ? `go directive ${v}` : undefined), undefined, v);
  }
  if (await exists(join(root, "Cargo.toml"))) add("rust", prov("manifest", "Cargo.toml", 1));
  if (await exists(join(root, "pom.xml"))) add("java", prov("manifest", "pom.xml", 1));
  if ((await exists(join(root, "build.gradle"))) || (await exists(join(root, "build.gradle.kts"))))
    add("java", prov("manifest", "build.gradle", 0.9));

  // Concept families that apply to most backends once their signals exist.
  if (
    facts.has("express") ||
    facts.has("fastify") ||
    facts.has("nestjs") ||
    facts.has("fastapi") ||
    facts.has("django") ||
    facts.has("flask")
  ) {
    add("http", prov("inferred", "dependencies", 0.8, "web framework present"));
  }
  return {
    technologies: [...facts.values()].sort((a, b) => a.technology.localeCompare(b.technology)),
    isMonorepo,
    workspaces,
    packageManager,
    notes,
  };
}

export function relativeTo(root: string, p: string): string {
  return relative(root, p).replace(/\\/g, "/");
}
