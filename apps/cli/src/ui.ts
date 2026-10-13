import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

/** Exit codes, documented in docs/cli.md. */
export const EXIT = { ok: 0, error: 1, usage: 2, needsConfirmation: 3, notFound: 4, unavailable: 5 } as const;

export class CliExit extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const useColor = stdout.isTTY && !process.env.NO_COLOR;
const wrap = (open: number, close: number) => (s: string) =>
  useColor ? `\u001b[${open}m${s}\u001b[${close}m` : s;
export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  green: wrap(32, 39),
  red: wrap(31, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
};

export interface GlobalOpts {
  json?: boolean;
  yes?: boolean;
  cwd?: string;
  interactive?: boolean;
}

export function isInteractive(opts: GlobalOpts): boolean {
  return opts.interactive !== false && Boolean(stdin.isTTY && stdout.isTTY) && !opts.json;
}

export function out(opts: GlobalOpts, data: unknown, human: () => string | string[] | void): void {
  if (opts.json) {
    stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  const text = human();
  if (text === undefined) return;
  stdout.write(`${Array.isArray(text) ? text.join("\n") : text}\n`);
}

export function pct(n: number | undefined): string {
  return n === undefined ? c.dim("—") : `${Math.round(n * 100)}%`;
}

export function table(rows: string[][], header?: string[]): string {
  const all = header ? [header, ...rows] : rows;
  // eslint-disable-next-line no-control-regex
  const visible = (s: string) => s.replace(/\u001b\[\d+m/g, "").length;
  const widths = all[0]?.map((_, i) => Math.max(...all.map((r) => visible(r[i] ?? "")))) ?? [];
  const fmt = (r: string[]) =>
    r
      .map((cell, i) => cell + " ".repeat(Math.max(0, (widths[i] ?? 0) - visible(cell))))
      .join("  ")
      .trimEnd();
  const lines = all.map(fmt);
  if (header) lines.splice(1, 0, c.dim(widths.map((w) => "─".repeat(w)).join("  ")));
  return lines.join("\n");
}

let rl: ReturnType<typeof createInterface> | undefined;
function reader() {
  rl ??= createInterface({ input: stdin, output: stdout });
  return rl;
}

export function closePrompts(): void {
  rl?.close();
  rl = undefined;
}

export async function ask(question: string): Promise<string> {
  return (await reader().question(question)).trim();
}

/** Confirmation for consequential actions. --yes answers yes; non-interactive without --yes refuses. */
export async function confirm(opts: GlobalOpts, question: string): Promise<boolean> {
  if (opts.yes) return true;
  if (!isInteractive(opts)) {
    throw new CliExit(
      EXIT.needsConfirmation,
      `${question} — re-run with --yes to confirm (non-interactive).`,
    );
  }
  const a = (await ask(`${question} [y/N] `)).toLowerCase();
  return a === "y" || a === "yes";
}
