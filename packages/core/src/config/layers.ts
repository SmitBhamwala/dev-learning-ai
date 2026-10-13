import { ConfigSchema, isSensitiveKey, type Config } from "./schema.js";

export const LAYER_ORDER = ["defaults", "global", "project", "workspace", "session", "managed"] as const;
export type LayerName = (typeof LAYER_ORDER)[number];

export type RawLayer = Record<string, unknown>;

export interface ConfigLayers {
  global?: RawLayer;
  project?: RawLayer;
  workspace?: RawLayer;
  session?: RawLayer;
  /** Organization-managed settings: applied last, cannot be overridden by any other layer. */
  managed?: RawLayer;
}

export interface ResolvedConfig {
  config: Config;
  /** Dotted path → the layer that supplied its value. */
  origins: Record<string, LayerName>;
  locked: string[];
}

export class ConfigValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigValidationError";
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge: objects merge key by key, arrays and scalars replace. Prototype keys are ignored. */
export function deepMerge(base: RawLayer, over: RawLayer): RawLayer {
  const out: RawLayer = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    const prev = out[k];
    out[k] = isPlainObject(prev) && isPlainObject(v) ? deepMerge(prev, v) : v;
  }
  return out;
}

export function flatten(obj: unknown, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isPlainObject(obj)) {
    if (prefix) out[prefix] = obj;
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v) && Object.keys(v).length > 0 && !isRecordLeaf(key))
      Object.assign(out, flatten(v, key));
    else out[key] = v;
  }
  return out;
}

/** Record-typed settings whose keys are data, not schema (shown as one leaf). */
function isRecordLeaf(path: string): boolean {
  return path === "learning.version_scope.targets" || path === "plugins.permissions";
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function setPath(obj: RawLayer, path: string, value: unknown): RawLayer {
  const parts = path.split(".");
  if (parts.some((p) => p === "__proto__" || p === "constructor" || p === "prototype" || p === "")) {
    throw new ConfigValidationError([`Illegal configuration path: ${path}`]);
  }
  const out: RawLayer = structuredClone(obj);
  let cur: RawLayer = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (!isPlainObject(cur[p])) cur[p] = {};
    cur = cur[p] as RawLayer;
  }
  const last = parts[parts.length - 1]!;
  if (value === undefined) delete cur[last];
  else cur[last] = value;
  return out;
}

export function unsetPath(obj: RawLayer, path: string): RawLayer {
  return setPath(obj, path, undefined);
}

/** Every valid leaf path of the schema, from the defaults. */
export function knownPaths(): string[] {
  return Object.keys(flatten(ConfigSchema.parse({})));
}

export function isKnownPath(path: string): boolean {
  const paths = knownPaths();
  return paths.includes(path) || paths.some((p) => path.startsWith(`${p}.`) && isRecordLeaf(p));
}

/**
 * Coerces a CLI string into the type the schema expects at `path`, using the
 * default value's type as the guide.
 */
export function coerceValue(path: string, raw: string): unknown {
  const sample = getPath(ConfigSchema.parse({}), path);
  const trimmed = raw.trim();
  if (trimmed === "auto") return "auto";
  if (typeof sample === "boolean") {
    if (/^(true|on|yes|1)$/i.test(trimmed)) return true;
    if (/^(false|off|no|0)$/i.test(trimmed)) return false;
    return trimmed;
  }
  if (typeof sample === "number" || (sample === "auto" && /^-?\d+(\.\d+)?$/.test(trimmed))) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : trimmed;
  }
  if (Array.isArray(sample)) {
    if (trimmed.startsWith("[")) return JSON.parse(trimmed);
    return trimmed === "" ? [] : trimmed.split(",").map((s) => s.trim());
  }
  if (isPlainObject(sample)) return JSON.parse(trimmed);
  return trimmed;
}

export function resolveConfig(layers: ConfigLayers): ResolvedConfig {
  const origins: Record<string, LayerName> = {};
  for (const key of Object.keys(flatten(ConfigSchema.parse({})))) origins[key] = "defaults";

  let merged: RawLayer = {};
  for (const name of ["global", "project", "workspace", "session", "managed"] as const) {
    const layer = layers[name];
    if (!layer) continue;
    merged = deepMerge(merged, layer);
    for (const key of Object.keys(flatten(layer))) origins[key] = name;
  }
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigValidationError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  }
  return { config: parsed.data, origins, locked: layers.managed ? Object.keys(flatten(layers.managed)) : [] };
}

export function validateLayer(layer: RawLayer): string[] {
  const issues: string[] = [];
  for (const key of Object.keys(flatten(layer))) {
    if (key === "schema_version") continue;
    if (!isKnownPath(key)) issues.push(`${key}: unknown setting`);
  }
  const parsed = ConfigSchema.safeParse(layer);
  if (!parsed.success) issues.push(...parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  return issues;
}

export interface ConfigDiffEntry {
  path: string;
  before: unknown;
  after: unknown;
  sensitive: boolean;
}

export function diffConfigs(before: unknown, after: unknown): ConfigDiffEntry[] {
  const a = flatten(before);
  const b = flatten(after);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const out: ConfigDiffEntry[] = [];
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      out.push({ path: k, before: a[k], after: b[k], sensitive: isSensitiveKey(k) });
    }
  }
  return out;
}

export function formatDiff(diff: ConfigDiffEntry[]): string {
  if (diff.length === 0) return "(no changes)";
  return diff
    .map(
      (d) => `${d.sensitive ? "!" : " "} ${d.path}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`,
    )
    .join("\n");
}
