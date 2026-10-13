# AI providers

Questions are always generated at runtime by a model. A provider is how that model is reached (`packages/core/src/providers/contracts.ts`).

| Provider | Kind | Status |
| --- | --- | --- |
| `host` | The coding agent's own model, run by its integration (Claude Code: `$.model.complete` on the session model) | Implemented |
| `anthropic` | Anthropic API via the official TypeScript SDK; credentials from `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or an `ant auth login` profile | Implemented |
| `openai`, `gemini` | | Registered as not implemented |

## Selection (`ai.provider: auto`)

1. Inside an agent integration, with `ai.allow_host_model: true`: `host`.
2. Otherwise, with `ai.allow_remote_analysis: true`: the first implemented provider that reports it is available.
3. Otherwise, no provider: learning is **deferred** and the evidence kept (`ai.fallback: defer`), or an error is reported (`fail`).

## Models and effort

- Models come from the provider's own listing. The Anthropic provider calls the Models API and prefers `claude-opus-5-5` when the account lists it. A model is never invented. With no listing and `ai.model: auto`, the provider is unusable until you set `ai.model`.
- Effort is validated against what the provider reports. The Anthropic provider reports `low`, `medium`, `high`, `xhigh` and `max`. An unsupported effort produces a warning listing the valid values, and the lowest is used.
- On Claude models that support it, the Anthropic provider sends the server-side refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`), so a declined request is retried on a fallback model in the same call.

## Budgets

| Setting | Default |
| --- | --- |
| `ai.max_model_calls_per_task` | 2 |
| `ai.max_model_calls_per_session` | 10 |
| `ai.max_tokens_per_task` | 8000 |

Usage is persisted per assessment, so budgets survive restarts. When a budget is reached, learning is deferred rather than breaking anything.

## Writing a provider

Implement `AIProvider`: `status()`, `capabilities()` (report `isRemote`, `efforts` and discovered `models` truthfully), and `complete(request, { model, effort, signal, timeoutMs })` returning `{ text, usage }`. Throw `ProviderError` with a kind (`auth`, `rate-limit`, `timeout`, …). Register it from an extension that has the `network` permission. It is subject to the same privacy gates and budgets as built-in providers.
