import { describe, expect, test } from "claude-code/testing";
import type { TestBody } from "claude-code/testing";

/**
 * End-to-end behaviour inside the engine's test kit: a prompt, an Edit, the
 * turn completing, the offer band, Start, question generation on the
 * session's own model, answering, feedback, and the consent path.
 * The CLI is simulated by answering `$.process.run`; nothing here talks to a
 * real dev-learning-ai install.
 */

type Rpc = { op: string; [k: string]: unknown };
type On = Parameters<TestBody>[1];
type Engine = Parameters<TestBody>[0];

const QUESTION = {
  assessmentId: "asm_1",
  question: {
    id: "gen_q1",
    type: "single",
    prompt: "Which combinator tolerates partial failure?",
    choices: [
      { id: "a", text: "Promise.all" },
      { id: "b", text: "Promise.allSettled" },
    ],
    isMultiSelect: false,
    isOpen: false,
  },
  conceptLabel: "Promise combinators",
  progress: "Question 1 of 1",
  askReasoning: true,
  askConfidence: true,
  requireReasoning: false,
  requireConfidence: false,
};

function engine(on: On, sent: Rpc[], opts: { allowHost?: boolean } = {}) {
  let allowHost = opts.allowHost ?? true;
  on("process.run", ($, e) => {
    const req = JSON.parse(e.init?.stdin ?? "{}") as Rpc;
    sent.push(req);
    let result: unknown = {};
    switch (req.op) {
      case "status":
        result = { enabled: true, dueReviews: 0, allowHostModel: allowHost, resumable: [] };
        break;
      case "ingest":
        result = {
          results: [
            {
              taskId: "t",
              offer: { taskId: "t-1", message: "This task touched promise combinators. 1 quick question?" },
            },
          ],
        };
        break;
      case "prepare":
        result = allowHost
          ? {
              assessmentId: "asm_1",
              status: "generating",
              requests: [
                {
                  requestKey: "k1",
                  conceptId: "javascript.async.promise-combinators",
                  system: "SYS",
                  prompt: "PROMPT",
                  maxTokens: 800,
                },
              ],
            }
          : {
              assessmentId: "asm_0",
              status: "deferred",
              requests: [],
              reason: "ai.allow_host_model is false",
            };
        break;
      case "allow-host-model":
        allowHost = true;
        result = { applied: true };
        break;
      case "submit":
        result = { assessmentId: "asm_1", status: "in-progress", requests: [], question: QUESTION };
        break;
      case "answer":
        result = {
          headline: "Correct",
          isCorrect: true,
          feedback: ["Answer: Promise.allSettled"],
          explanation: "allSettled waits for every promise.",
          summary: { lines: ["1 of 1 answered correctly."] },
        };
        break;
    }
    return {
      value: {
        exitCode: 0,
        stdout: `${JSON.stringify({ ok: true, version: 1, result })}\n`,
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });
  on("model.complete", () => ({
    value: {
      isAnswered: true as const,
      text: '{"questions":[]}',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }));
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("clock.now", () => ({ value: Date.parse("2026-10-13T10:00:00Z") }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }) as never);
  on("ui.render", ($, e) => {
    const { Box } = $.ui.resolve(e as never) as { Box: never };
    return h(Box, {}) as never;
  });
  on("ui.status", () => ({ value: undefined }));
  on("session.cwd", () => ({ value: "/work/shop" }));
  on("session.id", () => ({ value: "sess-1" }));
  on("session.model", () => ({ value: "claude-opus-5-5" }));
  on("session.version", () => ({ value: { version: "2.1.295", base: "2.1.295" } as never }));
  on("prompt.submit", (_$, e) => ({ text: e.text }) as never);
  on("tool.call", () => ({ result: { filePath: "/work/shop/src/jobs.ts" } as never }));
  on("turn.complete", () => ({ text: "" }));
}

const BAND = {
  component: "AbovePrompt" as const,
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
};

async function workTurn($: Engine) {
  await $.session.start({ cwd: "/work/shop", surface: "terminal", isInteractive: true });
  await $.prompt.submit({ text: "SECRET-PROMPT please fix the retry logic", wait: false } as never);
  await $.tool.call({
    tool: "Edit",
    file_path: "/work/shop/src/jobs.ts",
    old_string: "await Promise.all(jobs)",
    new_string: "const results = await Promise.allSettled(jobs);\nfor (const r of results) report(r);",
  } as never);
  await $.turn.complete({
    answer: "done",
    durationMs: 1000,
    isAborted: false,
    turnId: "turn-1",
    reason: "answer",
  } as never);
}

describe("task flow", () => {
  test("hands one minimal event to the engine after a turn that changed code, without the prompt", async ($, on) => {
    const sent: Rpc[] = [];
    engine(on, sent);
    await workTurn($);
    const ingest = sent.find((r) => r.op === "ingest");
    expect(ingest).toBeDefined();
    const json = JSON.stringify(ingest);
    expect(json).not.toContain("SECRET-PROMPT");
    expect(json).not.toContain("report(r)"); // no source lines, only identifiers
    const event = (
      ingest!.events as {
        changes: { path: string; symbols: string[]; linesAdded: number }[];
        task: { status: string };
      }[]
    )[0]!;
    expect(event.changes[0]!.path).toBe("src/jobs.ts");
    expect(event.changes[0]!.symbols).toContain("Promise.allSettled");
    expect(event.changes[0]!.linesAdded).toBeGreaterThan(0);
    expect(event.task.status).toBe("completed");
  });

  test("offers questions, generates them on the session's model only after Start, and gives feedback", async ($, on) => {
    const sent: Rpc[] = [];
    engine(on, sent);
    for (const surface of ["terminal", "desktop"] as const) {
      sent.length = 0;
      await workTurn($);
      expect(sent.some((r) => r.op === "prepare")).toBe(false);
      const ui = await $.ui.mount({ plugin: "dev-learning-ai", surface, ...BAND });
      expect(await ui.find({ key: "start" })).toBeDefined();
      await ui.press({ key: "start" });
      expect(sent.map((r) => r.op)).toContain("prepare");
      const submit = sent.find((r) => r.op === "submit")!;
      expect((submit.replies as { requestKey: string }[])[0]!.requestKey).toBe("k1");
      expect(submit.model).toBe("claude-opus-5-5");
      await ui.press({ key: "choice-b" });
      await ui.press({ key: "c4" });
      const answer = sent.find((r) => r.op === "answer")!;
      expect(answer.answer).toMatchObject({ choiceIds: ["b"], confidence: "high" });
      expect(await ui.find({ key: "done" })).toBeDefined();
      await ui.press({ key: "done" });
      expect(await ui.find({ key: "close" })).toBeDefined();
      await ui.unmount();
    }
  });

  test("asks before letting the session's model write questions", async ($, on) => {
    const sent: Rpc[] = [];
    engine(on, sent, { allowHost: false });
    await workTurn($);
    const ui = await $.ui.mount({ plugin: "dev-learning-ai", surface: "terminal", ...BAND });
    await ui.press({ key: "start" });
    expect(sent.some((r) => r.op === "submit")).toBe(false);
    expect(await ui.find({ key: "allow" })).toBeDefined();
    await ui.press({ key: "allow" });
    expect(sent.map((r) => r.op)).toContain("allow-host-model");
    expect(sent.some((r) => r.op === "submit")).toBe(true);
    await ui.unmount();
  });

  test("stays silent when the CLI is missing", async ($, on) => {
    on("ui.render", ($2, e) => {
      const { Box } = $2.ui.resolve(e as never) as { Box: never };
      return h(Box, {}) as never;
    });
    on("ui.status", () => ({ value: undefined }));
    on("clock.now", () => ({ value: Date.parse("2026-10-13T10:00:00Z") }));
    on("command.register", (_$, e) => ({ value: { command: e.name } }) as never);
    on("process.run", () => ({
      value: {
        exitCode: 1,
        stdout: "",
        stderr: "not found",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }));
    on("session.start", (_$, e) => ({ cwd: e.cwd }));
    on("session.cwd", () => ({ value: "/work/shop" }));
    on("session.id", () => ({ value: "sess-1" }));
    on("session.version", () => ({ value: { version: "2.1.295", base: "2.1.295" } as never }));
    on("prompt.submit", (_$, e) => ({ text: e.text }) as never);
    on("tool.call", () => ({ result: {} as never }));
    on("turn.complete", () => ({ text: "" }));
    await workTurn($);
    const ui = await $.ui.mount({ plugin: "dev-learning-ai", surface: "terminal", ...BAND });
    expect(await ui.find({ key: "start" })).toBeUndefined();
    await ui.unmount();
  });
});
