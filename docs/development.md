# Development

```bash
pnpm install
pnpm build            # tsc -b across packages
pnpm test             # vitest: core, runtime, dashboard, example extension, end-to-end
pnpm typecheck        # also type-checks tests and scripts
pnpm lint             # architecture/safety rules (scripts/lint.mjs)
pnpm format:check
pnpm mod:validate     # claude plugin validate integrations/claude-code
pnpm mod:test         # claude plugin test integrations/claude-code
pnpm check            # format, lint, build, typecheck, test
pnpm dev:dashboard    # dashboard on demo data in .dev-data/ (never your real data)
```

## Tests

| Suite | Covers |
| --- | --- |
| `packages/core/test` | config precedence and validation, natural-language config, version scopes, events, question validation, generation parsing, evaluation and calibration, scoring, scheduling, hierarchy, selection, opportunities, redaction, provider resolution |
| `packages/runtime/test` | store transactions and crash recovery, project identity (clones, forks, worktrees, monorepos), config service with managed locks and rollback, the learning flow, host two-phase generation and restart recovery, cross-project boundaries, deferral, backup and restore, vault ownership |
| `packages/dashboard/test` | authentication, CSRF, Host/Origin checks, static file map, field allow-list, answer-key hiding |
| `examples/*/test` | extension contract tests |
| `tests/e2e` | the 14-step lifecycle from the specification |
| `integrations/claude-code/tests` | the mod under Claude Code's own test kit |

A scripted `FakeModelProvider` (`packages/core/test/fixtures/fake-provider.ts`) stands in for the model in tests. It replays hand-verified fixture questions as if a model had written them, so the validation and scoring paths are exercised realistically.

## Releases

1. Update `CHANGELOG.md` and the versions in every `package.json` and `integrations/claude-code/.claude-plugin/plugin.json`.
2. Run `pnpm check`, `pnpm mod:validate` and `pnpm mod:test`.
3. Tag `vX.Y.Z`. CI runs on all platforms.
4. Publish `@dev-learning-ai/core`, `@dev-learning-ai/runtime`, `@dev-learning-ai/dashboard` and `dev-learning-ai` in dependency order (`pnpm -r publish`).

## Migration policy

- **Database:** `DB_SCHEMA_VERSION` with ordered, idempotent migrations in `packages/runtime/src/store.ts`. A database from a newer version is refused, never rewritten.
- **Configuration:** `schema_version` in every file. Unknown keys are refused with a message.
- **Scoring:** every score change records its rule version. A new rule version is added alongside the old one and documented in `docs/scoring.md`, and history is not rewritten.
- **Extension API and agent protocol:** versioned (`EXTENSION_API_VERSION`, `AGENT_RPC_VERSION`). Breaking changes bump the version.
