# Extensions (plugin SDK)

Extensions add concepts, review schedulers, AI providers, resource providers and report exporters. The API is versioned (`EXTENSION_API_VERSION = 1`). The host refuses extensions targeting an API version it does not support.

```ts
import { defineExtension, EXTENSION_API_VERSION } from "@dev-learning-ai/core";

export default defineExtension({
  id: "my-extension",
  name: "My extension",
  version: "1.0.0",
  apiVersion: EXTENSION_API_VERSION,
  permissions: ["write-knowledge", "reports"],
  activate(ctx) {
    ctx.registerConcepts([{ id: "graphql", technology: "graphql", label: "GraphQL", summary: "…", category: "fundamentals" }]);
    ctx.registerExporter({ id: "csv", extension: "csv", export: (report) => "…" });
  },
});
```

## Enabling

```yaml
plugins:
  enabled: ["@dev-learning-ai/example-extension-graphql", "./tools/my-extension.js"]
  permissions:
    example-graphql: [write-knowledge, reports]
```

`dev-learning-ai plugins` lists what loaded and what failed.

## Permissions

| Permission | Allows |
| --- | --- |
| `write-knowledge` | `registerConcepts`, `registerScheduler` |
| `network` | `registerProvider`, `registerResourceProvider` |
| `reports` | `registerExporter` |
| `read-knowledge` | reserved |

An extension gets only the intersection of what it declares and what you granted. A registration without the permission throws `ExtensionPermissionError`.

Extensions never receive raw storage, configuration or credentials. Concepts are schema-validated, and may not be project-specific. Providers go through the same privacy gates and budgets as built-in ones.

Extensions run in-process with your user's permissions, so only enable extensions you trust.

## Contract tests

`examples/extension-graphql/test/extension.test.ts` shows the expected contract:
- refused without permissions
- validated registrations
- unsupported API versions rejected
- exporter output

Copy it for your extension.
