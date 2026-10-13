# Architecture

dev-learning-ai is a pnpm monorepo of strict TypeScript packages. The learning engine does not depend on Claude Code, on any model vendor or on Obsidian. Integrations translate their world into the engine's contracts.

```text
apps/cli                     dev-learning-ai / dla command; interactive assessments; setup; agent protocol
packages/dashboard           local HTTP server + no-build SPA (public/)
packages/runtime             Node layer: storage, projects, discovery, config files, vaults, providers, service
packages/core                pure domain: no Node, no vendor SDK, no Claude Code import (lint-enforced)
integrations/claude-code     Claude Code mod (function hooks) — talks to the CLI over JSON stdin/stdout
examples/extension-graphql   example extension (concepts + CSV exporter) with contract tests
```

## Layers

| Layer | Where | Responsibility |
| --- | --- | --- |
| Domain | `core/src/domain`, `core/src/events` | Entities (projects, concepts, knowledge state, evidence, score changes), version scopes, the normalized event contract |
| Learning engine | `core/src/knowledge`, `core/src/assessment`, `core/src/scheduling` | Opportunity detection, question validation and runtime-generation prompts, evaluation, scoring, hierarchy aggregation, review scheduling |
| Configuration | `core/src/config`, `runtime/src/config-service.ts` | One schema; layered files; managed locks; diff, confirmation, history and rollback |
| AI providers | `core/src/providers`, `runtime/src/providers` | Capability discovery, privacy gates, budgets; host-delegated and direct providers |
| Storage | `runtime/src/store.ts`, `runtime/src/vault.ts` | Transactional JSON document store (source of truth); Markdown/Obsidian views |
| Integration | `runtime/src/agent-rpc.ts`, `integrations/claude-code` | Normalizes agent signals into events; runs host model requests |
| Interfaces | `apps/cli`, `packages/dashboard`, the mod's band and pane | All call `LearningService` — the same configuration and domain services |
| Extensions | `core/src/extensions`, `runtime/src/extensions.ts` | Versioned, permission-scoped contracts |

## The flow of a task

```text
Claude Code session
  prompt.submit ──► mod starts a per-turn accumulator (prompt text is never read)
  tool.call     ──► after the tool ran: file paths, line counts, identifiers, test runs
  turn.complete ──► one task.completed event ──► `dev-learning-ai agent rpc` (argv, stdin JSON)
                                                     │
                     LearningService.ingest ◄────────┘
                       ├─ validate + sanitize event, idempotency key (replays ignored)
                       ├─ detectOpportunities (deterministic rules; no model call)
                       ├─ practical-work evidence (exposure; application capped at 60%)
                       └─ offer (if post-task assessment applies and the task isn't urgent)
  band: "This task touched … 3 quick questions?"  [Start] [Later] [Skip]
  Start ──► prepare: generation requests (concept, redacted evidence, prior prompts of THIS project only)
        ──► host provider: the mod runs each request on $.model.complete (session model)
        ──► submit: parseGeneratedQuestions → validateQuestion → dedupe → assessment session
  answer ──► evaluateAnswer (correctness, reasoning, confidence, calibration matrix)
         ──► applyEvidence per scope (project; global when cross-project reuse is on)
         ──► SM-2 review scheduling, audit trail of every score change
  summary ──► plain-language explanation of what changed and when the next review is
```

With a direct provider (Anthropic API) the CLI and dashboard run generation themselves. Without any permitted model, the assessment is **deferred**: evidence is kept and nothing breaks.

## Key decisions

- **Questions are always generated at runtime.** The hand-written question set in `packages/core/test/fixtures` exists only so tests can exercise the engine without a live model; a lint rule keeps it out of product code.
- **Model output is untrusted data.** Generated questions must pass schema validation, answer-key checks, distractor distinctness, duplicate detection and provenance requirements. Open-answer grading by a model can move a rubric score by at most ±0.25.
- **Deterministic where possible.** Opportunity detection, scoring, scheduling, configuration and storage never call a model.
- **Two-phase generation for agents.** The engine prepares requests; the agent integration runs them on its own authorised session; the engine validates the replies. No credential ever crosses the boundary, and the engine never assumes an agent subscription authorises separate API calls.
- **No server needed for agents.** The mod invokes the CLI per event or per user action; the CLI holds the logic. This keeps the mod small and the engine testable.
- **JSON document store.** One file per collection, journaled atomic writes, inter-process lock, schema migrations, quarantine of corrupt files. No native dependency. A SQLite backend can replace it behind the `Store` boundary.

## Scopes

- **Global (developer-wide)**: your knowledge across projects.
- **Project**: how you applied concepts in one project, and project-specific concepts. Never visible from another project.
- **Technology / version**: a concept's `versionScope` places it in a version branch; aggregation is described in [scoring.md](scoring.md).
