import { existsSync } from "fs";
import { join } from "path";
import { z } from "zod";
import type { LintConfig } from "./lint/config";

/**
 * Zod schema for ChantConfig validation.
 */
export const ChantConfigSchema = z.object({
  runtime: z.enum(["bun", "node"]).optional(),
  lexicons: z.array(z.string().min(1)).optional(),
  lint: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

/**
 * Top-level chant project configuration.
 *
 * Loaded from `chant.config.ts` (preferred) or `chant.config.json`.
 */
export interface ChantConfig {
  /** JS runtime to use for spawned commands: "bun" (default) or "node" */
  runtime?: "bun" | "node";

  /** Lexicon package names to load (e.g. ["aws"]) */
  lexicons?: string[];

  /** Lint configuration (rules, extends, overrides, plugins) */
  lint?: LintConfig;
}

/**
 * Resolved project configuration with metadata about how it was loaded.
 */
export interface ResolvedConfig {
  /** The loaded configuration */
  config: ChantConfig;

  /** Path to the config file that was loaded, or undefined if defaults */
  configPath?: string;
}

/**
 * Default configuration when no config file exists.
 */
export const DEFAULT_CHANT_CONFIG: ChantConfig = {};

/**
 * Load project configuration from a directory.
 *
 * Tries `chant.config.ts` first (via dynamic import), then `chant.config.json`.
 * Returns default config if neither exists.
 */
export async function loadChantConfig(dir: string): Promise<ResolvedConfig> {
  // Try chant.config.ts first
  const tsPath = join(dir, "chant.config.ts");
  if (existsSync(tsPath)) {
    const mod = await import(tsPath);
    const config = mod.default ?? mod.config ?? mod;
    return { config: normalizeConfig(config, tsPath), configPath: tsPath };
  }

  // Fall back to chant.config.json
  const jsonPath = join(dir, "chant.config.json");
  if (existsSync(jsonPath)) {
    const { readFileSync } = await import("fs");
    const content = readFileSync(jsonPath, "utf-8");
    const parsed = JSON.parse(content);
    return { config: normalizeConfig(parsed, jsonPath), configPath: jsonPath };
  }

  return { config: DEFAULT_CHANT_CONFIG };
}

/**
 * Validate and normalize a raw config object into ChantConfig shape.
 */
function normalizeConfig(raw: Record<string, unknown>, source?: string): ChantConfig {
  if (typeof raw !== "object" || raw === null) {
    return DEFAULT_CHANT_CONFIG;
  }

  const result = ChantConfigSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.length > 0 ? issue.path.join(".") : undefined;
    const loc = source ? ` in ${source}` : "";
    throw new Error(`Invalid chant config${loc}: ${path ? `${path}: ` : ""}${issue.message}`);
  }

  return raw as ChantConfig;
}
