# Agent adapters

An adapter turns one coding agent's native signals into [events](events.md) and, optionally, runs model requests on that agent's own session.

## The agent protocol (`dev-learning-ai agent rpc`)

One JSON request goes in on stdin and one JSON reply comes out on stdout. Every request carries `work: { cwd, sessionId }`. Every reply is `{ ok: true, version: 1, result }` or `{ ok: false, version: 1, error: { code, message } }`.

| op | Request fields | Result |
| --- | --- | --- |
| `status` | | `{ enabled, mode, project, allowHostModel, askReasoning, askConfidence, dueReviews, resumable[] }` |
| `ingest` | `events[]` (≤ 100) | `{ results[] }` with `offer` when questions should be offered |
| `prepare` | `kind`, `taskId?`, `conceptIds?`, `count?` | `{ assessmentId, status, requests[], question?, reason? }` |
| `submit` | `assessmentId`, `replies[{ requestKey, text }]`, `model?` | the same as `prepare`, after validation |
| `question` | `assessmentId` | the current public question (no answer key) or `null` |
| `answer` | `assessmentId`, `questionId`, `answer{ choiceIds?, text?, reasoning?, confidence? }` | feedback, `next?`, `summary?` |
| `skip` · `end` · `offer` · `due` | | |
| `allow-host-model` | `confirmed: true` | send only after the person pressed an explicit Allow control |
| `set-learning` | `enabled`, `layer` | |

### Two-phase generation

When `prepare` returns `status: "generating"`, run each request's `system` and `prompt` on the agent's own model, then call `submit` with the reply texts. The engine validates every question. If none pass, the assessment is deferred.

## The `AgentAdapter` contract (in-process)

`packages/core/src/extensions/contracts.ts` defines `AgentAdapter`: `initialize`, `subscribe(handler)`, `getStatus`, `dispose`, and declared `capabilities`. It is for adapters that run inside the engine's process, such as a file-watching or webhook adapter.

## Status

| Agent | Adapter |
| --- | --- |
| Claude Code (Mods) | `integrations/claude-code`, implemented |
| Manual / any tool | `dev-learning-ai ingest`, implemented |
| Codex, Cursor, Gemini CLI, GitHub Copilot, Cline, Roo Code, Aider, Windsurf, Continue, OpenCode | not implemented; contributions welcome |

## Writing an adapter

1. Observe task boundaries: a prompt or request starting work, and a completion.
2. Collect only what the event schema allows. Never send prompts, whole files or transcripts.
3. Send one `task.completed` per meaningful unit of work, with a stable task id, so retries deduplicate.
4. Show the offer non-blockingly, and start nothing until the person chooses to.
5. If the agent can run model calls on its own authorised session, implement two-phase generation. Otherwise rely on the user's configured provider, or defer.
6. Fail open. A broken learning integration must never break coding.
7. Add contract tests that replay your agent's events through `handleAgentRequest`.
