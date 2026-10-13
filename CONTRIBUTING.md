# Contributing

Thanks for helping. This project values correctness, privacy and honesty about what works.

## Getting started

```bash
pnpm install && pnpm build && pnpm test
```

See [docs/development.md](docs/development.md) for every check, and [docs/architecture.md](docs/architecture.md) for how the pieces fit.

## Ground rules

- `packages/core` stays free of Node built-ins, vendor SDKs and Claude Code imports. `pnpm lint` enforces this.
- Never add a code path that sends prompts, whole files or transcripts anywhere. New data that leaves the machine needs a configuration gate and an entry in [docs/privacy.md](docs/privacy.md).
- Product questions are generated at runtime. The fixture question set is for tests only.
- Don't claim support you haven't verified. Adapters, providers and platforms are listed as implemented only once they have tests.
- Add or update tests with every behaviour change. Scoring changes need a new rule version and a docs update.
- Keep the mod fail-open: a learning failure must never block a coding session.

## Pull requests

Fill in the template. Small, focused PRs are easiest to review.

Before pushing, run `pnpm check`. When you touch `integrations/claude-code`, also run `pnpm mod:validate && pnpm mod:test`.

## Good first contributions

- An agent adapter (see [docs/adapters.md](docs/adapters.md)).
- A provider (see [docs/providers.md](docs/providers.md)).
- Concepts for a technology you know well, added through an extension (see [docs/extensions.md](docs/extensions.md)).
