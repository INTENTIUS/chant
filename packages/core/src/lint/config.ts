import { readFileSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { createRequire } from "module";
import { z } from "zod";
import type { Severity, RuleConfig } from "./rule";
import { moduleDir, getRuntime } from "../runtime-adapter";
import strictPreset from "./presets/strict.json";

/** Mapping of built-in preset names to their file paths */
const BUILTIN_PRESETS: Record<string, string> = {
  "@intentius/chant/lint/presets/strict": resolve(moduleDir(import.meta.url), "presets/strict.json"),
  "@intentius/chant/lint/presets/relaxed": resolve(moduleDir(import.meta.url), "presets/relaxed.json"),
};

// ── Zod schemas for lint config validation ─────────────────────────

const SeveritySchema = z.enum(["off", "error", "warning", "info"]);

const RuleConfigSchema = z.union([
  SeveritySchema,
  z.tuple([SeveritySchema, z.record(z.string(), z.unknown())]),
]);

export const LintConfigSchema = z.object({
  rules: z.record(z.string(), RuleConfigSchema).optional(),
  extends: z.array(z.string()).optional(),
  overrides: z.array(z.object({
    files: z.array(z.string()),
    rules: z.record(z.string(), RuleConfigSchema),
  })).optional(),
  plugins: z.array(z.string()).optional(),
});

/**
 * Check if a Zod union error is specifically about an invalid severity string
 * (as opposed to a completely wrong type like a number).
 */
function isBadSeverityError(issue: z.ZodIssue, config: unknown, path: readonly (string | number)[]): string | null {
  if (issue.code !== "invalid_union") return null;

  // Navigate to the value in the config to see what was actually provided
  let value: unknown = config;
  for (const key of path) {
    if (value == null || typeof value !== "object") return null;
    value = (value as any)[key];
  }

  // If the value is a string, the user meant it as a severity — show the specific severity error
  if (typeof value === "string") {
    return value;
  }
  return null;
}

/**
 * Format a Zod error into a human-readable message matching existing error patterns.
 */
function formatLintConfigError(configPath: string, error: z.ZodError, rawConfig: unknown): string {
  const issue = error.issues[0];
  const path = issue.path;

  // Cast path to (string | number)[] — Zod's path is PropertyKey[] but only uses string | number
  const p = path as (string | number)[];

  // rules.{ruleId} — invalid severity or structure
  if (p[0] === "rules" && p.length >= 2) {
    const ruleId = p[1];
    const badValue = isBadSeverityError(issue, rawConfig, p);
    if (badValue !== null) {
      return `Invalid config file ${configPath}: rule "${ruleId}" has invalid severity "${badValue}". Must be "off", "error", "warning", or "info"`;
    }
    return `Invalid config file ${configPath}: rule "${ruleId}" must be a severity string or [severity, options] tuple`;
  }

  // rules — wrong type
  if (p[0] === "rules" && p.length === 1) {
    return `Invalid config file ${configPath}: rules must be an object`;
  }

  // extends — wrong type or element type
  if (p[0] === "extends") {
    if (p.length === 1) {
      return `Invalid config file ${configPath}: extends must be an array`;
    }
    return `Invalid config file ${configPath}: extends must be an array of strings`;
  }

  // overrides[i].* errors
  if (p[0] === "overrides") {
    if (p.length === 1) {
      return `Invalid config file ${configPath}: overrides must be an array`;
    }
    const i = p[1];
    if (p.length === 2) {
      return `Invalid config file ${configPath}: overrides[${i}] must be an object`;
    }
    if (p[2] === "files") {
      if (p.length === 3) {
        return `Invalid config file ${configPath}: overrides[${i}].files must be an array`;
      }
      return `Invalid config file ${configPath}: overrides[${i}].files must be an array of strings`;
    }
    if (p[2] === "rules") {
      if (p.length === 3) {
        return `Invalid config file ${configPath}: overrides[${i}].rules must be an object`;
      }
      if (p.length >= 4) {
        const ruleId = p[3];
        const badValue = isBadSeverityError(issue, rawConfig, p);
        if (badValue !== null) {
          return `Invalid config file ${configPath}: overrides[${i}] rule "${ruleId}" has invalid severity "${badValue}". Must be "off", "error", "warning", or "info"`;
        }
        return `Invalid config file ${configPath}: overrides[${i}] rule "${ruleId}" must be a severity string or [severity, options] tuple`;
      }
    }
  }

  // plugins — wrong type or element type
  if (p[0] === "plugins") {
    if (p.length === 1) {
      return `Invalid config file ${configPath}: plugins must be an array`;
    }
    return `Invalid config file ${configPath}: plugins must be an array of strings`;
  }

  // Fallback
  return `Invalid config file ${configPath}: ${issue.message}`;
}

/**
 * Per-file rule override
 */
export interface LintOverride {
  /** Glob patterns to match file paths */
  files: string[];
  /** Rule overrides for matched files */
  rules: Record<string, RuleConfig>;
}

/**
 * Lint configuration
 */
export interface LintConfig {
  /** Rule configurations: rule ID -> severity string or [severity, options] tuple */
  rules?: Record<string, RuleConfig>;
  /** Array of config file paths to extend from */
  extends?: string[];
  /** Per-file rule overrides via glob patterns */
  overrides?: LintOverride[];
  /** Array of plugin file paths to load custom rules from (project-local, not inherited) */
  plugins?: string[];
}

/**
 * Parsed rule configuration with severity and optional options
 */
export interface ParsedRuleConfig {
  severity: "off" | Severity;
  options?: Record<string, unknown>;
}

/**
 * Parse a rule config value into severity and options
 */
export function parseRuleConfig(value: RuleConfig): ParsedRuleConfig {
  if (typeof value === "string") {
    return { severity: value as "off" | Severity };
  }

  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`Invalid rule config: expected a severity string or [severity, options] tuple`);
  }

  const [severity, options] = value;

  if (typeof severity !== "string" || !isValidSeverity(severity)) {
    throw new Error(
      `Invalid rule config: severity "${severity}" must be "off", "error", "warning", or "info"`
    );
  }

  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new Error(`Invalid rule config: options must be a plain object`);
  }

  return { severity, options };
}

/**
 * Default configuration with all rules enabled at strict preset severities
 */
export const DEFAULT_CONFIG: LintConfig = {
  rules: { ...strictPreset.rules } as Record<string, RuleConfig>,
  extends: [],
};

/**
 * Validate that a severity string is valid
 */
function isValidSeverity(value: string): value is "off" | Severity {
  return value === "off" || value === "error" || value === "warning" || value === "info";
}

/**
 * Load and merge a single config file
 */
function loadConfigFile(configPath: string, visited: Set<string> = new Set()): LintConfig {
  // Check for circular extends
  if (visited.has(configPath)) {
    throw new Error(`Circular extends detected: ${configPath}`);
  }
  visited.add(configPath);

  // Read and parse config file
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  let content: string;
  try {
    content = readFileSync(configPath, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read config file ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let config: LintConfig;
  try {
    config = JSON.parse(content);
  } catch (err) {
    throw new Error(`Failed to parse config file ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Validate config structure
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`Invalid config file ${configPath}: must be an object`);
  }

  // Validate with Zod schema
  const parseResult = LintConfigSchema.safeParse(config);
  if (!parseResult.success) {
    throw new Error(formatLintConfigError(configPath, parseResult.error, config));
  }

  // Process extends
  let mergedConfig: LintConfig = { rules: {}, extends: [] };

  if (config.extends && config.extends.length > 0) {
    const baseDir = dirname(configPath);

    for (const extendPath of config.extends) {
      // Resolve paths: relative, built-in preset, or absolute
      let resolvedPath: string;
      if (extendPath.startsWith(".")) {
        resolvedPath = join(baseDir, extendPath);
      } else if (extendPath.startsWith("@intentius/chant")) {
        const builtinPath = BUILTIN_PRESETS[extendPath];
        if (builtinPath) {
          resolvedPath = builtinPath;
        } else {
          throw new Error(`Unknown preset: ${extendPath} (extended from ${configPath})`);
        }
      } else {
        resolvedPath = extendPath;
      }

      // Check if extended config exists
      if (!existsSync(resolvedPath)) {
        throw new Error(`Extended config file not found: ${resolvedPath} (extended from ${configPath})`);
      }

      // Load extended config recursively
      const extendedConfig = loadConfigFile(resolvedPath, visited);

      // Merge rules (later configs override earlier ones)
      mergedConfig.rules = {
        ...mergedConfig.rules,
        ...extendedConfig.rules,
      };
    }
  }

  // Merge current config rules on top
  mergedConfig.rules = {
    ...mergedConfig.rules,
    ...config.rules,
  };

  // Preserve overrides from the current config
  if (config.overrides) {
    mergedConfig.overrides = config.overrides;
  }

  // Preserve plugins from the current config only (not inherited from extends)
  if (config.plugins) {
    mergedConfig.plugins = config.plugins;
  }

  return mergedConfig;
}

/**
 * Load lint configuration from a directory.
 *
 * Tries `chant.config.ts` first (extracts `lint` property from ChantConfig),
 * then falls back to `chant.config.json` (legacy LintConfig format).
 * Returns default configuration if neither exists.
 *
 * @param dir - Directory path to search for config file
 * @returns Loaded and merged configuration, or default config if not found
 */
export function loadConfig(dir: string): LintConfig {
  // Try chant.config.ts first — Bun has native require() for .ts, Node uses tsx's loader
  const tsConfigPath = join(dir, "chant.config.ts");
  if (existsSync(tsConfigPath)) {
    try {
      const _require = createRequire(join(dir, "package.json"));
      const mod = _require(tsConfigPath);
      const config = mod.default ?? mod.config ?? mod;
      if (typeof config === "object" && config !== null) {
        // ChantConfig format: extract lint property
        if ("lint" in config && typeof config.lint === "object") {
          return config.lint as LintConfig;
        }
        // Bare rules at top level
        if ("rules" in config) {
          return config as LintConfig;
        }
        // Config exists but has no lint section — use defaults
        return DEFAULT_CONFIG;
      }
    } catch {
      // Fall through to JSON
    }
  }

  // Fall back to chant.config.json
  const jsonConfigPath = join(dir, "chant.config.json");
  if (!existsSync(jsonConfigPath)) {
    return DEFAULT_CONFIG;
  }

  try {
    return loadConfigFile(jsonConfigPath);
  } catch (error) {
    throw error;
  }
}

/**
 * Resolve the effective rules for a specific file path by applying overrides.
 *
 * Starts with the base config rules, then iterates through overrides in order.
 * For each override whose file globs match the given path, merges override rules on top.
 *
 * @param config - The loaded lint configuration
 * @param filePath - The file path to resolve rules for (relative to project root)
 * @returns Merged rule configuration with overrides applied
 */
export function resolveRulesForFile(config: LintConfig, filePath: string): Record<string, RuleConfig> {
  const rules: Record<string, RuleConfig> = { ...config.rules };

  if (!config.overrides) {
    return rules;
  }

  for (const override of config.overrides) {
    const matches = override.files.some((pattern) => {
      return getRuntime().globMatch(pattern, filePath);
    });

    if (matches) {
      Object.assign(rules, override.rules);
    }
  }

  return rules;
}
