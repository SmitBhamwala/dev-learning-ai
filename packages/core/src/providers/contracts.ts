import type { Config } from "../config/schema.js";
import type { Resolved } from "../config/auto.js";
import type { ModelRequest } from "../assessment/generation.js";

/**
 * AI provider contract. Questions are always written by a model at runtime;
 * a provider is how a model call is made. Capabilities are discovered, never
 * assumed, and vendors are interchangeable.
 *
 * Two kinds of provider:
 * - Direct providers make the call themselves (e.g. the Anthropic API with the
 *   user's own key).
 * - The host provider delegates the call to the coding agent that raised the
 *   task (Claude Code Mods `$.model.complete`): the engine prepares requests,
 *   the agent's integration runs them on its own authorised session, and
 *   returns the replies for validation. No credential ever leaves the host.
 *
 * Scoring, scheduling, configuration and storage never call a model.
 */

export const PROVIDER_API_VERSION = 2;

export interface ModelInfo {
  id: string;
  displayName?: string;
  contextTokens?: number;
  /** Where this entry came from: the provider's own model listing, or the user's config. */
  source: "discovered" | "configured" | "host";
}

export interface ProviderCapabilities {
  isRemote: boolean;
  /** Requests are executed by the coding agent's host, not by this process. */
  isHostDelegated: boolean;
  /** Effort/reasoning levels the provider genuinely supports; empty when it has no such control. */
  efforts: string[];
  models: ModelInfo[];
}

export interface ProviderStatus {
  available: boolean;
  reason?: string;
}

export interface ProviderUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CompletionResult {
  text: string;
  usage: ProviderUsage;
  model?: string;
}

export interface AIProvider {
  readonly id: string;
  readonly displayName: string;
  /** False for registered-but-unimplemented vendors; selecting one fails with a clear message. */
  readonly isImplemented: boolean;
  status(): Promise<ProviderStatus>;
  capabilities(): Promise<ProviderCapabilities>;
  /** Direct providers only. Host-delegated providers return requests to their host instead. */
  complete?(
    req: ModelRequest,
    opts: { model?: string; effort?: string; signal: AbortSignal; timeoutMs: number },
  ): Promise<CompletionResult>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "unavailable"
      | "auth"
      | "rate-limit"
      | "timeout"
      | "invalid-output"
      | "budget"
      | "unsupported"
      | "server"
      | "network",
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** The coding agent's own model, reached through its integration (e.g. Claude Code Mods). */
export class HostModelProvider implements AIProvider {
  readonly id = "host";
  readonly displayName = "Coding agent's own model (via its integration)";
  readonly isImplemented = true;
  async status(): Promise<ProviderStatus> {
    return { available: true, reason: "available when an agent integration runs the requests" };
  }
  async capabilities(): Promise<ProviderCapabilities> {
    return {
      isRemote: true,
      isHostDelegated: true,
      efforts: [],
      models: [{ id: "session", displayName: "the session's model", source: "host" }],
    };
  }
}

export class UnimplementedProvider implements AIProvider {
  readonly isImplemented = false;
  constructor(
    readonly id: string,
    readonly displayName: string,
  ) {}
  async status(): Promise<ProviderStatus> {
    return {
      available: false,
      reason: `${this.displayName} is not implemented yet (contributions welcome: docs/providers.md)`,
    };
  }
  async capabilities(): Promise<ProviderCapabilities> {
    return { isRemote: true, isHostDelegated: false, efforts: [], models: [] };
  }
}

export class ProviderRegistry {
  private readonly providers = new Map<string, AIProvider>();
  constructor(initial: AIProvider[] = [new HostModelProvider()]) {
    for (const p of initial) this.register(p);
  }
  register(p: AIProvider): void {
    this.providers.set(p.id, p);
  }
  get(id: string): AIProvider | undefined {
    return this.providers.get(id);
  }
  list(): AIProvider[] {
    return [...this.providers.values()];
  }
}

export interface ProviderContext {
  /** True when the request comes from an agent integration that can run host requests. */
  hostAvailable: boolean;
}

export interface ResolvedProvider {
  provider?: AIProvider;
  model: Resolved<string | undefined>;
  effort: Resolved<string | undefined>;
  reason: string;
  warnings: string[];
  /** Set when no model may or can run: what the user can do about it. */
  unavailable?: string;
}

/**
 * Chooses provider, model and effort from configuration, privacy gates and
 * discovered capabilities. Never invents a model name and never silently
 * ignores an unsupported effort (it warns and lists the supported values).
 */
export async function resolveProvider(
  config: Config,
  registry: ProviderRegistry,
  ctx: ProviderContext,
): Promise<ResolvedProvider> {
  const warnings: string[] = [];
  const none = (reason: string, unavailable: string): ResolvedProvider => ({
    model: { value: undefined, reason: "no provider", isAuto: true },
    effort: { value: undefined, reason: "no provider", isAuto: true },
    reason,
    warnings,
    unavailable,
  });

  const usable = async (p: AIProvider): Promise<string | undefined> => {
    if (!p.isImplemented) return `${p.displayName} is not implemented yet`;
    const caps = await p.capabilities();
    if (caps.isHostDelegated) {
      if (!ctx.hostAvailable) return "no coding-agent integration is running this request";
      if (!config.ai.allow_host_model)
        return "ai.allow_host_model is false (enable it to let the agent's model write questions)";
      return undefined;
    }
    if (caps.isRemote && !config.ai.allow_remote_analysis) return "ai.allow_remote_analysis is false";
    const s = await p.status();
    return s.available ? undefined : (s.reason ?? "unavailable");
  };

  let provider: AIProvider | undefined;
  let reason: string;
  if (config.ai.provider === "auto") {
    const order = [registry.get("host"), ...registry.list().filter((p) => p.id !== "host")].filter(
      (p): p is AIProvider => Boolean(p),
    );
    const reasons: string[] = [];
    for (const p of order) {
      const problem = await usable(p);
      if (!problem) {
        provider = p;
        break;
      }
      if (p.isImplemented) reasons.push(`${p.id}: ${problem}`);
    }
    if (!provider) {
      return none(
        "auto: no model is permitted and available",
        `No AI model can write questions right now (${reasons.join("; ") || "no providers registered"}). The task's evidence is saved; run \`dev-learning-ai setup\` to enable the agent's model or a provider.`,
      );
    }
    reason = `auto: ${provider.displayName}`;
  } else {
    const p = registry.get(config.ai.provider);
    if (!p)
      return none(
        "unknown provider",
        `Unknown provider "${config.ai.provider}". Known: ${registry
          .list()
          .map((x) => x.id)
          .join(", ")}`,
      );
    const problem = await usable(p);
    if (problem) return none("requested provider unusable", `${p.displayName}: ${problem}`);
    provider = p;
    reason = "set explicitly";
  }

  const caps = await provider.capabilities();
  let model: Resolved<string | undefined>;
  if (caps.isHostDelegated) {
    model = { value: undefined, reason: "the agent session's own model", isAuto: true };
    if (config.ai.model !== "auto")
      warnings.push("ai.model does not apply to the host provider; the session's model is used");
  } else if (config.ai.model !== "auto") {
    if (caps.models.length > 0 && !caps.models.some((m) => m.id === config.ai.model)) {
      warnings.push(`Model "${config.ai.model}" was not in ${provider.displayName}'s model list`);
    }
    model = { value: config.ai.model, reason: "set explicitly", isAuto: false };
  } else if (caps.models.length > 0) {
    model = {
      value: caps.models[0]!.id,
      reason: `first model ${provider.displayName} listed (${caps.models[0]!.source})`,
      isAuto: true,
    };
  } else {
    return none("no model", `${provider.displayName} reported no models; set ai.model explicitly.`);
  }

  let effort: Resolved<string | undefined>;
  if (caps.efforts.length === 0) {
    if (config.ai.effort !== "auto")
      warnings.push(`${provider.displayName} has no effort control; "${config.ai.effort}" is ignored`);
    effort = {
      value: undefined,
      reason: "provider has no effort control",
      isAuto: config.ai.effort === "auto",
    };
  } else if (config.ai.effort === "auto") {
    const n = caps.efforts.length - 1;
    const idx = { minimal: 0, balanced: Math.floor(n / 2), generous: n, custom: 0 }[config.ai.token_budget];
    effort = {
      value: caps.efforts[idx],
      reason: `matches token_budget ${config.ai.token_budget}`,
      isAuto: true,
    };
  } else if (!caps.efforts.includes(config.ai.effort)) {
    warnings.push(
      `Effort "${config.ai.effort}" is not supported by ${provider.displayName}; supported: ${caps.efforts.join(", ")}`,
    );
    effort = {
      value: caps.efforts[0],
      reason: "requested effort unsupported; using the lowest supported",
      isAuto: false,
    };
  } else {
    effort = { value: config.ai.effort, reason: "set explicitly", isAuto: false };
  }
  return { provider, model, effort, reason, warnings };
}

/** Per-task and per-session model budgets. Exhaustion defers learning; it never breaks the coding session. */
export class ModelBudget {
  constructor(
    private readonly limits: { perTaskCalls: number; perSessionCalls: number; perTaskTokens: number },
  ) {}

  static fromConfig(config: Config): ModelBudget {
    return new ModelBudget({
      perTaskCalls: config.ai.max_model_calls_per_task,
      perSessionCalls: config.ai.max_model_calls_per_session,
      perTaskTokens: config.ai.max_tokens_per_task,
    });
  }

  /** `used` comes from persisted usage so the budget survives restarts. */
  check(
    used: { taskCalls: number; taskTokens: number; sessionCalls: number },
    estimatedTokens: number,
  ): { ok: boolean; reason?: string } {
    if (used.taskCalls >= this.limits.perTaskCalls)
      return { ok: false, reason: "per-task model-call budget reached" };
    if (used.sessionCalls >= this.limits.perSessionCalls)
      return { ok: false, reason: "per-session model-call budget reached" };
    if (used.taskTokens + estimatedTokens > this.limits.perTaskTokens)
      return { ok: false, reason: "per-task token budget would be exceeded" };
    return { ok: true };
  }

  get limitsSnapshot() {
    return { ...this.limits };
  }
}
