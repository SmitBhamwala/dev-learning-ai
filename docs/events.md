# Event schema (v1)

Every agent integration converts its signals into `LearningEvent`s (`packages/core/src/events/events.ts`, validated with zod).

```ts
interface LearningEvent {
  id: string;
  schemaVersion: 1;
  type:
    | "session.started" | "session.ended" | "task.started" | "task.progressed" | "task.completed"
    | "code.changed" | "test.completed" | "pr.created" | "pr.reviewed"
    | "assessment.started" | "assessment.completed";
  timestamp: string;            // ISO 8601 with offset
  source: { providerId: string; providerVersion?: string; sessionId?: string };
  developerId: string;
  projectId?: string;           // usually resolved from repository.root
  correlationId?: string;       // ties a task's events together across turns and restarts
  repository?: { root?: string; branch?: string; remote?: string; workspace?: string };
  task?: {
    id: string; title?: string; urgency?: "normal" | "urgent" | "incident";
    turns?: number; toolCalls?: Record<string, number>;
    tests?: { ran: number; failed: number };
    status?: "in-progress" | "completed" | "aborted";
  };
  changes?: { path: string; kind?: "added" | "modified" | "deleted" | "renamed";
              linesAdded?: number; linesRemoved?: number; language?: string;
              symbols?: string[];       // short identifiers, ≤ 50, ≤ 80 chars each
              excerpt?: string }[];     // dropped unless privacy.store_code_snippets allows; redacted
  technologies?: { technology: string; version?: string }[];
  metadata?: Record<string, unknown>;   // keys like prompt/transcript/token/secret are stripped; ≤ 4 KiB
}
```

## Semantics

- Events with the same task id accumulate into one task. `task.completed` triggers opportunity detection and possibly an offer.
- **Idempotency**: `type + providerId + sessionId + correlationId/task.id + projectId + sorted change paths` forms a key. A replayed event is acknowledged with `duplicate: true` and ignored.
- `urgency: "incident"` means no questions are offered.

## Manual ingestion

For agents without a native adapter:

```bash
dev-learning-ai ingest --file events.json        # one event or an array
some-agent-hook | dev-learning-ai ingest --stdin
```

Integrations that cannot run a command synchronously can drop JSON files into `~/.dev-learning-ai/inbox/`. They are imported by `dev-learning-ai ingest --inbox` and by most commands.
