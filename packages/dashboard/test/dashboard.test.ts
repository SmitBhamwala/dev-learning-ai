import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboard, type DashboardHandle } from "@dev-learning-ai/dashboard";
import { openService, tempDir } from "../../runtime/test/helpers.js";

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function call(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: opts.method ?? "GET",
        headers: { Host: `127.0.0.1:${port}`, ...opts.headers },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe("dashboard security", () => {
  let dash: DashboardHandle;
  let port: number;
  let cookie = "";
  let csrf = "";

  beforeAll(async () => {
    const svc = await openService(await tempDir());
    dash = await startDashboard(svc, { token: "test-token-123" });
    port = Number(new URL(dash.origin).port);
  });
  afterAll(async () => dash.close());

  it("binds to loopback and sends a strict CSP", async () => {
    expect(dash.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const r = await call(port, "/styles.css");
    expect(r.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses API access without the session cookie and a wrong token", async () => {
    expect((await call(port, "/api/overview")).status).toBe(401);
    expect((await call(port, "/?token=wrong")).status).toBe(401);
    expect((await call(port, "/")).status).toBe(401);
  });

  it("exchanges the token for an HttpOnly SameSite=Strict cookie", async () => {
    const r = await call(port, "/?token=test-token-123");
    expect(r.status).toBe(303);
    const set = String(r.headers["set-cookie"]);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    cookie = set.split(";")[0]!;
    const s = await call(port, "/api/session", { headers: { Cookie: cookie } });
    csrf = JSON.parse(s.body).csrf;
    expect(csrf.length).toBeGreaterThan(20);
    expect((await call(port, "/api/overview", { headers: { Cookie: cookie } })).status).toBe(200);
  });

  it("rejects DNS-rebinding hosts, cross-origin writes and writes without CSRF", async () => {
    expect(
      (await call(port, "/api/overview", { headers: { Cookie: cookie, Host: "evil.example:80" } })).status,
    ).toBe(421);
    const body = JSON.stringify({
      changes: [{ path: "learning.questions_per_task", value: 4 }],
      confirm: true,
    });
    const json = { Cookie: cookie, "Content-Type": "application/json" };
    expect((await call(port, "/api/config", { method: "POST", headers: json, body })).status).toBe(403);
    expect(
      (
        await call(port, "/api/config", {
          method: "POST",
          headers: { ...json, "X-DLA-CSRF": csrf, Origin: "https://evil.example" },
          body,
        })
      ).status,
    ).toBe(403);
    const ok = await call(port, "/api/config", {
      method: "POST",
      headers: { ...json, "X-DLA-CSRF": csrf, Origin: dash.origin },
      body,
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).applied).toBe(true);
  });

  it("only serves known static files and refuses settings outside the dashboard's list", async () => {
    expect((await call(port, "/../package.json", { headers: { Cookie: cookie } })).status).toBe(404);
    expect((await call(port, "/%2e%2e/%2e%2e/etc/passwd", { headers: { Cookie: cookie } })).status).toBe(404);
    const r = await call(port, "/api/config", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-DLA-CSRF": csrf },
      body: JSON.stringify({ changes: [{ path: "dashboard.host", value: "0.0.0.0" }], confirm: true }),
    });
    expect(r.status).toBe(400);
  });

  it("does not reveal answer keys for unanswered questions", async () => {
    const r = await call(port, "/api/assessments", { headers: { Cookie: cookie } });
    expect(r.status).toBe(200);
    expect(r.body).not.toContain('"correct":["');
  });
});
