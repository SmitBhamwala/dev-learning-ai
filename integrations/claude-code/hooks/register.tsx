import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { Band, Feedback, QuestionView, Status, TaskAccumulator } from "../types";

/**
 * dev-learning-ai for Claude Code (Mods / function hooks).
 *
 * What it does:
 * - Observes tool calls passively (never rewrites or blocks them) and keeps a
 *   small per-turn summary: changed file paths, line counts, identifiers, and
 *   whether tests ran. Prompts are never read or stored.
 * - When a turn that changed code completes, it hands one normalized event to
 *   the local dev-learning-ai engine (`dev-learning-ai agent rpc`, argv only, no
 *   shell). The engine decides whether the work is a learning opportunity.
 * - If it is, a band above the prompt offers a few questions. Nothing starts
 *   until the person presses Start. Questions are written at that moment by
 *   this session's own model (`$.model.complete`) from the task's evidence,
 *   validated by the engine, then asked one at a time with immediate feedback.
 * - Every failure degrades to silence: coding is never blocked.
 */

const PANE = "dev-learning-ai";
const task = atom({ plugin: "dev-learning-ai", key: "task" } as const, null);
const band = atom({ plugin: "dev-learning-ai", key: "band" } as const, { kind: "hidden" });
const status = atom({ plugin: "dev-learning-ai", key: "status" } as const, {
  available: false,
  enabled: false,
  dueReviews: 0,
  allowHostModel: false,
});
const lastSummary = atom({ plugin: "dev-learning-ai", key: "lastSummary" } as const, []);

type $ = EngineInterface;
type Options = { cli?: string; showStatus?: boolean };
type Reply<T> = { ok: true; result: T } | { ok: false; error: { code: string; message: string } };

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const TEST_COMMAND =
  /\b(vitest|jest|mocha|pytest|go test|cargo test|dotnet test|phpunit|rspec|(npm|pnpm|yarn|bun)( run)? test)\b/;
const STOP = new Set([
  "const",
  "let",
  "var",
  "function",
  "return",
  "import",
  "export",
  "from",
  "default",
  "class",
  "extends",
  "new",
  "this",
  "true",
  "false",
  "null",
  "undefined",
  "async",
  "await",
  "type",
  "interface",
  "string",
  "number",
  "boolean",
  "void",
  "else",
  "for",
  "while",
  "switch",
  "case",
  "break",
  "continue",
  "try",
  "catch",
  "finally",
  "throw",
  "typeof",
  "the",
  "and",
]);

/** Splits the configured command (`dev-learning-ai`, or `node path/to/bin.js`) into argv. */
export function cliArgv(cli: string | undefined): string[] {
  const raw = (cli ?? "dev-learning-ai").trim() || "dev-learning-ai";
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) return parsed as string[];
    } catch {
      /* fall through */
    }
  }
  return raw.split(/\s+/);
}

/** Short identifiers seen in changed code. Never whole lines. */
export function identifiers(text: string, limit = 40): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)) {
    const t = m[0];
    if (t.length < 3 || t.length > 60 || STOP.has(t)) continue;
    out.add(t);
    if (out.size >= limit) break;
  }
  return [...out];
}

function countLines(s: unknown): number {
  return typeof s === "string" && s.length ? s.split("\n").length : 0;
}

/**
 * Commands to try, in order:
 * 1. the `cli` option, when the person set it to something other than the default;
 * 2. the location the CLI recorded itself in `<data>/cli.json` (absolute node.exe and
 *    bin.js paths, so the app's PATH doesn't matter);
 * 3. `dev-learning-ai` on the PATH;
 * 4. the CLI built in the repository this plugin folder belongs to.
 * The first that answers is remembered for the rest of the module's life.
 */
export function cliCandidates(
  cli: string | undefined,
  pluginRoot: string | undefined,
  recorded?: { node: string; bin: string },
): string[][] {
  const out: string[][] = [];
  if (cli && cli.trim() && cli.trim() !== "dev-learning-ai") out.push(cliArgv(cli));
  if (recorded) out.push([recorded.node, recorded.bin]);
  out.push(["dev-learning-ai"]);
  if (pluginRoot) {
    const parts = pluginRoot.split("\\").join("/").replace(/\/+$/, "").split("/");
    if (parts.length > 2) out.push(["node", `${parts.slice(0, -2).join("/")}/apps/cli/dist/bin.js`]);
  }
  return out.filter((c, i) => out.findIndex((o) => o.join(" ") === c.join(" ")) === i);
}

/** Reads `<data>/cli.json`, written by the CLI each time it runs. */
async function recordedLocation($: $): Promise<{ node: string; bin: string } | undefined> {
  try {
    const homes: string[] = [];
    const none = () => undefined;
    const override = await $.env.get("DEV_LEARNING_AI_HOME").catch(none);
    if (override) homes.push(override);
    const xdg = await $.env.get("XDG_DATA_HOME").catch(none);
    if (xdg) homes.push(`${xdg}/dev-learning-ai`);
    const user = (await $.env.get("USERPROFILE").catch(none)) ?? (await $.env.get("HOME").catch(none));
    if (user) homes.push(`${user}/.dev-learning-ai`);
    for (const home of homes) {
      try {
        const text = await $.fs.read(`${home}/cli.json`);
        const doc = JSON.parse(typeof text === "string" ? text : "") as { node?: unknown; bin?: unknown };
        if (typeof doc.node === "string" && typeof doc.bin === "string")
          return { node: doc.node, bin: doc.bin };
      } catch {
        /* not recorded here */
      }
    }
  } catch {
    /* fall back to the other candidates */
  }
  return undefined;
}

let workingArgv: string[] | undefined;

async function rpc<T>($: $, options: Options, request: Record<string, unknown>): Promise<Reply<T>> {
  let work: { cwd: string; sessionId: string };
  try {
    work = { cwd: await $.session.cwd(), sessionId: await $.session.id() };
  } catch (err) {
    return {
      ok: false,
      error: { code: "unavailable", message: String((err as Error)?.message ?? err).slice(0, 200) },
    };
  }
  const candidates = workingArgv
    ? [workingArgv]
    : cliCandidates(options.cli, $.plugin.root, await recordedLocation($));
  const failures: string[] = [];
  for (const argv of candidates) {
    const label = argv.join(" ");
    try {
      const ran = await $.process.run([...argv, "agent", "rpc"], {
        stdin: JSON.stringify({ ...request, work }),
        timeoutMs: 120_000,
      });
      const line = ran.stdout.trim().split("\n").pop() ?? "";
      if (!line) {
        const why =
          ran.stderr
            .trim()
            .split("\n")
            .find((l) => /Error|not found/i.test(l)) ?? `exit code ${ran.exitCode}`;
        failures.push(`${label}: ${why.slice(0, 160)}`);
        continue;
      }
      workingArgv = argv;
      return JSON.parse(line) as Reply<T>;
    } catch (err) {
      failures.push(`${label}: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
    }
  }
  return {
    ok: false,
    error: {
      code: "unavailable",
      message: `tried ${failures.length} way(s) to run the CLI — ${failures.join(" | ")}`,
    },
  };
}

type RpcQuestion = {
  assessmentId: string;
  question: {
    id: string;
    type: string;
    prompt: string;
    code?: string;
    codeLanguage?: string;
    choices?: { id: string; text: string }[];
    isMultiSelect: boolean;
    isOpen: boolean;
  };
  conceptLabel: string;
  progress: string;
  askReasoning: boolean;
  askConfidence: boolean;
  requireReasoning: boolean;
  requireConfidence: boolean;
};
type Prepared = {
  assessmentId: string;
  status: string;
  requests: { requestKey: string; system: string; prompt: string; maxTokens: number }[];
  question?: RpcQuestion;
  reason?: string;
};
type AnswerResult = {
  headline: string;
  isCorrect: boolean;
  feedback: string[];
  explanation: string;
  next?: RpcQuestion;
  summary?: { lines: string[] };
};

function view(q: RpcQuestion): QuestionView {
  return {
    assessmentId: q.assessmentId,
    questionId: q.question.id,
    prompt: q.question.prompt,
    code: q.question.code,
    codeLanguage: q.question.codeLanguage,
    choices: q.question.choices,
    isMultiSelect: q.question.isMultiSelect,
    isOpen: q.question.isOpen,
    type: q.question.type,
    conceptLabel: q.conceptLabel,
    progress: q.progress,
    askReasoning: q.askReasoning,
    askConfidence: q.askConfidence,
    requireReasoning: q.requireReasoning,
    requireConfidence: q.requireConfidence,
  };
}

const show =
  (b: Band) =>
  (_current: Band): Band =>
    b;

async function refreshStatus($: $, options: Options): Promise<void> {
  const r = await rpc<{
    enabled: boolean;
    dueReviews: number;
    allowHostModel: boolean;
    resumable: { id: string; answered: number; total: number; status: string }[];
  }>($, options, { op: "status" });
  if (!r.ok) {
    await update($, status, () => ({
      available: false,
      enabled: false,
      dueReviews: 0,
      allowHostModel: false,
      reason: r.error.message,
    }));
    return;
  }
  const s: Status = {
    available: true,
    enabled: r.result.enabled,
    dueReviews: r.result.dueReviews,
    allowHostModel: r.result.allowHostModel,
  };
  await update($, status, () => s);
  if (options.showStatus !== false)
    $.ui.status(s.enabled && s.dueReviews > 0 ? `learn: ${s.dueReviews} due` : undefined);
  const resume = r.result.resumable.find((x) => x.status === "in-progress");
  if (resume && (await read($, band)).kind === "hidden") {
    await update(
      $,
      band,
      show({ kind: "resume", assessmentId: resume.id, answered: resume.answered, total: resume.total }),
    );
  }
}

/**
 * Runs the assessment's pending generation requests on this session's own
 * model and submits the replies for validation. Model output is data: the
 * engine accepts only questions that pass its schema and answer-key checks.
 */
async function generateAndSubmit($: $, options: Options, prepared: Prepared): Promise<Prepared> {
  const model = await $.session.model();
  const replies: { requestKey: string; text: string; inputTokens: number; outputTokens: number }[] = [];
  for (const req of prepared.requests) {
    const r = await $.model.complete({
      model,
      system: req.system,
      prompt: req.prompt,
      maxTokens: Math.max(1500, req.maxTokens),
    });
    if (r.isAnswered) {
      replies.push({
        requestKey: req.requestKey,
        text: r.text,
        inputTokens: r.usage.input_tokens ?? 0,
        outputTokens: r.usage.output_tokens ?? 0,
      });
    }
  }
  if (replies.length === 0)
    return { ...prepared, status: "deferred", reason: "the session's model did not answer; try again later" };
  const submitted = await rpc<Prepared>($, options, {
    op: "submit",
    assessmentId: prepared.assessmentId,
    replies,
    model,
  });
  return submitted.ok
    ? submitted.result
    : { ...prepared, status: "deferred", reason: submitted.error.message };
}

async function startAssessment(
  $: $,
  options: Options,
  spec: { taskId?: string; kind: "task" | "review" },
): Promise<void> {
  await update($, band, show({ kind: "working", message: "Writing questions from this task…" }));
  let r = await rpc<Prepared>($, options, { op: "prepare", kind: spec.kind, taskId: spec.taskId });
  if (!r.ok) {
    await update($, band, show({ kind: "notice", message: `Couldn't start: ${r.error.message}` }));
    return;
  }
  let prepared = r.result;
  if (prepared.status === "deferred" && /allow_host_model/.test(prepared.reason ?? "")) {
    await update($, band, show({ kind: "consent", taskId: spec.taskId, assessmentKind: spec.kind }));
    return;
  }
  if (prepared.status === "generating") prepared = await generateAndSubmit($, options, prepared);
  if (prepared.status === "in-progress" && prepared.question) {
    await update(
      $,
      band,
      show({
        kind: "question",
        question: view(prepared.question),
        selected: [],
        reasoning: "",
        answerText: "",
        stage: "answer",
      }),
    );
    return;
  }
  if (prepared.status === "in-progress") {
    r = await rpc<Prepared>($, options, { op: "question", assessmentId: prepared.assessmentId });
  }
  await update(
    $,
    band,
    show({
      kind: "notice",
      message: prepared.reason
        ? `Learning deferred: ${prepared.reason}`
        : "No questions could be prepared right now.",
    }),
  );
}

async function submitAnswer(
  $: $,
  options: Options,
  q: QuestionView,
  answer: { choiceIds?: string[]; text?: string; reasoning?: string; confidence?: string },
): Promise<void> {
  await update($, band, show({ kind: "working", message: "Checking your answer…" }));
  const r = await rpc<AnswerResult>($, options, {
    op: "answer",
    assessmentId: q.assessmentId,
    questionId: q.questionId,
    answer,
  });
  if (!r.ok) {
    await update($, band, show({ kind: "notice", message: r.error.message }));
    return;
  }
  const feedback: Feedback = {
    headline: r.result.headline,
    isCorrect: r.result.isCorrect,
    lines: r.result.feedback.slice(0, 3),
    explanation: r.result.explanation,
  };
  await update(
    $,
    band,
    show({
      kind: "feedback",
      assessmentId: q.assessmentId,
      feedback,
      next: r.result.next ? view(r.result.next) : null,
      summary: r.result.summary?.lines ?? null,
    }),
  );
  if (r.result.summary) await update($, lastSummary, () => r.result.summary!.lines);
}

export const register: Register = (on, options: Options) => {
  // ── Session start: commands, status, recovery of an interrupted assessment ──
  on("session.start", async ($, e, next) => {
    // Each step is independent: a failure in one never skips the other, and never blocks the session.
    try {
      await $.command.register({
        name: "learn",
        description: "dev-learning-ai: learning status, reviews and controls",
        argumentHint: "[review|pause|on|off|status]",
      });
    } catch {
      /* commands are optional */
    }
    try {
      await refreshStatus($, options);
    } catch {
      /* the CLI may be absent; learning stays off */
    }
    return next(e);
  });

  // ── A user prompt starts a task. The prompt text is not read. ──
  on("prompt.submit", async ($, e, next) => {
    try {
      const now = new Date(await $.clock.now()).toISOString();
      await update(
        $,
        task,
        (t) =>
          t ?? {
            taskId: `cc-${now.replace(/[^\d]/g, "").slice(0, 17)}`,
            startedAt: now,
            turns: 0,
            paths: [],
            linesChanged: 0,
            symbols: [],
            toolCalls: {},
            testsRan: 0,
            testsFailed: 0,
          },
      );
    } catch {
      /* observe only */
    }
    return next(e);
  });

  // ── Tool calls: observed after they run; never rewritten, never blocked. ──
  on("tool.call", async ($, e, next) => {
    const ran = await next(e);
    try {
      if (e.agentId) return ran;
      const tool = String(e.tool);
      const input = e as unknown as Record<string, unknown>;
      if (ran.deny !== undefined) return ran;
      if (!EDIT_TOOLS.has(tool) && tool !== "Bash") return ran;
      await update($, task, (t) => {
        if (!t) return t;
        const next2: TaskAccumulator = {
          ...t,
          toolCalls: { ...t.toolCalls, [tool]: (t.toolCalls[tool] ?? 0) + 1 },
        };
        if (EDIT_TOOLS.has(tool) && !ran.isError) {
          const path = String(input.file_path ?? input.notebook_path ?? "");
          if (path && !next2.paths.includes(path)) next2.paths = [...next2.paths, path].slice(-100);
          let added = "";
          let lines = 0;
          if (tool === "Write") {
            added = String(input.content ?? "");
            lines = countLines(input.content);
          } else if (tool === "MultiEdit" && Array.isArray(input.edits)) {
            for (const ed of input.edits as { old_string?: string; new_string?: string }[]) {
              added += `\n${ed.new_string ?? ""}`;
              lines += countLines(ed.new_string) + countLines(ed.old_string);
            }
          } else {
            added = String(input.new_string ?? input.new_source ?? "");
            lines = countLines(input.new_string ?? input.new_source) + countLines(input.old_string);
          }
          next2.linesChanged += lines;
          const merged = new Set([...next2.symbols, ...identifiers(added)]);
          next2.symbols = [...merged].slice(0, 120);
        }
        if (tool === "Bash" && TEST_COMMAND.test(String(input.command ?? ""))) {
          next2.testsRan += 1;
          if (ran.isError) next2.testsFailed += 1;
        }
        return next2;
      });
    } catch {
      /* observation failures are ignored */
    }
    return ran;
  });

  // ── Turn completion: one event to the engine if code changed. ──
  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    try {
      if (e.agentId) return result;
      const t = await read($, task);
      await update($, task, () => null);
      if (!t || t.paths.length === 0) return result;
      const cwd = await $.session.cwd();
      const sessionId = await $.session.id();
      const rel = (p: string) => {
        const norm = p.replace(/\\/g, "/");
        const base = cwd.replace(/\\/g, "/").replace(/\/$/, "");
        return norm.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? norm.slice(base.length + 1) : norm;
      };
      const event = {
        id: `${sessionId}:${t.taskId}:completed`,
        schemaVersion: 1,
        type: "task.completed",
        timestamp: new Date(await $.clock.now()).toISOString(),
        source: {
          providerId: "claude-code",
          providerVersion: (await $.session.version()).version,
          sessionId,
        },
        developerId: "local",
        correlationId: t.taskId,
        repository: { root: cwd },
        task: {
          id: t.taskId,
          urgency: "normal",
          turns: t.turns + 1,
          toolCalls: t.toolCalls,
          tests: { ran: t.testsRan, failed: t.testsFailed },
          status: e.isAborted ? "aborted" : "completed",
        },
        changes: t.paths.map((p, i) => ({
          path: rel(p),
          kind: "modified",
          linesAdded: i === 0 ? t.linesChanged : 0,
          symbols: i === 0 ? t.symbols.slice(0, 50) : [],
        })),
      };
      const r = await rpc<{ results: { offer?: { taskId: string; message: string }; skipped?: string }[] }>(
        $,
        options,
        { op: "ingest", events: [event] },
      );
      if (!r.ok) {
        await update($, status, (s) => ({ ...s, available: false, reason: r.error.message }));
        return result;
      }
      const offer = r.result.results[0]?.offer;
      if (offer && !e.isAborted) {
        const current = await read($, band);
        if (current.kind === "hidden" || current.kind === "summary" || current.kind === "notice") {
          await update($, band, show({ kind: "offer", taskId: offer.taskId, message: offer.message }));
        }
      }
    } catch {
      /* never break the session */
    }
    return result;
  });

  // ── /learn command ──
  on("command.run", { command: "learn" }, async ($, e) => {
    const arg = e.args.trim().toLowerCase();
    if (arg === "review") {
      void startAssessment($, options, { kind: "review" });
      return { text: "Preparing a review with new questions…" };
    }
    if (arg === "pause") {
      const t = await read($, task);
      await update($, band, show({ kind: "hidden" }));
      if (t) await rpc($, options, { op: "offer", taskId: t.taskId, decision: "paused" });
      return { text: "Learning paused for the current task. Your settings are unchanged." };
    }
    if (arg === "off" || arg === "on") {
      const r = await rpc($, options, { op: "set-learning", enabled: arg === "on", layer: "session" });
      await refreshStatus($, options);
      return {
        text: r.ok ? `Learning turned ${arg} for this session.` : `Couldn't change it: ${r.error.message}`,
      };
    }
    await refreshStatus($, options);
    await $.ui.open({ id: PANE, title: "dev-learning-ai" });
    const s = await read($, status);
    return {
      text: s.available
        ? `Learning ${s.enabled ? "on" : "off"} · ${s.dueReviews} review(s) due.`
        : `dev-learning-ai is not reachable (${s.reason ?? "CLI not found"}). Install it, or set the plugin's "cli" option.`,
    };
  });

  // ── The pane: status and the last session summary ──
  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e);
    const s = await read($, status);
    const summary = await read($, lastSummary);
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>dev-learning-ai</Text>
        {!s.available && (
          <Text>
            Not reachable: {s.reason ?? "the dev-learning-ai CLI was not found"}. Learning is off; coding is
            unaffected.
          </Text>
        )}
        {s.available && (
          <Text>
            Learning {s.enabled ? "on" : "off"} · {s.dueReviews} review{s.dueReviews === 1 ? "" : "s"} due
            {s.allowHostModel ? "" : " · question writing not yet allowed"}
          </Text>
        )}
        {summary.length > 0 && <Text bold>Last session</Text>}
        {summary.map((l, i) => (
          <Text key={`s${i}`} dimColor={i > 0}>
            {l}
          </Text>
        ))}
        {s.available && (
          <Box gap={1}>
            {s.dueReviews > 0 && (
              <Button
                key="review"
                hotkey="r"
                variant="primary"
                label="Review now"
                onPress={() => void startAssessment($, options, { kind: "review" })}
              />
            )}
            <Button key="refresh" hotkey="u" label="Refresh" onPress={() => void refreshStatus($, options)} />
          </Box>
        )}
        <Text dimColor>
          /learn review · /learn pause · /learn off · dashboard: run `dev-learning-ai dashboard`
        </Text>
      </Box>
    );
  });

  // ── The band above the prompt: offer → question → feedback → summary ──
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const b = await read($, band);
    if (e.props.hasSurvey || b.kind === "hidden") return next(e);
    const els = $.ui.resolve(e);
    const { Box, Text, Button, Code } = els;
    const Input = "Input" in els ? els.Input : undefined;
    const hide = () => update($, band, show({ kind: "hidden" }));
    const title = <Text bold>learn </Text>;

    switch (b.kind) {
      case "offer":
        return (
          <Box flexDirection="column">
            <Text>
              {title}
              {b.message}
            </Text>
            <Box gap={1}>
              <Button
                key="start"
                hotkey="1"
                variant="primary"
                label="Start"
                onPress={() => void startAssessment($, options, { taskId: b.taskId, kind: "task" })}
              />
              <Button
                key="later"
                hotkey="2"
                label="Later"
                onPress={async () => {
                  await rpc($, options, { op: "offer", taskId: b.taskId, decision: "deferred" });
                  await hide();
                }}
              />
              <Button
                key="skip"
                hotkey="3"
                label="Skip"
                onPress={async () => {
                  await rpc($, options, { op: "offer", taskId: b.taskId, decision: "declined" });
                  await hide();
                }}
              />
            </Box>
          </Box>
        );
      case "resume":
        return (
          <Box gap={1}>
            <Text>
              {title}An assessment was interrupted ({b.answered}/{b.total} answered).
            </Text>
            <Button
              key="resume"
              hotkey="1"
              variant="primary"
              label="Resume"
              onPress={async () => {
                const r = await rpc<RpcQuestion | null>($, options, {
                  op: "question",
                  assessmentId: b.assessmentId,
                });
                if (r.ok && r.result)
                  await update(
                    $,
                    band,
                    show({
                      kind: "question",
                      question: view(r.result),
                      selected: [],
                      reasoning: "",
                      answerText: "",
                      stage: "answer",
                    }),
                  );
                else await hide();
              }}
            />
            <Button key="dismiss" hotkey="2" label="Not now" onPress={hide} />
          </Box>
        );
      case "consent":
        return (
          <Box flexDirection="column">
            <Text>
              {title}Questions are written by this session's model from the task's file names, identifiers and
              detected concepts, never whole files. Allow this?
            </Text>
            <Box gap={1}>
              <Button
                key="allow"
                hotkey="1"
                variant="primary"
                label="Allow"
                onPress={async () => {
                  const r = await rpc($, options, { op: "allow-host-model", confirmed: true });
                  if (r.ok) await startAssessment($, options, { taskId: b.taskId, kind: b.assessmentKind });
                  else await update($, band, show({ kind: "notice", message: r.error.message }));
                }}
              />
              <Button key="no" hotkey="2" label="Not now" onPress={hide} />
            </Box>
          </Box>
        );
      case "working":
        return (
          <Text dimColor>
            {title}
            {b.message}
          </Text>
        );
      case "notice":
        return (
          <Box gap={1}>
            <Text>
              {title}
              {b.message}
            </Text>
            <Button key="close" hotkey="1" label="Close" onPress={hide} />
          </Box>
        );
      case "summary":
        return (
          <Box flexDirection="column">
            {b.lines.map((l, i) => (
              <Text key={`l${i}`} dimColor={i > 0}>
                {i === 0 ? title : ""}
                {l}
              </Text>
            ))}
            <Button key="close" hotkey="1" label="Close" onPress={hide} />
          </Box>
        );
      case "feedback":
        return (
          <Box flexDirection="column">
            <Text bold color={b.feedback.isCorrect ? "green" : "yellow"}>
              {b.feedback.isCorrect ? "✓ " : "· "}
              {b.feedback.headline}
            </Text>
            {b.feedback.lines.map((l, i) => (
              <Text key={`f${i}`}>{l}</Text>
            ))}
            <Text dimColor>{b.feedback.explanation.slice(0, 600)}</Text>
            <Box gap={1}>
              {b.next ? (
                <Button
                  key="next"
                  hotkey="n"
                  variant="primary"
                  label="Next question"
                  onPress={() =>
                    update(
                      $,
                      band,
                      show({
                        kind: "question",
                        question: b.next!,
                        selected: [],
                        reasoning: "",
                        answerText: "",
                        stage: "answer",
                      }),
                    )
                  }
                />
              ) : (
                <Button
                  key="done"
                  hotkey="n"
                  variant="primary"
                  label="See summary"
                  onPress={() =>
                    update(
                      $,
                      band,
                      show(b.summary ? { kind: "summary", lines: b.summary } : { kind: "hidden" }),
                    )
                  }
                />
              )}
              <Button key="later" hotkey="l" label="Finish later" onPress={hide} />
            </Box>
          </Box>
        );
      case "question": {
        const q = b.question;
        const header = (
          <Text dimColor>
            learn · {q.progress} · {q.conceptLabel}
          </Text>
        );
        if (b.stage === "confidence") {
          const send = (confidence?: string) =>
            void submitAnswer($, options, q, {
              choiceIds: q.choices ? b.selected : undefined,
              text: q.choices ? undefined : b.answerText,
              reasoning: b.reasoning.trim() || undefined,
              confidence,
            });
          const answerLabel = q.choices ? b.selected.join(", ") : b.answerText.slice(0, 80);
          return (
            <Box flexDirection="column">
              {header}
              <Text>Your answer: {answerLabel}</Text>
              {q.askReasoning && q.choices && Input && (
                <Input
                  key="why"
                  label="Why?"
                  placeholder={q.requireReasoning ? "required" : "optional"}
                  value={b.reasoning}
                  onInput={(value) =>
                    void update($, band, (cur) =>
                      cur.kind === "question" ? { ...cur, reasoning: value } : cur,
                    )
                  }
                  onSubmit={(value) =>
                    void update($, band, (cur) =>
                      cur.kind === "question" ? { ...cur, reasoning: value } : cur,
                    )
                  }
                />
              )}
              {q.askConfidence ? (
                <Box gap={1}>
                  <Text dimColor>How sure?</Text>
                  <Button key="c1" hotkey="1" label="Guessing" onPress={() => send("guessing")} />
                  <Button key="c2" hotkey="2" label="Not sure" onPress={() => send("low")} />
                  <Button key="c3" hotkey="3" label="Fairly sure" onPress={() => send("medium")} />
                  <Button key="c4" hotkey="4" label="Very sure" onPress={() => send("high")} />
                  {!q.requireConfidence && (
                    <Button key="c0" hotkey="0" label="Submit" onPress={() => send(undefined)} />
                  )}
                </Box>
              ) : (
                <Button
                  key="submit"
                  hotkey="0"
                  variant="primary"
                  label="Submit"
                  onPress={() => send(undefined)}
                />
              )}
            </Box>
          );
        }
        return (
          <Box flexDirection="column">
            {header}
            <Text>{q.prompt}</Text>
            {q.code && <Code source={q.code} language={q.codeLanguage} />}
            {q.choices?.map((c) => (
              <Button
                key={`choice-${c.id}`}
                plain
                hotkey={c.id.length === 1 && /[a-z]/.test(c.id) ? c.id : undefined}
                onPress={() =>
                  void update($, band, (cur) => {
                    if (cur.kind !== "question") return cur;
                    if (!q.isMultiSelect) return { ...cur, selected: [c.id], stage: "confidence" as const };
                    const has = cur.selected.includes(c.id);
                    return {
                      ...cur,
                      selected: has ? cur.selected.filter((x) => x !== c.id) : [...cur.selected, c.id],
                    };
                  })
                }
                label={`${q.isMultiSelect ? (b.selected.includes(c.id) ? "[x] " : "[ ] ") : ""}${c.text}`}
              />
            ))}
            {q.isOpen && Input && (
              <Input
                key="answer"
                label="Answer"
                placeholder="a few sentences, Enter to continue"
                onSubmit={(value) =>
                  void update($, band, (cur) =>
                    cur.kind === "question"
                      ? { ...cur, answerText: value, stage: "confidence" as const }
                      : cur,
                  )
                }
              />
            )}
            {q.isOpen && !Input && (
              <Text dimColor>
                Open questions need a surface with text input; use `dev-learning-ai assess --resume{" "}
                {q.assessmentId}`.
              </Text>
            )}
            <Box gap={1}>
              {q.isMultiSelect && (
                <Button
                  key="continue"
                  hotkey="0"
                  variant="primary"
                  label="Continue"
                  onPress={() =>
                    void update($, band, (cur) =>
                      cur.kind === "question" && cur.selected.length
                        ? { ...cur, stage: "confidence" as const }
                        : cur,
                    )
                  }
                />
              )}
              <Button
                key="skipq"
                hotkey="9"
                label="Skip question"
                onPress={async () => {
                  const r = await rpc<{ next?: RpcQuestion; summary?: { lines: string[] } }>($, options, {
                    op: "skip",
                    assessmentId: q.assessmentId,
                  });
                  if (r.ok && r.result.next)
                    await update(
                      $,
                      band,
                      show({
                        kind: "question",
                        question: view(r.result.next),
                        selected: [],
                        reasoning: "",
                        answerText: "",
                        stage: "answer",
                      }),
                    );
                  else
                    await update(
                      $,
                      band,
                      show(
                        r.ok && r.result.summary
                          ? { kind: "summary", lines: r.result.summary.lines }
                          : { kind: "hidden" },
                      ),
                    );
                }}
              />
              <Button key="later" hotkey="8" label="Later" onPress={hide} />
            </Box>
          </Box>
        );
      }
    }
    return next(e);
  });
};
