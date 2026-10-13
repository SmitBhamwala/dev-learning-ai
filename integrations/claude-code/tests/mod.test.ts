import { describe, expect, test } from "claude-code/testing";
import type { TestBody } from "claude-code/testing";

import { cliArgv, cliCandidates, identifiers } from "../hooks/register";

/**
 * Behaviour of the dev-learning-ai mod against the engine's own test kit.
 * The test's hooks stand beneath the plugin as the engine: they answer
 * `$.process.run` (the dev-learning-ai CLI) and `$.model.complete` (the
 * session's model), and record what the plugin sent.
 */

type Rpc = { op: string; [k: string]: unknown };

function engine(
  on: Parameters<TestBody>[1],
  reply: (req: Rpc) => unknown,
  sent: Rpc[],
  model?: () => string,
) {
  on("process.run", ($, e) => {
    const req = JSON.parse(e.init?.stdin ?? "{}") as Rpc;
    sent.push(req);
    const body = { ok: true, version: 1, result: reply(req) };
    return {
      value: {
        exitCode: 0,
        stdout: `${JSON.stringify(body)}\n`,
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });
  on("model.complete", () => ({
    value: {
      isAnswered: true as const,
      text: model ? model() : '{"questions":[]}',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }));
  on("session.cwd", () => ({ value: "/work/shop" }));
  on("session.id", () => ({ value: "sess-1" }));
  on("session.model", () => ({ value: "claude-opus-5-5" }));
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("clock.now", () => ({ value: Date.parse("2026-10-13T10:00:00Z") }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }) as never);
  on("ui.render", ($, e) => {
    const { Box } = $.ui.resolve(e as never) as { Box: never };
    return h(Box, {}) as never;
  });
  on("ui.status", () => ({ value: undefined }));
}

const status = {
  enabled: true,
  mode: "auto",
  allowHostModel: true,
  askReasoning: true,
  askConfidence: true,
  dueReviews: 2,
  resumable: [],
};

describe("helpers", () => {
  test("splits the configured command and extracts short identifiers only", async () => {
    expect(cliArgv(undefined)).toEqual(["dev-learning-ai"]);
    expect(cliArgv("node /opt/dla/bin.js")).toEqual(["node", "/opt/dla/bin.js"]);
    expect(cliArgv('["node","C:/a b/bin.js"]')).toEqual(["node", "C:/a b/bin.js"]);
    const ids = identifiers(
      "const x = await Promise.allSettled(jobs); useEffect(() => {}, []); // the comment",
    );
    expect(ids).toContain("Promise.allSettled");
    expect(ids).toContain("useEffect");
    expect(ids).not.toContain("const");
  });
});

describe("finding the CLI", () => {
  test("prefers an explicit setting, then the recorded location, then PATH, then the repository", async () => {
    const recorded = { node: "C:/node/node.exe", bin: "C:/code/dla/apps/cli/dist/bin.js" };
    expect(cliCandidates(undefined, "C:\\code\\dla\\integrations\\claude-code", recorded)).toEqual([
      ["C:/node/node.exe", "C:/code/dla/apps/cli/dist/bin.js"],
      ["dev-learning-ai"],
      ["node", "C:/code/dla/apps/cli/dist/bin.js"],
    ]);
    expect(cliCandidates("node /x/bin.js", "/repo/integrations/claude-code")).toEqual([
      ["node", "/x/bin.js"],
      ["dev-learning-ai"],
      ["node", "/repo/apps/cli/dist/bin.js"],
    ]);
    expect(cliCandidates("dev-learning-ai", undefined)).toEqual([["dev-learning-ai"]]);
  });
});

describe("observation", () => {
  test("registers /learn and reads status at session start", async ($, on) => {
    const sent: Rpc[] = [];
    engine(on, (req) => (req.op === "status" ? status : {}), sent);
    await $.session.start({ cwd: "/work/shop", surface: "terminal", isInteractive: true });
    expect(sent.map((r) => r.op)).toEqual(["status"]);
  });

  test("passes tool calls through unchanged and never blocks them", async ($, on) => {
    const sent: Rpc[] = [];
    engine(on, () => ({}), sent);
    on("tool.call", ({}, e) => ({
      result: { stdout: "ok", stderr: "", interrupted: false, isImage: false } as never,
    }));
    const r = await $.tool.call({ tool: "Bash", command: "pnpm test", description: "run tests" } as never);
    expect(r.deny).toBeUndefined();
  });
});
