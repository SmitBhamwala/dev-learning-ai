import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ConfigSchema,
  ConfigValidationError,
  coerceValue,
  diffConfigs,
  isKnownPath,
  isSensitiveKey,
  newId,
  resolveConfig,
  setPath,
  getPath,
  parseConfigIntent,
  type ConfigDiffEntry,
  type ConfigLayers,
  type ConfigOperation,
  type RawLayer,
  type ResolvedConfig,
} from "@dev-learning-ai/core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { atomicWrite, ensureDir, readTextFile, withLock } from "./fsutil.js";
import { PROJECT_CONFIG_FILE, projectDir, type GlobalPaths } from "./paths.js";
import type { Store } from "./store.js";

export type WritableLayer = "global" | "project" | "workspace" | "session";
export type ConfigActor = "cli" | "dashboard" | "ai-assisted" | "setup" | "mod" | "rollback";

export interface ConfigContext {
  projectRoot?: string;
  workspacePath?: string;
  sessionId?: string;
}

export interface ConfigHistoryEntry {
  id: string;
  at: string;
  actor: ConfigActor;
  layer: WritableLayer;
  target: string;
  diff: ConfigDiffEntry[];
  note?: string;
  snapshot: string;
}

export interface ConfigChangeResult {
  applied: boolean;
  diff: ConfigDiffEntry[];
  needsConfirmation: boolean;
  messages: string[];
  historyId?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function parseLayer(text: string | undefined, file: string): RawLayer {
  if (!text || !text.trim()) return {};
  const doc = parseYaml(text) as unknown;
  if (doc === null || doc === undefined) return {};
  if (typeof doc !== "object" || Array.isArray(doc))
    throw new ConfigError(`${file} must contain a YAML mapping`);
  return doc as RawLayer;
}

export class ConfigService {
  constructor(
    private readonly paths: GlobalPaths,
    private readonly store: Store,
    private readonly now: () => Date = () => new Date(),
  ) {}

  layerFile(layer: WritableLayer, ctx: ConfigContext): string | undefined {
    switch (layer) {
      case "global":
        return this.paths.configFile;
      case "project":
        return ctx.projectRoot ? join(projectDir(ctx.projectRoot), PROJECT_CONFIG_FILE) : undefined;
      case "workspace":
        return ctx.projectRoot && ctx.workspacePath
          ? join(projectDir(join(ctx.projectRoot, ctx.workspacePath)), PROJECT_CONFIG_FILE)
          : undefined;
      case "session":
        return undefined;
    }
  }

  async readLayer(layer: WritableLayer | "managed", ctx: ConfigContext): Promise<RawLayer> {
    if (layer === "managed")
      return parseLayer(await readTextFile(this.paths.managedConfigFile), this.paths.managedConfigFile);
    if (layer === "session") {
      if (!ctx.sessionId) return {};
      const db = await this.store.read();
      return db.sessionOverrides[ctx.sessionId]?.layer ?? {};
    }
    const file = this.layerFile(layer, ctx);
    if (!file) return {};
    return parseLayer(await readTextFile(file), file);
  }

  async layers(ctx: ConfigContext): Promise<ConfigLayers> {
    return {
      global: await this.readLayer("global", ctx),
      project: ctx.projectRoot ? await this.readLayer("project", ctx) : undefined,
      workspace: ctx.workspacePath ? await this.readLayer("workspace", ctx) : undefined,
      session: ctx.sessionId ? await this.readLayer("session", ctx) : undefined,
      managed: await this.readLayer("managed", ctx),
    };
  }

  async resolve(ctx: ConfigContext = {}): Promise<ResolvedConfig> {
    return resolveConfig(await this.layers(ctx));
  }

  /**
   * Applies a batch of operations atomically: all validate or none apply.
   * Sensitive or locked changes require `confirm`. Returns the diff either way.
   */
  async apply(
    operations: { path: string; value: unknown; layer: WritableLayer }[],
    opts: {
      actor: ConfigActor;
      ctx: ConfigContext;
      confirm?: boolean;
      dryRun?: boolean;
      note?: string;
      requireConfirmation?: boolean;
    },
  ): Promise<ConfigChangeResult> {
    const messages: string[] = [];
    const layers = await this.layers(opts.ctx);
    const before = resolveConfig(layers);
    const next: ConfigLayers = structuredClone(layers);
    const touched = new Set<WritableLayer>();
    for (const op of operations) {
      if (!isKnownPath(op.path))
        throw new ConfigError(
          `Unknown setting "${op.path}". Run \`dev-learning-ai config get\` to list settings.`,
        );
      if (before.locked.includes(op.path)) {
        throw new ConfigError(
          `"${op.path}" is set by organization-managed configuration and cannot be changed here.`,
        );
      }
      if (op.layer !== "global" && op.layer !== "session" && !opts.ctx.projectRoot) {
        throw new ConfigError(
          `The ${op.layer} layer needs a registered project; run inside a repository or pass --project.`,
        );
      }
      if (op.layer === "session" && !opts.ctx.sessionId)
        throw new ConfigError("The session layer needs a session id.");
      // Validate the value itself, so an invalid value hidden by a higher layer is still refused.
      if (op.value !== undefined) {
        const probe = ConfigSchema.safeParse(setPath({}, op.path, op.value));
        const own = probe.success
          ? []
          : probe.error.issues.filter(
              (i) =>
                i.path.join(".") === op.path ||
                (op.path.startsWith(`${i.path.join(".")}.`) && i.path.length > 0 && i.code !== "custom"),
            );
        if (own.length) throw new ConfigError(`${op.path}: ${own.map((i) => i.message).join("; ")}`);
      }
      next[op.layer] = setPath((next[op.layer] as RawLayer | undefined) ?? {}, op.path, op.value);
      touched.add(op.layer);
    }
    let after: ResolvedConfig;
    try {
      after = resolveConfig(next);
    } catch (err) {
      if (err instanceof ConfigValidationError) throw new ConfigError(err.message);
      throw err;
    }
    const diff = diffConfigs(before.config, after.config);
    const needsConfirmation =
      Boolean(opts.requireConfirmation) ||
      diff.some((d) => d.sensitive) ||
      operations.some((o) => isSensitiveKey(o.path));
    for (const d of diff.filter((x) => x.sensitive))
      messages.push(`${d.path} is privacy- or security-relevant.`);
    if (diff.length === 0) messages.push("No effective change (another layer may override this setting).");
    if (opts.dryRun || (needsConfirmation && !opts.confirm)) {
      return { applied: false, diff, needsConfirmation, messages };
    }
    let historyId: string | undefined;
    for (const layer of touched) {
      historyId = await this.writeLayer(
        layer,
        next[layer] as RawLayer,
        opts.ctx,
        opts.actor,
        diff,
        opts.note,
      );
    }
    return { applied: true, diff, needsConfirmation, messages, historyId };
  }

  async set(
    path: string,
    raw: string,
    layer: WritableLayer,
    opts: { actor: ConfigActor; ctx: ConfigContext; confirm?: boolean; dryRun?: boolean },
  ) {
    return this.apply([{ path, value: coerceValue(path, raw), layer }], opts);
  }

  async unset(
    path: string,
    layer: WritableLayer,
    opts: { actor: ConfigActor; ctx: ConfigContext; confirm?: boolean },
  ) {
    return this.apply([{ path, value: undefined, layer }], opts);
  }

  /** AI-assisted configuration: deterministic parse, then the same validated path as every other change. */
  async applyNaturalLanguage(
    text: string,
    opts: {
      actor?: ConfigActor;
      ctx: ConfigContext;
      confirm?: boolean;
      dryRun?: boolean;
      extraOperations?: ConfigOperation[];
    },
  ): Promise<ConfigChangeResult & { operations: ConfigOperation[]; unparsed: string[] }> {
    const intent = parseConfigIntent(text, opts.ctx.projectRoot ? "global" : "global");
    const operations = [...intent.operations, ...(opts.extraOperations ?? [])];
    if (operations.length === 0) {
      return {
        applied: false,
        diff: [],
        needsConfirmation: false,
        messages: ["No configuration change was recognised."],
        operations,
        unparsed: intent.unparsed,
      };
    }
    const result = await this.apply(operations, {
      actor: opts.actor ?? "ai-assisted",
      ctx: opts.ctx,
      confirm: opts.confirm,
      dryRun: opts.dryRun,
      note: text.slice(0, 200),
      // Consequential changes proposed from natural language always need confirmation.
      requireConfirmation: intent.needsConfirmation,
    });
    return { ...result, operations, unparsed: intent.unparsed };
  }

  private async writeLayer(
    layer: WritableLayer,
    content: RawLayer,
    ctx: ConfigContext,
    actor: ConfigActor,
    diff: ConfigDiffEntry[],
    note?: string,
  ): Promise<string> {
    const id = newId("cfg");
    const at = this.now().toISOString();
    let snapshot: string;
    let target: string;
    if (layer === "session") {
      target = `session:${ctx.sessionId}`;
      snapshot = await this.store.transact((db) => {
        const prev = JSON.stringify(db.sessionOverrides[ctx.sessionId!]?.layer ?? {});
        db.sessionOverrides[ctx.sessionId!] = { layer: content, at };
        return prev;
      });
    } else {
      target = this.layerFile(layer, ctx)!;
      snapshot = await withLock(`${target}.lock`, async () => {
        const prev = (await readTextFile(target)) ?? "";
        await atomicWrite(
          target,
          `# dev-learning-ai ${layer} configuration (schema_version 1)\n${stringifyYaml(content)}`,
        );
        return prev;
      });
    }
    await this.appendHistory({ id, at, actor, layer, target, diff, note, snapshot });
    return id;
  }

  private async appendHistory(entry: ConfigHistoryEntry): Promise<void> {
    await ensureDir(this.paths.configHistory);
    await appendFile(join(this.paths.configHistory, "history.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  }

  async history(limit = 50): Promise<ConfigHistoryEntry[]> {
    const text = await readTextFile(join(this.paths.configHistory, "history.jsonl"));
    if (!text) return [];
    const entries = text
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as ConfigHistoryEntry];
        } catch {
          return [];
        }
      });
    return entries.slice(-limit).reverse();
  }

  /** Restores the layer to its content before the given change. The rollback itself is recorded. */
  async rollback(historyId: string, ctx: ConfigContext): Promise<ConfigChangeResult> {
    const entries = await this.history(10_000);
    const entry = entries.find((e) => e.id === historyId);
    if (!entry) throw new ConfigError(`No configuration change ${historyId}`);
    const layers = await this.layers(ctx);
    const before = resolveConfig(layers);
    let restored: RawLayer;
    if (entry.layer === "session") restored = JSON.parse(entry.snapshot || "{}") as RawLayer;
    else restored = parseLayer(entry.snapshot, entry.target);
    const next: ConfigLayers = { ...layers, [entry.layer]: restored };
    const after = resolveConfig(next);
    const diff = diffConfigs(before.config, after.config);
    if (entry.layer === "session") {
      await this.writeLayer(
        "session",
        restored,
        { ...ctx, sessionId: entry.target.slice("session:".length) },
        "rollback",
        diff,
        `rollback of ${historyId}`,
      );
    } else {
      const id = newId("cfg");
      const prev = (await readTextFile(entry.target)) ?? "";
      await atomicWrite(entry.target, entry.snapshot);
      await this.appendHistory({
        id,
        at: this.now().toISOString(),
        actor: "rollback",
        layer: entry.layer,
        target: entry.target,
        diff,
        note: `rollback of ${historyId}`,
        snapshot: prev,
      });
      return {
        applied: true,
        diff,
        needsConfirmation: false,
        messages: [`Restored ${entry.target}`],
        historyId: id,
      };
    }
    return { applied: true, diff, needsConfirmation: false, messages: ["Restored session overrides"] };
  }

  explain(resolved: ResolvedConfig, path: string): { value: unknown; origin: string; locked: boolean } {
    return {
      value: getPath(resolved.config, path),
      origin: resolved.origins[path] ?? "defaults",
      locked: resolved.locked.includes(path),
    };
  }
}
