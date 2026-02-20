import { resolve, join } from "path";
import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { runLint } from "../../lint/engine";
import type { LintRule, LintDiagnostic, LintFix } from "../../lint/rule";
import { loadPlugins, resolveProjectLexicons } from "../plugins";
import { formatStylish, formatJson, formatSarif } from "../reporters/stylish";
import { loadLocalRules } from "../../lint/rule-loader";
import { loadCoreRules } from "../../lint/rules/index";
import { rule } from "../../lint/declarative";
import { watchDirectory, formatTimestamp, formatChangedFiles } from "../watch";
import { formatError, formatInfo } from "../format";

// Import config loader
import { loadConfig, resolveRulesForFile, parseRuleConfig } from "../../lint/config";
import type { RuleConfig } from "../../lint/rule";

/**
 * Type guard to check if a value conforms to the LintRule interface.
 */
export function isLintRule(value: unknown): value is LintRule {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof (value as Record<string, unknown>).id === "string" &&
    "severity" in value &&
    "category" in value &&
    "check" in value &&
    typeof (value as Record<string, unknown>).check === "function"
  );
}

/**
 * Load custom lint rules from plugin files.
 * Each plugin file is dynamically imported and all exports conforming to LintRule are collected.
 */
export async function loadPluginRules(
  plugins: string[],
  configDir: string,
): Promise<Map<string, LintRule>> {
  const pluginRules = new Map<string, LintRule>();
  for (const pluginPath of plugins) {
    const resolved = resolve(configDir, pluginPath);
    let mod: Record<string, unknown>;
    try {
      mod = await import(resolved);
    } catch (err) {
      throw new Error(
        `Failed to load plugin "${pluginPath}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    for (const value of Object.values(mod)) {
      if (isLintRule(value)) {
        pluginRules.set(value.id, value);
      }
    }
  }
  return pluginRules;
}

/**
 * Load all lint rules: core COR/EVL rules, then lexicon plugin rules.
 */
async function loadAllPluginRules(projectPath: string): Promise<Map<string, LintRule>> {
  const rules = new Map<string, LintRule>();

  // Load core COR/EVL rules directly
  for (const r of loadCoreRules()) {
    rules.set(r.id, r);
  }

  // Resolve project lexicons (e.g. ["aws"]) from config or detection
  let lexiconNames: string[] = [];
  try {
    lexiconNames = await resolveProjectLexicons(projectPath);
  } catch {
    // No lexicons detected — core rules only
  }

  // Load only project lexicon plugins (no "chant" injection)
  const plugins = await loadPlugins(lexiconNames);

  for (const plugin of plugins) {
    if (plugin.lintRules) {
      for (const r of plugin.lintRules()) {
        rules.set(r.id, r);
      }
    }
    // Compile declarative rules from plugins
    if (plugin.declarativeRules) {
      for (const spec of plugin.declarativeRules()) {
        const compiled = rule(spec);
        rules.set(compiled.id, compiled);
      }
    }
  }

  // Load project-local rules from .chant/rules/
  const localRules = await loadLocalRules(projectPath);
  for (const r of localRules) {
    rules.set(r.id, r);
  }

  return rules;
}

/**
 * Lint command options
 */
export interface LintOptions {
  /** Path to lint */
  path: string;
  /** Apply auto-fixes */
  fix?: boolean;
  /** Output format */
  format: "stylish" | "json" | "sarif";
  /** Rules to use (defaults to all) */
  rules?: LintRule[];
}

/**
 * Lint command result
 */
export interface LintResult {
  /** Whether lint passed (no errors) */
  success: boolean;
  /** Number of errors */
  errorCount: number;
  /** Number of warnings */
  warningCount: number;
  /** All diagnostics */
  diagnostics: LintDiagnostic[];
  /** Formatted output */
  output: string;
}

/**
 * Get all TypeScript files recursively
 */
function getTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];

  function scan(currentDir: string): void {
    const entries = readdirSync(currentDir);

    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        if (entry !== "node_modules" && !entry.startsWith(".")) {
          scan(fullPath);
        }
      } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".spec.ts")) {
        files.push(fullPath);
      }
    }
  }

  scan(dir);
  return files;
}

/**
 * Get default rules and options, optionally applying per-file overrides
 */
function getDefaultRules(
  infraPath: string,
  filePath?: string,
  allRules: Map<string, LintRule> = new Map(),
): { rules: LintRule[]; ruleOptions: Map<string, Record<string, unknown>> } {
  const config = loadConfig(infraPath);
  const effectiveRules = filePath ? resolveRulesForFile(config, filePath) : config.rules;
  const rules: LintRule[] = [];
  const ruleOptions = new Map<string, Record<string, unknown>>();

  for (const [ruleId, rule] of allRules) {
    const configValue: RuleConfig | undefined = effectiveRules?.[ruleId];

    if (configValue === undefined) {
      // Rule not mentioned in config — include with default severity
      rules.push(rule);
      continue;
    }

    const parsed = parseRuleConfig(configValue);

    // Skip rules that are explicitly turned off
    if (parsed.severity === "off") continue;

    // Override severity from config
    rules.push({
      ...rule,
      severity: parsed.severity as "error" | "warning" | "info",
    });

    // Store options if present
    if (parsed.options) {
      ruleOptions.set(ruleId, parsed.options);
    }
  }

  return { rules, ruleOptions };
}

/**
 * Apply fixes to a file
 */
function applyFixes(filePath: string, fixes: LintFix[]): void {
  if (fixes.length === 0) return;

  let content = readFileSync(filePath, "utf-8");

  // Sort fixes by position descending so we can apply from end to start
  const sortedFixes = [...fixes].sort((a, b) => b.range[0] - a.range[0]);

  for (const fix of sortedFixes) {
    content = content.slice(0, fix.range[0]) + fix.replacement + content.slice(fix.range[1]);
  }

  writeFileSync(filePath, content);
}

/**
 * Execute the lint command
 */
export async function lintCommand(options: LintOptions): Promise<LintResult> {
  const infraPath = resolve(options.path);
  const config = loadConfig(infraPath);
  const hasOverrides = config.overrides && config.overrides.length > 0;

  // Load all rules from lexicon plugins (core "chant" + lexicon-specific)
  let allRules = await loadAllPluginRules(infraPath);

  // Merge in any config-level plugin rules (custom .ts rule files)
  if (config.plugins && config.plugins.length > 0) {
    const pluginRules = await loadPluginRules(config.plugins, infraPath);
    allRules = new Map([...allRules, ...pluginRules]);
  }

  // Get all TypeScript files
  const files = getTypeScriptFiles(infraPath);

  // Run lint — use per-file rules when overrides are present
  let diagnostics: LintDiagnostic[];
  if (options.rules) {
    diagnostics = await runLint(files, options.rules, undefined);
  } else if (hasOverrides) {
    diagnostics = [];
    for (const file of files) {
      const relativePath = file.slice(infraPath.length + 1);
      const { rules: fileRules, ruleOptions } = getDefaultRules(infraPath, relativePath, allRules);
      const fileDiagnostics = await runLint([file], fileRules, ruleOptions);
      diagnostics.push(...fileDiagnostics);
    }
  } else {
    const { rules, ruleOptions } = getDefaultRules(infraPath, undefined, allRules);
    diagnostics = await runLint(files, rules, ruleOptions);
  }

  // Apply fixes if requested
  if (options.fix) {
    // Group fixes by file
    const fixesByFile = new Map<string, LintFix[]>();

    for (const diag of diagnostics) {
      if (diag.fix) {
        const existing = fixesByFile.get(diag.file) ?? [];
        existing.push(diag.fix);
        fixesByFile.set(diag.file, existing);
      }
    }

    // Apply fixes to each file
    for (const [file, fixes] of fixesByFile) {
      applyFixes(file, fixes);
    }

    // Re-lint after fixes to get updated diagnostics
    let postFixDiagnostics: LintDiagnostic[];
    if (options.rules) {
      postFixDiagnostics = await runLint(files, options.rules, undefined);
    } else if (hasOverrides) {
      postFixDiagnostics = [];
      for (const file of files) {
        const relativePath = file.slice(infraPath.length + 1);
        const { rules: fileRules, ruleOptions } = getDefaultRules(infraPath, relativePath, allRules);
        const fileDiagnostics = await runLint([file], fileRules, ruleOptions);
        postFixDiagnostics.push(...fileDiagnostics);
      }
    } else {
      const { rules, ruleOptions } = getDefaultRules(infraPath, undefined, allRules);
      postFixDiagnostics = await runLint(files, rules, ruleOptions);
    }
    diagnostics.length = 0;
    diagnostics.push(...postFixDiagnostics);
  }

  // Count errors and warnings
  let errorCount = 0;
  let warningCount = 0;

  for (const diag of diagnostics) {
    if (diag.severity === "error") {
      errorCount++;
    } else if (diag.severity === "warning") {
      warningCount++;
    }
  }

  // Format output
  let output: string;
  switch (options.format) {
    case "json":
      output = formatJson(diagnostics);
      break;
    case "sarif":
      output = formatSarif(diagnostics);
      break;
    case "stylish":
    default:
      output = formatStylish(diagnostics);
      break;
  }

  return {
    success: errorCount === 0,
    errorCount,
    warningCount,
    diagnostics,
    output,
  };
}

/**
 * Print lint result to console
 */
export function printLintResult(result: LintResult): void {
  if (result.output) {
    console.log(result.output);
  }
}

/**
 * Run lint in watch mode. Runs an initial lint, then watches for changes
 * and triggers re-lints. Returns a cleanup function.
 */
export function lintCommandWatch(
  options: LintOptions,
  onReLint?: (result: LintResult) => void,
): () => void {
  const infraPath = resolve(options.path);

  console.error(formatInfo(`[${formatTimestamp()}] Watching for changes...`));

  // Run initial lint
  lintCommand(options).then((result) => {
    printLintResult(result);
    onReLint?.(result);
    console.error(formatInfo(`[${formatTimestamp()}] Waiting for changes...`));
  });

  // Watch for changes and trigger re-lints
  const cleanup = watchDirectory(infraPath, async (changedFiles) => {
    console.error("");
    console.error(
      formatInfo(
        `[${formatTimestamp()}] Changes detected: ${formatChangedFiles(changedFiles, infraPath)}`,
      ),
    );

    try {
      const result = await lintCommand(options);
      printLintResult(result);
      onReLint?.(result);
    } catch (err) {
      console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    }

    console.error(formatInfo(`[${formatTimestamp()}] Waiting for changes...`));
  });

  return cleanup;
}
