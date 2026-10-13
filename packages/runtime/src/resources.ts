import type { ConceptCatalog, KnowledgeState, ResourceRecommendation } from "@dev-learning-ai/core";

/**
 * Learning-resource recommendations. The built-in list holds only official or
 * standards-body pages, curated by hand: they are NOT fetched at run time, so
 * each carries `retrievedAt: "curated"` and no publication date. External
 * lookup (when enabled) goes through resource-provider extensions.
 */

interface Curated {
  title: string;
  url: string;
  depth: ResourceRecommendation["depth"];
  version?: string;
}

const CURATED: Record<string, Curated[]> = {
  "javascript.async.promise-combinators": [
    {
      title: "MDN: Promise.allSettled()",
      url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled",
      depth: "reference",
    },
    {
      title: "MDN: Promise.all()",
      url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/all",
      depth: "reference",
    },
  ],
  "javascript.async.event-loop": [
    {
      title: "MDN: The event loop",
      url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Event_loop",
      depth: "intermediate",
    },
  ],
  "javascript.closures": [
    {
      title: "MDN: Closures",
      url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Closures",
      depth: "intro",
    },
  ],
  "react.rendering": [
    {
      title: "React: Preserving and resetting state",
      url: "https://react.dev/learn/preserving-and-resetting-state",
      depth: "intermediate",
    },
    { title: "React: Render and commit", url: "https://react.dev/learn/render-and-commit", depth: "intro" },
  ],
  "react.hooks.rules": [
    {
      title: "React: Rules of Hooks",
      url: "https://react.dev/reference/rules/rules-of-hooks",
      depth: "reference",
    },
  ],
  "react.hooks.effect-dependencies": [
    { title: "React: useEffect", url: "https://react.dev/reference/react/useEffect", depth: "reference" },
    {
      title: "React: You might not need an effect",
      url: "https://react.dev/learn/you-might-not-need-an-effect",
      depth: "advanced",
    },
  ],
  "react.performance.memoization": [
    { title: "React: useMemo", url: "https://react.dev/reference/react/useMemo", depth: "reference" },
  ],
  "react.18.transitions": [
    {
      title: "React: useTransition",
      url: "https://react.dev/reference/react/useTransition",
      depth: "reference",
      version: "18+",
    },
  ],
  "react.18.automatic-batching": [
    {
      title: "React: flushSync",
      url: "https://react.dev/reference/react-dom/flushSync",
      depth: "reference",
      version: "18+",
    },
  ],
  "react.19.actions": [
    {
      title: "React: useActionState",
      url: "https://react.dev/reference/react/useActionState",
      depth: "reference",
      version: "19",
    },
  ],
  "react.19.use-optimistic": [
    {
      title: "React: useOptimistic",
      url: "https://react.dev/reference/react/useOptimistic",
      depth: "reference",
      version: "19",
    },
  ],
  "react.transition.18-19": [
    {
      title: "React 19 Upgrade Guide",
      url: "https://react.dev/blog/2024/04/25/react-19-upgrade-guide",
      depth: "intermediate",
      version: "18 → 19",
    },
  ],
  "typescript.narrowing": [
    {
      title: "TypeScript Handbook: Narrowing",
      url: "https://www.typescriptlang.org/docs/handbook/2/narrowing.html",
      depth: "intermediate",
    },
  ],
  "typescript.generics": [
    {
      title: "TypeScript Handbook: Generics",
      url: "https://www.typescriptlang.org/docs/handbook/2/generics.html",
      depth: "intermediate",
    },
  ],
  "typescript.4-9.satisfies": [
    {
      title: "TypeScript 4.9 release notes",
      url: "https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html",
      depth: "reference",
      version: "4.9",
    },
  ],
  "nodejs.streams-backpressure": [
    { title: "Node.js: Stream API", url: "https://nodejs.org/api/stream.html", depth: "reference" },
  ],
  "nodejs.error-handling": [
    { title: "Node.js: process events", url: "https://nodejs.org/api/process.html", depth: "reference" },
  ],
  "nodejs.22.require-esm": [
    {
      title: "Node.js: Loading ES modules using require()",
      url: "https://nodejs.org/api/modules.html#loading-ecmascript-modules-using-require",
      depth: "reference",
      version: "22",
    },
  ],
  "sql.transactions-isolation": [
    {
      title: "PostgreSQL: Transaction Isolation",
      url: "https://www.postgresql.org/docs/current/transaction-iso.html",
      depth: "advanced",
    },
  ],
  "sql.indexes": [
    {
      title: "PostgreSQL: Multicolumn Indexes",
      url: "https://www.postgresql.org/docs/current/indexes-multicolumn.html",
      depth: "intermediate",
    },
  ],
  "http.status-codes": [
    { title: "RFC 9110: HTTP Semantics", url: "https://www.rfc-editor.org/rfc/rfc9110", depth: "reference" },
  ],
  "concurrency.idempotency": [
    {
      title: "RFC 9110 §9.2.2: Idempotent Methods",
      url: "https://www.rfc-editor.org/rfc/rfc9110#section-9.2.2",
      depth: "reference",
    },
  ],
  "security.authn-authz": [
    {
      title: "OWASP: Authorization Cheat Sheet",
      url: "https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html",
      depth: "intermediate",
    },
  ],
  "security.injection": [
    {
      title: "OWASP: SQL Injection Prevention Cheat Sheet",
      url: "https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html",
      depth: "intermediate",
    },
  ],
  "docker.layer-caching": [
    { title: "Docker: Build cache", url: "https://docs.docker.com/build/cache/", depth: "intermediate" },
  ],
};

/** Personalised: weak concepts first, intro material skipped once fundamentals are demonstrated. */
export function recommendResources(
  catalog: ConceptCatalog,
  states: Map<string, KnowledgeState>,
  opts: { conceptIds?: string[]; refresher?: boolean; limit?: number } = {},
): ResourceRecommendation[] {
  const ids = opts.conceptIds?.length
    ? opts.conceptIds
    : [...states.values()]
        .filter((s) => s.dimensions.mastery.evidence > 0)
        .sort((a, b) => a.dimensions.mastery.value - b.dimensions.mastery.value)
        .map((s) => s.conceptId);
  const out: ResourceRecommendation[] = [];
  for (const id of ids) {
    const st = states.get(id);
    const mastery = st?.dimensions.mastery.evidence ? st.dimensions.mastery.value : undefined;
    for (const r of CURATED[id] ?? []) {
      if (!opts.refresher && mastery !== undefined && mastery >= 0.8 && r.depth === "intro") continue;
      out.push({
        title: r.title,
        url: r.url,
        conceptId: id,
        why:
          mastery === undefined
            ? `${catalog.get(id)?.label ?? id} came up in your work and hasn't been assessed yet.`
            : mastery < 0.6
              ? `Mastery of ${catalog.get(id)?.label ?? id} is ${Math.round(mastery * 100)}% so far.`
              : `To deepen ${catalog.get(id)?.label ?? id}.`,
        gap: mastery !== undefined && mastery < 0.6 ? "low demonstrated mastery" : undefined,
        depth: r.depth,
        versionScope: r.version,
        retrievedAt: "curated",
        trust: "official",
      });
    }
  }
  return out.slice(0, opts.limit ?? 10);
}
