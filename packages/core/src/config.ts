import { existsSync } from "fs";
import { join } from "path";
import { z } from "zod";
import type { LintConfig } from "./lint/config";
import type { OwnershipMarker } from "./ownership";

/**
 * Zod schema for ChantConfig validation.
 */
export const ChantConfigSchema = z.object({
  lexicons: z.array(z.string().min(1)).optional(),
  environments: z.array(z.string().min(1)).optional(),
  sourceDir: z.string().min(1).optional(),
  lint: z.record(z.string(), z.unknown()).optional(),
  ownership: z.object({
    stack: z.string().min(1).optional(),
    env: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
  }).optional(),
}).passthrough();

/**
 * Top-level chant project configuration.
 *
 * Loaded from `chant.config.ts` (preferred) or `chant.config.json`.
 */
export interface ChantConfig {
  /** Lexicon package names to load (e.g. ["aws"]) */
  lexicons?: string[];

  /** Environment names (e.g. ["staging", "prod"]) */
  environments?: string[];

  /**
   * Directory (relative to the project root) that holds the chant infrastructure
   * source. Lifecycle commands (`snapshot`/`diff`/`plan`) build from here instead
   * of the project root, so a mixed-layout project — chant `src/` alongside app
   * code that has import side effects — can scope the build to just the infra.
   * Defaults to "." (the project root). The `--src` flag overrides it.
   */
  sourceDir?: string;

  /** Lint configuration (rules, extends, overrides, plugins) */
  lint?: LintConfig;

  /**
   * Opt-in cloud-side ownership marking. When `stack` is set (and `enabled`
   * is not false), the serializer stamps a chant ownership marker carrying
   * this stack/env identity onto every supported resource. See {@link
   * resolveOwnershipMarker}.
   */
  ownership?: {
    /** Stack identity stamped onto resources (required to enable stamping). */
    stack?: string;
    /** Optional environment identity. */
    env?: string;
    /** Set false to disable stamping even when `stack` is present. */
    enabled?: boolean;
  };
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
 * Resolve the ownership marker to stamp from project config, or undefined when
 * ownership marking is off (no `stack`, or `enabled: false`).
 */
export function resolveOwnershipMarker(config: ChantConfig): OwnershipMarker | undefined {
  const o = config.ownership;
  if (!o || !o.stack || o.enabled === false) return undefined;
  return { stack: o.stack, env: o.env };
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
