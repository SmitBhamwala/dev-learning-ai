import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ENV_PREFIX, PRODUCT_DIR_NAME, PRODUCT_NAME } from "@dev-learning-ai/core";

/**
 * Global data location, discoverable and overridable:
 *   1. DEV_LEARNING_AI_HOME (any platform)
 *   2. Linux: $XDG_DATA_HOME/dev-learning-ai when XDG_DATA_HOME is set
 *   3. ~/.dev-learning-ai (Windows, macOS, Linux)
 */

export interface GlobalPaths {
  home: string;
  config: string;
  configFile: string;
  managedConfigFile: string;
  configHistory: string;
  database: string;
  cache: string;
  logs: string;
  projects: string;
  inbox: string;
  backups: string;
  defaultVault: string;
}

export function resolveHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env[`${ENV_PREFIX}_HOME`];
  if (override && override.trim()) return resolve(override.trim());
  if (platform === "linux" && env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, PRODUCT_NAME);
  return join(env.HOME && platform !== "win32" ? env.HOME : homedir(), PRODUCT_DIR_NAME);
}

export function globalPaths(home = resolveHome(), env: NodeJS.ProcessEnv = process.env): GlobalPaths {
  const config = join(home, "config");
  return {
    home,
    config,
    configFile: join(config, "config.yaml"),
    managedConfigFile: env[`${ENV_PREFIX}_MANAGED_CONFIG`] ?? join(config, "managed.yaml"),
    configHistory: join(config, "history"),
    database: join(home, "database"),
    cache: join(home, "cache"),
    logs: join(home, "logs"),
    projects: join(home, "projects"),
    inbox: join(home, "inbox"),
    backups: join(home, "backups"),
    defaultVault: join(home, "vault"),
  };
}

export const PROJECT_FILE = "project.yaml";
export const PROJECT_CONFIG_FILE = "config.yaml";

export function projectDir(repoRoot: string): string {
  return join(repoRoot, PRODUCT_DIR_NAME);
}
