import type {
  AIProvider,
  CompletionResult,
  ModelRequest,
  ProviderCapabilities,
  ProviderStatus,
} from "../../src/index.js";
import { FIXTURE_QUESTIONS } from "./bank.js";

/**
 * A scripted stand-in for a real model, for tests only. It "generates"
 * questions by reading the concept id from the generation prompt and
 * returning fixture questions for it in the JSON shape a model is asked for.
 * Every request it receives is recorded so tests can assert what would have
 * been sent to a provider (e.g. that no other project's details leak).
 */
export class FakeModelProvider implements AIProvider {
  readonly id = "fake";
  readonly displayName = "Fake model (tests)";
  readonly isImplemented = true;
  readonly requests: ModelRequest[] = [];
  private served = new Map<string, number>();

  constructor(
    private readonly opts: { isRemote?: boolean; reply?: (req: ModelRequest) => string; fail?: boolean } = {},
  ) {}

  async status(): Promise<ProviderStatus> {
    return { available: true };
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      isRemote: this.opts.isRemote ?? false,
      isHostDelegated: false,
      efforts: ["low", "high"],
      models: [{ id: "fake-1", source: "configured" }],
    };
  }

  async complete(req: ModelRequest): Promise<CompletionResult> {
    this.requests.push(req);
    if (this.opts.fail) throw new Error("simulated provider failure");
    const text = this.opts.reply ? this.opts.reply(req) : fakeReply(req, this.served);
    return { text, usage: { calls: 1, inputTokens: 100, outputTokens: 200 }, model: "fake-1" };
  }
}

export function fakeReply(
  req: ModelRequest | { prompt: string },
  served = new Map<string, number>(),
): string {
  const conceptId = /^Concept: .*\(([^)]+)\)$/m.exec(req.prompt)?.[1] ?? "";
  const count = Number(/Write (\d+) question/.exec(req.prompt)?.[1] ?? 1);
  const pool = FIXTURE_QUESTIONS.filter((q) => q.conceptId === conceptId);
  const start = served.get(conceptId) ?? 0;
  const picked = Array.from(
    { length: Math.min(count, pool.length) },
    (_, i) => pool[(start + i) % pool.length]!,
  );
  served.set(conceptId, start + picked.length);
  return JSON.stringify({
    questions: picked.map(
      ({ id: _id, conceptId: _c, provenance: _p, tags: _t, versionScope: _v, ...rest }) => rest,
    ),
  });
}
