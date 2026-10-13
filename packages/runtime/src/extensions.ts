import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ConceptSchema,
  ExtensionPermissionError,
  SUPPORTED_EXTENSION_API_VERSIONS,
  registerScheduler,
  type Config,
  type Extension,
  type ExtensionContext,
  type ExtensionPermission,
  type ReportExporter,
  type ResourceProvider,
} from "@dev-learning-ai/core";
import type { LearningService } from "./service.js";

/**
 * Loads extensions named in `plugins.enabled` and activates each with a
 * capability-scoped context. An extension only gets the permissions the user
 * granted in `plugins.permissions.<id>`; every registration is validated, and
 * nothing gives an extension raw storage, configuration or credentials.
 */

export interface LoadedExtensions {
  loaded: { id: string; name: string; version: string }[];
  failed: { spec: string; error: string }[];
  exporters: ReportExporter[];
  resourceProviders: ResourceProvider[];
}

export async function activateExtension(
  svc: LearningService,
  ext: Extension,
  granted: ExtensionPermission[],
  sink: Pick<LoadedExtensions, "exporters" | "resourceProviders">,
  log: (m: string) => void = () => undefined,
): Promise<void> {
  if (!SUPPORTED_EXTENSION_API_VERSIONS.includes(ext.apiVersion)) {
    throw new Error(
      `Extension ${ext.id} targets extension API v${ext.apiVersion}; supported: ${SUPPORTED_EXTENSION_API_VERSIONS.join(", ")}`,
    );
  }
  const permissions = new Set(granted.filter((p) => ext.permissions.includes(p)));
  const need = (p: ExtensionPermission) => {
    if (!permissions.has(p)) throw new ExtensionPermissionError(ext.id, p);
  };
  const pending: Promise<unknown>[] = [];
  const ctx: ExtensionContext = {
    apiVersion: ext.apiVersion,
    permissions,
    log: (m) => log(`[${ext.id}] ${String(m).slice(0, 500)}`),
    registerConcepts(concepts) {
      need("write-knowledge");
      for (const c of concepts) {
        const parsed = ConceptSchema.parse(c);
        if (parsed.projectId) throw new Error(`Extension ${ext.id} may not create project-specific concepts`);
        pending.push(svc.addConcept(parsed));
      }
    },
    registerScheduler(id, factory) {
      need("write-knowledge");
      registerScheduler(`${ext.id}/${id}`, factory);
    },
    registerProvider(provider) {
      need("network");
      if (svc.registry.get(provider.id)) throw new Error(`Provider id ${provider.id} is already registered`);
      // Provider calls still go through resolveProvider, so privacy gates and budgets apply.
      svc.registry.register(provider);
    },
    registerResourceProvider(provider) {
      need("network");
      sink.resourceProviders.push(provider);
    },
    registerExporter(exporter) {
      need("reports");
      sink.exporters.push(exporter);
    },
  };
  await ext.activate(ctx);
  await Promise.all(pending);
}

export async function loadExtensions(
  svc: LearningService,
  config: Config,
  baseDir: string,
): Promise<LoadedExtensions> {
  const out: LoadedExtensions = { loaded: [], failed: [], exporters: [], resourceProviders: [] };
  for (const spec of config.plugins.enabled) {
    try {
      const target =
        spec.startsWith(".") || isAbsolute(spec) ? pathToFileURL(resolve(baseDir, spec)).href : spec;
      const mod = (await import(target)) as { default?: Extension; extension?: Extension };
      const ext = mod.default ?? mod.extension;
      if (!ext || typeof ext.activate !== "function")
        throw new Error("module does not export an extension (default export)");
      await activateExtension(svc, ext, config.plugins.permissions[ext.id] ?? [], out);
      out.loaded.push({ id: ext.id, name: ext.name, version: ext.version });
    } catch (err) {
      out.failed.push({ spec, error: (err as Error).message });
    }
  }
  return out;
}
