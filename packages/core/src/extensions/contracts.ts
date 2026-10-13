import type { ConceptInput } from "../domain/model.js";
import type { LearningEvent } from "../events/events.js";
import type { ReviewScheduler } from "../scheduling/scheduler.js";
import type { AIProvider } from "../providers/contracts.js";

/**
 * Public extension API (versioned). Extensions contribute concepts (which the
 * runtime question generator then writes questions about), review schedulers, AI providers, agent adapters, resource providers
 * and report exporters. They receive a capability-scoped context, never raw
 * storage or configuration, so they cannot bypass privacy, storage or
 * security policies.
 *
 * Compatibility: an extension declares `apiVersion`. Minor additions keep the
 * same version; breaking changes bump it, and the host refuses extensions
 * whose apiVersion it does not support.
 */

export const EXTENSION_API_VERSION = 1;
export const SUPPORTED_EXTENSION_API_VERSIONS = [1];

export type ExtensionPermission = "read-knowledge" | "write-knowledge" | "network" | "reports";

export interface ResourceRecommendation {
  title: string;
  url: string;
  conceptId: string;
  why: string;
  gap?: string;
  depth: "intro" | "intermediate" | "advanced" | "reference";
  versionScope?: string;
  publishedAt?: string;
  retrievedAt: string;
  trust: "official" | "trusted" | "community" | "unverified";
}

export interface ResourceProvider {
  id: string;
  recommend(
    conceptIds: string[],
    ctx: { installedVersions: Record<string, string> },
  ): Promise<ResourceRecommendation[]>;
}

export interface ReportExporter {
  id: string;
  /** File extension without the dot. */
  extension: string;
  export(report: ExportableReport): string;
}

export interface ExportableReport {
  title: string;
  period: { from: string; to: string };
  sections: { heading: string; observed: string[]; estimated: string[] }[];
}

export interface AgentCapabilities {
  sessionLifecycle: boolean;
  promptObservation: boolean;
  toolObservation: boolean;
  turnCompletion: boolean;
  interactiveUi: boolean;
  commands: boolean;
}

export type Unsubscribe = () => Promise<void> | void;

export interface AdapterStatus {
  state: "ready" | "degraded" | "unavailable";
  detail?: string;
  hostVersion?: string;
}

/** Converts one coding agent's native signals into normalized LearningEvents. */
export interface AgentAdapter {
  readonly id: string;
  readonly capabilities: AgentCapabilities;
  initialize(context: { developerId: string; now: () => Date }): Promise<void>;
  subscribe(handler: (event: LearningEvent) => Promise<void>): Promise<Unsubscribe>;
  getStatus(): Promise<AdapterStatus>;
  dispose(): Promise<void>;
}

export interface ExtensionContext {
  apiVersion: number;
  permissions: ReadonlySet<ExtensionPermission>;
  log(message: string): void;
  registerConcepts(concepts: ConceptInput[]): void;
  registerScheduler(id: string, factory: () => ReviewScheduler): void;
  registerProvider(provider: AIProvider): void;
  registerResourceProvider(provider: ResourceProvider): void;
  registerExporter(exporter: ReportExporter): void;
}

export interface Extension {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  /** Permissions requested; the user grants them in plugins.permissions. */
  permissions: ExtensionPermission[];
  activate(ctx: ExtensionContext): void | Promise<void>;
}

export function defineExtension(ext: Extension): Extension {
  return ext;
}

export class ExtensionPermissionError extends Error {
  constructor(extensionId: string, permission: ExtensionPermission) {
    super(
      `Extension ${extensionId} needs the "${permission}" permission (grant it in plugins.permissions.${extensionId})`,
    );
    this.name = "ExtensionPermissionError";
  }
}
