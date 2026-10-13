import Anthropic from "@anthropic-ai/sdk";
import {
  ProviderError,
  type AIProvider,
  type CompletionResult,
  type ModelInfo,
  type ModelRequest,
  type ProviderCapabilities,
  type ProviderStatus,
} from "@dev-learning-ai/core";

/**
 * Anthropic API provider (direct). Credentials come from the SDK's own
 * resolution (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login`
 * profile); this product never stores, logs or copies them. Models are
 * discovered from the Models API, never hard-coded guesses; the preferred
 * default is used only when the account's model list contains it.
 */

const PREFERRED_DEFAULT = "claude-opus-5-5";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];
/** Models that accept the server-side refusal fallback in its "default" form on the Claude API. */
const FALLBACK_DEFAULT_MODELS = new Set([
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);

export interface AnthropicProviderOptions {
  client?: Anthropic;
  env?: NodeJS.ProcessEnv;
}

export class AnthropicProvider implements AIProvider {
  readonly id = "anthropic";
  readonly displayName = "Anthropic API";
  readonly isImplemented = true;
  private readonly env: NodeJS.ProcessEnv;
  private clientInstance?: Anthropic;
  private discovered?: ModelInfo[];

  constructor(opts: AnthropicProviderOptions = {}) {
    this.env = opts.env ?? process.env;
    this.clientInstance = opts.client;
  }

  private get client(): Anthropic {
    this.clientInstance ??= new Anthropic({ maxRetries: 2 });
    return this.clientInstance;
  }

  private hasCredentialHint(): boolean {
    return Boolean(
      this.env.ANTHROPIC_API_KEY ||
        this.env.ANTHROPIC_AUTH_TOKEN ||
        this.env.ANTHROPIC_PROFILE ||
        this.clientInstance,
    );
  }

  async status(): Promise<ProviderStatus> {
    if (!this.hasCredentialHint()) {
      return {
        available: false,
        reason: "no Anthropic credentials found (set ANTHROPIC_API_KEY or run `ant auth login`)",
      };
    }
    return { available: true };
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return { isRemote: true, isHostDelegated: false, efforts: [...EFFORTS], models: await this.models() };
  }

  /** Lists models from the Models API; on failure returns none rather than guessing. */
  async models(): Promise<ModelInfo[]> {
    if (this.discovered) return this.discovered;
    if (!this.hasCredentialHint()) return [];
    try {
      const out: ModelInfo[] = [];
      for await (const m of this.client.models.list({ limit: 100 })) {
        out.push({
          id: m.id,
          displayName: m.display_name,
          contextTokens: m.max_input_tokens ?? undefined,
          source: "discovered",
        });
      }
      const preferred = out.findIndex((m) => m.id === PREFERRED_DEFAULT);
      if (preferred > 0) out.unshift(...out.splice(preferred, 1));
      this.discovered = out;
      return out;
    } catch {
      return [];
    }
  }

  async complete(
    req: ModelRequest,
    opts: { model?: string; effort?: string; signal: AbortSignal; timeoutMs: number },
  ): Promise<CompletionResult> {
    if (!opts.model)
      throw new ProviderError("No model selected for the Anthropic provider; set ai.model", "unsupported");
    const effort = EFFORTS.includes(opts.effort as Effort) ? (opts.effort as Effort) : undefined;
    const useFallback = FALLBACK_DEFAULT_MODELS.has(opts.model);
    try {
      const response = await this.client.beta.messages.create(
        {
          model: opts.model,
          max_tokens: Math.max(req.maxTokens, 2000),
          system: req.system,
          messages: [{ role: "user", content: req.prompt }],
          ...(effort ? { output_config: { effort } } : {}),
          ...(useFallback
            ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
            : {}),
        },
        { signal: opts.signal, timeout: opts.timeoutMs },
      );
      if (response.stop_reason === "refusal") {
        throw new ProviderError("The model declined this request", "invalid-output");
      }
      const text = response.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("\n")
        .trim();
      if (!text)
        throw new ProviderError(
          `Empty reply (stop reason: ${response.stop_reason ?? "unknown"})`,
          "invalid-output",
          true,
        );
      return {
        text,
        model: response.model,
        usage: {
          calls: 1,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new ProviderError("Anthropic rejected the credentials", "auth");
      }
      if (err instanceof Anthropic.NotFoundError)
        throw new ProviderError(`Model "${opts.model}" was not found for this account`, "unsupported");
      if (err instanceof Anthropic.RateLimitError)
        throw new ProviderError("Rate limited by the Anthropic API", "rate-limit", true);
      if (err instanceof Anthropic.BadRequestError)
        throw new ProviderError(`Request rejected: ${err.message.slice(0, 200)}`, "unsupported");
      if (err instanceof Anthropic.APIConnectionTimeoutError)
        throw new ProviderError("The Anthropic request timed out", "timeout", true);
      if (err instanceof Anthropic.APIConnectionError)
        throw new ProviderError("Could not reach the Anthropic API", "network", true);
      if (err instanceof Anthropic.APIError)
        throw new ProviderError(`Anthropic API error ${err.status ?? ""}`.trim(), "server", true);
      throw err;
    }
  }
}
