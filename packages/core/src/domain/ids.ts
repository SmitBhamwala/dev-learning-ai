/**
 * Identifier helpers. The core never imports Node built-ins, so randomness comes
 * from the Web Crypto global that Node, browsers and the Claude Code mod sandbox share.
 */

export const PRODUCT_NAME = "dev-learning-ai";
export const PRODUCT_DIR_NAME = ".dev-learning-ai";
export const ENV_PREFIX = "DEV_LEARNING_AI";

export function newId(prefix?: string): string {
  const id = globalThis.crypto.randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

/** Deterministic 64-bit FNV-1a hash rendered as hex. Used for idempotency keys, not security. */
export function stableHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s.-]/g, "")
    .trim()
    .replace(/[\s_.]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(iso: string): Clock & { advanceDays(days: number): void; set(iso: string): void } {
  let current = new Date(iso);
  return {
    now: () => new Date(current.getTime()),
    advanceDays(days: number) {
      current = new Date(current.getTime() + days * 86_400_000);
    },
    set(next: string) {
      current = new Date(next);
    },
  };
}

export const DAY_MS = 86_400_000;

export function daysBetween(a: Date | string, b: Date | string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / DAY_MS;
}

export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function round(n: number, places = 3): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
