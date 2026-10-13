# CLI reference

The command is `dev-learning-ai`, with the alias `dla`. Every command accepts these options:

| Option | Meaning |
| --- | --- |
| `--json` | machine-readable output (errors become `{"error": {code, message}}`) |
| `-y, --yes` | confirm consequential changes without prompting |
| `-C, --cwd <path>` | act as if started in `<path>` |
| `--session <id>` | agent session id (session-scoped settings and budgets) |
| `--no-interactive` | never prompt; consequential changes then require `--yes` |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | error |
| 2 | usage error, or an identity conflict that needs `--same-project` / `--new-project` |
| 3 | needs confirmation (re-run with `--yes`) |
| 4 | not found |
| 5 | unavailable (e.g. no model may write questions; learning deferred) |

## Commands

| Command | Purpose |
| --- | --- |
| `init` | create or reuse the global installation |
| `setup [--vault <dir>] [--vault-provider obsidian\|markdown\|none] [--allow-host-model] [--install-mod] [--dry-run]` | guided setup |
| `register [path] [--name] [--product-group] [--same-project\|--new-project] [--no-project-file]` | register a repository |
| `projects list [--all]` · `inspect [id]` · `switch <id>` · `remove <id>` · `delete-data <id> [--remove-repo-files]` · `rebuild [path]` · `set-tech <tech> [version]` | manage projects (`remove` keeps history; `delete-data` asks first) |
| `status` | what is configured and what needs attention |
| `config get [key] [--origins]` · `set <key> <value> [--layer] [--dry-run]` · `unset <key>` · `ask "<request>"` · `history` · `rollback <id>` · `path` | configuration |
| `assess [topic…] [--task <id>] [--concept <ids…>] [-n] [--resume <id>] [--interview]` | assess a task, concepts, or a topic such as `React 18 and 19` |
| `interview [topic…]` | interview practice on interview-critical concepts |
| `session start [topic…]` · `stop [id]` · `summary [id]` · `list` | learning sessions |
| `review [--weak] [--interview-critical] [-n]` | review due concepts with new questions |
| `review due [--upcoming]` · `postpone <concept> <days>` · `suspend <concept>` · `resume <concept>` · `reset <concept>` · `why <concept>` | manage reviews |
| `weak-topics` | areas with low mastery or poor calibration |
| `knowledge [technology] [--dimension <d>]` | the knowledge hierarchy |
| `explain <concept>` | evidence and rules behind a concept's scores |
| `concepts [technology]` | list concept ids |
| `resources [concepts…] [--refresher]` | official documentation for your gaps |
| `report [weekly\|monthly] [--days n] [--out file] [--all-projects]` | reports (observed vs estimated) |
| `vault sync` · `vault check` | knowledge vault |
| `export --format json\|markdown --out <path>` · `backup [--out]` · `restore [file]` | data portability |
| `ingest --file <f> \| --stdin \| --inbox` | manual event ingestion (see [events.md](events.md)) |
| `agent rpc` | the agent-integration protocol (JSON on stdin and stdout) |
| `adapters` · `plugins` · `doctor [--check-agents]` | integrations and diagnostics |
| `dashboard [--port]` | local dashboard |
| `uninstall [--integration] [--project-registration <id>] [--caches] [--all-data]` | removal steps |
| `completion` | bash/zsh completion script |

## Examples

```bash
dla assess React 18 and 19
dla assess --concept sql.transactions-isolation -n 2
dla config ask "use a lower-cost model for routine assessments"
dla config set learning.questions_per_task 2 --layer project
dla review --weak
dla report monthly --out monthly.md
dla knowledge react --dimension retention
```
