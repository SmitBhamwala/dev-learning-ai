# Installation and setup

Requirements: Node.js 22.12 or newer. Windows, macOS and Linux.

## Global installation

```bash
npm install -g dev-learning-ai
dev-learning-ai init
```

`init` creates the global data directory, or reuses an existing one. It never creates a separate database per repository.

| Location | Default |
| --- | --- |
| Data directory | `~/.dev-learning-ai` (all platforms); `$XDG_DATA_HOME/dev-learning-ai` on Linux when set |
| Override | `DEV_LEARNING_AI_HOME=/path` |
| Organization-managed settings | `<data>/config/managed.yaml`, or `DEV_LEARNING_AI_MANAGED_CONFIG=/path` |

```text
~/.dev-learning-ai/
├── config/        config.yaml, managed.yaml (optional), history/ (audit log)
├── database/      one JSON file per collection + lock + journal
├── backups/       dev-learning-ai backup
├── inbox/         events integrations drop for later import
├── vault/         default Markdown vault (if you don't choose one)
├── cache/  logs/  projects/
```

## Register repositories

```bash
cd ~/code/shop && dev-learning-ai register
cd ~/code/api  && dev-learning-ai register
dev-learning-ai projects list
```

Registration writes `.dev-learning-ai/project.yaml`, which holds only a stable id and name and is safe to commit. Pass `--no-project-file` to keep it out of the repository.

- **Clones** with a matching git remote join the same project automatically.
- **Git worktrees** join their repository automatically.
- **Forks or copies** with an unrelated remote stop and ask. Re-run with `--same-project` or `--new-project`; the latter writes a local, git-ignored identity.
- **Moved repositories** are detected when the old path no longer exists. You can also run `dev-learning-ai projects rebuild`.
- **Monorepos** (npm/pnpm/yarn workspaces, lerna, nx, turbo, rush) are detected, and technologies are recorded per workspace.

## Guided setup

`dev-learning-ai setup` performs, in order:

1. inspects the repository, runtime and coding agent
2. explains each planned change
3. asks for confirmation (`--yes` to accept, `--dry-run` to only show the plan)
4. creates or reuses the installation
5. registers the project and records detected technologies
6. configures the vault (creating the folder, and `.obsidian/` for an Obsidian vault)
7. records whether the agent's model may write questions
8. registers the Claude Code mod, only with `--install-mod` and a second confirmation
9. syncs the vault
10. runs the same checks as `doctor`
11. prints a completion report

It never rewrites existing agent configuration silently, never adds permissions and never changes your application's code or dependencies. Every configuration change it makes is recorded and can be undone with `dev-learning-ai config rollback <id>`.

## Claude Code integration

From a terminal Claude Code session:

```bash
claude plugin marketplace add /path/to/dev-learning-ai/integrations/claude-code
```

```text
/plugin install dev-learning-ai@dev-learning-ai
```

Plugin options:

- `cli`: how to run the CLI. Default `dev-learning-ai`. Use `node /abs/path/apps/cli/dist/bin.js` when the command isn't on the PATH Claude Code sees. On Windows, npm's `.cmd` shims may not be runnable without a shell, so prefer the `node …` form there.
- `showStatus`: the `learn: N due` status-line indicator.

To try the mod without installing, start a session with `claude --plugin-dir /path/to/integrations/claude-code`.

Claude Code may run an installed plugin from a cached copy under `~/.claude/plugins/cache/` instead of from this folder (the Claude desktop app does). After changing the mod, bump `version` in `integrations/claude-code/.claude-plugin/plugin.json`, run `claude plugin update dev-learning-ai@dev-learning-ai`, and start a new session. `claude plugin list` shows the version installed.

## Enabling question generation

Questions are written by a model, and no model is used until you allow it:

- Inside Claude Code: press **Allow** when the band asks, or run `dev-learning-ai config set ai.allow_host_model true --yes`.
- CLI and dashboard via the Anthropic API: set `ANTHROPIC_API_KEY` (or sign in with `ant auth login`), then run `dev-learning-ai config set ai.allow_remote_analysis true --yes` and `dev-learning-ai config set ai.provider anthropic --yes`.

See [privacy.md](privacy.md) for exactly what is sent.

## Uninstall

`dev-learning-ai uninstall` lists the separate steps. Removing the integration, unregistering a project, deleting caches and deleting all learning history are separate commands. Your vault is never deleted by them.
