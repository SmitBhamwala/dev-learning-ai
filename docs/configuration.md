# Configuration reference

One schema (`packages/core/src/config/schema.ts`) is shared by the CLI, the dashboard, AI-assisted configuration and every integration.

## Layers and precedence

Later layers win:

```text
built-in defaults → global (~/.dev-learning-ai/config/config.yaml)
                  → project (<repo>/.dev-learning-ai/config.yaml)
                  → workspace (<repo>/<workspace>/.dev-learning-ai/config.yaml)
                  → session (per agent session, stored in the database)
                  → managed (organization; applied last and locked)
```

- Objects merge key by key; arrays and scalars replace.
- A setting in `managed.yaml` cannot be changed by any other layer. Attempts are refused with an explanation.
- `dev-learning-ai config get --origins` shows which layer supplied each value.
- Each value is validated on its own and the merged result is validated as a whole, so an invalid value hidden by a higher layer is still refused.

## Changing settings

All interfaces use the same validated path:

1. compute the diff
2. ask for confirmation when a setting is privacy- or security-relevant (marked below), or when the change came from natural language and is consequential
3. write the layer file atomically
4. record the change in `config/history/history.jsonl` together with the previous file content
5. `config rollback <id>` restores that content, and the rollback is recorded as well

AI-assisted configuration (`config ask "…"`) parses recognised phrasings into explicit operations. Anything it doesn't recognise is reported and ignored, never guessed.

## Settings

`auto` means the value is resolved per task, and the reason is shown in `status` and the dashboard.

| Key | Default | Notes |
| --- | --- | --- |
| `learning.enabled` | `true` | Off: nothing is recorded; coding unaffected |
| `learning.mode` | `auto` | `observe` · `collaborate` · `teach` · `auto` (never interrupts urgent/incident work) |
| `learning.post_task_assessment` | `true` | Offer questions after meaningful tasks |
| `learning.pre_task_assessment` | `false` | Reserved (not implemented) |
| `learning.questions_per_task` | `3` | 1–20 |
| `learning.difficulty` | `auto` | 1–5 or auto (follows demonstrated mastery) |
| `learning.reasoning_prompts` | `optional` | `off` · `optional` · `required` |
| `learning.confidence_tracking` | `optional` | `off` · `optional` · `required` |
| `learning.interview_mode` | `false` | Harder, reasoning required |
| `learning.socratic_mode` | `false` | Reserved (not implemented) |
| `learning.adaptive_questions` | `true` | Difficulty and variant selection follow evidence |
| `learning.min_changed_lines_for_assessment` | `10` | Smaller changes are recorded, not assessed |
| `learning.spaced_repetition.enabled` / `.algorithm` / `.max_reviews_per_day` | `true` / `sm2` / `20` | Algorithm is replaceable by extensions |
| `learning.knowledge_health.enabled` / `.dependency_insights` | `true` / `false` | Neutral learning-health indicators |
| `learning.version_scope.default` | `current` | `current` · `agnostic` · `latest` |
| `ai.allow_host_model` ! | `false` | Let the coding agent's own model write questions |
| `ai.allow_remote_analysis` ! | `false` | Let a separately configured provider receive task evidence |
| `ai.provider` ! | `auto` | `auto` · `host` · `anthropic` (others not implemented) |
| `ai.model` | `auto` | Must be a model the provider lists; never invented |
| `ai.effort` | `auto` | Validated against the provider's reported efforts |
| `ai.token_budget` | `balanced` | `minimal` caps questions at 2 and picks the lowest effort |
| `ai.max_model_calls_per_task` / `_per_session` / `max_tokens_per_task` | `2` / `10` / `8000` | Exhaustion defers learning, keeps evidence |
| `ai.fallback` | `defer` | `defer` or `fail` when no model may/can run |
| `ai.timeout_ms` | `30000` | Per model call |
| `knowledge.provider` ! | `markdown` | `markdown` · `obsidian` · `none` |
| `knowledge.vault_path` ! | `""` | Required for `obsidian` |
| `knowledge.vault_folder` | `DeveloperKnowledge` | Folder inside the vault |
| `knowledge.allow_cross_project_reuse` | `true` | Project work also updates developer-wide knowledge |
| `resources.external_lookup` ! | `ask` | For resource-provider extensions |
| `privacy.store_full_transcripts` ! | `false` | Transcripts are never needed |
| `privacy.store_code_snippets` ! | `minimal` | `none` · `minimal` (≤12 redacted lines) · `full` |
| `privacy.redact_secrets` ! | `true` | Pattern-based; not a guarantee |
| `privacy.send_project_metadata_to_providers` ! | `false` | Reserved |
| `dashboard.host` ! / `.port` / `.allow_remote_access` ! | `127.0.0.1` / `auto` / `false` | Non-loopback host requires `allow_remote_access` |
| `events.sampling_rate` / `.max_queue` | `1` / `1000` | High-volume sessions |
| `projects.excluded_paths` | `[]` | Reserved |
| `plugins.enabled` ! / `plugins.permissions` ! | `[]` / `{}` | See [extensions.md](extensions.md) |

`!` marks settings that need confirmation to change.

## Example

```yaml
schema_version: 1
learning:
  mode: auto
  questions_per_task: 3
  difficulty: auto
ai:
  allow_host_model: true
  token_budget: balanced
knowledge:
  provider: obsidian
  vault_path: /Users/me/Documents/Obsidian/DevLearning
privacy:
  store_code_snippets: minimal
```
