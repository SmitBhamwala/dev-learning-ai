# Knowledge vaults (Markdown and Obsidian)

The JSON database is the source of truth for scoring and scheduling. The vault is a synchronized, human-readable view that you own.

```text
<vault>/DeveloperKnowledge/
├── Index.md
├── Concepts/<concept-id>.md          developer-wide scores, review, change history, related concepts
├── Technologies/<Tech>/Index.md      the version-aware hierarchy
├── Projects/<Project>.md             technologies with provenance, project-specific knowledge, recent tasks
├── Assessments/<date> <id>.md        questions, your answers and feedback
└── Reviews/Schedule.md
```

- **Obsidian** (`knowledge.provider: obsidian`): links are wiki-links (`[[Concepts/react.rendering|Rendering]]`). Setup creates `.obsidian/` in a new folder so Obsidian recognises it as a vault.
- **Markdown** (`markdown`): standard links. Works in any editor or git repository.
- Sync happens with `dev-learning-ai vault sync`, from the dashboard (Diagnostics → **Sync vault now**), and during setup.

## Ownership and conflicts

- Generated notes carry `dla_managed: true` in their frontmatter. Their content sits between `<!-- dev-learning-ai:begin … -->` and `<!-- dev-learning-ai:end -->`.
- **Text you write outside those markers is preserved** on every sync.
- If a note without the marker already exists at a target path, it is yours. It is never overwritten: the generated note is written beside it as `<name> (dev-learning-ai).md`, and the conflict is reported.

## Availability

`dev-learning-ai vault check` validates the path, write permission and Obsidian markers. If the vault is missing or not writable, learning continues and sync is skipped with an explanation.

## Writing a vault provider

Vault providers are currently built into `packages/runtime/src/vault.ts`. The extension API does not yet expose a vault-provider registration; see the [roadmap](roadmap.md).
