import { stableHash } from "../domain/ids.js";
import type { Concept } from "../domain/model.js";
import { describeScope } from "../domain/version.js";
import { redactSecrets } from "../privacy/redact.js";
import { QUESTION_TYPES, OPEN_TYPES, validateQuestion, type Question } from "./question.js";
import { isDuplicateQuestion } from "./selection.js";

/**
 * Runtime question generation. Every question a learner sees is written by an
 * AI model at the moment it is needed, from the evidence of the task they just
 * did (or, for reviews, from the concept and their history), so a review is
 * always a new situation rather than a memorized question.
 *
 * This module is provider-neutral: it builds the request text and parses and
 * validates the reply. Who runs the model is decided elsewhere: the coding
 * agent's own model through its host API (Claude Code Mods `$.model.complete`),
 * or a configured provider such as the Anthropic API. Output that fails
 * validation is rejected, never shown.
 */

export const GENERATION_PROMPT_VERSION = "generate@1";

export interface GenerationRequest {
  concept: Concept;
  /** Why the concept is relevant now (from opportunity detection). */
  why?: string;
  /** Redacted evidence lines: file names, symbols, test outcomes. Never whole files. */
  evidence: string[];
  count: number;
  difficulty: number;
  installedVersion?: string;
  /** Prompts of questions already asked on this concept: the model must not repeat them. */
  avoidPrompts: string[];
  /** The previous question type, so the next one tests the concept differently. */
  lastType?: string;
  preferChoice: boolean;
  purpose: "post-task" | "review" | "study" | "interview";
}

export interface ModelRequest {
  system: string;
  prompt: string;
  maxTokens: number;
  /** Stable id so a replayed request can be recognised and its result reused. */
  requestKey: string;
}

export function buildGenerationRequest(req: GenerationRequest): ModelRequest {
  const c = req.concept;
  const scope = c.versionScope ? describeScope(c.versionScope) : "version-agnostic";
  const evidence = req.evidence.map((e) => redactSecrets(e).text.slice(0, 300)).slice(0, 20);
  const system = [
    "You write assessment questions for a software developer who wants to retain and deepen what they learn while working with AI coding agents.",
    "Rules:",
    "- Test understanding and reasoning, not trivia or memorized wording.",
    "- Ground each question in the task evidence when it is given; never ask about code that is not described.",
    "- Only state facts you are certain are true for the stated version scope. Never invent version numbers, APIs, or deprecations. If something depends on a version you are unsure of, choose a version-agnostic angle instead.",
    "- Multiple-choice distractors must be plausible but clearly distinguishable from the correct answer.",
    "- Every question needs a verified answer key and an explanation of why it is right.",
    "- Reply with JSON only, no prose and no code fences.",
  ].join("\n");
  const allowed = req.preferChoice ? QUESTION_TYPES.filter((t) => !OPEN_TYPES.includes(t)) : QUESTION_TYPES;
  const prompt = [
    `Concept: ${c.label} (${c.id})`,
    `Summary: ${c.summary}`,
    `Technology: ${c.technology}; version scope: ${scope}${req.installedVersion ? `; the project uses ${c.technology} ${req.installedVersion}` : ""}`,
    `Purpose: ${req.purpose}${req.why ? `. Relevance: ${req.why}` : ""}`,
    evidence.length
      ? `Task evidence:\n${evidence.map((e) => `- ${e}`).join("\n")}`
      : "Task evidence: none (write a concept-level question).",
    `Write ${req.count} question(s) at difficulty ${req.difficulty} on a 1-5 scale.`,
    `Allowed types: ${allowed.join(", ")}.${req.lastType ? ` Do not use the type "${req.lastType}" if another fits.` : ""} Vary the type across questions.`,
    req.avoidPrompts.length
      ? `Do not repeat or paraphrase these earlier questions; test the concept through a different situation:\n${req.avoidPrompts
          .slice(-8)
          .map((p) => `- ${p.slice(0, 200)}`)
          .join("\n")}`
      : "",
    "JSON shape:",
    `{"questions":[{"type":"single","difficulty":3,"objective":"...","prompt":"...","code":"optional snippet","codeLanguage":"optional","choices":[{"id":"a","text":"..."}],"correct":["a"],"reasoningSignals":[["synonym","synonym"],["another idea"]],"rubric":[{"id":"x","description":"...","weight":1,"anyOf":[["term"],["other","terms"]]}],"explanation":"...","ambiguity":"optional caveat"}]}`,
    "Use 'choices' and 'correct' for choice types (exactly one correct id unless type is 'multi'). Use 'rubric' instead for open types (explain-change, open, practical): each criterion lists alternative term sets that indicate it was met.",
    "'reasoningSignals' lists the key ideas a sound explanation would mention, each as a list of synonyms.",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    system,
    prompt,
    maxTokens: Math.min(4000, 700 * req.count + 300),
    requestKey: stableHash(
      `${GENERATION_PROMPT_VERSION}|${c.id}|${req.purpose}|${req.difficulty}|${evidence.join("|")}|${req.avoidPrompts.join("|")}`,
    ),
  };
}

export interface ParsedGeneration {
  questions: Question[];
  rejected: { index: number; issues: string[] }[];
}

/** Pulls the first JSON object out of a model reply (tolerating stray prose or fences). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("The model reply contained no JSON object");
  return JSON.parse(body.slice(start, end + 1));
}

export function parseGeneratedQuestions(
  replyText: string,
  ctx: {
    concept: Concept;
    evidence: string[];
    source: string;
    model?: string;
    existing: Question[];
    at: Date;
  },
): ParsedGeneration {
  let doc: unknown;
  try {
    doc = extractJson(replyText);
  } catch (err) {
    return { questions: [], rejected: [{ index: -1, issues: [(err as Error).message] }] };
  }
  const list = Array.isArray(doc) ? doc : (doc as { questions?: unknown }).questions;
  if (!Array.isArray(list))
    return { questions: [], rejected: [{ index: -1, issues: ["reply has no questions array"] }] };
  const questions: Question[] = [];
  const rejected: ParsedGeneration["rejected"] = [];
  list.slice(0, 10).forEach((raw, index) => {
    if (!raw || typeof raw !== "object") {
      rejected.push({ index, issues: ["not an object"] });
      return;
    }
    const r = raw as Record<string, unknown>;
    const candidate = {
      ...r,
      id: `gen_${stableHash(`${ctx.concept.id}|${String(r.prompt ?? "")}|${ctx.at.toISOString()}|${index}`)}`,
      conceptId: ctx.concept.id,
      versionScope: ctx.concept.versionScope,
      reasoningSignals: Array.isArray(r.reasoningSignals) ? r.reasoningSignals : [],
      provenance: {
        kind: "generated" as const,
        source: ctx.source,
        version: ctx.model,
        retrievedAt: ctx.at.toISOString(),
        evidence: ctx.evidence.length ? ctx.evidence.slice(0, 10) : [`concept:${ctx.concept.id}`],
      },
      tags: ["generated", GENERATION_PROMPT_VERSION],
    };
    const v = validateQuestion(candidate);
    if (!v.ok || !v.question) {
      rejected.push({ index, issues: v.issues });
      return;
    }
    if (isDuplicateQuestion(v.question, [...ctx.existing, ...questions])) {
      rejected.push({ index, issues: ["duplicate of an earlier question"] });
      return;
    }
    questions.push(v.question);
  });
  return { questions, rejected };
}

/** Request for grading an open answer or the reasoning behind a choice. Bounded by mergeProviderGrade. */
export function buildGradingRequest(
  question: Question,
  answerText: string,
  reasoning?: string,
): ModelRequest {
  const system =
    "You grade a developer's answer against a rubric. Be fair and specific. Reply with JSON only: " +
    '{"correctness":0..1,"reasoningScore":0..1,"notes":["one short, kind, specific note"]}';
  const prompt = [
    `Question: ${question.prompt}`,
    question.code ? `Code:\n${question.code}` : "",
    question.correct && question.choices
      ? `Correct answer: ${question.choices
          .filter((c) => question.correct!.includes(c.id))
          .map((c) => c.text)
          .join("; ")}`
      : "",
    question.rubric
      ? `Rubric:\n${question.rubric.map((c) => `- (${c.weight}) ${c.description}`).join("\n")}`
      : "",
    `Reference explanation: ${question.explanation}`,
    `Developer's answer: ${redactSecrets(answerText).text.slice(0, 3000)}`,
    reasoning ? `Developer's reasoning: ${redactSecrets(reasoning).text.slice(0, 3000)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    system,
    prompt,
    maxTokens: 400,
    requestKey: stableHash(`grade|${question.id}|${answerText}|${reasoning ?? ""}`),
  };
}

export function parseGrade(
  replyText: string,
): { correctness?: number; reasoningScore?: number; notes?: string[] } | undefined {
  try {
    const doc = extractJson(replyText) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && v >= 0 && v <= 1 ? v : undefined);
    return {
      correctness: num(doc.correctness),
      reasoningScore: num(doc.reasoningScore),
      notes: Array.isArray(doc.notes)
        ? doc.notes.filter((n): n is string => typeof n === "string").map((n) => n.slice(0, 300))
        : undefined,
    };
  } catch {
    return undefined;
  }
}
