# Supported platforms and agents

## Platforms

| Platform | Status |
| --- | --- |
| Windows 11, Node.js 22.12 | Developed and tested (unit, integration, end-to-end, dashboard checked in a browser at 375 px and desktop widths, light and dark) |
| macOS, Linux, Node.js 22.12+ | CI target; path handling, XDG data directory and file locking are portable, but not exercised by the authors locally |
| Node.js < 22.12 | Not supported |

## Coding agents

| Agent | Integration | Verified |
| --- | --- | --- |
| Claude Code 2.1.295 | Mods (function hooks) in `integrations/claude-code` | `claude plugin validate` passes; the mod type-checks against the 2.1.295 declarations; 7 behaviour tests pass under `claude plugin test` (terminal and desktop surfaces); a live interactive session has not been exercised by the authors |
| Claude Code, other versions | Same mod | The Mods API is early access and may change; re-run `pnpm mod:validate` and `pnpm mod:test` after upgrading |
| Any agent | `dev-learning-ai ingest` | Implemented |
| Codex, Cursor, Gemini CLI, Copilot, Cline, Roo Code, Aider, Windsurf, Continue, OpenCode | none | Not implemented |

## Claude Code Mods capabilities used

| Capability | Used for |
| --- | --- |
| `session.start` | registers `/learn`, reads status, offers to resume an interrupted assessment |
| `prompt.submit` | marks the start of a task (prompt text not read) |
| `tool.call` (observed after it ran) | file paths, line counts, identifiers, test runs |
| `turn.complete` | hands one event to the engine |
| `ui.render` `AbovePrompt` | the offer, consent, question, feedback and summary band |
| `ui.render` `Pane` | `/learn` status and the last session summary |
| `command.run` | `/learn [review\|pause\|on\|off\|status]` |
| `$.model.complete` | question generation on the session's model |
| `$.process.run` | the dev-learning-ai CLI (argv, no shell) |
| `$.state` | band state, per-turn accumulator, status (survives hot reloads) |
| `$.ui.status` | compact `learn: N due` indicator |
