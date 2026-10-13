import { CONFIDENCE_LABELS, CONFIDENCE_LEVELS, type Confidence } from "@dev-learning-ai/core";
import type {
  LearningService,
  PreparedAssessment,
  QuestionView,
  WorkContext,
} from "@dev-learning-ai/runtime";
import { ask, c } from "./ui.js";

/**
 * The terminal assessment flow: one question at a time, optional reasoning and
 * confidence, immediate feedback, then the next question, then a summary.
 */
export async function runInteractive(
  svc: LearningService,
  prepared: PreparedAssessment,
  work: WorkContext,
): Promise<void> {
  if (prepared.status === "deferred") {
    console.log(c.yellow(`Deferred: ${prepared.reason ?? "no model available"}`));
    return;
  }
  for (const w of prepared.warnings) console.log(c.dim(`note: ${w}`));
  let q: QuestionView | undefined = prepared.question;
  if (!q) {
    console.log(c.yellow(`Assessment ${prepared.assessmentId} is ${prepared.status}.`));
    return;
  }
  console.log(
    c.dim("Answer with the letter(s). Enter `s` to skip a question, `q` to stop (progress is saved)."),
  );
  while (q) {
    const pq = q.question;
    console.log("");
    console.log(
      `${c.bold(q.progress)} ${c.dim(`· ${q.conceptLabel} · ${pq.type} · difficulty ${pq.difficulty}`)}`,
    );
    console.log(pq.prompt);
    if (pq.code)
      console.log(
        c.cyan(
          pq.code
            .split("\n")
            .map((l) => `    ${l}`)
            .join("\n"),
        ),
      );
    let choiceIds: string[] | undefined;
    let text: string | undefined;
    if (pq.choices) {
      for (const ch of pq.choices) console.log(`  ${c.bold(ch.id)}) ${ch.text}`);
      for (;;) {
        const raw = (
          await ask(pq.isMultiSelect ? "Your answer (e.g. a,c): " : "Your answer: ")
        ).toLowerCase();
        if (raw === "q") return stopped(prepared.assessmentId);
        if (raw === "s") break;
        const ids = raw.split(/[\s,]+/).filter(Boolean);
        if (
          ids.length &&
          ids.every((i) => pq.choices!.some((ch) => ch.id === i)) &&
          (pq.isMultiSelect || ids.length === 1)
        ) {
          choiceIds = ids;
          break;
        }
        console.log(
          c.yellow(
            `Pick ${pq.isMultiSelect ? "one or more of" : "one of"}: ${pq.choices.map((ch) => ch.id).join(", ")}`,
          ),
        );
      }
    } else {
      const raw = await ask("Your answer (one paragraph): ");
      if (raw.toLowerCase() === "q") return stopped(prepared.assessmentId);
      if (raw.toLowerCase() !== "s") text = raw;
    }
    if (!choiceIds && !text) {
      const r = await svc.skipQuestion(prepared.assessmentId);
      q = r.next;
      if (r.summary) printSummary(r.summary.lines);
      continue;
    }
    let reasoning: string | undefined;
    if (q.askReasoning && pq.choices) {
      reasoning =
        (await ask(q.requireReasoning ? "Why? (required): " : c.dim("Why? (optional, Enter to skip): "))) ||
        undefined;
      while (q.requireReasoning && !reasoning)
        reasoning = (await ask("Reasoning is required in this mode: ")) || undefined;
    }
    let confidence: Confidence | undefined;
    if (q.askConfidence) {
      const labels = CONFIDENCE_LEVELS.map((l, i) => `${i + 1}=${CONFIDENCE_LABELS[l]}`).join("  ");
      for (;;) {
        const raw = await ask(
          c.dim(`Confidence ${labels}${q.requireConfidence ? "" : " (Enter to skip)"}: `),
        );
        if (!raw && !q.requireConfidence) break;
        const n = Number(raw);
        if (n >= 1 && n <= 4) {
          confidence = CONFIDENCE_LEVELS[n - 1];
          break;
        }
      }
    }
    const r = await svc.answer(
      prepared.assessmentId,
      pq.id,
      { choiceIds, text, reasoning, confidence },
      work,
    );
    console.log("");
    console.log(
      r.isCorrect
        ? c.green(`✓ ${r.headline}`)
        : r.correctness >= 0.4
          ? c.yellow(`◐ ${r.headline}`)
          : c.red(`✗ ${r.headline}`),
    );
    for (const f of r.feedback) console.log(`  ${f}`);
    console.log(c.dim(`  ${r.explanation}`));
    q = r.next;
    if (r.summary) printSummary(r.summary.lines, r.summary.nextReviews);
  }
}

function stopped(id: string): void {
  console.log(c.dim(`Paused. Resume with: dev-learning-ai assess --resume ${id}`));
}

export function printSummary(lines: string[], next: { conceptId: string; at: string }[] = []): void {
  console.log("");
  console.log(c.bold("Session summary"));
  for (const l of lines) console.log(`  ${l}`);
  if (next.length)
    console.log(
      c.dim(
        `  Next review${next.length > 1 ? "s" : ""}: ${next.map((n) => `${n.conceptId} on ${n.at.slice(0, 10)}`).join(", ")}`,
      ),
    );
}
