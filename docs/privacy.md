# Privacy

## What is stored (locally, in `~/.dev-learning-ai`)

- Project metadata: id, name, checkout paths, git remote URLs with credentials stripped, and detected technologies with their provenance.
- Task summaries: changed file paths, line counts, short identifiers seen in changed code (for example `Promise.allSettled`), tool-call counts, and whether tests ran.
- Generated questions, your answers, reasoning and confidence, the evaluations, the evidence records and the score-change audit trail.
- Configuration and its change history.

What is **not** stored by default:

- prompts, because the Claude Code mod never reads the prompt text
- transcripts
- whole files
- code snippets beyond `privacy.store_code_snippets: minimal`, which keeps at most 12 redacted lines and applies only to excerpts an integration chooses to send (the Claude Code mod sends none)

## What is sent to a model, and when

Nothing is sent until you allow it:

- `ai.allow_host_model` covers the coding agent's own model.
- `ai.allow_remote_analysis` covers a separate provider.

When allowed, a question-generation request contains:

- the concept's name, summary and version scope
- the evidence lines that matched the concept, such as `files: src/checkout/Form.tsx` or `observed: useEffect, AbortController`. These are redacted and capped at 20 lines of 300 characters.
- the installed version of that technology
- earlier question prompts on the concept, from **this project or from non-project sessions only**, with other projects' names and paths stripped

A grading request (for open answers, with a direct provider only) contains the question, the rubric and your answer, redacted.

Never sent: whole files, prompts, transcripts, other projects' details, or credentials.

## Redaction

Secrets are redacted before storage and before anything is sent. This covers private keys, cloud and SaaS tokens (AWS, GitHub, Anthropic, OpenAI, Slack, Stripe, Google), JWTs, bearer tokens, credentials in connection strings, and `password=`/`token:`-style assignments. Redaction is pattern-based and cannot catch every format. Data minimisation is the primary control.

## Cross-project boundaries

- Project-scoped knowledge, tasks and assessments are visible only from that project.
- With `knowledge.allow_cross_project_reuse: true` (the default), answers also update developer-wide concept knowledge. Project details are never part of it.
- Turn reuse off to keep every project fully separate.

## Deleting data

| Command | What it deletes |
| --- | --- |
| `dev-learning-ai projects delete-data <id>` | one project's learning data, after you confirm |
| `dev-learning-ai review reset <concept>` | one concept's history |
| Dashboard → Assessments → **Delete answer text** | your written answers and reasoning in one assessment (scores kept) |
| `dev-learning-ai uninstall --all-data` | everything in the data directory (your vault is untouched) |
