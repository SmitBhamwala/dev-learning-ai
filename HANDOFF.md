# Handoff: dev-learning-ai (state as of 2026-10-14)

This file is for the next agent or developer picking up the project on another machine. The spec is the "AI Learning Skill Master Prompt" (not in this repo). Read `README.md`, `docs/architecture.md` and `docs/roadmap.md` first.

## Status

- Version 0.1.0: a pnpm monorepo containing:
  - `packages/core`: the pure domain
  - `packages/runtime`: the Node services
  - `packages/dashboard`: the local web UI
  - `apps/cli`: the `dev-learning-ai` / `dla` command
  - `integrations/claude-code`: the Claude Code mod, at version 0.1.2
  - `examples/extension-graphql`
- All gates were green at the last run: `pnpm check` (55 vitest tests), plus `claude plugin validate integrations/claude-code` and `claude plugin test integrations/claude-code` (8 mod tests).
- **Product decision (from the owner):** questions are ALWAYS generated at runtime by an AI model. There is no static question bank in the product. `packages/core/test/fixtures/bank.ts` is for tests only, and a lint rule enforces this.

## Setup on a new machine

```bash
pnpm install
pnpm build
pnpm test
cd apps/cli && npm link
dev-learning-ai setup --vault <path-to-obsidian-vault>
```

`npm link` puts `dev-learning-ai` on your PATH.

Claude Code mod:

```bash
claude plugin marketplace add <repo>/integrations/claude-code
claude plugin install dev-learning-ai@dev-learning-ai
```

Run any `dev-learning-ai` command once afterwards. It writes `~/.dev-learning-ai/cli.json` (the absolute node.exe and bin.js paths), which the mod uses to find the CLI.

## Windows desktop-app CLI discovery (resolved)

- Inside the **Claude desktop app** on Windows, the mod could not start the CLI: `$.process.run(dev-learning-ai)` failed with ENOENT, because the app's PATH differs from the terminal's.
- The latest fix (mod 0.1.2) tries these candidates in order, and its error message reports every attempt:
  1. the `cli` option, if set to something non-default
  2. the paths recorded in `~/.dev-learning-ai/cli.json`
  3. `dev-learning-ai` on PATH
  4. `<repo>/apps/cli/dist/bin.js`
- **Verified on 2026-10-14** in a live Claude desktop session (Windows): `/learn` shows "Learning on · 0 reviews due" and the status pane. Still unverified live: the offer band after a code-changing turn, the consent step, generation on the session model, and the quiz itself.
- **Gotcha:** the desktop app runs installed plugins from a CACHED copy (`~/.claude/plugins/cache/dev-learning-ai/...`), not from this folder. After editing the mod, bump `version` in `integrations/claude-code/.claude-plugin/plugin.json`, run `claude plugin update dev-learning-ai@dev-learning-ai`, then start a new session.
- The per-machine settings: `claude plugin configure dev-learning-ai@dev-learning-ai --values-stdin` sets the `cli` option. On the original machine, `ai.allow_host_model` is true in `~/.dev-learning-ai/config/config.yaml`.

## Not yet verified or built

- Live Claude Code session flow: offer, then consent, then generation on the session model, then the quiz. The mod is only tested with the official test kit.
- The Anthropic API provider has never been called against the live API.
- macOS and Linux have not been run locally; they are CI targets in `.github/workflows/ci.yml`.
- Not implemented: other agent adapters, OpenAI/Gemini providers, teach mode inside the agent, pre-task assessment, live documentation lookup, a SQLite backend, vault-provider extensions, and grading open answers on the host model. See `docs/roadmap.md`.

## Useful commands

- `pnpm dev:dashboard`: runs the dashboard on seeded demo data in `.dev-data/`. It never touches real data.
- `node apps/cli/dist/bin.js doctor`: diagnostics.
- `echo '{"op":"status","work":{"cwd":"<repo>"}}' | dev-learning-ai agent rpc`: the protocol the mod uses.
