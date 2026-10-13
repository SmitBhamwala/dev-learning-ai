import { ConceptSchema, type Concept, type ConceptInput } from "../domain/model.js";

/**
 * The built-in concept catalog: a curated, version-aware starting hierarchy.
 * Concepts are the stable unit of learning; questions are replaceable
 * instruments that test them. Extensions and projects add more concepts.
 *
 * Version facts here are limited to well-documented release changes; each
 * version-specific concept names the release that introduced the behaviour.
 */

const C = (c: ConceptInput): ConceptInput => c;

const RAW: ConceptInput[] = [
  // ── JavaScript ──────────────────────────────────────────────
  C({
    id: "javascript",
    technology: "javascript",
    label: "JavaScript",
    summary: "The language and its runtime semantics.",
    category: "fundamentals",
  }),
  C({
    id: "javascript.async.promise-combinators",
    technology: "javascript",
    parent: "javascript",
    label: "Promise combinators",
    summary: "Promise.all, allSettled, race and any: when each settles and how failures propagate.",
    category: "fundamentals",
    interviewCritical: true,
    related: ["concurrency.race-conditions", "http.retries-backoff"],
    signals: { keywords: ["Promise.all", "Promise.allSettled", "Promise.race", "Promise.any"] },
  }),
  C({
    id: "javascript.async.event-loop",
    technology: "javascript",
    parent: "javascript",
    label: "Event loop and microtasks",
    summary: "Ordering of synchronous code, microtasks (promise reactions) and macrotasks (timers, I/O).",
    category: "fundamentals",
    interviewCritical: true,
    signals: { keywords: ["setTimeout", "queueMicrotask", "process.nextTick", "await"] },
  }),
  C({
    id: "javascript.closures",
    technology: "javascript",
    parent: "javascript",
    label: "Closures and captured values",
    summary:
      "Functions capture bindings, not snapshots; stale values arise when a closure outlives the state it read.",
    category: "fundamentals",
    interviewCritical: true,
    signals: { keywords: ["closure", "callback"] },
  }),

  // ── Concurrency (technology-independent) ────────────────────
  C({
    id: "concurrency",
    technology: "concurrency",
    label: "Concurrency",
    summary: "Correctness when work overlaps in time.",
    category: "fundamentals",
  }),
  C({
    id: "concurrency.race-conditions",
    technology: "concurrency",
    parent: "concurrency",
    label: "Race conditions",
    summary: "Outcomes that depend on the interleaving of operations; check-then-act and lost updates.",
    category: "fundamentals",
    interviewCritical: true,
    related: ["sql.transactions-isolation", "concurrency.idempotency"],
    signals: { keywords: ["race", "mutex", "lock", "atomic", "concurrent", "debounce", "AbortController"] },
  }),
  C({
    id: "concurrency.idempotency",
    technology: "concurrency",
    parent: "concurrency",
    label: "Idempotency",
    summary:
      "Operations that can be applied more than once with the same effect; idempotency keys for retries.",
    category: "architecture",
    interviewCritical: true,
    related: ["http.retries-backoff"],
    signals: { keywords: ["idempotent", "idempotency", "dedupe", "Idempotency-Key"] },
  }),

  // ── React ───────────────────────────────────────────────────
  C({
    id: "react",
    technology: "react",
    label: "React",
    summary: "Component model, rendering and hooks.",
    category: "fundamentals",
    signals: { imports: ["react"] },
  }),
  C({
    id: "react.rendering",
    technology: "react",
    parent: "react",
    label: "Rendering and reconciliation",
    summary: "What triggers a render, how reconciliation matches elements, and why keys matter.",
    category: "fundamentals",
    interviewCritical: true,
    signals: { paths: ["**/*.jsx", "**/*.tsx"], keywords: ["key=", "re-render", "rerender"] },
  }),
  C({
    id: "react.hooks.rules",
    technology: "react",
    parent: "react",
    label: "Rules of Hooks",
    summary: "Hooks are called unconditionally, in the same order, from components or custom hooks.",
    category: "fundamentals",
    signals: { keywords: ["useState", "useEffect", "useMemo", "useCallback", "useRef"] },
  }),
  C({
    id: "react.hooks.effect-dependencies",
    technology: "react",
    parent: "react",
    label: "Effect dependencies and stale closures",
    summary:
      "useEffect re-runs when dependencies change; missing dependencies capture stale values; cleanup runs before re-run.",
    category: "fundamentals",
    interviewCritical: true,
    related: ["javascript.closures"],
    signals: { keywords: ["useEffect", "useLayoutEffect", "dependency array", "exhaustive-deps"] },
  }),
  C({
    id: "react.performance.memoization",
    technology: "react",
    parent: "react",
    label: "Memoization",
    summary: "React.memo, useMemo and useCallback: when skipping work pays off and when it does not.",
    category: "performance",
    signals: { keywords: ["React.memo", "useMemo", "useCallback", "memo("] },
  }),
  C({
    id: "react.18.automatic-batching",
    technology: "react",
    parent: "react",
    label: "Automatic batching",
    summary:
      "Since React 18 (with createRoot), state updates in timeouts, promises and native handlers are batched too.",
    category: "version-specific",
    versionScope: { kind: "range", from: "18", to: "19" },
    signals: { keywords: ["flushSync", "createRoot", "batch"] },
  }),
  C({
    id: "react.18.transitions",
    technology: "react",
    parent: "react",
    label: "Transitions",
    summary:
      "startTransition / useTransition mark updates as non-urgent so urgent input stays responsive (React 18+).",
    category: "version-specific",
    versionScope: { kind: "range", from: "18", to: "19" },
    signals: { keywords: ["startTransition", "useTransition", "useDeferredValue", "isPending"] },
  }),
  C({
    id: "react.19.actions",
    technology: "react",
    parent: "react",
    label: "Actions and useActionState",
    summary:
      "React 19 Actions: async transitions that manage pending state, errors and forms; useActionState returns [state, action, isPending].",
    category: "version-specific",
    versionScope: { kind: "specific", version: "19" },
    signals: { keywords: ["useActionState", "useFormStatus", "action={"] },
  }),
  C({
    id: "react.19.use-optimistic",
    technology: "react",
    parent: "react",
    label: "useOptimistic",
    summary:
      "React 19 hook that shows an optimistic value while an async Action is pending and reverts when it settles.",
    category: "version-specific",
    versionScope: { kind: "specific", version: "19" },
    signals: { keywords: ["useOptimistic"] },
  }),
  C({
    id: "react.transition.18-19",
    technology: "react",
    parent: "react",
    label: "Migrating React 18 → 19",
    summary:
      "Removed legacy APIs (ReactDOM.render, string refs, propTypes checks), ref as a prop for function components.",
    category: "transition",
    versionScope: { kind: "migration", from: "18", to: "19" },
    signals: { keywords: ["ReactDOM.render", "forwardRef", "propTypes", "defaultProps"] },
  }),

  // ── TypeScript ──────────────────────────────────────────────
  C({
    id: "typescript",
    technology: "typescript",
    label: "TypeScript",
    summary: "Static types for JavaScript.",
    category: "fundamentals",
    signals: { paths: ["**/*.ts", "**/*.tsx"] },
  }),
  C({
    id: "typescript.narrowing",
    technology: "typescript",
    parent: "typescript",
    label: "Narrowing, unknown and any",
    summary: "Control-flow narrowing, type guards and discriminated unions; why unknown is safer than any.",
    category: "fundamentals",
    interviewCritical: true,
    signals: { keywords: ["unknown", "typeof", "instanceof", " is ", "discriminated"] },
  }),
  C({
    id: "typescript.generics",
    technology: "typescript",
    parent: "typescript",
    label: "Generics and constraints",
    summary: "Type parameters, constraints with extends, and inference from arguments.",
    category: "fundamentals",
    signals: { keywords: ["<T", "extends keyof", "generic"] },
  }),
  C({
    id: "typescript.4-9.satisfies",
    technology: "typescript",
    parent: "typescript",
    label: "The satisfies operator",
    summary: "TypeScript 4.9+: checks a value against a type without widening the value's inferred type.",
    category: "version-specific",
    versionScope: { kind: "range", from: "4.9", to: "5" },
    signals: { keywords: ["satisfies"] },
  }),

  // ── Node.js ─────────────────────────────────────────────────
  C({
    id: "nodejs",
    technology: "nodejs",
    label: "Node.js",
    summary: "Server-side JavaScript runtime.",
    category: "fundamentals",
  }),
  C({
    id: "nodejs.error-handling",
    technology: "nodejs",
    parent: "nodejs",
    label: "Async error handling",
    summary:
      "Unhandled promise rejections terminate the process by default (since Node.js 15); errors in callbacks vs promises.",
    category: "fundamentals",
    interviewCritical: true,
    signals: { keywords: ["unhandledRejection", "uncaughtException", "try {", ".catch("] },
  }),
  C({
    id: "nodejs.streams-backpressure",
    technology: "nodejs",
    parent: "nodejs",
    label: "Streams and backpressure",
    summary: "write() returning false, the 'drain' event, and pipeline() for error propagation and cleanup.",
    category: "performance",
    signals: { keywords: ["pipeline(", "createReadStream", "drain", "Readable", "Writable"] },
  }),
  C({
    id: "nodejs.22.require-esm",
    technology: "nodejs",
    parent: "nodejs",
    label: "require() of ES modules",
    summary:
      "Node.js 22.12 enabled require() of synchronous ES module graphs by default; graphs with top-level await still cannot be required.",
    category: "version-specific",
    versionScope: { kind: "specific", version: "22" },
    signals: { keywords: ["require(", "ERR_REQUIRE_ESM", "ERR_REQUIRE_ASYNC_MODULE"] },
  }),

  // ── SQL / PostgreSQL ────────────────────────────────────────
  C({
    id: "sql",
    technology: "sql",
    label: "SQL databases",
    summary: "Relational data, queries and transactions.",
    category: "fundamentals",
  }),
  C({
    id: "sql.transactions-isolation",
    technology: "sql",
    parent: "sql",
    label: "Transactions and isolation",
    summary: "Atomicity, isolation levels and the anomalies each prevents; SELECT ... FOR UPDATE.",
    category: "fundamentals",
    interviewCritical: true,
    related: ["concurrency.race-conditions"],
    signals: { keywords: ["BEGIN", "COMMIT", "ROLLBACK", "transaction", "FOR UPDATE", "isolation"] },
  }),
  C({
    id: "sql.indexes",
    technology: "sql",
    parent: "sql",
    label: "Indexes",
    summary: "B-tree indexes, composite column order, and when the planner can use an index.",
    category: "performance",
    interviewCritical: true,
    signals: { keywords: ["CREATE INDEX", "EXPLAIN", "index"] },
  }),
  C({
    id: "sql.migrations",
    technology: "sql",
    parent: "sql",
    label: "Schema migrations",
    summary: "Evolving a schema safely: expand/contract, backfills, locks and rollback plans.",
    category: "architecture",
    signals: {
      paths: ["**/migrations/**", "**/migrate/**", "**/*.sql", "**/prisma/schema.prisma"],
      keywords: ["ALTER TABLE", "migration"],
    },
  }),

  // ── HTTP / APIs ─────────────────────────────────────────────
  C({
    id: "http",
    technology: "http",
    label: "HTTP and APIs",
    summary: "Protocol semantics and API design.",
    category: "fundamentals",
  }),
  C({
    id: "http.status-codes",
    technology: "http",
    parent: "http",
    label: "Status codes and error semantics",
    summary: "4xx vs 5xx, 401 vs 403, 409, 422 and 429, and what clients should do with each.",
    category: "fundamentals",
    signals: { keywords: ["status(", "res.status", "401", "403", "404", "409", "422", "429", "500"] },
  }),
  C({
    id: "http.retries-backoff",
    technology: "http",
    parent: "http",
    label: "Retries and backoff",
    summary: "Which failures to retry, exponential backoff with jitter, and why retries need idempotency.",
    category: "architecture",
    interviewCritical: true,
    related: ["concurrency.idempotency"],
    signals: { keywords: ["retry", "backoff", "jitter", "Retry-After"] },
  }),

  // ── Security ────────────────────────────────────────────────
  C({
    id: "security",
    technology: "security",
    label: "Application security",
    summary: "Protecting users and data.",
    category: "security",
  }),
  C({
    id: "security.authn-authz",
    technology: "security",
    parent: "security",
    label: "Authentication vs authorization",
    summary: "Who you are vs what you may do; object-level authorization checks on every request.",
    category: "security",
    interviewCritical: true,
    signals: {
      paths: ["**/auth/**", "**/*auth*"],
      keywords: ["authorize", "permission", "role", "session", "login"],
    },
  }),
  C({
    id: "security.token-validation",
    technology: "security",
    parent: "security",
    label: "Token validation",
    summary: "Verifying JWT signatures with a pinned algorithm, and checking exp, iss and aud claims.",
    category: "security",
    interviewCritical: true,
    signals: { keywords: ["jwt", "jsonwebtoken", "verify(", "Bearer", "decode("] },
  }),
  C({
    id: "security.injection",
    technology: "security",
    parent: "security",
    label: "Injection",
    summary: "Parameterized queries and why string concatenation of untrusted input is unsafe.",
    category: "security",
    interviewCritical: true,
    signals: { keywords: ["query(", "exec(", "raw(", "${"] },
  }),

  // ── Testing ─────────────────────────────────────────────────
  C({
    id: "testing",
    technology: "testing",
    label: "Testing",
    summary: "Verifying behaviour.",
    category: "testing",
  }),
  C({
    id: "testing.test-doubles",
    technology: "testing",
    parent: "testing",
    label: "Test doubles",
    summary: "Stubs, mocks, fakes and spies, and the risk of tests coupled to implementation details.",
    category: "testing",
    signals: {
      paths: ["**/*.test.*", "**/*.spec.*", "**/__tests__/**"],
      keywords: ["mock", "vi.fn", "jest.fn", "stub", "spy"],
    },
  }),
  C({
    id: "testing.flaky-tests",
    technology: "testing",
    parent: "testing",
    label: "Flaky tests",
    summary:
      "Non-determinism from time, ordering, shared state and real I/O; how to make tests deterministic.",
    category: "testing",
    signals: { keywords: ["flaky", "retry", "sleep(", "setTimeout", "waitFor"] },
  }),

  // ── Performance ─────────────────────────────────────────────
  C({
    id: "performance",
    technology: "performance",
    label: "Performance",
    summary: "Making software fast enough.",
    category: "performance",
  }),
  C({
    id: "performance.complexity",
    technology: "performance",
    parent: "performance",
    label: "Algorithmic complexity",
    summary: "Big-O of common operations; replacing nested scans with indexed lookups.",
    category: "performance",
    interviewCritical: true,
    signals: { keywords: [".find(", ".includes(", ".indexOf(", "new Map", "new Set", "O(n"] },
  }),
  C({
    id: "performance.caching",
    technology: "performance",
    parent: "performance",
    label: "Caching and invalidation",
    summary: "Cache keys, TTLs, invalidation strategies and stampedes.",
    category: "performance",
    signals: { keywords: ["cache", "ttl", "memoize", "redis", "stale-while-revalidate"] },
  }),

  // ── Docker ──────────────────────────────────────────────────
  C({
    id: "docker",
    technology: "docker",
    label: "Docker",
    summary: "Container images and runtime.",
    category: "fundamentals",
    signals: { paths: ["**/Dockerfile", "**/docker-compose*.yml", "**/compose*.yaml"] },
  }),
  C({
    id: "docker.layer-caching",
    technology: "docker",
    parent: "docker",
    label: "Image layers and build cache",
    summary:
      "Instruction order and the build cache: copy manifests and install dependencies before copying source.",
    category: "performance",
    signals: { paths: ["**/Dockerfile"], keywords: ["COPY", "RUN npm", "RUN pip", "--mount=type=cache"] },
  }),
];

export const BUILTIN_CONCEPTS: Concept[] = RAW.map((c) => ConceptSchema.parse(c));

export class ConceptCatalog {
  private readonly byId = new Map<string, Concept>();

  constructor(concepts: Concept[] = BUILTIN_CONCEPTS) {
    for (const c of concepts) this.add(c);
  }

  add(concept: ConceptInput): Concept {
    const parsed = ConceptSchema.parse(concept);
    if (parsed.parent && !this.byId.has(parsed.parent) && parsed.parent !== parsed.technology) {
      throw new Error(`Concept ${parsed.id} names unknown parent ${parsed.parent}`);
    }
    this.byId.set(parsed.id, parsed);
    return parsed;
  }

  get(id: string): Concept | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  all(): Concept[] {
    return [...this.byId.values()];
  }

  ids(): Set<string> {
    return new Set(this.byId.keys());
  }

  technologies(): string[] {
    return [...new Set(this.all().map((c) => c.technology))].sort();
  }

  children(id: string): Concept[] {
    return this.all().filter((c) => c.parent === id);
  }

  forTechnology(tech: string): Concept[] {
    return this.all().filter((c) => c.technology === tech);
  }

  /** Concepts visible from a project: shared ones plus that project's own. Never another project's. */
  visibleTo(projectId?: string): Concept[] {
    return this.all().filter((c) => !c.projectId || c.projectId === projectId);
  }
}
