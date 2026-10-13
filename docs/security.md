# Security model

## Trust boundaries

| Input | Treatment |
| --- | --- |
| Agent events (stdin of `agent rpc`, inbox files, `ingest`) | Schema-validated, bounded sizes, forbidden metadata keys stripped, idempotent |
| Model output (generated questions, grades) | Untrusted data: strict schema validation, answer-key and distractor checks, duplicate detection; grades bounded to ±0.25 of the rubric |
| Repository contents | Read for metadata only (manifests, lockfiles, git config); never executed; instructions in them are ignored |
| Configuration files | Schema-validated per value and as a whole; prototype-pollution keys refused |
| Dashboard requests | Authenticated, CSRF-protected, origin- and host-checked, bodies ≤ 64 KiB, field allow-list |
| Extensions | Run in-process with only the permissions granted in `plugins.permissions`; cannot reach raw storage, configuration or credentials through the context they receive |

## Dashboard

- Binds to `127.0.0.1` by default. Binding elsewhere needs `dashboard.allow_remote_access: true`, and the config schema refuses it otherwise.
- Access needs a random per-run token from the launch URL, exchanged once for an `HttpOnly; SameSite=Strict` session cookie.
- Mutating requests need the per-run CSRF header and a same-origin `Origin`. The `Host` header must be the bound loopback address, which defends against DNS rebinding.
- A strict CSP (`default-src 'none'`), `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, and no CORS headers.
- Static files come from a fixed map, with no path joins from the request URL. The UI builds DOM with `textContent`; a lint rule forbids `innerHTML`.
- Covered by `packages/dashboard/test/dashboard.test.ts`.

## Claude Code mod

Claude Code mods run with the permissions of the host process and are **not** a sandbox. The mod therefore keeps its footprint minimal:

- It never rewrites or blocks prompts or tool calls, and never adds permissions.
- It runs exactly one external program: the configured `dev-learning-ai` CLI, by argv (no shell), once per turn that changed code and once per user action.
- It calls the session's model only after the person pressed **Start**, and only after they allowed question writing.
- It fails open: if a hook throws or the CLI is missing, the hook is skipped and the session continues.

## Engine

- No shell execution in the core, runtime or dashboard packages, enforced by lint. The one exception is `doctor --check-agents`, which runs `claude --version` only when asked.
- Storage writes are atomic and journaled, under an inter-process lock. Corrupt collections are quarantined, never silently overwritten.
- Credentials for the Anthropic provider come from the SDK's own resolution and are never stored, logged or copied.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
