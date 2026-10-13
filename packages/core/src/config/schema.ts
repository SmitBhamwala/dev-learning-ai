import { z } from "zod";

/**
 * The single configuration schema shared by the CLI, the dashboard, the
 * AI-assisted configurator and every agent integration.
 *
 * Precedence (later wins): built-in defaults → global → project → workspace → session.
 * Organization-managed settings (if present) are applied last and locked.
 */

export const CONFIG_SCHEMA_VERSION = 1;

const auto = <T extends z.ZodTypeAny>(t: T) => z.union([z.literal("auto"), t]);

export const ModeSchema = z.enum(["observe", "collaborate", "teach"]);
export type Mode = z.infer<typeof ModeSchema>;

export const ConfigSchema = z
  .object({
    schema_version: z.literal(CONFIG_SCHEMA_VERSION).default(CONFIG_SCHEMA_VERSION),
    learning: z
      .object({
        enabled: z.boolean().default(true),
        mode: auto(ModeSchema).default("auto"),
        post_task_assessment: z.boolean().default(true),
        pre_task_assessment: z.boolean().default(false),
        questions_per_task: z.number().int().min(1).max(20).default(3),
        difficulty: auto(z.number().int().min(1).max(5)).default("auto"),
        reasoning_prompts: z.enum(["off", "optional", "required"]).default("optional"),
        confidence_tracking: z.enum(["off", "optional", "required"]).default("optional"),
        interview_mode: z.boolean().default(false),
        socratic_mode: z.boolean().default(false),
        adaptive_questions: z.boolean().default(true),
        min_changed_lines_for_assessment: z.number().int().min(0).default(10),
        spaced_repetition: z
          .object({
            enabled: z.boolean().default(true),
            algorithm: z.string().default("sm2"),
            review_due_topics: z.boolean().default(true),
            generate_variants: z.boolean().default(true),
            max_reviews_per_day: z.number().int().min(1).max(200).default(20),
          })
          .default({}),
        knowledge_health: z
          .object({
            enabled: z.boolean().default(true),
            dependency_insights: z.boolean().default(false),
          })
          .default({}),
        version_scope: z
          .object({
            default: z.enum(["current", "agnostic", "latest"]).default("current"),
            targets: z.record(z.string(), z.string()).default({}),
          })
          .default({}),
      })
      .default({}),
    ai: z
      .object({
        provider: z.string().default("auto"),
        model: z.string().default("auto"),
        effort: z.string().default("auto"),
        token_budget: z.enum(["minimal", "balanced", "generous", "custom"]).default("balanced"),
        max_model_calls_per_task: z.number().int().min(0).max(50).default(2),
        max_model_calls_per_session: z.number().int().min(0).max(500).default(10),
        max_tokens_per_task: z.number().int().min(0).default(8000),
        /**
         * Let the coding agent's own model (e.g. Claude Code's session model, via the
         * Mods API) write questions. It receives redacted task evidence: file names,
         * symbols and detected concepts, never whole files. Setup asks before enabling.
         */
        allow_host_model: z.boolean().default(false),
        /** Let a separately configured provider (e.g. the Anthropic API) receive the same evidence. */
        allow_remote_analysis: z.boolean().default(false),
        /** When no model may or can run: defer learning (evidence is kept) or report an error. */
        fallback: z.enum(["defer", "fail"]).default("defer"),
        timeout_ms: z.number().int().min(1000).max(300000).default(30000),
      })
      .default({}),
    knowledge: z
      .object({
        provider: z.enum(["markdown", "obsidian", "none"]).default("markdown"),
        vault_path: z.string().default(""),
        vault_folder: z.string().default("DeveloperKnowledge"),
        allow_cross_project_reuse: z.boolean().default(true),
        sync: z.enum(["on-change", "manual"]).default("on-change"),
      })
      .default({}),
    resources: z
      .object({
        enabled: z.boolean().default(true),
        external_lookup: z.enum(["never", "ask", "allow"]).default("ask"),
        trusted_domains: z.array(z.string()).default([]),
      })
      .default({}),
    privacy: z
      .object({
        store_full_transcripts: z.boolean().default(false),
        store_code_snippets: z.enum(["none", "minimal", "full"]).default("minimal"),
        redact_secrets: z.boolean().default(true),
        external_resource_lookup: z.enum(["never", "ask", "allow"]).default("ask"),
        retention_days: z.number().int().min(0).default(0),
        send_project_metadata_to_providers: z.boolean().default(false),
      })
      .default({}),
    dashboard: z
      .object({
        enabled: z.boolean().default(true),
        host: z.string().default("127.0.0.1"),
        port: auto(z.number().int().min(1).max(65535)).default("auto"),
        allow_remote_access: z.boolean().default(false),
      })
      .default({}),
    notifications: z
      .object({
        enabled: z.boolean().default(true),
        due_review_reminders: z.boolean().default(false),
      })
      .default({}),
    events: z
      .object({
        sampling_rate: z.number().min(0).max(1).default(1),
        max_queue: z.number().int().min(10).max(100000).default(1000),
      })
      .default({}),
    projects: z
      .object({
        excluded_paths: z.array(z.string()).default([]),
      })
      .default({}),
    plugins: z
      .object({
        enabled: z.array(z.string()).default([]),
        permissions: z
          .record(z.string(), z.array(z.enum(["read-knowledge", "write-knowledge", "network", "reports"])))
          .default({}),
      })
      .default({}),
  })
  .superRefine((cfg, ctx) => {
    if (
      cfg.dashboard.host !== "127.0.0.1" &&
      cfg.dashboard.host !== "localhost" &&
      cfg.dashboard.host !== "::1"
    ) {
      if (!cfg.dashboard.allow_remote_access) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dashboard", "host"],
          message:
            "Binding the dashboard to a non-loopback host requires dashboard.allow_remote_access: true",
        });
      }
    }
    if (cfg.learning.interview_mode && cfg.learning.reasoning_prompts === "off") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["learning", "reasoning_prompts"],
        message: "Interview mode needs reasoning prompts; set reasoning_prompts to optional or required",
      });
    }
    if (cfg.knowledge.provider === "obsidian" && cfg.knowledge.vault_path.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["knowledge", "vault_path"],
        message: "The obsidian provider needs knowledge.vault_path (the vault's folder)",
      });
    }
    if (
      cfg.ai.max_model_calls_per_task > cfg.ai.max_model_calls_per_session &&
      cfg.ai.max_model_calls_per_session > 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ai", "max_model_calls_per_task"],
        message: "Per-task model calls cannot exceed the per-session budget",
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;

/** Keys the user must confirm before an AI-assisted or dashboard change applies. */
export const SENSITIVE_KEYS = [
  "ai.allow_remote_analysis",
  "ai.allow_host_model",
  "ai.provider",
  "privacy.store_full_transcripts",
  "privacy.store_code_snippets",
  "privacy.redact_secrets",
  "privacy.send_project_metadata_to_providers",
  "privacy.external_resource_lookup",
  "resources.external_lookup",
  "dashboard.host",
  "dashboard.allow_remote_access",
  "knowledge.vault_path",
  "knowledge.provider",
  "plugins.enabled",
  "plugins.permissions",
];

export function isSensitiveKey(path: string): boolean {
  return SENSITIVE_KEYS.some((k) => path === k || path.startsWith(`${k}.`));
}

export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}
