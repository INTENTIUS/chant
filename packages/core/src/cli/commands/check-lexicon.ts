import { existsSync, readdirSync, readFileSync } from "fs";
import { join, basename } from "path";
import { auditIntrinsics } from "./check-lexicon-intrinsics";
import { checkExamplesBuild } from "./check-lexicon-examples";
import { auditDocsReachability } from "./check-lexicon-docs";
import { auditMcpNames, lexiconNameFor } from "./check-lexicon-mcp";
import { loadLexiconFromDir, registers, safeList } from "./check-lexicon-plugin";
import { RULE_CATALOG } from "../../audit/catalog";

// ── Types ────────────────────────────────────────────────────────────

export interface CheckItem {
  name: string;
  tier: 1 | 2 | 3;
  pass: boolean;
  detail?: string;
}

export interface CheckResult {
  items: CheckItem[];
  tier1Pass: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────

/** List .ts files in a directory, optionally excluding some basenames. */
function listTsFiles(dir: string, exclude: string[] = []): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !exclude.includes(f));
}

/** Recursively find files matching a predicate. */
function findFiles(dir: string, predicate: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      results.push(...findFiles(join(dir, entry.name), predicate));
    } else if (predicate(entry.name)) {
      results.push(join(dir, entry.name));
    }
  }
  return results;
}

/** Read a file's content, returning empty string if missing. */
function readOr(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/** Count subdirectories in a directory, ignoring .gitkeep-only dirs. */
function countSubdirs(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => {
      const contents = readdirSync(join(dir, e.name));
      // Ignore directories that only contain .gitkeep
      return contents.length > 0 && !(contents.length === 1 && contents[0] === ".gitkeep");
    })
    .length;
}

// ── Check runner ─────────────────────────────────────────────────────

/**
 * Run all completeness checks against a lexicon directory.
 */
export async function checkLexicon(dir: string): Promise<CheckResult> {
  const items: CheckItem[] = [];

  // ── Tier 1: Required ───────────────────────────────────────────

  // #1342 — a capability is present when the plugin exposes it, not when a file
  // with the right name sits on disk. The checks below used to be existence
  // assertions, which is how helm shipped `src/lsp/completions.ts` and
  // `src/lsp/hover.ts` (with tests) while registering neither provider, and
  // passed every tier. `cli/lsp/server.ts` dispatches through the plugin
  // members, so those files were unreachable in an editor.
  const loaded = await loadLexiconFromDir(dir);
  const plugin = loaded.plugin;

  items.push({
    name: "The package exports a LexiconPlugin",
    tier: 1,
    pass: plugin !== undefined,
    detail: loaded.error ?? (loaded.entry ? `exported by ${basename(loaded.entry)}` : undefined),
  });

  const serializer = plugin?.serializer as { name?: unknown; rulePrefix?: unknown; serialize?: unknown } | undefined;
  const serializerOk =
    typeof serializer?.name === "string" &&
    typeof serializer?.rulePrefix === "string" &&
    typeof serializer?.serialize === "function";
  items.push({
    name: "The plugin exposes a Serializer with a name and rule prefix",
    tier: 1,
    pass: serializerOk,
    detail: serializerOk
      ? `${String(serializer?.name)} (${String(serializer?.rulePrefix)})`
      : plugin
        ? "serializer is missing name, rulePrefix, or serialize"
        : undefined,
  });

  const lintRules = safeList(plugin?.lintRules?.bind(plugin));
  items.push({
    name: "lintRules() returns at least 1 rule",
    tier: 1,
    pass: lintRules.items.length > 0,
    detail: lintRules.error ? `threw: ${lintRules.error}` : `${lintRules.items.length} rule(s)`,
  });

  const postSynthChecks = safeList(plugin?.postSynthChecks?.bind(plugin));
  items.push({
    name: "postSynthChecks() returns at least 1 check",
    tier: 1,
    pass: postSynthChecks.items.length > 0,
    detail: postSynthChecks.error
      ? `threw: ${postSynthChecks.error}`
      : `${postSynthChecks.items.length} check(s)`,
  });

  // #1349 — `rulePrefix` exists so ids do not collide when several lexicons are
  // loaded together (forgejo wraps github's rules as `WFJ-GHA0xx` for exactly
  // that reason), and it was checked by nothing. k8s shipped five `ARGO0xx`
  // checks outside its declared `WK8`. Core's cross-cutting ids are exempt:
  // they belong to core, not to whichever lexicon surfaces them.
  const declaredPrefixes = [
    typeof serializer?.rulePrefix === "string" ? serializer.rulePrefix : "",
    ...((plugin?.serializer as { extraRulePrefixes?: readonly string[] } | undefined)?.extraRulePrefixes ?? []),
  ].filter((p) => p.length > 0);
  const allRuleIds = [
    ...lintRules.items.map((r) => (r as { id?: string }).id),
    ...postSynthChecks.items.map((c) => (c as { id?: string }).id),
  ].filter((id): id is string => typeof id === "string");
  const offPrefix = allRuleIds.filter(
    (id) => !(id in RULE_CATALOG) && !declaredPrefixes.some((p) => id.startsWith(p)),
  );
  items.push({
    name: "Every rule id starts with a declared rule prefix",
    tier: 1,
    pass: declaredPrefixes.length > 0 && offPrefix.length === 0,
    detail:
      offPrefix.length > 0
        ? `${offPrefix.length} outside ${declaredPrefixes.join("/")}: ${[...new Set(offPrefix)].slice(0, 6).join(", ")}`
        : declaredPrefixes.length > 0
          ? `${allRuleIds.length} id(s) under ${declaredPrefixes.join("/")}`
          : "no rule prefix declared",
  });

  items.push({
    name: "The plugin registers completionProvider",
    tier: 1,
    pass: registers(plugin, "completionProvider"),
  });

  items.push({
    name: "The plugin registers hoverProvider",
    tier: 1,
    pass: registers(plugin, "hoverProvider"),
  });

  items.push({
    name: "The plugin registers docs()",
    tier: 1,
    pass: registers(plugin, "docs"),
  });

  items.push({
    name: "dist/manifest.json exists",
    tier: 1,
    pass: existsSync(join(dir, "dist/manifest.json")),
  });

  // chant #1067 — chantVersion was "optional, unchecked": a lexicon could
  // declare (or omit) a core-version constraint and nothing failed. This
  // does not validate compatibility against the running core version — that
  // needs a live check at plugin-load time (a different tool: candidates are
  // `loadPlugin`/`loadPlugins` in ../plugins.ts), which is a deliberate
  // non-goal here (see PR description). It closes the narrower gap that the
  // field can be silently absent or malformed in the shipped manifest.
  const manifestJson = readOr(join(dir, "dist/manifest.json"));
  let chantVersionOk = false;
  let chantVersionDetail: string | undefined;
  if (manifestJson) {
    try {
      const parsed = JSON.parse(manifestJson) as { chantVersion?: unknown };
      const cv = parsed.chantVersion;
      chantVersionOk = typeof cv === "string" && /\d/.test(cv);
      chantVersionDetail = chantVersionOk ? `chantVersion: ${cv as string}` : `chantVersion: ${JSON.stringify(cv)}`;
    } catch {
      chantVersionDetail = "dist/manifest.json is not valid JSON";
    }
  } else {
    chantVersionDetail = "dist/manifest.json missing or unreadable";
  }
  items.push({
    name: "dist/manifest.json declares a chantVersion",
    tier: 1,
    pass: chantVersionOk,
    detail: chantVersionDetail,
  });

  // chant #1067 — packaging shape ("all 11 lexicons route exports['.'].default
  // at ./src/index.ts and delete emitted JS in build") was real but
  // unenforced; a lexicon shipping differently would break consumers
  // silently. Cheap structural check on package.json, not a build execution.
  const packageJsonRaw = readOr(join(dir, "package.json"));
  let packagingOk = false;
  let packagingDetail: string | undefined;
  if (packageJsonRaw) {
    try {
      const pkg = JSON.parse(packageJsonRaw) as {
        exports?: { "."?: { default?: string } };
        scripts?: { build?: string };
      };
      const defaultExport = pkg.exports?.["."]?.default;
      const buildScript = pkg.scripts?.build ?? "";
      const exportOk = defaultExport === "./src/index.ts";
      const deletesEmittedJs = /-delete/.test(buildScript) && /\.js/.test(buildScript);
      packagingOk = exportOk && deletesEmittedJs;
      const problems: string[] = [];
      if (!exportOk) problems.push(`exports["."].default is ${JSON.stringify(defaultExport)}, expected "./src/index.ts"`);
      if (!deletesEmittedJs) problems.push(`build script doesn't delete emitted .js from dist/: ${JSON.stringify(buildScript)}`);
      packagingDetail = problems.length > 0 ? problems.join("; ") : undefined;
    } catch {
      packagingDetail = "package.json is not valid JSON";
    }
  } else {
    packagingDetail = "package.json missing or unreadable";
  }
  items.push({
    name: 'package.json routes exports["."].default at ./src/index.ts and deletes emitted JS in build',
    tier: 1,
    pass: packagingOk,
    detail: packagingDetail,
  });

  const exampleCount = countSubdirs(join(dir, "examples"));
  items.push({
    name: "At least 1 example in examples/",
    tier: 1,
    pass: exampleCount > 0,
    detail: exampleCount > 0 ? `${exampleCount} example(s)` : undefined,
  });

  // chant #1067 — every shipped example must actually build. The prior
  // checks only ever counted example directories; none tried to build one,
  // so `lexicons/aws/examples/core-concepts` shipped with a discovery-time
  // "Duplicate export name" error while this tool reported "All tier-1
  // checks passed." See ./check-lexicon-examples.ts for exactly what
  // "builds" means here (discovery + serialization, not post-synth/lint).
  const exampleBuilds = await checkExamplesBuild(dir);
  const brokenExamples = exampleBuilds.filter((e) => !e.ok);
  items.push({
    name: "Every shipped example builds",
    tier: 1,
    pass: brokenExamples.length === 0,
    detail:
      brokenExamples.length > 0
        ? brokenExamples.map((e) => `${e.example}: ${e.detail}`).join(" | ")
        : exampleBuilds.length > 0
          ? `${exampleBuilds.length} example(s) built`
          : undefined,
  });

  // chant #1067 — foldability (isTag) is required and validated, not an
  // optional flag nobody checks. #1039 shipped with it wrong in both
  // directions (aws's Sub missing isTag; gitlab's reference() claiming
  // isTag: true for a plain call) and nothing caught either half. See
  // ./check-lexicon-intrinsics.ts for what "exported"/"matches" mean.
  const intrinsicAudit = auditIntrinsics(dir);
  const unexportedIntrinsics = intrinsicAudit.filter((i) => !i.exported);
  items.push({
    name: "Registered intrinsics are exported by the package",
    tier: 1,
    pass: unexportedIntrinsics.length === 0,
    detail:
      unexportedIntrinsics.length > 0
        ? unexportedIntrinsics.map((i) => i.detail).join(" | ")
        : intrinsicAudit.length > 0
          ? `${intrinsicAudit.length} intrinsic(s) checked`
          : undefined,
  });

  const mismatchedIntrinsics = intrinsicAudit.filter((i) => !i.ok);
  items.push({
    name: "Registered intrinsics' isTag matches how they're authored",
    tier: 1,
    pass: mismatchedIntrinsics.length === 0,
    detail:
      mismatchedIntrinsics.length > 0
        ? mismatchedIntrinsics.map((i) => i.detail).join(" | ")
        : intrinsicAudit.length > 0
          ? `${intrinsicAudit.length} intrinsic(s) checked`
          : undefined,
  });

  // chant #1044 — the call-form opt-in (`foldsAsCall`) admits a plain call
  // into `fold()`, which has no general CallExpression case. Declaring it on
  // a tagged template claims a form the intrinsic cannot be invoked in, so
  // it fails here rather than being quietly ignored — the same reasoning as
  // the isTag check above.
  const badCallForm = intrinsicAudit.filter((i) => !i.callFormOk);
  items.push({
    name: "Registered intrinsics' foldsAsCall opt-in is only on plain calls",
    tier: 1,
    pass: badCallForm.length === 0,
    detail:
      badCallForm.length > 0
        ? badCallForm.map((i) => i.callFormDetail).join(" | ")
        : intrinsicAudit.length > 0
          ? `${intrinsicAudit.length} intrinsic(s) checked`
          : undefined,
  });

  // #1341 — core namespaces MCP contributions, and so do the shared helpers and
  // most lexicons, so the names agents actually saw were `gitlab:gitlab:diff`
  // and `chant://azure/chant://lexicon/azure/catalog`. The check is on the
  // registered name rather than the declared one: three authored forms are in
  // use and all of them are fine, but only one registered shape is.
  const mcpNames = await auditMcpNames(dir);
  items.push({
    name: "MCP tools and resources register under one well-formed namespace",
    tier: 1,
    pass: mcpNames.violations.length === 0,
    detail:
      mcpNames.violations.length > 0
        ? mcpNames.violations.join(" | ")
        : mcpNames.loaded
          ? `${mcpNames.checked} contribution(s) checked`
          : "lexicon could not be loaded — not checked",
  });

  const hasPluginTest = findFiles(join(dir, "src"), (n) => n === "plugin.test.ts").length > 0;
  items.push({
    name: "plugin.test.ts exists",
    tier: 1,
    pass: hasPluginTest,
  });

  const hasSerializerTest = findFiles(join(dir, "src"), (n) => n === "serializer.test.ts").length > 0;
  items.push({
    name: "serializer.test.ts exists",
    tier: 1,
    pass: hasSerializerTest,
  });

  const mdxFiles = findFiles(join(dir, "docs"), (n) => n.endsWith(".mdx"));
  items.push({
    name: "At least 1 .mdx doc page",
    tier: 1,
    pass: mdxFiles.length > 0,
    detail: mdxFiles.length > 0 ? `${mdxFiles.length} page(s)` : undefined,
  });

  // Counting pages says nothing about whether a reader can find them.
  // Starlight has no auto-discovery, so a page missing from the sidebar is
  // reachable only by direct URL (#1312).
  const docsReach = auditDocsReachability(dir);
  items.push({
    name: "Every doc page is reachable from the sidebar",
    tier: 1,
    pass: !docsReach.hasSite || docsReach.unreachable.length === 0,
    detail:
      docsReach.unreachable.length > 0
        ? `${docsReach.unreachable.length} unreachable: ${docsReach.unreachable.join(", ")}`
        : undefined,
  });

  // ── Tier 2: Recommended ────────────────────────────────────────

  const pluginContent = readOr(join(dir, "src/plugin.ts"));

  // #1342 — these were a regex over plugin.ts source text, which passed on a
  // method declared in a form the regex happened to match and on one that
  // throws when called. Ask the plugin instead.
  for (const method of ["mcpTools", "mcpResources", "skills", "detectTemplate", "initTemplates"] as const) {
    items.push({
      name: `The plugin registers ${method}`,
      tier: 2,
      pass: registers(plugin, method),
    });
  }

  // #1346 — `resolveAuditCatalog` contributes nothing for a lexicon that omits
  // the method, silently, so its checks surface in `chant audit` with no title,
  // tier, fix kind, or category. Tier 2 rather than tier 1: the lexicon builds
  // and lints correctly without it; what suffers is one command's output.
  const auditCatalog = (() => {
    try {
      return plugin?.auditCatalog?.() ?? {};
    } catch {
      return {};
    }
  })();
  const uncatalogued = postSynthChecks.items
    .map((c) => (c as { id?: string }).id)
    .filter((id): id is string => typeof id === "string" && !(id in auditCatalog) && !(id in RULE_CATALOG));
  items.push({
    name: "auditCatalog() covers every post-synth check",
    tier: 2,
    pass: uncatalogued.length === 0,
    detail:
      uncatalogued.length > 0
        ? `${uncatalogued.length} without metadata: ${uncatalogued.slice(0, 6).join(", ")}`
        : `${Object.keys(auditCatalog).length} entry/entries`,
  });

  // #1348 — the marker channel is a claim: declaring `reads: ["exportResources"]`
  // while not implementing `exportResources` promises a verdict from a path
  // that does not exist. The behavioral half lives in the observation
  // conformance suite, which holds a declared path to a real verdict and an
  // undeclared one to `unknown`; this is the static half.
  const channel = plugin?.ownershipChannel;
  const channelProblems: string[] = [];
  if (channel) {
    for (const path of channel.reads) {
      if (!registers(plugin, path as keyof typeof plugin)) {
        channelProblems.push(`declares a marker channel on ${path}, which the plugin does not implement`);
      }
    }
    const keys = channel.keys as { managedBy?: unknown; stack?: unknown; env?: unknown } | undefined;
    for (const key of ["managedBy", "stack", "env"] as const) {
      if (typeof keys?.[key] !== "string" || (keys[key] as string).length === 0) {
        channelProblems.push(`marker keys are missing ${key}`);
      }
    }
    if (channel.reads.length === 0) {
      channelProblems.push("declares marker keys but no read path — nothing can resolve a verdict");
    }
  }
  items.push({
    name: "Any declared ownership channel names paths the plugin implements",
    tier: 2,
    pass: channelProblems.length === 0,
    detail:
      channelProblems.length > 0
        ? channelProblems.join("; ")
        : channel
          ? `marker on ${channel.reads.join(", ")}`
          : "no marker channel — every verdict must be unknown",
  // #1344 — a lexicon that reads its own `chant.config.ts` namespace should
  // declare its shape, or a typo inside that namespace is accepted and silently
  // ignored: `forgejo: { runnerLabel: … }` left the dialect on its defaults with
  // nothing said. Source scan, because the read happens deep in a serializer
  // rather than anywhere the plugin object can be asked.
  const lexiconName = lexiconNameFor(dir);
  const readsOwnNamespace = findFiles(join(dir, "src"), (n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))
    .some((file) => new RegExp(`config\\s*\\??\\.\\s*${lexiconName}\\b`).test(readOr(file)));
  items.push({
    name: "Declares a configSchema if it reads its own config namespace",
    tier: 2,
    pass: !readsOwnNamespace || plugin?.configSchema !== undefined,
    detail: readsOwnNamespace
      ? plugin?.configSchema
        ? `config.${lexiconName} is declared and validated`
        : `reads config.${lexiconName} but declares no schema — unknown keys there are silently ignored`
      : "reads no config namespace of its own",
  });

  const compositeFiles = listTsFiles(join(dir, "src/composites"), ["index.ts"]);
  items.push({
    name: "At least 1 composite in src/composites/",
    tier: 2,
    pass: compositeFiles.length > 0,
    detail: compositeFiles.length > 0 ? `${compositeFiles.length} composite(s)` : undefined,
  });

  items.push({
    name: "At least 3 examples",
    tier: 2,
    pass: exampleCount >= 3,
    detail: `${exampleCount} example(s)`,
  });

  items.push({
    name: "src/lsp/completions.test.ts exists",
    tier: 2,
    pass: existsSync(join(dir, "src/lsp/completions.test.ts")),
  });

  items.push({
    name: "src/lsp/hover.test.ts exists",
    tier: 2,
    pass: existsSync(join(dir, "src/lsp/hover.test.ts")),
  });

  const coverageContent = readOr(join(dir, "src/coverage.ts"));
  items.push({
    name: "coverage.ts is implemented",
    tier: 2,
    pass: !coverageContent.includes("not yet implemented"),
    detail: coverageContent.includes("not yet implemented") ? "contains 'not yet implemented'" : undefined,
  });

  items.push({
    name: "At least 8 doc pages",
    tier: 2,
    pass: mdxFiles.length >= 8,
    detail: `${mdxFiles.length} page(s)`,
  });

  // Post-synth check count (excluding helpers, tests, and support files)
  const postSynthCheckFiles = listTsFiles(join(dir, "src/lint/post-synth"), ["index.ts"])
    .filter((f) => !f.endsWith(".test.ts") && !f.endsWith("-helpers.ts") && f !== "helpers.ts" && !f.startsWith("arm-") && !f.startsWith("k8s-"));
  items.push({
    name: "At least 15 post-synth checks",
    tier: 2,
    pass: postSynthCheckFiles.length >= 15,
    detail: `${postSynthCheckFiles.length} check(s)`,
  });

  // Skills count
  const skillsDir = join(dir, "src/skills");
  const skillFiles = existsSync(skillsDir) ? readdirSync(skillsDir).filter((f) => f.endsWith(".md")) : [];
  items.push({
    name: "At least 3 skills",
    tier: 2,
    pass: skillFiles.length >= 3,
    detail: `${skillFiles.length} skill(s)`,
  });

  // initTemplates count — check for template branches in plugin.ts
  const initTemplateBranches = (pluginContent.match(/template\s*===\s*["']/g) || []).length + 1; // +1 for default
  items.push({
    name: "At least 3 initTemplates",
    tier: 2,
    pass: initTemplateBranches >= 3,
    detail: `${initTemplateBranches} template(s)`,
  });

  // ── Tier 3: Thoroughness ───────────────────────────────────────

  // Each lint rule has a test (per-file or consolidated)
  const ruleDir = join(dir, "src/lint/rules");
  const ruleSourceFiles = listTsFiles(ruleDir, ["index.ts"]).filter((f) => !f.endsWith(".test.ts"));
  const ruleTestFiles = listTsFiles(ruleDir).filter((f) => f.endsWith(".test.ts"));
  // A consolidated test file (e.g. rules.test.ts) covers all rules in the directory
  const hasConsolidatedRuleTest = ruleTestFiles.length > 0;
  const untestedRules = hasConsolidatedRuleTest
    ? []
    : ruleSourceFiles.filter(
        (f) => !ruleTestFiles.includes(f.replace(".ts", ".test.ts")),
      );
  items.push({
    name: "Each lint rule has a .test.ts",
    tier: 3,
    pass: ruleSourceFiles.length > 0 && untestedRules.length === 0,
    detail: untestedRules.length > 0 ? `missing: ${untestedRules.join(", ")}` : undefined,
  });

  // Each post-synth has a test (per-file or consolidated)
  const postSynthDir = join(dir, "src/lint/post-synth");
  const postSynthSourceFiles = listTsFiles(postSynthDir, ["index.ts"])
    .filter((f) => !f.endsWith(".test.ts") && !f.endsWith("-helpers.ts") && f !== "helpers.ts");
  const postSynthTestFiles = listTsFiles(postSynthDir).filter((f) => f.endsWith(".test.ts"));
  // A consolidated test file (e.g. post-synth.test.ts) covers all checks in the directory
  const hasConsolidatedPostSynthTest = postSynthTestFiles.length > 0;
  const untestedPostSynth = hasConsolidatedPostSynthTest
    ? []
    : postSynthSourceFiles.filter(
        (f) => !postSynthTestFiles.includes(f.replace(".ts", ".test.ts")),
      );
  items.push({
    name: "Each post-synth check has a .test.ts",
    tier: 3,
    pass: postSynthSourceFiles.length > 0 && untestedPostSynth.length === 0,
    detail: untestedPostSynth.length > 0 ? `missing: ${untestedPostSynth.join(", ")}` : undefined,
  });

  const hasTypecheckTest = findFiles(join(dir, "src"), (n) => n === "typecheck.test.ts").length > 0;
  items.push({
    name: "typecheck.test.ts exists",
    tier: 3,
    pass: hasTypecheckTest,
  });

  const hasRoundtripTest = findFiles(join(dir, "src"), (n) => n === "roundtrip.test.ts").length > 0;
  items.push({
    name: "roundtrip.test.ts exists",
    tier: 3,
    pass: hasRoundtripTest,
  });

  items.push({
    name: "At least 5 composites",
    tier: 3,
    pass: compositeFiles.length >= 5,
    detail: `${compositeFiles.length} composite(s)`,
  });

  const hasActions = existsSync(join(dir, "src/actions")) &&
    listTsFiles(join(dir, "src/actions"), ["index.ts"]).length > 0;
  items.push({
    name: "src/actions/ with at least 1 action",
    tier: 3,
    pass: hasActions,
  });

  // Validate required names count
  const validateContent = readOr(join(dir, "src/validate.ts"));
  const requiredNamesMatches = validateContent.match(/["'][A-Z][a-zA-Z]+["']/g) || [];
  items.push({
    name: "validate.ts checks at least 30 required names",
    tier: 3,
    pass: requiredNamesMatches.length >= 30,
    detail: `${requiredNamesMatches.length} required name(s)`,
  });

  // Composite test file exists
  const hasCompositeTest = existsSync(join(dir, "src/composites/composites.test.ts"));
  items.push({
    name: "Composite test file exists",
    tier: 3,
    pass: hasCompositeTest,
  });

  // Examples with tests (per-example or consolidated root test file)
  const examplesDir = join(dir, "examples");
  let examplesWithTests = 0;
  if (existsSync(examplesDir)) {
    // A .test.ts in the examples root directory covers all examples
    const rootTestFiles = readdirSync(examplesDir).filter((f) => f.endsWith(".test.ts"));
    const hasConsolidatedExampleTest = rootTestFiles.length > 0;
    const exampleDirs = readdirSync(examplesDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const entry of exampleDirs) {
      if (hasConsolidatedExampleTest) {
        // Consolidated test covers all non-empty example dirs
        const contents = readdirSync(join(examplesDir, entry.name));
        if (contents.length > 0 && !(contents.length === 1 && contents[0] === ".gitkeep")) {
          examplesWithTests++;
        }
      } else {
        const exampleTests = findFiles(join(examplesDir, entry.name), (n) => n.endsWith(".test.ts"));
        if (exampleTests.length > 0) examplesWithTests++;
      }
    }
  }
  items.push({
    name: "At least 5 examples with tests",
    tier: 3,
    pass: examplesWithTests >= 5,
    detail: `${examplesWithTests} example(s) with tests`,
  });

  const tier1Pass = items.filter((i) => i.tier === 1).every((i) => i.pass);

  return { items, tier1Pass };
}

// ── Output formatting ────────────────────────────────────────────────

const COLORS = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
};

function useColors(): boolean {
  return !process.env.NO_COLOR && process.stdout.isTTY !== false;
}

function c(text: string, code: string): string {
  return useColors() ? `${code}${text}${COLORS.reset}` : text;
}

/**
 * Print the check result as a colored table or JSON.
 */
export function printCheckResult(result: CheckResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const tierLabels: Record<number, string> = {
    1: "required",
    2: "recommended",
    3: "thoroughness",
  };

  for (const tier of [1, 2, 3] as const) {
    const tierItems = result.items.filter((i) => i.tier === tier);
    if (tierItems.length === 0) continue;

    const passCount = tierItems.filter((i) => i.pass).length;
    const label = tierLabels[tier];
    console.log("");
    console.log(c(`Tier ${tier} — ${label} (${passCount}/${tierItems.length})`, COLORS.bold));

    for (const item of tierItems) {
      let icon: string;
      let nameColor: string;

      if (item.pass) {
        icon = c("PASS", COLORS.green);
        nameColor = COLORS.green;
      } else if (tier === 1) {
        icon = c("FAIL", COLORS.red);
        nameColor = COLORS.red;
      } else if (tier === 2) {
        icon = c("WARN", COLORS.yellow);
        nameColor = COLORS.yellow;
      } else {
        icon = c("INFO", COLORS.gray);
        nameColor = COLORS.gray;
      }

      const detail = item.detail ? c(` (${item.detail})`, COLORS.gray) : "";
      console.log(`  ${icon}  ${c(item.name, nameColor)}${detail}`);
    }
  }

  console.log("");
  if (result.tier1Pass) {
    console.log(c("All tier-1 checks passed.", COLORS.green));
  } else {
    const failures = result.items.filter((i) => i.tier === 1 && !i.pass);
    console.log(c(`${failures.length} tier-1 check(s) failed.`, COLORS.red));
  }
}
