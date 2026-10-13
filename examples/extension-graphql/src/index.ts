import { defineExtension, EXTENSION_API_VERSION, type ExportableReport } from "@dev-learning-ai/core";

/**
 * Example extension: adds GraphQL concepts (which the runtime question
 * generator then writes questions about) and a CSV report exporter.
 *
 * Enable it in configuration:
 *   plugins:
 *     enabled: ["@dev-learning-ai/example-extension-graphql"]
 *     permissions:
 *       example-graphql: [write-knowledge, reports]
 */

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function reportToCsv(report: ExportableReport): string {
  const rows = [["section", "kind", "text"]];
  for (const s of report.sections) {
    for (const o of s.observed) rows.push([s.heading, "observed", o]);
    for (const e of s.estimated) rows.push([s.heading, "estimated", e]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\n");
}

export default defineExtension({
  id: "example-graphql",
  name: "GraphQL concepts and CSV reports",
  version: "0.1.0",
  apiVersion: EXTENSION_API_VERSION,
  permissions: ["write-knowledge", "reports"],
  activate(ctx) {
    ctx.registerConcepts([
      {
        id: "graphql",
        technology: "graphql",
        label: "GraphQL",
        summary: "Typed query language and runtime for APIs.",
        category: "fundamentals",
        signals: { imports: ["graphql", "@apollo/server"] },
      },
      {
        id: "graphql.n-plus-one",
        technology: "graphql",
        parent: "graphql",
        label: "N+1 queries in resolvers",
        summary:
          "Field resolvers that query per parent item; batching with a DataLoader-style cache per request.",
        category: "performance",
        interviewCritical: true,
        signals: { keywords: ["DataLoader", "resolver", "batchLoad"], paths: ["**/resolvers/**"] },
      },
    ]);
    ctx.registerExporter({ id: "csv", extension: "csv", export: reportToCsv });
    ctx.log("registered GraphQL concepts and the CSV exporter");
  },
});
