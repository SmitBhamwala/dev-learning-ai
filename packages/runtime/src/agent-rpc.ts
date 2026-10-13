import { z } from "zod";
import { CONFIDENCE_LEVELS, normalizeEvent } from "@dev-learning-ai/core";
import { ServiceError, type LearningService } from "./service.js";

/**
 * The agent-integration protocol: one JSON request on stdin, one JSON reply
 * on stdout (`dev-learning-ai agent rpc`). It is how the Claude Code mod (and
 * any future agent adapter that can run a local command) talks to the engine
 * without a long-running server. Every request is validated; replies never
 * contain answer keys before an answer is submitted.
 */

export const AGENT_RPC_VERSION = 1;

const Work = z
  .object({ cwd: z.string().max(4096).optional(), sessionId: z.string().max(200).optional() })
  .default({});
const AnswerSchema = z.object({
  choiceIds: z.array(z.string().max(20)).max(20).optional(),
  text: z.string().max(5000).optional(),
  reasoning: z.string().max(5000).optional(),
  confidence: z.enum(CONFIDENCE_LEVELS).optional(),
});

export const AgentRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("status"), work: Work }),
  z.object({ op: z.literal("ingest"), work: Work, events: z.array(z.unknown()).min(1).max(100) }),
  z.object({
    op: z.literal("prepare"),
    work: Work,
    taskId: z.string().max(200).optional(),
    conceptIds: z.array(z.string().max(200)).max(20).optional(),
    kind: z.enum(["task", "review", "manual", "interview"]).default("task"),
    count: z.number().int().min(1).max(20).optional(),
  }),
  z.object({
    op: z.literal("submit"),
    work: Work,
    assessmentId: z.string().max(200),
    replies: z
      .array(
        z.object({
          requestKey: z.string().max(200),
          text: z.string().max(200_000),
          inputTokens: z.number().int().optional(),
          outputTokens: z.number().int().optional(),
        }),
      )
      .max(20),
    model: z.string().max(200).optional(),
  }),
  z.object({ op: z.literal("question"), work: Work, assessmentId: z.string().max(200) }),
  z.object({
    op: z.literal("answer"),
    work: Work,
    assessmentId: z.string().max(200),
    questionId: z.string().max(200),
    answer: AnswerSchema,
  }),
  z.object({ op: z.literal("skip"), work: Work, assessmentId: z.string().max(200) }),
  z.object({
    op: z.literal("end"),
    work: Work,
    assessmentId: z.string().max(200),
    how: z.enum(["deferred", "abandoned"]),
  }),
  z.object({
    op: z.literal("offer"),
    work: Work,
    taskId: z.string().max(200),
    decision: z.enum(["deferred", "declined", "paused"]),
  }),
  z.object({ op: z.literal("due"), work: Work }),
  /** Only sent after the person pressed an explicit "Allow" control in the agent's UI. */
  z.object({ op: z.literal("allow-host-model"), work: Work, confirmed: z.literal(true) }),
  z.object({
    op: z.literal("set-learning"),
    work: Work,
    enabled: z.boolean(),
    layer: z.enum(["global", "project", "session"]),
  }),
]);
export type AgentRequest = z.infer<typeof AgentRequestSchema>;

export type AgentReply =
  | { ok: true; version: number; result: unknown }
  | { ok: false; version: number; error: { code: string; message: string } };

export async function handleAgentRequest(svc: LearningService, raw: unknown): Promise<AgentReply> {
  const parsed = AgentRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      version: AGENT_RPC_VERSION,
      error: {
        code: "invalid",
        message: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")
          .slice(0, 500),
      },
    };
  }
  const req = parsed.data;
  const work = { ...req.work, hostAvailable: true };
  try {
    return { ok: true, version: AGENT_RPC_VERSION, result: await dispatch(svc, req, work) };
  } catch (err) {
    const code = err instanceof ServiceError ? err.code : "error";
    return {
      ok: false,
      version: AGENT_RPC_VERSION,
      error: { code, message: (err as Error).message.slice(0, 500) },
    };
  }
}

async function dispatch(
  svc: LearningService,
  req: AgentRequest,
  work: { cwd?: string; sessionId?: string; hostAvailable: boolean },
): Promise<unknown> {
  switch (req.op) {
    case "status": {
      const r = await svc.resolved(work);
      const resumable = await svc.resumable(work);
      const due = r.config.learning.spaced_repetition.enabled ? await svc.dueReviews(work) : [];
      return {
        enabled: r.config.learning.enabled && !r.project?.excludedFromLearning,
        mode: r.config.learning.mode,
        project: r.project ? { id: r.project.id, name: r.project.name } : undefined,
        allowHostModel: r.config.ai.allow_host_model,
        askReasoning: r.config.learning.reasoning_prompts !== "off",
        askConfidence: r.config.learning.confidence_tracking !== "off",
        dueReviews: due.length,
        resumable: resumable.map((s) => ({
          id: s.id,
          status: s.status,
          answered: s.items.filter((i) => i.evaluation).length,
          total: s.items.length,
        })),
      };
    }
    case "ingest": {
      const results = [];
      for (const e of req.events) {
        try {
          results.push(await svc.ingest(normalizeEvent(e), work));
        } catch (err) {
          results.push({ error: (err as Error).message.slice(0, 300) });
        }
      }
      return { results };
    }
    case "prepare":
      return svc.prepareAssessment(
        { kind: req.kind, taskId: req.taskId, conceptIds: req.conceptIds, count: req.count },
        work,
      );
    case "submit":
      return svc.submitGenerated(
        req.assessmentId,
        req.replies.map((r) => ({
          requestKey: r.requestKey,
          text: r.text,
          usage: { inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0 },
        })),
        { source: "host", model: req.model },
      );
    case "question":
      return (await svc.getAssessment(req.assessmentId)).question ?? null;
    case "answer":
      return svc.answer(req.assessmentId, req.questionId, req.answer, work);
    case "skip":
      return svc.skipQuestion(req.assessmentId);
    case "end":
      return svc.endAssessment(req.assessmentId, req.how);
    case "offer":
      if (req.decision === "paused") await svc.pauseTask(req.taskId);
      else await svc.setTaskOffer(req.taskId, req.decision);
      return { taskId: req.taskId, decision: req.decision };
    case "due":
      return svc.dueReviews(work);
    case "allow-host-model": {
      const loc = await svc.locate(work);
      return svc.config.apply([{ path: "ai.allow_host_model", value: true, layer: "global" }], {
        actor: "mod",
        ctx: loc.ctx,
        confirm: true,
        note: "allowed from the agent UI",
      });
    }
    case "set-learning": {
      const loc = await svc.locate(work);
      return svc.config.apply([{ path: "learning.enabled", value: req.enabled, layer: req.layer }], {
        actor: "mod",
        ctx: loc.ctx,
        confirm: true,
      });
    }
  }
}
