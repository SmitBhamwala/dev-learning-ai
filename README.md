# dev-learning-ai

**AI can write your code. This tool helps you understand it, remember it, and become better at building software.**

dev-learning-ai works alongside AI coding agents. After a meaningful task it offers a few questions about what you just built, written at that moment by an AI model from the task's evidence. It evaluates your answer, your reasoning and your confidence, and gives feedback immediately. Then it schedules reviews that test the same concept through new questions, never the same one twice. Your knowledge is tracked across every project you work on, by technology and by version, and kept locally in files you own, including an Obsidian vault if you use one.

- **Learns from real work.** It observes the tasks you do with your agent; it does not invent busywork.
- **Assesses understanding, not activity.** Correctness, reasoning, confidence and retention are scored separately and explained.
- **Questions are generated at runtime.** Inside Claude Code, the session's own model writes them; elsewhere, a provider you configure. Every question is validated before you see it.
- **One install, every project.** Developer-wide knowledge follows you; project-specific architecture knowledge stays in its project.
- **Version-aware.** React fundamentals, React 18 and React 19 are scored separately, so a gap in a new release never lowers your fundamentals.
- **Local-first and private by default.** No model is used until you allow it, no whole files or prompts are ever sent, and the dashboard binds to loopback with a one-time token.

> Status: 0.1.0, early. See [What works today](#what-works-today) for exactly what is implemented and verified.

## Quick start

### With a coding agent (recommended)

Open a repository in Claude Code and say:

> Set up the dev-learning-ai developer learning platform for this codebase. Use Obsidian as the knowledge vault at `~/Documents/Obsidian/DevLearning`.

The agent runs `dev-learning-ai setup`. Setup inspects the repository, explains each change, asks before making any of them, and ends with a completion report. It never edits your application's source code or dependencies.

### Manually

```bash
npm install -g dev-learning-ai        # Node.js 22.12 or newer
cd your-repo
dev-learning-ai setup                  # guided: registration, vault, model permission
```

Then add the Claude Code integration (in a terminal session of Claude Code):

```bash
claude plugin marketplace add /path/to/dev-learning-ai/integrations/claude-code
```

```text
/plugin install dev-learning-ai@dev-learning-ai
```

If the `dev-learning-ai` command is not on the PATH that Claude Code sees (common on Windows), set the plugin's `cli` option to `node /path/to/dev-learning-ai/apps/cli/dist/bin.js` in the plugin configuration.

### From source

```bash
git clone <this repository> dev-learning-ai && cd dev-learning-ai
pnpm install && pnpm build
node apps/cli/dist/bin.js setup
```

## How it feels

1. You ask Claude Code to fix a race in a checkout form. It edits three files.
2. When the turn ends, a line appears above the prompt: *This task touched race conditions and effect dependencies. 3 quick questions?* You can choose **Start**, **Later** or **Skip**.
3. You press **Start**. The session's model writes questions grounded in the files and identifiers of that task, and dev-learning-ai checks each one has a verified answer key before showing it.
4. You answer, optionally say why, and say how sure you were. You get feedback immediately, for example: *"Right answer, but the reasoning didn't show why. Worth revisiting the explanation."*
5. A short summary explains what changed: *"Race conditions mastery increased from 45% to 61% because you answered correctly on a difficulty-3 new-variant question."* A review is scheduled for later, with a different question.

The CLI (`dev-learning-ai assess React 18`) and the local dashboard (`dev-learning-ai dashboard`) work too, with or without an agent.

## What works today

| Area | Status |
| --- | --- |
| CLI: projects, config, assess, review, knowledge, reports, export/backup/restore, doctor | Implemented, tested |
| Runtime question generation inside Claude Code (session model via Mods `$.model.complete`) | Implemented; verified with Claude Code's own plugin validator and test kit (2.1.295); not yet exercised in a live session by the authors |
| Runtime question generation via the Anthropic API (`ai.provider: anthropic`) | Implemented against the official SDK; not exercised against the live API in CI |
| OpenAI, Gemini and other providers | Registered as **not implemented** (contributions welcome) |
| Claude Code Mods integration: observation, offer band, assessment UI, `/learn`, pane, recovery | Implemented; validated and tested with Claude Code's official tooling |
| Other agents (Codex, Cursor, Gemini CLI, Copilot, Cline, Aider, …) | Not implemented; use `dev-learning-ai ingest` with the [event schema](docs/events.md) |
| Knowledge scoring (8 dimensions), version-aware hierarchy, spaced repetition (SM-2 variant) | Implemented, tested |
| Multi-project identity (clones, forks, worktrees, monorepos) | Implemented, tested |
| Markdown and Obsidian vaults with ownership markers | Implemented, tested (Obsidian is written as plain Markdown plus wiki-links) |
| Local dashboard (11 views, configuration with diff and rollback) | Implemented; security-tested; visually checked at 375 px and desktop, in light and dark |
| AI-assisted configuration (`config ask "…"`) | Deterministic phrase parser; validated, diffed, confirmed and audited |
| Extensions API with permissions | Implemented; one example extension with contract tests |
| SQLite storage backend | Not implemented (a JSON document store with journaled atomic writes is used) |

## Documentation

- [Architecture](docs/architecture.md): packages, layers and the flow of a task
- [Installation and setup](docs/installation.md)
- [CLI reference](docs/cli.md)
- [Configuration reference](docs/configuration.md)
- [Privacy](docs/privacy.md) and [Security](docs/security.md)
- [Scoring methodology](docs/scoring.md)
- [Event schema](docs/events.md) and [agent adapters](docs/adapters.md)
- [AI providers](docs/providers.md), [vaults](docs/vaults.md) and [extensions](docs/extensions.md)
- [Supported platforms and agents](docs/platforms.md)
- [Development, testing and releases](docs/development.md)
- [Roadmap](docs/roadmap.md)

## License

[MIT](LICENSE)
