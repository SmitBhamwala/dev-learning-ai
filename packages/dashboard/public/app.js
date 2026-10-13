// dev-learning-ai dashboard. No framework, no build step. All DOM is built with
// createElement/textContent (never innerHTML with data), so API content cannot inject markup.

const root = document.getElementById("main");
// Each navigation renders into its own host; only the latest navigation is attached (no stale-view races).
let main = document.createElement("div");
let routeSeq = 0;
const currentHost = () => main;
const dialog = document.getElementById("dialog");
let csrf = "";

// ── helpers ───────────────────────────────────────────────────────────
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
function render(target, ...nodes) {
  target.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
}
const pct = (n) => (n === undefined || n === null ? "—" : `${Math.round(n * 100)}%`);
const fmtDate = (iso) =>
  iso ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso)) : "—";
const fmtDateTime = (iso) =>
  iso
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso))
    : "—";
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers: opts.body !== undefined ? { "Content-Type": "application/json", "X-DLA-CSRF": csrf } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

function toast(message) {
  const t = h("div", { class: "toast" }, message);
  document.getElementById("toasts").append(t);
  setTimeout(() => t.remove(), 5000);
}

function pageHead(title, sub, ...actions) {
  return h(
    "div",
    { class: "page-head" },
    h("div", {}, h("h1", {}, title), sub ? h("p", {}, sub) : null),
    actions.length ? h("div", { class: "btn-row" }, actions) : null,
  );
}

function skeleton() {
  return h(
    "div",
    { "aria-busy": "true", "aria-label": "Loading" },
    h("div", { class: "skeleton w40" }),
    h("div", { class: "skeleton tall" }),
    h("div", { class: "skeleton w60" }),
    h("div", { class: "skeleton" }),
  );
}

function errorBox(err, retry) {
  return h(
    "div",
    { class: "error-box", role: "alert" },
    h("p", {}, err.message),
    retry
      ? h(
          "div",
          { class: "btn-row", style: { marginTop: "12px" } },
          h("button", { class: "btn", type: "button", onclick: retry }, "Try again"),
        )
      : null,
  );
}

function empty(title, body, action) {
  return h(
    "div",
    { class: "empty" },
    h("strong", {}, title),
    body,
    action ? h("div", { class: "btn-row", style: { marginTop: "12px" } }, action) : null,
  );
}

function bar(name, value, opts = {}) {
  const tag = opts.onclick ? "button" : "li";
  const assessed = value !== undefined && value !== null;
  const row = h(
    tag,
    {
      class: `bar-row${opts.strong ? " strong" : ""}`,
      type: opts.onclick ? "button" : undefined,
      onclick: opts.onclick,
      "aria-pressed": opts.onclick ? String(Boolean(opts.pressed)) : undefined,
    },
    h("span", { class: "name" }, name),
    h("span", { class: "val" }, assessed ? pct(value) : h("span", { class: "muted" }, "not assessed")),
    h(
      "span",
      { class: `track${assessed ? "" : " unassessed"}`, "aria-hidden": "true" },
      assessed
        ? h("span", { class: "fill", style: { width: `${Math.max(2, Math.round(value * 100))}%` } })
        : null,
    ),
    opts.meta ? h("span", { class: "meta" }, opts.meta) : null,
  );
  return tag === "button" ? h("li", {}, row) : row;
}

function confirmDialog(title, bodyNodes, confirmLabel = "Confirm", destructive = false) {
  return new Promise((resolve) => {
    dialog.replaceChildren(
      h(
        "form",
        { method: "dialog", class: "dlg" },
        h("h2", { id: "dialog-title" }, title),
        bodyNodes,
        h(
          "div",
          { class: "btn-row" },
          h(
            "button",
            { class: `btn primary${destructive ? " danger" : ""}`, value: "yes", autofocus: true },
            confirmLabel,
          ),
          h("button", { class: "btn", value: "no" }, "Cancel"),
        ),
      ),
    );
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "yes"), { once: true });
    dialog.showModal();
  });
}

function copyButton(text, label = "Copy command") {
  return h(
    "button",
    {
      class: "btn",
      type: "button",
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast("Copied to clipboard");
        } catch {
          toast("Copy failed; select the command text instead");
        }
      },
    },
    label,
  );
}

// ── views ─────────────────────────────────────────────────────────────
const views = {};

views.overview = async (_arg, main) => {
  const d = await api("/api/overview");
  document.getElementById("project-label").textContent = d.project
    ? `Project: ${d.project.name}`
    : "No project selected";
  const weakest = d.weak[0];
  const insightText = !d.learning.enabled
    ? "Learning is turned off. Nothing is being recorded."
    : d.dueCount > 0
      ? `${plural(d.dueCount, "review is", "reviews are")} due${weakest ? `, and ${weakest.label} is your least certain area so far (${pct(weakest.mastery)} from ${plural(weakest.evidence, "answer")}).` : "."}`
      : d.coverage.assessed === 0
        ? "No knowledge has been assessed yet. Finish a task with your coding agent, or study a topic now."
        : weakest
          ? `Nothing is due. ${weakest.label} is the area with the least evidence of understanding (${pct(weakest.mastery)}).`
          : "Nothing is due, and no weak areas stand out in the evidence so far.";
  const why = d.generation.agent
    ? `Questions are written at runtime by ${d.generation.agent}.`
    : `Question generation is off inside your agent: ${d.generation.agentWhy ?? "not configured"}.`;
  const action = d.resumable[0]
    ? h(
        "a",
        { class: "btn primary", href: `#/assessments/${d.resumable[0].id}` },
        `Resume assessment (${d.resumable[0].answered}/${d.resumable[0].total})`,
      )
    : d.dueCount > 0
      ? h("a", { class: "btn primary", href: "#/reviews" }, "Review now")
      : h("a", { class: "btn primary", href: "#/assessments" }, "Study a topic");

  const improved = d.improved.length
    ? h(
        "ul",
        { class: "bars" },
        d.improved.map((x, i) =>
          bar(x.label, x.after, { strong: i === 0, meta: `${pct(x.before)} → ${pct(x.after)} · ${x.why}` }),
        ),
      )
    : empty(
        "No changes this week",
        "Scores move when you answer questions; practical work alone never sets mastery.",
      );
  const attention = d.weak.length
    ? h(
        "ul",
        { class: "bars" },
        d.weak.map((x, i) =>
          bar(x.label, x.mastery, {
            strong: i === 0,
            meta: `${plural(x.evidence, "answer")}${x.calibration !== undefined && x.calibration < 0.55 ? " · confidence tends to exceed correctness" : ""}`,
          }),
        ),
      )
    : empty(
        "Nothing needs attention",
        "Areas appear here once there's enough evidence to say something useful.",
      );

  render(
    main,
    pageHead(
      "Overview",
      d.project
        ? `Developer-wide knowledge, plus what's specific to ${d.project.name}.`
        : "Developer-wide knowledge across your projects.",
    ),
    h(
      "section",
      { class: "insight", "aria-label": "Summary" },
      h("div", {}, h("p", {}, insightText), h("p", { class: "why" }, why)),
      action,
    ),
    h(
      "div",
      { class: "stats" },
      h(
        "div",
        { class: "stat" },
        h("div", { class: "value" }, d.dueCount),
        h("div", { class: "label" }, "Reviews due"),
        h("div", { class: "sub" }, "each uses a new question"),
      ),
      h(
        "div",
        { class: "stat" },
        h("div", { class: "value" }, d.week.correct, h("small", {}, ` / ${d.week.answered}`)),
        h("div", { class: "label" }, "Correct answers this week"),
        h("div", { class: "sub" }, `${plural(d.week.assessments, "assessment")} completed`),
      ),
      h(
        "div",
        { class: "stat" },
        h("div", { class: "value" }, d.coverage.assessed, h("small", {}, ` / ${d.coverage.encountered}`)),
        h("div", { class: "label" }, "Concepts assessed"),
        h("div", { class: "sub" }, "of those you've encountered"),
      ),
    ),
    h(
      "div",
      { class: "cols" },
      h("section", { class: "section" }, h("h2", {}, "Improved this week"), improved),
      h("section", { class: "section" }, h("h2", {}, "Needs attention"), attention),
    ),
    h(
      "section",
      { class: "section" },
      h(
        "div",
        { class: "section-head" },
        h("h2", {}, "Up next"),
        h("a", { href: "#/reviews", class: "small" }, "All reviews"),
      ),
      d.due.length
        ? h(
            "ul",
            { class: "list panel" },
            d.due.map((r) =>
              h(
                "li",
                {},
                h(
                  "div",
                  { class: "main" },
                  h("div", {}, r.label),
                  h("div", { class: "muted small" }, r.reason),
                ),
                h(
                  "span",
                  { class: "small muted num" },
                  `due ${fmtDate(r.due)} · retention ~${pct(r.retention)}`,
                ),
              ),
            ),
          )
        : empty("No reviews due", "Reviews are scheduled after you answer questions."),
    ),
    h(
      "section",
      { class: "section" },
      h("h2", {}, "Recent AI-assisted tasks"),
      d.tasks.length
        ? h(
            "ul",
            { class: "list panel" },
            d.tasks.map((t) =>
              h(
                "li",
                {},
                h(
                  "div",
                  { class: "main" },
                  h("div", {}, t.title),
                  h(
                    "div",
                    { class: "muted small" },
                    t.concepts.length ? t.concepts.join(", ") : (t.skipped ?? "no learning opportunity"),
                  ),
                ),
                h(
                  "span",
                  { class: "small muted" },
                  `${t.project ? `${t.project} · ` : ""}${fmtDateTime(t.at)}`,
                ),
                t.offer === "pending" || t.offer === "deferred"
                  ? h(
                      "span",
                      { class: "chip warn" },
                      t.offer === "pending" ? "questions offered" : "deferred",
                    )
                  : null,
              ),
            ),
          )
        : empty(
            "No tasks observed yet",
            "Tasks appear when the Claude Code integration is installed, or when you ingest events manually.",
          ),
    ),
    h(
      "p",
      { class: "section small muted" },
      `Learning ${d.learning.enabled ? "on" : "off"} · mode ${d.learning.mode} · ${plural(d.learning.questionsPerTask, "question")} per task · `,
      h("a", { href: "#/configuration" }, "Change"),
    ),
  );
};

let knowledgeState = { tech: null, concept: null, dimension: "mastery" };
views.knowledge = async (_arg, main) => {
  const d = await api(`/api/knowledge?dimension=${encodeURIComponent(knowledgeState.dimension)}`);
  const techs = d.technologies.filter((t) => t.total > 0);
  const withData = techs.filter((t) => t.assessed > 0);
  if (!knowledgeState.tech || !techs.some((t) => t.technology === knowledgeState.tech))
    knowledgeState.tech = (withData[0] ?? techs[0])?.technology;
  const tech = techs.find((t) => t.technology === knowledgeState.tech);
  const dimSelect = h(
    "select",
    {
      id: "dim",
      onchange: (e) => {
        knowledgeState.dimension = e.target.value;
        route();
      },
    },
    Object.entries(d.dimensions).map(([k, info]) =>
      h(
        "option",
        { value: k, selected: k === d.dimension },
        `${info.label}${info.isEstimate ? " (estimate)" : ""}`,
      ),
    ),
  );
  const detail = h("div", { class: "detail", id: "concept-detail", "aria-live": "polite" });
  const treeView = tech
    ? h(
        "div",
        {},
        h(
          "div",
          { class: "section-head" },
          h("h2", {}, tech.label),
          h(
            "span",
            { class: "muted small num" },
            `overall ${pct(tech.overall)} · ${tech.assessed} of ${tech.total} assessed`,
          ),
        ),
        h(
          "p",
          { class: "small muted" },
          "Version branches are scored separately. They weigh 25% in the overall figure, so a gap in a new release never lowers your fundamentals. Concepts you haven't been assessed on show as gaps, not zeros.",
        ),
        tech.groups.map((g) =>
          h(
            "section",
            { class: "group", "aria-label": g.label },
            h(
              "h3",
              {},
              g.label,
              h("span", { class: "muted small num" }, `${pct(g.score)} · ${g.assessed}/${g.total}`),
            ),
            h(
              "ul",
              { class: "bars" },
              g.concepts.map((c) =>
                bar(c.label, c.score, {
                  pressed: knowledgeState.concept === c.id,
                  meta: `${c.scope}${c.evidence ? ` · ${plural(c.evidence, "piece")} of evidence` : ""}`,
                  onclick: () => {
                    knowledgeState.concept = c.id;
                    for (const b of main.querySelectorAll("button.bar-row"))
                      b.setAttribute("aria-pressed", "false");
                    showConcept(c.id, detail);
                  },
                }),
              ),
            ),
          ),
        ),
        detail,
      )
    : empty("No concepts", "No technology concepts are available.");
  render(
    main,
    pageHead(
      "Knowledge",
      "Technology → version branches → concept → the evidence behind each score.",
      h("label", { class: "small", for: "dim" }, "Dimension "),
      dimSelect,
    ),
    h(
      "div",
      { class: "explorer" },
      h(
        "ul",
        { class: "tech-list", "aria-label": "Technologies" },
        techs.map((t) =>
          h(
            "li",
            {},
            h(
              "button",
              {
                type: "button",
                "aria-pressed": String(t.technology === knowledgeState.tech),
                onclick: () => {
                  knowledgeState.tech = t.technology;
                  knowledgeState.concept = null;
                  route();
                },
              },
              h("span", {}, t.label),
              h("span", { class: "muted num" }, t.assessed ? pct(t.overall) : "—"),
            ),
          ),
        ),
      ),
      treeView,
    ),
    d.project.length
      ? h(
          "section",
          { class: "section" },
          h("h2", {}, "Specific to this project"),
          h(
            "p",
            { class: "small muted" },
            "How you've applied concepts here. Never shared with other projects.",
          ),
          h(
            "ul",
            { class: "bars", style: { marginTop: "12px" } },
            d.project.map((p) =>
              bar(p.label, p.application, { meta: `application · mastery ${pct(p.mastery)}` }),
            ),
          ),
        )
      : null,
  );
  if (knowledgeState.concept) showConcept(knowledgeState.concept, detail);
};

async function showConcept(id, target) {
  target.replaceChildren(skeleton());
  try {
    const d = await api(`/api/concepts/${encodeURIComponent(id)}`);
    const dimInfo = (await api(`/api/knowledge?dimension=mastery`)).dimensions;
    const blocks = d.states.map((s) =>
      h(
        "div",
        { class: "section" },
        h("h3", {}, s.scope === "global" ? "Developer-wide" : "This project"),
        h(
          "div",
          { class: "dims" },
          Object.entries(dimInfo).map(([k, info]) =>
            h(
              "div",
              {},
              h(
                "div",
                { class: "v" },
                s.dimensions[k].evidence
                  ? pct(s.dimensions[k].value)
                  : h("span", { class: "muted small" }, "not assessed"),
              ),
              h(
                "div",
                { class: "small" },
                info.label,
                info.isEstimate ? h("span", { class: "muted" }, " · estimate") : null,
              ),
              h("div", { class: "xs muted" }, info.meaning),
            ),
          ),
        ),
        s.review
          ? h(
              "p",
              { class: "small muted" },
              `Next review ${fmtDate(s.review.nextReviewAt)}: ${s.review.reason ?? ""}`,
            )
          : null,
      ),
    );
    target.replaceChildren(
      h(
        "div",
        { class: "panel" },
        h("h2", {}, d.concept.label),
        h("p", { class: "muted", style: { marginTop: "4px" } }, d.concept.summary),
        h(
          "p",
          { class: "small", style: { marginTop: "8px" } },
          `Scope: ${d.concept.scopeLabel}${d.concept.interviewCritical ? " · interview-critical" : ""}`,
        ),
        blocks.length
          ? blocks
          : empty("Not assessed yet", "Answer a question on this concept to see its scores."),
        d.changes.length
          ? h(
              "div",
              { class: "section" },
              h("h3", {}, "Why the scores moved"),
              h(
                "ul",
                { class: "list" },
                d.changes
                  .slice(-10)
                  .reverse()
                  .map((c) =>
                    h(
                      "li",
                      {},
                      h(
                        "div",
                        { class: "main" },
                        h("div", {}, `${c.dimension}: ${pct(c.before)} → ${pct(c.after)}`),
                        h("div", { class: "small muted" }, c.explanation),
                      ),
                      h("span", { class: "xs muted" }, `${fmtDate(c.at)} · ${c.rule} (${c.ruleVersion})`),
                    ),
                  ),
              ),
            )
          : null,
        d.evidence.length
          ? h(
              "div",
              { class: "section" },
              h("h3", {}, "Evidence"),
              h(
                "ul",
                { class: "list" },
                d.evidence
                  .slice(-10)
                  .reverse()
                  .map((e) =>
                    h(
                      "li",
                      {},
                      h(
                        "div",
                        { class: "main" },
                        h(
                          "div",
                          {},
                          e.kind === "practical-work"
                            ? "Practical work in a task (observed; counts as exposure and capped application)"
                            : `Answer: ${pct(e.outcome?.correctness)} correct${e.outcome?.confidence ? `, confidence ${e.outcome.confidence}` : ""}${e.novel ? ", new variant" : ""}`,
                        ),
                        h(
                          "div",
                          { class: "small muted" },
                          `${e.scope === "global" ? "developer-wide" : "project"} · reliability ${pct(e.reliability)}`,
                        ),
                      ),
                      h("span", { class: "xs muted" }, fmtDateTime(e.at)),
                    ),
                  ),
              ),
            )
          : null,
      ),
    );
  } catch (err) {
    target.replaceChildren(errorBox(err));
  }
}

views.technologies = async (_arg, main) => {
  const [k, projects] = await Promise.all([api("/api/knowledge"), api("/api/projects")]);
  const assessed = k.technologies.filter((t) => t.assessed > 0);
  const current = projects.find((p) => p.isCurrent);
  render(
    main,
    pageHead(
      "Technologies",
      "Broad understanding per technology, with each version branch shown on its own.",
    ),
    assessed.length
      ? h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            {},
            h("caption", { class: "sr-only" }, "Technology scores"),
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                h("th", { scope: "col" }, "Technology"),
                h("th", { scope: "col", class: "n" }, "Overall"),
                h("th", { scope: "col" }, "Branches"),
                h("th", { scope: "col", class: "n" }, "Assessed"),
              ),
            ),
            h(
              "tbody",
              {},
              assessed.map((t) =>
                h(
                  "tr",
                  {},
                  h(
                    "th",
                    { scope: "row" },
                    h(
                      "a",
                      {
                        href: "#/knowledge",
                        onclick: () => {
                          knowledgeState.tech = t.technology;
                        },
                      },
                      t.label,
                    ),
                  ),
                  h("td", { class: "n" }, pct(t.overall)),
                  h(
                    "td",
                    {},
                    t.groups.map((g) =>
                      h("div", { class: "small" }, `${g.label}: `, h("span", { class: "num" }, pct(g.score))),
                    ),
                  ),
                  h("td", { class: "n" }, `${t.assessed}/${t.total}`),
                ),
              ),
            ),
          ),
        )
      : empty("Nothing assessed yet", "Technology scores appear after your first answers."),
    current
      ? h(
          "section",
          { class: "section" },
          h("h2", {}, `Detected in ${current.name}`),
          h(
            "p",
            { class: "small muted" },
            "From lockfiles and manifests. A declared range is not treated as a verified version. Correct any fact with `dev-learning-ai projects set-tech`.",
          ),
          h(
            "ul",
            { class: "list panel", style: { marginTop: "12px" } },
            current.technologies.map((t) =>
              h(
                "li",
                {},
                h(
                  "div",
                  { class: "main" },
                  h("div", {}, `${t.technology}${t.workspace ? ` (${t.workspace})` : ""}`),
                  h(
                    "div",
                    { class: "small muted" },
                    t.provenance.map((p) => `${p.source}${p.file ? `: ${p.file}` : ""}`).join(" · "),
                  ),
                ),
                h(
                  "span",
                  { class: "num small" },
                  t.version ?? (t.declaredRange ? `declared ${t.declaredRange}` : "version unknown"),
                ),
                t.correctedByUser ? h("span", { class: "chip" }, "your correction") : null,
              ),
            ),
          ),
        )
      : null,
  );
};

views.projects = async (_arg, main) => {
  const list = await api("/api/projects");
  render(
    main,
    pageHead(
      "Projects",
      "Each project keeps its own architecture knowledge. Developer-wide knowledge follows you everywhere.",
    ),
    list.length
      ? h(
          "ul",
          { class: "list panel" },
          list.map((p) =>
            h(
              "li",
              {},
              h(
                "div",
                { class: "main" },
                h(
                  "div",
                  {},
                  p.name,
                  " ",
                  p.isCurrent ? h("span", { class: "chip ok" }, "current") : null,
                  p.status === "removed" ? h("span", { class: "chip" }, "unregistered") : null,
                ),
                h("div", { class: "small muted" }, p.paths.join(" · ")),
                h(
                  "div",
                  { class: "xs muted" },
                  `${p.id}${p.productGroup ? ` · product ${p.productGroup}` : ""}${p.isMonorepo ? ` · monorepo, ${plural(p.workspaces.length, "workspace")}` : ""}`,
                ),
              ),
              h(
                "span",
                { class: "small muted num" },
                `${plural(p.tasks, "task")} · ${plural(p.projectKnowledge, "project concept")}`,
              ),
            ),
          ),
        )
      : empty(
          "No projects registered",
          "Run this in a repository:",
          h("code", {}, "dev-learning-ai register"),
        ),
  );
};

views.assessments = async (id, main) => {
  if (id) return assessmentDetail(id, main);
  const list = await api("/api/assessments");
  const topic = h("input", {
    type: "text",
    id: "topic",
    placeholder: "e.g. React 18 and 19, TypeScript generics",
    autocomplete: "off",
  });
  const practice = h(
    "form",
    {
      class: "panel",
      onsubmit: async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector("button");
        btn.disabled = true;
        btn.textContent = "Writing questions…";
        try {
          const r = await api("/api/assess", { method: "POST", body: { topic: topic.value, count: 3 } });
          if (r.status === "deferred") {
            toast(r.reason ?? "No model is available here.");
            renderPracticeUnavailable(practiceHost, r.reason, topic.value);
          } else location.hash = `#/assessments/${r.assessmentId}`;
        } catch (err) {
          toast(err.message);
        } finally {
          btn.disabled = false;
          btn.textContent = "Start";
        }
      },
    },
    h("label", { for: "topic", class: "small" }, "Study a topic"),
    h(
      "div",
      { class: "btn-row", style: { marginTop: "6px" } },
      h("div", { style: { flex: "1 1 240px" } }, topic),
      h("button", { class: "btn primary", type: "submit" }, "Start"),
    ),
    h(
      "p",
      { class: "xs muted", style: { marginTop: "8px" } },
      "Questions are written now by an AI model. In the dashboard that needs a configured provider (see Integrations); inside Claude Code the agent's own model is used.",
    ),
  );
  const practiceHost = h("div", {}, practice);
  render(
    main,
    pageHead("Assessments", "Every question, your answer, and why the scores changed."),
    practiceHost,
    h(
      "section",
      { class: "section" },
      h("h2", {}, "History"),
      list.length
        ? h(
            "ul",
            { class: "list panel", style: { marginTop: "12px" } },
            list.map((s) =>
              h(
                "li",
                {},
                h(
                  "div",
                  { class: "main" },
                  h("a", { href: `#/assessments/${s.id}` }, s.concepts.join(", ") || "Assessment"),
                  h(
                    "div",
                    { class: "small muted" },
                    `${s.origin}${s.project ? ` · ${s.project}` : ""} · ${fmtDateTime(s.createdAt)}`,
                  ),
                  s.deferredReason ? h("div", { class: "xs muted" }, s.deferredReason) : null,
                ),
                h("span", { class: "num small" }, s.answered ? `${s.correct}/${s.answered} correct` : "—"),
                h(
                  "span",
                  {
                    class: `chip ${s.status === "completed" ? "ok" : s.status === "deferred" ? "warn" : ""}`,
                  },
                  s.status,
                ),
              ),
            ),
          )
        : empty("No assessments yet", "They appear after your first post-task questions or study session."),
    ),
  );
};

function renderPracticeUnavailable(host, reason, topic) {
  const cmd = `dev-learning-ai assess ${topic || "React 18"}`;
  host.append(
    h(
      "div",
      { class: "panel", style: { marginTop: "12px" } },
      h("p", {}, reason ?? "No model is available here."),
      h("p", { class: "small muted", style: { margin: "8px 0" } }, "You can study in the terminal instead:"),
      h("pre", {}, h("code", {}, cmd)),
      copyButton(cmd),
    ),
  );
}

async function assessmentDetail(id, main) {
  const s = await api(`/api/assessments/${encodeURIComponent(id)}`);
  if (s.status === "in-progress") {
    const q = await api(`/api/assess/${encodeURIComponent(id)}`);
    if (q) return renderQuestion(id, q, main);
  }
  render(
    main,
    pageHead(
      "Assessment",
      `${s.origin.kind} · ${fmtDateTime(s.createdAt)} · ${s.status}`,
      h("a", { class: "btn", href: "#/assessments" }, "All assessments"),
      h(
        "button",
        {
          class: "btn danger",
          type: "button",
          onclick: async () => {
            if (
              !(await confirmDialog(
                "Delete your written answers?",
                h(
                  "p",
                  {},
                  "Your typed answers and reasoning in this assessment are replaced with “[deleted]”. Scores and the rest of your history are kept.",
                ),
                "Delete text",
                true,
              ))
            )
              return;
            await api(`/api/assessments/${encodeURIComponent(id)}/redact`, { method: "POST", body: {} });
            toast("Answer text deleted");
            route();
          },
        },
        "Delete answer text",
      ),
    ),
    s.summary
      ? h(
          "section",
          { class: "insight" },
          h(
            "div",
            {},
            s.summary.lines.map((l, i) => h("p", { class: i ? "why" : "" }, l)),
          ),
        )
      : null,
    s.deferredReason ? h("p", { class: "panel" }, s.deferredReason) : null,
    h(
      "ol",
      { class: "list", style: { marginTop: "24px", paddingLeft: "0" } },
      s.items.map((it, i) =>
        h(
          "li",
          { class: "panel", style: { marginTop: "12px", display: "block" } },
          h(
            "div",
            { class: "small muted" },
            `${i + 1}. ${it.concept}${it.question ? ` · ${it.question.type}` : ""}${it.isNovelVariant ? " · new variant" : ""}`,
          ),
          it.question ? h("p", { style: { margin: "8px 0", fontWeight: "550" } }, it.question.prompt) : null,
          it.question?.code ? h("pre", {}, it.question.code) : null,
          it.question?.choices
            ? h(
                "ul",
                { class: "small", style: { margin: "8px 0" } },
                it.question.choices.map((c) =>
                  h(
                    "li",
                    {},
                    `${c.id}) ${c.text}`,
                    it.answer?.choiceIds?.includes(c.id) ? h("strong", {}, " ← your answer") : null,
                    it.question.correct?.includes(c.id)
                      ? h("span", { class: "chip ok", style: { marginLeft: "6px" } }, "correct")
                      : null,
                  ),
                ),
              )
            : null,
          it.answer?.text ? h("p", { class: "small" }, `Your answer: ${it.answer.text}`) : null,
          it.answer?.reasoning ? h("p", { class: "small" }, `Your reasoning: ${it.answer.reasoning}`) : null,
          it.answer?.confidence
            ? h("p", { class: "small muted" }, `Confidence: ${it.answer.confidence}`)
            : null,
          it.evaluation
            ? h(
                "div",
                { class: `feedback${it.evaluation.isCorrect ? " ok" : ""}`, style: { marginTop: "8px" } },
                h("strong", {}, `${it.evaluation.headline} · ${pct(it.evaluation.correctness)}`),
                h(
                  "ul",
                  { class: "small" },
                  it.evaluation.feedback.map((f) => h("li", {}, f)),
                ),
                h("p", { class: "small muted" }, it.evaluation.explanation),
              )
            : h("p", { class: "small muted" }, it.skipped ? "Skipped" : "Not answered"),
          it.question?.provenance
            ? h(
                "p",
                { class: "xs muted", style: { marginTop: "8px" } },
                `Written by ${it.question.provenance.source ?? "a model"}${it.question.provenance.version ? ` (${it.question.provenance.version})` : ""} from: ${(it.question.provenance.evidence ?? []).join("; ")}`,
              )
            : null,
        ),
      ),
    ),
  );
}

function renderQuestion(id, q, host) {
  const main = host ?? currentHost();
  const pq = q.question;
  const form = h("form", { class: "question", "aria-labelledby": "q-prompt" });
  const head = h(
    "div",
    { class: "small muted" },
    `${q.progress} · ${q.conceptLabel} · ${pq.type} · difficulty ${pq.difficulty}`,
  );
  const prompt = h("p", { id: "q-prompt", style: { fontSize: "1.125rem", fontWeight: "550" } }, pq.prompt);
  const parts = [head, prompt, pq.code ? h("pre", {}, h("code", {}, pq.code)) : null];
  let textArea;
  if (pq.choices) {
    parts.push(
      h(
        "fieldset",
        { class: "choices" },
        h("legend", { class: "sr-only" }, pq.isMultiSelect ? "Select all that apply" : "Choose one answer"),
        pq.isMultiSelect ? h("p", { class: "small muted" }, "Select all that apply.") : null,
        pq.choices.map((c) =>
          h(
            "label",
            { class: "choice" },
            h("input", { type: pq.isMultiSelect ? "checkbox" : "radio", name: "choice", value: c.id }),
            h("span", {}, c.text),
          ),
        ),
      ),
    );
  } else {
    textArea = h("textarea", { id: "answer-text", required: true });
    parts.push(h("label", { for: "answer-text" }, "Your answer"), textArea);
  }
  const reasoning = h("textarea", { id: "reasoning", required: q.requireReasoning || undefined });
  if (q.askReasoning && pq.choices)
    parts.push(
      h("label", { for: "reasoning" }, q.requireReasoning ? "Why? (required)" : "Why? (optional)"),
      reasoning,
    );
  if (q.askConfidence) {
    parts.push(
      h(
        "fieldset",
        {},
        h(
          "legend",
          { class: "small", style: { marginBottom: "6px" } },
          `How confident are you?${q.requireConfidence ? "" : " (optional)"}`,
        ),
        h(
          "div",
          { class: "confidence" },
          [
            ["guessing", "Guessing"],
            ["low", "Not confident"],
            ["medium", "Somewhat confident"],
            ["high", "Very confident"],
          ].map(([v, l]) =>
            h(
              "label",
              {},
              h("input", {
                type: "radio",
                name: "confidence",
                value: v,
                required: q.requireConfidence || undefined,
              }),
              l,
            ),
          ),
        ),
      ),
    );
  }
  const submit = h("button", { class: "btn primary", type: "submit" }, "Submit answer");
  const skip = h(
    "button",
    {
      class: "btn",
      type: "button",
      onclick: async () => {
        const r = await api(`/api/assess/${encodeURIComponent(id)}/skip`, { method: "POST", body: {} });
        r.next ? renderQuestion(id, r.next, main) : route();
      },
    },
    "Skip",
  );
  parts.push(
    h(
      "div",
      { class: "btn-row" },
      submit,
      skip,
      h("a", { class: "btn quiet", href: "#/assessments" }, "Finish later"),
    ),
  );
  form.append(...parts.filter(Boolean));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const choiceIds = [...form.querySelectorAll('input[name="choice"]:checked')].map((i) => i.value);
    if (pq.choices && choiceIds.length === 0) return toast("Pick an answer first");
    submit.disabled = true;
    try {
      const r = await api(`/api/assess/${encodeURIComponent(id)}/answer`, {
        method: "POST",
        body: {
          questionId: pq.id,
          choiceIds: pq.choices ? choiceIds : undefined,
          text: textArea?.value,
          reasoning: reasoning.value || undefined,
          confidence: form.querySelector('input[name="confidence"]:checked')?.value,
        },
      });
      const fb = h(
        "div",
        { class: `feedback${r.isCorrect ? " ok" : ""}`, tabindex: "-1" },
        h(
          "strong",
          {},
          r.isCorrect ? `✓ ${r.headline}` : r.correctness >= 0.4 ? `◐ ${r.headline}` : `✗ ${r.headline}`,
        ),
        h(
          "ul",
          { class: "small" },
          r.feedback.map((f) => h("li", {}, f)),
        ),
        h("p", { class: "small muted" }, r.explanation),
        h(
          "div",
          { class: "btn-row" },
          r.next
            ? h(
                "button",
                { class: "btn primary", type: "button", onclick: () => renderQuestion(id, r.next, main) },
                "Next question",
              )
            : h("button", { class: "btn primary", type: "button", onclick: () => route() }, "See summary"),
        ),
      );
      form.replaceChildren(head, prompt, fb);
      fb.focus();
    } catch (err) {
      toast(err.message);
      submit.disabled = false;
    }
  });
  render(main, pageHead("Practice", "One question at a time. Your answer is evaluated immediately."), form);
}

views.reviews = async (_arg, main) => {
  const list = await api("/api/reviews");
  const now = Date.now();
  const due = list.filter((r) => new Date(r.due).getTime() <= now);
  const later = list.filter((r) => new Date(r.due).getTime() > now);
  const act = (r, action, days) => async () => {
    try {
      await api(`/api/reviews/${encodeURIComponent(r.conceptId)}`, {
        method: "POST",
        body: { action, days },
      });
      toast(
        action === "postpone"
          ? `Postponed ${r.label}`
          : `${action === "suspend" ? "Suspended" : "Resumed"} ${r.label}`,
      );
      route();
    } catch (err) {
      toast(err.message);
    }
  };
  const rows = (items) =>
    h(
      "ul",
      { class: "list panel" },
      items.map((r) =>
        h(
          "li",
          {},
          h(
            "div",
            { class: "main" },
            h(
              "div",
              {},
              r.label,
              r.interviewCritical
                ? h("span", { class: "chip", style: { marginLeft: "6px" } }, "interview-critical")
                : null,
            ),
            h(
              "div",
              { class: "small muted" },
              `${r.reason} · mastery ${pct(r.mastery)} · retention ~${pct(r.retention)} (estimate)`,
            ),
          ),
          h("span", { class: "small num muted" }, fmtDate(r.due)),
          h(
            "div",
            { class: "btn-row" },
            h("button", { class: "btn", type: "button", onclick: act(r, "postpone", 1) }, "Tomorrow"),
            h("button", { class: "btn", type: "button", onclick: act(r, "postpone", 7) }, "Next week"),
            h("button", { class: "btn quiet", type: "button", onclick: act(r, "suspend") }, "Suspend"),
          ),
        ),
      ),
    );
  const cmd = "dev-learning-ai review";
  render(
    main,
    pageHead(
      "Reviews",
      "Spaced repetition on concepts, never on the same question twice. Missing a review never erases what you showed before.",
      h("a", { class: "btn primary", href: "#/assessments" }, "Practice in the dashboard"),
      copyButton(cmd, "Copy terminal command"),
    ),
    h(
      "section",
      {},
      h("h2", { style: { marginBottom: "12px" } }, `Due now (${due.length})`),
      due.length ? rows(due) : empty("Nothing due", "New reviews are scheduled as you answer questions."),
    ),
    later.length
      ? h(
          "section",
          { class: "section" },
          h("h2", { style: { marginBottom: "12px" } }, "Coming up"),
          rows(later.slice(0, 30)),
        )
      : null,
  );
};

let reportState = { kind: "weekly", scope: "project" };
views.reports = async (_arg, main) => {
  const { report, markdown } = await api(`/api/reports?kind=${reportState.kind}&scope=${reportState.scope}`);
  const seg = (key, options) =>
    h(
      "div",
      { class: "seg", role: "group" },
      options.map(([v, l]) =>
        h(
          "button",
          {
            type: "button",
            "aria-pressed": String(reportState[key] === v),
            onclick: () => {
              reportState[key] = v;
              route();
            },
          },
          l,
        ),
      ),
    );
  const download = h(
    "button",
    {
      class: "btn",
      type: "button",
      onclick: () => {
        const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
        const a = h("a", {
          href: url,
          download: `${report.kind}-report-${report.period.to.slice(0, 10)}.md`,
        });
        document.body.append(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      },
    },
    "Download Markdown",
  );
  render(
    main,
    pageHead(
      report.title,
      `${fmtDate(report.period.from)} – ${fmtDate(report.period.to)}`,
      seg("kind", [
        ["weekly", "Weekly"],
        ["monthly", "Monthly"],
      ]),
      seg("scope", [
        ["project", "This project"],
        ["all", "Developer-wide"],
      ]),
      download,
    ),
    h(
      "div",
      { class: "panel report" },
      report.sections.map((s) =>
        h(
          "section",
          {},
          h("h2", {}, s.heading),
          s.observed.length
            ? [
                h("p", { class: "kind" }, "Observed"),
                h(
                  "ul",
                  {},
                  s.observed.map((o) => h("li", {}, o)),
                ),
              ]
            : null,
          s.estimated.length
            ? [
                h("p", { class: "kind" }, "Estimated"),
                h(
                  "ul",
                  {},
                  s.estimated.map((o) => h("li", {}, o)),
                ),
              ]
            : null,
          !s.observed.length && !s.estimated.length
            ? h("p", { class: "small muted" }, "Nothing to report.")
            : null,
        ),
      ),
      report.health
        ? h("p", { class: "small muted", style: { marginTop: "24px" } }, report.health.disclaimer)
        : null,
    ),
  );
};

views.resources = async (_arg, main) => {
  const list = await api("/api/resources");
  render(
    main,
    pageHead(
      "Resources",
      "Official documentation matched to your gaps. Links are curated, not fetched live, so dates are not shown.",
    ),
    list.length
      ? h(
          "ul",
          { class: "list panel" },
          list.map((r) =>
            h(
              "li",
              {},
              h(
                "div",
                { class: "main" },
                h("a", { href: r.url, target: "_blank", rel: "noopener noreferrer" }, r.title),
                h("div", { class: "small muted" }, r.why),
                h("div", { class: "xs muted" }, new URL(r.url).hostname),
              ),
              h("span", { class: "chip" }, r.depth),
              r.versionScope ? h("span", { class: "chip" }, r.versionScope) : null,
              h("span", { class: "chip ok" }, r.trust),
            ),
          ),
        )
      : empty(
          "No recommendations yet",
          "Recommendations follow from assessed gaps, so they appear after your first answers.",
        ),
  );
};

let configLayer = "global";
views.configuration = async (_arg, main) => {
  const [cfg, history] = await Promise.all([api("/api/config"), api("/api/config/history")]);
  const changes = new Map();
  const groups = [...new Set(cfg.fields.map((f) => f.group))];
  const saveBtn = h("button", { class: "btn primary", type: "button", disabled: true }, "Review changes");
  const status = h("span", { class: "small muted", "aria-live": "polite" }, "No unsaved changes");
  const markChanged = (f, value, row) => {
    const same = JSON.stringify(value) === JSON.stringify(f.value);
    if (same) changes.delete(f.path);
    else changes.set(f.path, value);
    row.classList.toggle("changed", !same);
    saveBtn.disabled = changes.size === 0;
    status.textContent = changes.size ? `${plural(changes.size, "unsaved change")}` : "No unsaved changes";
  };
  const control = (f, row) => {
    const id = `f-${f.path.replace(/\./g, "-")}`;
    const common = { id, disabled: f.locked || undefined, "aria-describedby": `${id}-help` };
    if (f.kind === "boolean") {
      const input = h("input", {
        ...common,
        type: "checkbox",
        checked: f.value === true,
        onchange: (e) => markChanged(f, e.target.checked, row),
      });
      return h("label", { class: "switch", for: id }, input, h("span", {}, f.value ? "On" : "Off"));
    }
    if (f.kind === "select")
      return h(
        "select",
        { ...common, onchange: (e) => markChanged(f, e.target.value, row) },
        f.options.map((o) => h("option", { value: o, selected: o === f.value }, o)),
      );
    if (f.kind === "number")
      return h("input", {
        ...common,
        type: "number",
        min: f.min,
        max: f.max,
        value: f.value,
        onchange: (e) => markChanged(f, Number(e.target.value), row),
      });
    if (f.kind === "auto-number") {
      const isAuto = f.value === "auto";
      const num = h("input", {
        type: "number",
        min: f.min,
        max: f.max,
        value: isAuto ? "" : f.value,
        disabled: isAuto || f.locked || undefined,
        "aria-label": `${f.label} value`,
        onchange: (e) => markChanged(f, Number(e.target.value), row),
      });
      const auto = h("input", {
        ...common,
        type: "checkbox",
        checked: isAuto,
        onchange: (e) => {
          num.disabled = e.target.checked;
          markChanged(f, e.target.checked ? "auto" : Number(num.value || f.min), row);
        },
      });
      return h(
        "div",
        { class: "btn-row" },
        h("label", { class: "switch", for: id }, auto, h("span", {}, "Auto")),
        h("div", { style: { flex: "1 1 80px" } }, num),
      );
    }
    return h("input", {
      ...common,
      type: "text",
      value: f.value ?? "",
      onchange: (e) => markChanged(f, e.target.value, row),
    });
  };
  const fieldRow = (f) => {
    const row = h("div", { class: "field" });
    const id = `f-${f.path.replace(/\./g, "-")}`;
    row.append(
      h(
        "div",
        {},
        f.kind === "boolean" || f.kind === "auto-number"
          ? h("span", { class: "label" }, f.label)
          : h("label", { for: id }, f.label),
        h("p", { class: "help", id: `${id}-help` }, f.help),
        h(
          "div",
          { class: "origin" },
          h("span", { class: "chip" }, f.origin === "defaults" ? "default" : `set in ${f.origin}`),
          f.sensitive ? h("span", { class: "chip warn" }, "privacy-relevant") : null,
          f.locked ? h("span", { class: "chip bad" }, "locked by your organization") : null,
          h("code", { class: "xs muted" }, f.path),
        ),
      ),
      control(f, row),
    );
    return row;
  };
  saveBtn.addEventListener("click", async () => {
    const payload = [...changes].map(([path, value]) => ({ path, value }));
    try {
      const preview = await api("/api/config", {
        method: "POST",
        body: { changes: payload, layer: configLayer },
      });
      const diffText = preview.diff.length
        ? preview.diff
            .map(
              (d) =>
                `${d.sensitive ? "! " : "  "}${d.path}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`,
            )
            .join("\n")
        : "No effective change (a higher layer overrides this setting).";
      const ok = await confirmDialog(
        `Save to the ${configLayer} layer?`,
        [h("pre", {}, diffText), ...preview.messages.map((m) => h("p", { class: "small" }, m))],
        "Save changes",
      );
      if (!ok) return;
      const r = await api("/api/config", {
        method: "POST",
        body: { changes: payload, layer: configLayer, confirm: true },
      });
      toast(`Saved. Undo from the history below (${r.historyId}).`);
      route();
    } catch (err) {
      toast(err.message);
    }
  });
  const layerSelect = h(
    "select",
    {
      id: "layer",
      onchange: (e) => {
        configLayer = e.target.value;
      },
    },
    h("option", { value: "global", selected: configLayer === "global" }, "Everywhere (global)"),
    cfg.hasProject
      ? h(
          "option",
          { value: "project", selected: configLayer === "project" },
          `Only ${cfg.projectName} (project)`,
        )
      : null,
  );
  render(
    main,
    pageHead(
      "Configuration",
      "The same settings the CLI changes. Every save shows a diff first and can be rolled back.",
      h("label", { for: "layer", class: "small" }, "Save to "),
      layerSelect,
    ),
    groups.map((g) =>
      h(
        "section",
        { class: "section" },
        h("h2", { style: { marginBottom: "4px" } }, g),
        h("div", { class: "panel" }, cfg.fields.filter((f) => f.group === g).map(fieldRow)),
      ),
    ),
    h("div", { class: "sticky-bar" }, status, saveBtn),
    h(
      "section",
      { class: "section" },
      h("h2", { style: { marginBottom: "12px" } }, "Change history"),
      history.length
        ? h(
            "ul",
            { class: "list panel" },
            history.map((e) =>
              h(
                "li",
                {},
                h(
                  "div",
                  { class: "main" },
                  h(
                    "div",
                    {},
                    e.diff.map((d) => `${d.path} → ${JSON.stringify(d.after)}`).join(", ") ||
                      "(no effective change)",
                  ),
                  h(
                    "div",
                    { class: "small muted" },
                    `${e.actor} · ${e.layer} · ${fmtDateTime(e.at)}${e.note ? ` · ${e.note}` : ""}`,
                  ),
                ),
                h(
                  "button",
                  {
                    class: "btn",
                    type: "button",
                    onclick: async () => {
                      if (
                        !(await confirmDialog(
                          "Roll back this change?",
                          h(
                            "p",
                            {},
                            "The layer it changed is restored to how it was before. The rollback is recorded too.",
                          ),
                          "Roll back",
                        ))
                      )
                        return;
                      try {
                        await api("/api/config/rollback", { method: "POST", body: { id: e.id } });
                        toast("Rolled back");
                        route();
                      } catch (err) {
                        toast(err.message);
                      }
                    },
                  },
                  "Roll back",
                ),
              ),
            ),
          )
        : empty("No changes yet", "Saved changes from the CLI, the dashboard and your agent appear here."),
    ),
  );
};

views.integrations = async (_arg, main) => {
  const d = await api("/api/integrations");
  render(
    main,
    pageHead(
      "Integrations",
      "Which coding agents and AI providers are connected, and what each may receive.",
    ),
    h(
      "section",
      {},
      h("h2", { style: { marginBottom: "12px" } }, "Coding agents"),
      h(
        "ul",
        { class: "list panel" },
        d.adapters.map((a) =>
          h(
            "li",
            {},
            h("div", { class: "main" }, h("div", {}, a.name), h("div", { class: "small muted" }, a.detail)),
            h("span", { class: `chip ${a.status === "implemented" ? "ok" : ""}` }, a.status),
          ),
        ),
      ),
    ),
    h(
      "section",
      { class: "section" },
      h("h2", { style: { marginBottom: "12px" } }, "Question generation"),
      h(
        "dl",
        { class: "kv panel" },
        h("dt", {}, "Agent's own model"),
        h(
          "dd",
          {},
          d.gates.allowHostModel
            ? "Allowed: receives file names, symbols and detected concepts of a task (never whole files)"
            : "Not allowed (learning defers inside your agent)",
        ),
        h("dt", {}, "Separate provider"),
        h("dd", {}, d.gates.allowRemote ? "Allowed" : "Not allowed"),
      ),
      h(
        "ul",
        { class: "list panel", style: { marginTop: "12px" } },
        d.providers.map((p) =>
          h(
            "li",
            {},
            h(
              "div",
              { class: "main" },
              h("div", {}, p.name),
              h("div", { class: "small muted" }, p.reason ?? ""),
            ),
            h(
              "span",
              { class: `chip ${p.available ? "ok" : p.implemented ? "warn" : ""}` },
              !p.implemented ? "not implemented" : p.available ? "available" : "unavailable",
            ),
          ),
        ),
      ),
    ),
  );
};

views.diagnostics = async (_arg, main) => {
  const checks = await api("/api/diagnostics");
  const sync = h(
    "button",
    {
      class: "btn",
      type: "button",
      onclick: async () => {
        try {
          const r = await api("/api/vault/sync", { method: "POST", body: {} });
          toast(
            r.skipped
              ? `Skipped: ${r.skipped}`
              : `Vault synced: ${r.written.length} written, ${r.conflicts.length} kept as yours`,
          );
        } catch (err) {
          toast(err.message);
        }
      },
    },
    "Sync vault now",
  );
  const icon = { ok: "✓", warn: "!", fail: "✗", info: "·" };
  const label = { ok: "OK", warn: "Warning", fail: "Problem", info: "Info" };
  render(
    main,
    pageHead(
      "Diagnostics",
      "The same checks as `dev-learning-ai doctor`.",
      sync,
      h("button", { class: "btn", type: "button", onclick: () => route() }, "Run again"),
    ),
    h(
      "ul",
      { class: "list panel" },
      checks.map((c) =>
        h(
          "li",
          {},
          h(
            "div",
            { class: "main" },
            h("div", {}, `${icon[c.status]} ${c.name}`),
            h("div", { class: "small muted" }, c.detail),
            c.fix ? h("div", { class: "small" }, `Fix: ${c.fix}`) : null,
          ),
          h(
            "span",
            {
              class: `chip ${c.status === "ok" ? "ok" : c.status === "warn" ? "warn" : c.status === "fail" ? "bad" : ""}`,
            },
            label[c.status],
          ),
        ),
      ),
    ),
  );
};

// ── router ────────────────────────────────────────────────────────────
async function route() {
  const [, name = "overview", arg] = location.hash.replace(/^#\/?/, "#").split(/[#/]/).concat([]);
  const view = views[name] ?? views.overview;
  for (const a of document.querySelectorAll(".nav a")) {
    if (a.getAttribute("href") === `#/${name in views ? name : "overview"}`)
      a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  document.getElementById("nav").classList.remove("open");
  document.querySelector(".menu-toggle").setAttribute("aria-expanded", "false");
  const seq = ++routeSeq;
  const host = document.createElement("div");
  main = host;
  root.replaceChildren(skeleton());
  try {
    await view(arg ? decodeURIComponent(arg) : undefined, host);
    if (seq !== routeSeq) return;
    root.replaceChildren(host);
    document.title = `${name[0].toUpperCase()}${name.slice(1)} · dev-learning-ai`;
  } catch (err) {
    if (seq !== routeSeq) return;
    root.replaceChildren(errorBox(err, route));
  }
}

document.querySelector(".menu-toggle").addEventListener("click", (e) => {
  const nav = document.getElementById("nav");
  const open = !nav.classList.contains("open");
  nav.classList.toggle("open", open);
  e.currentTarget.setAttribute("aria-expanded", String(open));
});
window.addEventListener("hashchange", () => {
  route();
  root.focus({ preventScroll: true });
});

(async () => {
  try {
    csrf = (await api("/api/session")).csrf;
  } catch (err) {
    root.replaceChildren(errorBox(err));
    return;
  }
  if (!location.hash) location.hash = "#/overview";
  route();
})();
