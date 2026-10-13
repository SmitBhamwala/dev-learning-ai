import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LearningService } from "@dev-learning-ai/runtime";
import { createApi, HttpError } from "./api.js";

/**
 * Local dashboard server.
 *
 * Security model (local-first):
 * - Binds to loopback by default; a non-loopback host requires
 *   dashboard.allow_remote_access (enforced by the config schema).
 * - Access needs a random per-run token, delivered in the launch URL once and
 *   exchanged for an HttpOnly, SameSite=Strict cookie.
 * - Mutating requests need a CSRF header matching a per-run secret, and the
 *   Host and Origin headers must match the bound address (DNS-rebinding defence).
 * - Strict CSP, no CORS headers, fixed static file map (no path traversal),
 *   JSON bodies capped at 64 KiB, errors never echo stack traces.
 */

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
};
const MAX_BODY = 64 * 1024;

export interface DashboardOptions {
  host?: string;
  port?: number;
  cwd?: string;
  /** For tests: a fixed token. */
  token?: string;
}

export interface DashboardHandle {
  url: string;
  origin: string;
  token: string;
  server: Server;
  close(): Promise<void>;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function securityHeaders(res: ServerResponse): void {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
}

export async function startDashboard(
  svc: LearningService,
  opts: DashboardOptions = {},
): Promise<DashboardHandle> {
  const host = opts.host ?? "127.0.0.1";
  const token = opts.token ?? randomBytes(24).toString("base64url");
  const csrf = randomBytes(24).toString("base64url");
  const sessionId = randomBytes(24).toString("base64url");
  const api = createApi(svc, { cwd: opts.cwd });
  let origin = "";
  let allowedHosts: string[] = [];

  const server = createServer(async (req, res) => {
    securityHeaders(res);
    try {
      const url = new URL(req.url ?? "/", "http://placeholder");
      if (!allowedHosts.includes(String(req.headers.host ?? "")))
        throw new HttpError(421, "Unexpected Host header");

      // Token exchange: /?token=… sets the session cookie, then redirects to a clean URL.
      const t = url.searchParams.get("token");
      if (url.pathname === "/" && t) {
        if (!safeEqual(t, token))
          throw new HttpError(401, "Invalid access token. Restart the dashboard to get a new link.");
        res.setHeader("Set-Cookie", `dla_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/`);
        res.writeHead(303, { Location: "/" });
        res.end();
        return;
      }
      const authed = safeEqual(cookie(req, "dla_session") ?? "", sessionId);

      if (!url.pathname.startsWith("/api/")) {
        const entry = STATIC[url.pathname];
        if (!entry || req.method !== "GET") throw new HttpError(404, "Not found");
        if (!authed && url.pathname === "/") {
          res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(
            "Open the dashboard with the link printed by `dev-learning-ai dashboard` (it carries a one-time token).",
          );
          return;
        }
        const body = await readFile(join(PUBLIC_DIR, entry.file));
        res.writeHead(200, { "Content-Type": entry.type });
        res.end(body);
        return;
      }

      if (!authed) throw new HttpError(401, "Not authenticated");
      const method = req.method ?? "GET";
      if (method !== "GET") {
        const o = req.headers.origin;
        if (o !== undefined && !allowedHosts.some((h) => o === `http://${h}`))
          throw new HttpError(403, "Cross-origin request refused");
        const h = req.headers["x-dla-csrf"];
        if (typeof h !== "string" || !safeEqual(h, csrf))
          throw new HttpError(403, "Missing or invalid CSRF token");
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json"))
          throw new HttpError(415, "Use application/json");
      }
      if (url.pathname === "/api/session") {
        send(res, 200, { csrf });
        return;
      }
      const body = method === "GET" ? undefined : await readBody(req);
      const result = await api(method, url.pathname, url.searchParams, body);
      send(res, 200, result);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : status === 500 ? errorMessage(err) : "Error";
      send(res, status, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const shownHost = host.includes(":") ? `[${host}]` : host;
  origin = `http://${shownHost}:${addr.port}`;
  allowedHosts = [`${shownHost}:${addr.port}`, ...(host === "127.0.0.1" ? [`localhost:${addr.port}`] : [])];
  return {
    url: `${origin}/?token=${token}`,
    origin,
    token,
    server,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

/** Service errors carry user-facing messages; anything else is reduced to its first line. */
function errorMessage(err: unknown): string {
  const name = (err as Error)?.name;
  if (name === "ConfigError" || name === "ServiceError" || name === "ProjectIdentityConflict")
    return (err as Error).message;
  return `Internal error: ${String((err as Error)?.message ?? err)
    .split("\n")[0]!
    .slice(0, 200)}`;
}
