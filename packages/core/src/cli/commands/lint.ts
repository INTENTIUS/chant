import { resolve, join, relative } from "path";
import type { BuildParamProvenance } from "../../provenance";
import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { execFileSync } from "child_process";
import { runLint, parseDisableComments } from "../../lint/engine";
import type { LintRule, LintDiagnostic, LintFix } from "../../lint/rule";
import type { IntrinsicDef, LexiconPlugin } from "../../lexicon";
import { loadPlugins, resolveProjectLexicons } from "../plugins";
import { formatStylish, formatJson, formatSarif } from "../reporters/stylish";
import { loadLocalRules } from "../../lint/rule-loader";
import { loadCoreRules } from "../../lint/rules/index";
import { loadComponentChecks } from "../../lint/rules/comp/index";
import { runComponentChecks, type ComponentCheckDiagnostic } from "../../lint/component-checks";
import { buildCapabilityRegistry } from "../../components/capability-plugin-loader";
import type { RollbackPolicy } from "../../components/capability";
import { coreOpChecks } from "../../lint/rules/op";
import { loadActivityContracts } from "../../op/activity-contract-registry";
import { runPostSynthChecks } from "../../lint/post-synth";
import { rule } from "../../lint/declarative";
import { watchDirectory, formatTimestamp, formatChangedFiles } from "../watch";
import { formatError, formatInfo } from "../format";
import { GENERATED_MARKER } from "../../discovery/files";
import { isNoLexiconDetected } from "../../detectLexicon";

// Import config loader
import { loadConfig, resolveRulesForFile, resolveConfiguredSeverity, findProjectRoot } from "../../lint/config";
import { loadChantConfig, resolveKnowledgeDir } from "../../config";
import { findProjectConfig } from "../../project-root";
import type { LintProjectConfig } from "../../lint/rule";
import { loadOkfBundle, type OkfBundle } from "../../okf-read";

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
 *
 * chant #1051 — this (and `loadLocalRules`, `../../lint/rule-loader.ts`, for
 * `.chant/rules/*.ts`) is unconditional project-source `import()` with no
 * `--sandbox` equivalent, the same class of gap #1051 closes for
 * `discoverComponents`. Deliberately NOT sandboxed here, and not a "decide by
 * omission": a `LintRule` is not a one-shot data producer like `Component`/
 * `Declarable` — its `check(context)` is a function the rule engine invokes
 * inline, once per linted file, for the whole `chant lint` run. There is no
 * cheap "collect once, JSON-serialize the result, hand it back" shape the way
 * there is for a `Component` (plain JSON) or an entity (a wire codec) —
 * `check` has to keep running as live JS in whichever process calls it. A
 * shallow fix that sandboxed only the *import* step (mirroring
 * `discoverComponents`) would give a false sense of safety: it would close
 * off "malicious top-level module code" but leave `check()`'s own executable
 * body — the dominant part of a rule's attack surface, since it runs for
 * every file, every lint invocation — entirely unsandboxed regardless. A real
 * fix needs either the AST/`ts.SourceFile` itself to cross the sandbox
 * boundary or the whole custom-rule evaluation to run inside the child; both
 * are materially harder, separate design problems from this issue's `Component`
 * fix and are tracked separately (chant #1052).
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
 * The diagnostic id `chant lint` reports a lexicon it could not resolve under
 * (chant #2222).
 *
 * Deliberately outside the COR/EVL/COMP/OPS families: those are *rules*, each
 * with a `check()` the engine runs per file, a documented page, a configurable
 * severity and a `chant-disable` escape hatch. This is none of those. It is
 * the lint run reporting that it could not assemble the rule set the project
 * asked for, so it is not silenceable through `rules: { ... : "off" }` or a
 * disable comment. Silencing it would put back the exact "green on a broken
 * project" this id exists to prevent.
 */
export const LEXICON_RESOLUTION_RULE_ID = "LEX001";

/**
 * Turn a lexicon-resolution failure into the error diagnostic `chant lint`
 * reports it as. The message is the underlying error's own, unwrapped, so it
 * is character-for-character what `chant build` prints after `error: ` for the
 * same project (`loadPluginsOrExit`, ../main.ts): one failure, one wording.
 *
 * Attributed to the project's `chant.config.*` where there is one, since that
 * is the file that names the lexicon; to the project root otherwise.
 */
function lexiconResolutionDiagnostic(projectRoot: string, error: Error): LintDiagnostic {
  return {
    file: findProjectConfig(projectRoot).configPath ?? projectRoot,
    line: 1,
    column: 1,
    ruleId: LEXICON_RESOLUTION_RULE_ID,
    severity: "error",
    message: error.message,
  };
}

/**
 * Load all lint rules: core COR/EVL rules, then lexicon plugin rules.
 *
 * Also returns the active lexicons' registered intrinsics (chant #1106) —
 * gathered here because this is where the project's lexicon plugins are
 * already resolved and loaded (`loadPlugins`), the same set `../commands/
 * build.ts` reads `plugin.intrinsics?.()` off of for the fold path. Handed
 * back alongside `rules` so `lintCommand` can thread it into every
 * `runLint` call without loading plugins a second time.
 */
async function loadAllPluginRules(
  projectPath: string,
): Promise<{ rules: Map<string, LintRule>; intrinsics: IntrinsicDef[]; lexiconError?: Error }> {
  const rules = new Map<string, LintRule>();

  // Load core COR/EVL rules directly
  for (const r of loadCoreRules()) {
    rules.set(r.id, r);
  }

  // Resolve project lexicons (e.g. ["aws"]) from config or detection, then
  // load their plugins.
  //
  // chant #2222: a failure in either step is handed back to `lintCommand`
  // (which reports it as {@link LEXICON_RESOLUTION_RULE_ID}) rather than
  // swallowed or thrown. Both steps fail on the same project state: a
  // `chant.config.ts` that names a lexicon whose package is not installed
  // throws out of `loadPlugins`, and one that *imports* that package throws
  // out of `resolveProjectLexicons` before the names are ever read. Before
  // this, the first case crashed `chant lint` with a stack trace and the
  // second was caught here and discarded, so `chant lint` printed "No
  // problems found" and exited 0 on a project `chant build` refuses to
  // build. A CI job that lints before it builds reported green on a project
  // whose lexicon was missing.
  //
  // The one failure that stays quiet is the one the original `catch` was
  // written for and named in its comment: a project that declares no
  // `lexicons` and imports none from its source files, where the detection
  // fallback throws `NO_LEXICON_DETECTED_MESSAGE`. That project lints under
  // the core rules alone and always has. It is told apart by the exported
  // sentinel rather than by a string literal copied to this file, so the two
  // cannot drift apart.
  let lexiconNames: string[] = [];
  let lexiconError: Error | undefined;
  try {
    lexiconNames = await resolveProjectLexicons(projectPath);
  } catch (err) {
    if (!isNoLexiconDetected(err)) {
      lexiconError = err instanceof Error ? err : new Error(String(err));
    }
  }

  // Load only project lexicon plugins (no "chant" injection)
  let plugins: LexiconPlugin[] = [];
  if (!lexiconError) {
    try {
      plugins = await loadPlugins(lexiconNames);
    } catch (err) {
      lexiconError = err instanceof Error ? err : new Error(String(err));
    }
  }

  // chant #1106 — the same plugins' registered intrinsics (`Ref`, `GetAtt`,
  // ...), so EVL001 can answer "does this call fold?" exactly like fold()
  // does instead of flagging every call as a violation. A plugin's
  // `intrinsics` is an optional extension (not every lexicon defines any),
  // hence the guard.
  const intrinsics = plugins.flatMap((plugin) => plugin.intrinsics?.() ?? []);

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

  return { rules, intrinsics, ...(lexiconError ? { lexiconError } : {}) };
}

/**
 * Lint command options
 */
export interface LintOptions {
  /** Path to lint */
  path: string;
  /**
   * This invocation's resolved build parameters (#1490).
   *
   * The COMP* checks import `*.component.ts`, and an ES module evaluates once
   * per path — so the values in effect during the lint gate are the values
   * every later reader observes. A caller that lints before it graphs must
   * pass the same parameters to both or the later resolution has no effect.
   */
  buildParams?: BuildParamProvenance[];
  /** Apply auto-fixes */
  fix?: boolean;
  /** Output format */
  format: "stylish" | "json" | "sarif";
  /** Rules to use (defaults to all) */
  rules?: LintRule[];
  /**
   * chant #1051 — opt-in: discover `*.component.ts` files (for the COMP*
   * composition checks) in a sandboxed child process instead of the CLI's
   * own process (`chant lint --sandbox`). See `discoverComponents`'s
   * `sandbox` option (../../components/discover.ts).
   */
  sandbox?: boolean;
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
 * Drop paths git ignores. Vendored trees (`vendor/`), build output (`dist/`),
 * and anything else in `.gitignore` are not authored chant source — linting
 * them surfaces EVL/COR errors in code the project never wrote, which then
 * gates `chant graph --format ir` on files outside the graph. Delegates to
 * `git check-ignore` for exact gitignore semantics (nesting, negation) in one
 * batched call; a non-git tree (or absent git) filters nothing.
 */
function filterGitIgnored(files: string[], cwd: string): string[] {
  if (files.length === 0) return files;
  try {
    const out = execFileSync("git", ["check-ignore", "--stdin"], {
      cwd,
      input: files.join("\n"),
      encoding: "utf-8",
      // stdin piped (input), stdout captured, stderr silenced so a non-git tree's
      // "fatal: not a git repository" never leaks to the lint output.
      stdio: ["pipe", "pipe", "ignore"],
      // Exit 1 means "nothing ignored" — execFileSync throws on non-zero, so the
      // catch handles it; exit 128 (not a repo) lands there too and filters none.
    });
    const ignored = new Set(out.split(/\r?\n/).filter(Boolean));
    return ignored.size === 0 ? files : files.filter((f) => !ignored.has(f));
  } catch {
    // No git, not a repo, or nothing ignored (exit 1) — keep every file.
    return files;
  }
}

/**
 * Get all TypeScript files recursively, skipping git-ignored paths.
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
        // Skip chant-generated files (worker/workflow/activities bootstrap): they
        // hold no authored source and use runtime patterns the EVL* rules forbid.
        if (readFileSync(fullPath, "utf-8").slice(0, 256).includes(GENERATED_MARKER)) {
          continue;
        }
        files.push(fullPath);
      }
    }
  }

  scan(dir);
  return filterGitIgnored(files, dir);
}

/**
 * Get default rules and options, optionally applying per-file overrides.
 *
 * `projectRoot` is where the config lives (see `findProjectRoot`); `filePath`,
 * when given, must be relative to that root so `lint.overrides` globs
 * (`src/lib/**`) match regardless of which subpath is being linted.
 */
function getDefaultRules(
  projectRoot: string,
  filePath?: string,
  allRules: Map<string, LintRule> = new Map(),
): { rules: LintRule[]; ruleOptions: Map<string, Record<string, unknown>> } {
  const config = loadConfig(projectRoot);
  const effectiveRules = filePath ? resolveRulesForFile(config, filePath) : config.rules;
  const rules: LintRule[] = [];
  const ruleOptions = new Map<string, Record<string, unknown>>();

  for (const [ruleId, rule] of allRules) {
    // chant #1138 — the same resolution post-synth checks and COMP* checks
    // now go through too (`resolveConfiguredSeverity`, ../../lint/config.ts),
    // so `lint.rules: { ID: "off" }` suppresses a rule id identically no
    // matter which phase produced it.
    const { severity, options } = resolveConfiguredSeverity(effectiveRules, ruleId, rule.severity);

    // Skip rules that are explicitly turned off
    if (severity === "off") continue;

    // Override severity from config (a no-op when the rule wasn't mentioned —
    // `severity` is then just `rule.severity` again)
    rules.push({ ...rule, severity });

    // Store options if present
    if (options) {
      ruleOptions.set(ruleId, options);
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
/**
 * Build the registry-derived context composition checks need — the set of
 * capability kinds registered for this project (core's starter set plus the
 * active lexicons' leaves, e.g. `cfn-deploy` when `lexicons: ["aws"]`) and each
 * verb's rollback disposition — so COMP005/COMP003 read real registry facts
 * rather than hard-coding verb lists. A verb's rollback policy is its own
 * declaration (`rollbackPolicy`), else derived: a paired `rollback` method is
 * `"native"`, everything else `"none-by-design"`. Tolerant: any failure (an
 * unresolvable lexicon, a config-less directory) returns `undefined` fields,
 * letting the checks fall back to core's starter set.
 */
async function resolveRegistryContext(
  infraPath: string,
): Promise<{ knownKinds?: ReadonlySet<string>; rollbackPolicies?: ReadonlyMap<string, RollbackPolicy> }> {
  try {
    const lexicons = await resolveProjectLexicons(infraPath).catch(() => [] as string[]);
    const registry = await buildCapabilityRegistry({ lexicons });
    const kinds = registry.kinds();
    const rollbackPolicies = new Map<string, RollbackPolicy>();
    for (const kind of kinds) {
      const capability = registry.resolve(kind);
      rollbackPolicies.set(kind, capability.rollbackPolicy ?? (capability.rollback ? "native" : "none-by-design"));
    }
    return { knownKinds: new Set(kinds), rollbackPolicies };
  } catch {
    return {};
  }
}

async function runComponentCheckDiagnostics(
  infraPath: string,
  sandbox?: boolean,
  buildParams?: BuildParamProvenance[],
): Promise<{ diagnostics: LintDiagnostic[]; suppressed: Array<LintDiagnostic & { reason?: string }> }> {
  // Discovery stays scoped to the lint arg; COMP* severity overrides come from
  // the project-root config, same as the AST-rule pass.
  const config = loadConfig(findProjectRoot(infraPath));
  const checks = loadComponentChecks();
  const allCheckIds = new Set(checks.map((c) => c.id));

  const registryContext = await resolveRegistryContext(infraPath);
  const raw = await runComponentChecks(infraPath, checks, registryContext, sandbox, buildParams);

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
      // chant #1138 — same resolution function AST rules and post-synth
      // checks use (`resolveConfiguredSeverity`, ../../lint/config.ts).
      const resolved = resolveConfiguredSeverity(config.rules, d.checkId, d.severity);
      if (resolved.severity === "off") continue;
      severity = resolved.severity;
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
 * Run the OPS* Op-model post-synth checks (#2122, epic #2114 sub-issue 6 —
 * OPS012/OPS013/OPS014, ported from a hosting lexicon's own
 * TMP012/TMP013/TMP014) over every `*.op.ts` file under the lint target and
 * merge them into the same diagnostics/suppressed lists `chant lint` already
 * reports through, the same treatment {@link runComponentCheckDiagnostics}
 * above gives COMP*.
 *
 * Deliberately scoped DOWNWARD from `infraPath` — the same scan
 * `getTypeScriptFiles` already ran to build `files` — rather than
 * `../../op/discover.ts`'s `discoverOps`, which walks UP to the nearest
 * project root (or the git root, absent a config file) precisely because a
 * real project's `ops/` convention sits outside `sourceDir`. That upward
 * walk is right for `chant run`/`chant build`, which always operate on one
 * whole project; it is wrong here, because `chant lint <path>` (and every
 * fixture-scoped test that calls this file's `lintCommand`) may point at a
 * directory with no `chant.config.*` above it short of this repo's own git
 * root — which would make this check import every `*.op.ts` file in the
 * entire monorepo on every such call. Scanning only under `infraPath`, like
 * every other check in this function, keeps this check's cost proportional
 * to the target the caller actually asked to lint.
 *
 * Each `*.op.ts` file's default export is imported directly and used as-is
 * (it is already the `Declarable` `OpResource` instance `Op()` built) — no
 * serializer and no lexicon plugin needed, since OPS012/OPS013/OPS014 only
 * ever read `ctx.entities`, never `ctx.outputs`. That's what lets this fire
 * even on a project with no lexicons configured at all.
 *
 * The project's configured lexicon NAMES are read, though (chant #2101), to
 * resolve the activity contracts each one declares at
 * `@intentius/chant-lexicon-<name>/op/activity-contracts` — one dynamic
 * import per lexicon, no plugin load. Without them a step calling a
 * lexicon's activity is flagged for the absence of a contract that lexicon
 * does declare, which is the whole point of OPS013 firing outside a build.
 *
 * Reported at `1:1` in the file the Op was declared in, the same whole-file
 * convention COMP* diagnostics use — a post-synth finding carries no real
 * line/column (../../lint/post-synth.ts's `PostSynthDiagnostic` doc) and
 * there's no per-file disable-directive suppression for the same reason
 * (that doc again), so this reads only `lint.rules` severity overrides, not
 * `chant-disable` comments.
 */
async function runOpCheckDiagnostics(
  infraPath: string,
  files: string[],
): Promise<{ diagnostics: LintDiagnostic[]; suppressed: Array<LintDiagnostic & { reason?: string }> }> {
  const config = loadConfig(findProjectRoot(infraPath));
  const opFiles = files.filter((f) => f.endsWith(".op.ts"));
  if (opFiles.length === 0) return { diagnostics: [], suppressed: [] };

  const entities = new Map<string, unknown>();
  const fileByOpName = new Map<string, string>();
  for (const filePath of opFiles) {
    try {
      const mod: unknown = await import(filePath);
      const entity = (mod as { default?: unknown }).default;
      if (!entity || typeof entity !== "object") continue;
      const opConfig = (entity as { props?: unknown }).props as { name?: unknown; phases?: unknown } | undefined;
      if (!opConfig || typeof opConfig.name !== "string" || !Array.isArray(opConfig.phases)) continue;
      entities.set(opConfig.name, entity);
      fileByOpName.set(opConfig.name, filePath);
    } catch {
      // A file that fails to import is somebody else's problem — a syntax
      // error surfaces through the AST rule pass over the same file instead
      // of crashing this one.
      continue;
    }
  }

  if (entities.size === 0) return { diagnostics: [], suppressed: [] };

  const lexiconNames = await resolveProjectLexicons(infraPath).catch(() => [] as string[]);
  const activityContracts = await loadActivityContracts(lexiconNames);

  const raw = runPostSynthChecks(
    coreOpChecks(),
    {
      outputs: new Map(),
      entities: entities as Map<string, never>,
      warnings: [],
      errors: [],
      sourceFileCount: opFiles.length,
    },
    undefined,
    { activityContracts },
  );

  const diagnostics: LintDiagnostic[] = [];
  const suppressed: Array<LintDiagnostic & { reason?: string }> = [];

  for (const d of raw) {
    const resolved = resolveConfiguredSeverity(config.rules, d.checkId, d.severity);
    if (resolved.severity === "off") continue;

    diagnostics.push({
      file: (d.entity && fileByOpName.get(d.entity)) ?? infraPath,
      line: 1,
      column: 1,
      ruleId: d.checkId,
      severity: resolved.severity,
      message: d.message,
    });
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
  // Config, rules, and lexicons anchor on the project root so a scoped lint
  // (`chant lint src`, the `graph --format ir` gate) still sees `lint.overrides`
  // and the declared lexicons; only the file scan stays scoped to `infraPath`.
  const projectRoot = findProjectRoot(infraPath);
  const config = loadConfig(projectRoot);
  const hasOverrides = config.overrides && config.overrides.length > 0;

  // chant #1221 — the project's chant.config slice for config-aware rules
  // (COR021 reads `environments` + `ownership`), threaded into every
  // runLint() call below via LintContext.projectConfig. Best-effort: a
  // directory with no project config lints with those rules silent.
  let projectConfig: LintProjectConfig | undefined;
  // chant #1866 — the loaded OKF knowledge bundle, threaded into
  // `formatStylish` below so its suppressed section can resolve `okf:`
  // citations. Best-effort like `projectConfig` above (same
  // `loadChantConfig` call): a directory with no chant config, or no
  // `knowledge/` bundle, lints with citations rendering unresolved rather
  // than a failure — `loadOkfBundle` already treats a missing directory as
  // an empty bundle.
  let knowledgeBundle: OkfBundle | undefined;
  try {
    const chantConfig = (await loadChantConfig(projectRoot)).config;
    projectConfig = chantConfig as LintProjectConfig;
    knowledgeBundle = await loadOkfBundle(resolveKnowledgeDir(chantConfig, projectRoot));
  } catch {
    projectConfig = undefined;
    knowledgeBundle = undefined;
  }

  // Load all rules from lexicon plugins (core "chant" + lexicon-specific)
  const loaded = await loadAllPluginRules(projectRoot);
  let allRules = loaded.rules;
  // chant #1106 — the active lexicons' registered intrinsics, threaded into
  // every runLint() call below so EVL001 answers exactly like fold() does
  // for a registered, opted-in call (`Ref(...)`, `GetAtt(...)`) instead of
  // flagging it. Computed once here regardless of which branch below runs,
  // same as `allRules`.
  const intrinsics = loaded.intrinsics;

  // Merge in any config-level plugin rules (custom .ts rule files)
  if (config.plugins && config.plugins.length > 0) {
    const pluginRules = await loadPluginRules(config.plugins, projectRoot);
    allRules = new Map([...allRules, ...pluginRules]);
  }

  // Get all TypeScript files (scan scoped to the lint arg, git-ignored trees dropped)
  const files = getTypeScriptFiles(infraPath);

  // Run lint — use per-file rules when overrides are present
  let diagnostics: LintDiagnostic[];
  let suppressed: Array<LintDiagnostic & { reason?: string }> = [];
  if (options.rules) {
    const result = await runLint(files, options.rules, undefined, intrinsics, projectConfig);
    diagnostics = result.diagnostics;
    suppressed = result.suppressed;
  } else if (hasOverrides) {
    diagnostics = [];
    for (const file of files) {
      const relativePath = relative(projectRoot, file);
      const { rules: fileRules, ruleOptions } = getDefaultRules(projectRoot, relativePath, allRules);
      const result = await runLint([file], fileRules, ruleOptions, intrinsics, projectConfig);
      diagnostics.push(...result.diagnostics);
      suppressed.push(...result.suppressed);
    }
  } else {
    const { rules, ruleOptions } = getDefaultRules(projectRoot, undefined, allRules);
    const result = await runLint(files, rules, ruleOptions, intrinsics, projectConfig);
    diagnostics = result.diagnostics;
    suppressed = result.suppressed;
  }

  // Run the COMP* composition checks (#562) over the discovered `Component`
  // graph and merge them into the same diagnostics/suppressed lists — a
  // structurally distinct check family (whole-project, post-discovery,
  // see ../../lint/component-checks.ts) but the same `chant lint` output and
  // the same error-severity gating as every COR/EVL diagnostic.
  const componentResult = await runComponentCheckDiagnostics(infraPath, options.sandbox, options.buildParams);
  diagnostics.push(...componentResult.diagnostics);
  suppressed.push(...componentResult.suppressed);

  // Run the OPS* Op-model post-synth checks (#2122) over every `*.op.ts`
  // file under the lint target — see runOpCheckDiagnostics's doc for why
  // this needs no lexicon or build to fire.
  const opResult = await runOpCheckDiagnostics(infraPath, files);
  diagnostics.push(...opResult.diagnostics);
  suppressed.push(...opResult.suppressed);

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
      const postResult = await runLint(files, options.rules, undefined, intrinsics, projectConfig);
      diagnostics = postResult.diagnostics;
      suppressed = postResult.suppressed;
    } else if (hasOverrides) {
      diagnostics = [];
      suppressed = [];
      for (const file of files) {
        const relativePath = relative(projectRoot, file);
        const { rules: fileRules, ruleOptions } = getDefaultRules(projectRoot, relativePath, allRules);
        const postResult = await runLint([file], fileRules, ruleOptions, intrinsics, projectConfig);
        diagnostics.push(...postResult.diagnostics);
        suppressed.push(...postResult.suppressed);
      }
    } else {
      const { rules, ruleOptions } = getDefaultRules(projectRoot, undefined, allRules);
      const postResult = await runLint(files, rules, ruleOptions, intrinsics, projectConfig);
      diagnostics = postResult.diagnostics;
      suppressed = postResult.suppressed;
    }

    // COMP* checks have no `.fix` (nothing above could have touched a
    // `*.component.ts` file on their behalf), but a fix applied to another
    // rule could still be in the same file a component was discovered from —
    // re-run for consistency with the AST re-lint above.
    const postComponentResult = await runComponentCheckDiagnostics(infraPath, options.sandbox, options.buildParams);
    diagnostics.push(...postComponentResult.diagnostics);
    suppressed.push(...postComponentResult.suppressed);

    // OPS* checks have no `.fix` either; re-run for the same consistency
    // reason as the COMP* re-run just above.
    const postOpResult = await runOpCheckDiagnostics(infraPath, files);
    diagnostics.push(...postOpResult.diagnostics);
    suppressed.push(...postOpResult.suppressed);
  }

  // chant #2222: a lexicon the project declared but this run could not
  // resolve. Appended here, after the `--fix` re-lint block above has finished
  // reassigning `diagnostics`, so it survives every path; it is a property of
  // the run, not of any file a fix could touch.
  if (loaded.lexiconError) {
    diagnostics.push(lexiconResolutionDiagnostic(projectRoot, loaded.lexiconError));
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
      output = formatStylish(diagnostics, suppressed, knowledgeBundle);
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
