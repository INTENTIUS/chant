import { resolve, join } from "path";
import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { runLint, parseDisableComments } from "../../lint/engine";
import type { LintRule, LintDiagnostic, LintFix } from "../../lint/rule";
import { loadPlugins, resolveProjectLexicons } from "../plugins";
import { formatStylish, formatJson, formatSarif } from "../reporters/stylish";
import { loadLocalRules } from "../../lint/rule-loader";
import { loadCoreRules } from "../../lint/rules/index";
import { loadComponentChecks } from "../../lint/rules/comp/index";
import { runComponentChecks, type ComponentCheckDiagnostic } from "../../lint/component-checks";
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
 * Run the COMP* composition checks (#562) over the discovered `Component`
 * graph and convert their results into plain `LintDiagnostic`s so they merge
 * into the same `chant lint` output (stylish/json/sarif) and the same
 * error-count gating as every COR/EVL diagnostic.
 *
 * These checks operate on the whole discovered component graph, not one
 * `ts.SourceFile`, so they carry no real line/column — reported at `1:1` in
 * the file the component was declared in (matching COR009's whole-file
 * diagnostic convention, see ../../lint/rules/file-declarable-limit.ts).
 * Config severity overrides (`lint.rules["COMP001"]`, including `"off"`) are
 * honored the same way `getDefaultRules` honors them for AST rules. Only the
 * *file-level* disable directive form (`// chant-disable` /
 * `// chant-disable COMP004 -- reason`, anywhere in the file) is honored —
 * `-line`/`-next-line` need an exact line to match against, which a
 * whole-component diagnostic does not have; see
 * docs/lint-rules/composition.mdx for this documented limitation.
 */
async function runComponentCheckDiagnostics(
  infraPath: string,
): Promise<{ diagnostics: LintDiagnostic[]; suppressed: Array<LintDiagnostic & { reason?: string }> }> {
  const config = loadConfig(infraPath);
  const checks = loadComponentChecks();
  const allCheckIds = new Set(checks.map((c) => c.id));

  const raw = await runComponentChecks(infraPath, checks);

  const fileDirectivesCache = new Map<string, ReturnType<typeof parseDisableComments>>();
  const fileLevelDisable = (
    file: string,
    checkId: string,
  ): { suppressed: boolean; reason?: string } => {
    let directives = fileDirectivesCache.get(file);
    if (!directives) {
      let content = "";
      try {
        content = readFileSync(file, "utf-8");
      } catch {
        // File may be unreadable (e.g. a synthetic discovery-error path) — no directives to honor.
      }
      directives = parseDisableComments(content);
      fileDirectivesCache.set(file, directives);
    }

    for (const directive of directives) {
      if (directive.type !== "file") continue;
      if (!directive.ruleIds) return { suppressed: true, reason: directive.reason };
      if (directive.ruleIds.some((id) => allCheckIds.has(id) || id === "COMP000") && directive.ruleIds.includes(checkId)) {
        return { suppressed: true, reason: directive.reason };
      }
    }
    return { suppressed: false };
  };

  const toLintDiagnostic = (d: ComponentCheckDiagnostic, severity: LintDiagnostic["severity"]): LintDiagnostic => ({
    file: d.file,
    line: 1,
    column: 1,
    ruleId: d.checkId,
    severity,
    message: d.message,
  });

  const diagnostics: LintDiagnostic[] = [];
  const suppressed: Array<LintDiagnostic & { reason?: string }> = [];

  for (const d of raw) {
    // Discovery errors (COMP000) always surface at error severity — not user-configurable.
    let severity = d.severity;
    if (d.checkId !== "COMP000") {
      const configValue = config.rules?.[d.checkId];
      if (configValue !== undefined) {
        const parsed = parseRuleConfig(configValue);
        if (parsed.severity === "off") continue;
        severity = parsed.severity;
      }
    }

    const disable = fileLevelDisable(d.file, d.checkId);
    const diagnostic = toLintDiagnostic(d, severity);
    if (disable.suppressed) {
      suppressed.push({ ...diagnostic, reason: disable.reason });
    } else {
      diagnostics.push(diagnostic);
    }
  }

  return { diagnostics, suppressed };
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
  let suppressed: Array<LintDiagnostic & { reason?: string }> = [];
  if (options.rules) {
    const result = await runLint(files, options.rules, undefined);
    diagnostics = result.diagnostics;
    suppressed = result.suppressed;
  } else if (hasOverrides) {
    diagnostics = [];
    for (const file of files) {
      const relativePath = file.slice(infraPath.length + 1);
      const { rules: fileRules, ruleOptions } = getDefaultRules(infraPath, relativePath, allRules);
      const result = await runLint([file], fileRules, ruleOptions);
      diagnostics.push(...result.diagnostics);
      suppressed.push(...result.suppressed);
    }
  } else {
    const { rules, ruleOptions } = getDefaultRules(infraPath, undefined, allRules);
    const result = await runLint(files, rules, ruleOptions);
    diagnostics = result.diagnostics;
    suppressed = result.suppressed;
  }

  // Run the COMP* composition checks (#562) over the discovered `Component`
  // graph and merge them into the same diagnostics/suppressed lists — a
  // structurally distinct check family (whole-project, post-discovery,
  // see ../../lint/component-checks.ts) but the same `chant lint` output and
  // the same error-severity gating as every COR/EVL diagnostic.
  const componentResult = await runComponentCheckDiagnostics(infraPath);
  diagnostics.push(...componentResult.diagnostics);
  suppressed.push(...componentResult.suppressed);

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
    if (options.rules) {
      const postResult = await runLint(files, options.rules, undefined);
      diagnostics = postResult.diagnostics;
      suppressed = postResult.suppressed;
    } else if (hasOverrides) {
      diagnostics = [];
      suppressed = [];
      for (const file of files) {
        const relativePath = file.slice(infraPath.length + 1);
        const { rules: fileRules, ruleOptions } = getDefaultRules(infraPath, relativePath, allRules);
        const postResult = await runLint([file], fileRules, ruleOptions);
        diagnostics.push(...postResult.diagnostics);
        suppressed.push(...postResult.suppressed);
      }
    } else {
      const { rules, ruleOptions } = getDefaultRules(infraPath, undefined, allRules);
      const postResult = await runLint(files, rules, ruleOptions);
      diagnostics = postResult.diagnostics;
      suppressed = postResult.suppressed;
    }

    // COMP* checks have no `.fix` (nothing above could have touched a
    // `*.component.ts` file on their behalf), but a fix applied to another
    // rule could still be in the same file a component was discovered from —
    // re-run for consistency with the AST re-lint above.
    const postComponentResult = await runComponentCheckDiagnostics(infraPath);
    diagnostics.push(...postComponentResult.diagnostics);
    suppressed.push(...postComponentResult.suppressed);
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

  // Collect all loaded rules for SARIF enrichment
  const allLoadedRules = options.rules
    ? options.rules
    : [...allRules.values()];

  // Format output
  let output: string;
  switch (options.format) {
    case "json":
      output = formatJson(diagnostics);
      break;
    case "sarif":
      output = formatSarif(diagnostics, allLoadedRules, suppressed);
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
