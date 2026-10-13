import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostModelProvider, ProviderRegistry, type AIProvider } from "@dev-learning-ai/core";
import { LearningService } from "@dev-learning-ai/runtime";
import { FakeModelProvider } from "../../core/test/fixtures/fake-provider.js";

export async function tempDir(prefix = "dla-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, content);
  }
}

/** A minimal git repository on disk (no git binary needed): .git/HEAD and .git/config with a remote. */
export async function fakeRepo(
  root: string,
  opts: { remote?: string; react?: string; name?: string } = {},
): Promise<string> {
  await writeFiles(root, {
    ".git/HEAD": "ref: refs/heads/main\n",
    ".git/config": `[core]\n\trepositoryformatversion = 0\n${opts.remote ? `[remote "origin"]\n\turl = ${opts.remote}\n` : ""}`,
    "package.json": JSON.stringify({
      name: opts.name ?? "app",
      dependencies: { react: `^${opts.react ?? "18.3.1"}`, "react-dom": `^${opts.react ?? "18.3.1"}` },
      devDependencies: { typescript: "^5.8.3", vitest: "^3.2.4" },
    }),
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/react": { version: opts.react ?? "18.3.1" },
        "node_modules/react-dom": { version: opts.react ?? "18.3.1" },
        "node_modules/typescript": { version: "5.8.3" },
      },
    }),
    "tsconfig.json": "{}",
    "src/index.ts": "export {};\n",
  });
  return root;
}

export async function openService(
  home: string,
  extra: AIProvider[] = [new FakeModelProvider()],
  now?: () => Date,
) {
  const registry = new ProviderRegistry([new HostModelProvider(), ...extra]);
  return LearningService.open({ home, registry, env: {}, now });
}

export function taskEvent(o: {
  taskId: string;
  type?: string;
  root?: string;
  paths?: string[];
  symbols?: string[];
  lines?: number;
  id?: string;
  sessionId?: string;
}) {
  return {
    id: o.id ?? `${o.taskId}-${o.type ?? "task.completed"}`,
    schemaVersion: 1,
    type: o.type ?? "task.completed",
    timestamp: new Date().toISOString(),
    source: { providerId: "test-agent", sessionId: o.sessionId ?? "agent-session-1" },
    developerId: "dev",
    repository: o.root ? { root: o.root } : undefined,
    task: { id: o.taskId, title: "Fix the form submit race", status: "completed" },
    changes: (o.paths ?? ["src/components/Form.tsx"]).map((path) => ({
      path,
      kind: "modified",
      linesAdded: o.lines ?? 40,
      symbols: o.symbols ?? ["useEffect", "Promise.allSettled", "AbortController"],
    })),
  };
}

export { FakeModelProvider };
