# Scoring methodology

Scores are evidence summaries, not measurements of ability. Each one has a defined meaning, a 0–1 range, an update rule, an evidence count and a versioned rule id (`scoring@1`). Every change is recorded with the evidence and the rule that caused it (`dev-learning-ai explain <concept>`).

## Dimensions

| Dimension | Meaning | Updated by | Estimate? |
| --- | --- | --- | --- |
| Mastery | Demonstrated understanding | Answers: correctness × confidence factor × reasoning factor, weighted by difficulty, reliability and novelty | no |
| Recall | Retrieved the right answer | Answers; a correct guess counts 30% | no |
| Reasoning | Quality of explanations given | Reasoning signal coverage (or a bounded provider grade) | no |
| Application | Applied the concept | Scenario, debugging, review and migration questions; practical work (capped at 60%) | no |
| Calibration | Confidence matched correctness | `1 − |confidence − correctness|`, first answer sets it directly | no |
| Retention | Chance of recall today | Forgetting curve `2^(−t / interval)` from review history | yes |
| Freshness | How recently validated | 100% for 90 days after validation, then decays to 30% at a year | yes |
| Exposure | Encountered in work | Practical-work events (saturating) | no; **not ability** |

Unassessed concepts are shown as gaps, never as zeros, because a lack of exposure is not a lack of ability.

## Update rule (mastery, recall, reasoning, application)

```text
weight = min(0.6, 0.35 × reliability × difficultyWeight × novelty)
difficultyWeight = correct ? 0.7 + 0.15·(d−1) : 1.3 − 0.15·(d−1)      # hard right / easy wrong move more
novelty = 1.2 for a new variant of a known concept, else 1
credit = correctness × {guessing .35, low .7, medium .9, high 1, none .85} × {sound 1, weak .85, absent .9}
value ← value + w·(credit − value), w = max(weight, 0.5) for the first evidence
```

The same evidence is never counted twice: every evidence record has an idempotency key, for example `answer|<assessment>|<question>|<scope>`.

A code change alone never sets mastery. Practical work raises exposure, and raises application only up to 60%, until you are assessed.

## Answer evaluation

Correctness, reasoning and confidence are evaluated separately, then combined in a calibration matrix:

| Correctness | Reasoning | Confidence | Classification | Effect |
| --- | --- | --- | --- | --- |
| ≥ 80% | sound | medium/high | strong | grade 4–5, interval grows |
| ≥ 80% | weak | high | possible false confidence | grade 3, interval held |
| ≥ 80% | any | low/guessing | uncertain recall | grade 3, limited credit |
| 40–80% | any | any | partial | grade 2–3 |
| < 40% | sound | any | check the question (possible ambiguity) | |
| < 40% | not sound | high | possible misconception | grade 0, follow-up scheduled |
| < 40% | not sound | low/guessing | likely gap | grade 1 |

- **Multi-select** partial credit: `(right − wrong) / |correct|`, clamped to 0–1.
- **Open answers**: a weighted rubric. Each criterion lists alternative term sets, and partial credit is the sum of the met weights. A provider may refine this by at most ±0.25.

## Hierarchy aggregation (`agnostic-first@1`)

- Groups:
  - version-agnostic: fundamentals, architecture, performance, testing, security
  - one branch per version
  - version transitions
  - project-specific
- A group's score is the evidence-weighted mean of its **assessed** concepts.
- A technology's overall score weights version-agnostic concepts at 1.0 and version-specific or transition concepts at 0.25. Weak React 19 knowledge therefore never lowers the fundamentals score, and only lightly affects the overall figure. Both are shown side by side.

## Reviews (SM-2 with documented adjustments)

1. Grades 0–5 come from the evaluation above. A correct guess or low confidence gives 3, so the item is reviewed sooner.
2. A missed review never resets mastery. If an overdue item is recalled, the elapsed time counts, capped at twice the interval.
3. Intervals are capped at 180 days.
4. Every review asks a **new question** about the concept. The model is told the earlier prompts and the previous question type. Duplicates are rejected.

`dev-learning-ai review why <concept>` explains a schedule. Schedulers are replaceable through extensions.
