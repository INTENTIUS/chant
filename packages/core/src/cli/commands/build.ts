import { build } from "../../build";
import {
  loadChantConfigUpward,
  resolveOwnershipMarker,
  resolveOwnershipEnv,
  ownershipEnvDisagreement,
  isOwnershipParamRef,
  resolveKnowledgeDir,
} from "../../config";
import { resolveBuildModes, resolveProjectBuildOptions } from "../build-options";
import { loadOkfBundle } from "../../okf-read";
import { unknownEnvError } from "../../env";
import type { OwnershipMarker } from "../../ownership";
import { resolveCliBuildParams } from "../build-params-cli";
import type { Serializer, SerializerResult } from "../../serializer";
import type { LexiconPlugin } from "../../lexicon";
import { runPostSynthChecks } from "../../lint/post-synth";
import { coreReceiptChecks } from "../../lint/receipt-checks";
import { coreOutputChecks } from "../../lint/output-checks";
import { coreKnowledgeChecks } from "../../lint/knowledge-checks";
import { applyConfiguredSeverity } from "../../lint/config";
import { loadPolicyChecks } from "../../lint/policy";
import { armSandboxPolicyExecution, runProjectPolicies } from "../../lint/policy-sandbox";
import { sortedJsonReplacer } from "../../utils";
import { rankFoldBlockers, toCollapsedFormat, type FoldRankResult } from "../../discovery/fold-rank";
import { formatError, formatWarning, formatSuccess, formatBold, formatInfo } from "../format";
import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname, join, relative } from "path";
import { watchDirectory, formatTimestamp, formatChangedFiles } from "../watch";

/**
 * Build command options
 */
export interface BuildOptions {
  /** Path to infrastructure directory */
  path: string;
  /** Output file path (undefined = stdout) */
  output?: string;
  /** Output format */
  format: "json" | "yaml";
  /** Serializers to use for serialization */
  serializers: Serializer[];
  /** Lexicon plugins (for post-synth checks) */
  plugins?: LexiconPlugin[];
  /** Print summary to stderr */
  verbose?: boolean;
  /**
   * Environment/stack to evaluate policy against (`--env`). Falls back to the
   * project's `ownership.env`. Passed into post-synth checks so organizational
   * policy can branch on environment.
   */
  env?: string;
  /**
   * chant #1022/#1134 (epic #1019) — fold source modules statically instead
   * of importing/running them; the DEFAULT build path since #1134. Falls
   * back to run per-file for anything the folder can't represent. Tri-state:
   * `--fold` → true, `--no-fold` → false, unset → the project config /
   * default via {@link resolveFoldEnabled}. An explicit flag always wins for
   * the invocation, in either direction.
   */
  fold?: boolean;

  /**
   * chant #1045 Phase 2 — opt-in: run-fallback source files (or, without
   * `fold`, every file) execute together, isolated, in one sandboxed child
   * process (`chant build --sandbox`). Merged with the project's
   * `chant.config.ts` `build.sandbox` via {@link resolveSandboxEnabled} —
   * this flag, when true, always wins for the invocation.
   */
  sandbox?: boolean;

  /**
   * chant #1064 — `--param name=value` flags (repeatable), parsed to a flat
   * `{ name: value }` record of raw (unvalidated) strings. Highest
   * precedence in {@link resolveBuildParams}'s resolution against the
   * project's declared `chant.config.ts` `buildParams`.
   */
  params?: Record<string, string>;

  /**
   * chant #1064 — `--params-file <path>`: a JSON file of `{ "name": value }`
   * build-time parameter values, read and parsed here. Second precedence,
   * after {@link params}.
   */
  paramsFile?: string;

  /**
   * chant #1083 — `chant build --fold --fold-rank`: after the build, rank
   * `"run"`-mode files by dominator retained-count over the forward
   * import-failure graph (see `../../discovery/fold-rank.ts`), and report
   * the reverse-taint bucket (#1044) separately. Printed to stderr,
   * independent of `--verbose`'s per-file listing. No-op without `fold`.
   */
  foldRank?: boolean;

  /**
   * chant #1083 — `chant build --fold --fold-rank <path>`: as {@link
   * foldRank}, and ALSO writes the ranking as a Brendan Gregg collapsed
   * stack export (weighted by retained count) to this path, so it opens in
   * any flame/icicle viewer with no chant-specific tooling.
   */
  foldRankCollapsedFile?: string;
}

/**
 * Resolve the output format for `chant build`.
 *
 * When `--format` is not given, infer it from the `-o` file extension
 * (`.yaml`/`.yml` → yaml, `.json` → json); fall back to json when there is no
 * extension to infer from. An explicit `--format` always wins, but a mismatch
 * with the output extension is surfaced as a warning.
 */
export function resolveBuildFormat(
  explicit: string | undefined,
  output: string | undefined,
): { format: "json" | "yaml"; warning?: string } {
  const inferred = output
    ? /\.ya?ml$/i.test(output)
      ? "yaml"
      : /\.json$/i.test(output)
        ? "json"
        : undefined
    : undefined;

  if (explicit === "json" || explicit === "yaml") {
    if (inferred && inferred !== explicit) {
      return {
        format: explicit,
        warning: `Output file "${output}" looks like ${inferred} but --format ${explicit} was given; writing ${explicit}.`,
      };
    }
    return { format: explicit };
  }

  return { format: inferred ?? "json" };
}

/**
 * Build command result
 */
export interface BuildResult {
  /** Whether the build succeeded */
  success: boolean;
  /** Number of resources built */
  resourceCount: number;
  /** Number of source files processed */
  fileCount: number;
  /** Error messages */
  errors: string[];
  /** Warning messages */
  warnings: string[];
  /** This build's resolved build-time parameters (#1064) — see `BuildResult.buildParams` (../../build.ts). Empty when the project declares/supplies none. */
  buildParams?: import("../../provenance").BuildParamProvenance[];
}

/**
 * Execute the build command
 */
export async function buildCommand(options: BuildOptions): Promise<BuildResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Resolve the path
  const infraPath = resolve(options.path);

  // Resolve opt-in ownership marking from project config. chant #1117 — walks
  // up from the infra dir to the project root (`loadChantConfigUpward`), not
  // just the infra dir's immediate parent: a project whose stacks live two or
  // more levels below `chant.config.ts` (loomster's `src/<stack>` layout)
  // otherwise never finds the root config at all, and every declared
  // `buildParams`/`ownership`/`lint.policies` setting silently falls back to
  // its default.
  const loaded = await loadChantConfigUpward(infraPath);
  const config = loaded.config;
  // The ownership marker is resolved further down, after build parameters —
  // `ownership.env` may reference one (#1396).

  // Project-authored organizational policy checks (lint.policies), run over the
  // resolved resources during build. Resolve paths relative to the config dir.
  const configDir = loaded.configPath ? dirname(loaded.configPath) : infraPath;
  const policies = config.lint?.policies ?? [];

  // #1022/#1134 (fold) and #1045 Phase 2 (sandbox) — an explicit CLI flag
  // (--fold/--no-fold, --sandbox) wins over `chant.config.ts`'s
  // `build.fold`/`build.sandbox`, which wins over the defaults (fold on,
  // sandbox off). Resolved here rather than with the rest of the build
  // options below because arming sandboxed policy execution has to happen
  // before any policy module could be loaded — see #2002 in ../build-options.ts.
  const modes = resolveBuildModes(config, { fold: options.fold, sandbox: options.sandbox });
  const { fold, sandbox } = modes;

  // #1131 — arm sandboxed policy execution from the RESOLVED value, before any
  // policy module could be loaded. Resolved, not `options.sandbox`, because
  // policies have none of the config's bootstrap limit: they are loaded long
  // after `build.sandbox` is known, so a config-only opt-in sandboxes them just
  // as the CLI flag does. Arming (rather than threading a flag to each caller)
  // makes `loadPolicyChecks` refuse process-wide — a call site that forgot to
  // ask gets a loud error instead of quietly running project code here.
  if (sandbox) armSandboxPolicyExecution();

  // Unsandboxed, the policy pack is still loaded HERE, before the build — a
  // policy path that doesn't resolve has always failed the command up front,
  // including when the build itself then fails, and #1131 does not change that.
  // Sandboxed, there is nothing to load in this process at all.
  const preloadedPolicyChecks =
    !sandbox && policies.length > 0 ? await loadPolicyChecks([...policies], configDir) : undefined;

  // #1113 — the bootstrap limit, surfaced rather than left implicit. Reading
  // `build.sandbox` out of `chant.config.ts` requires evaluating that file, so
  // a config-only opt-in cannot have covered its own evaluation; only the CLI
  // flag, known before any config is touched, arms `../config-sandbox.ts`.
  // Say so instead of letting two different boundaries share one word.
  if (sandbox && !options.sandbox && loaded.configPath?.endsWith(".ts")) {
    warnings.push(
      formatWarning({
        message: `build.sandbox is enabled by ${loaded.configPath}, but that file was itself evaluated in this process — reading the setting requires running the config. Pass --sandbox on the command line to evaluate chant.config.ts inside the boundary too.`,
      }),
    );
  }

  // #1064 (factored into ../build-params-cli.ts's resolveCliBuildParams by
  // #1108, so the component deploy driver runs the identical sequence) —
  // resolve declared build-time parameters (chant.config.ts's buildParams)
  // against this invocation's --param/--params-file/declared env mapping,
  // BEFORE calling build() — a resolution failure (an unknown name, a
  // missing required value, a type/enum mismatch) is reported as a chant
  // build error naming the parameter, never a thrown error from inside user
  // source (which is what loomster's hand-rolled `tierFromEnv()`-style
  // validators did before migrating to this mechanism). Also logs a one-line
  // count on success, or every resolved value (`[param] name = value
  // (source)`) under --verbose (#1424).
  const paramsResolution = resolveCliBuildParams(config.buildParams, {
    cli: options.params,
    paramsFile: options.paramsFile,
    verbose: options.verbose,
  });
  if (!paramsResolution.success) {
    errors.push(...paramsResolution.errors);
    return { success: false, resourceCount: 0, fileCount: 0, errors, warnings };
  }

  // chant #1117 — a project that declares buildParams but resolves NONE of
  // them for this build is the exact shape that let loomster#162 live for two
  // releases: the discovered config wasn't the one the project author
  // expected (a stale --path, a workspace boundary that stopped the walk
  // short), or every declared parameter's `env:` var went unset, and either
  // way every `params.<name>` read silently falls back to `undefined` — with
  // no error (an all-`required: false` declaration resolves successfully to
  // an empty set). Warn, naming the config path this build actually
  // discovered, so a mismatch is visible instead of silent.
  if (
    Object.keys(config.buildParams ?? {}).length > 0 &&
    paramsResolution.provenance.length === 0
  ) {
    warnings.push(
      formatWarning({
        message: `chant.config.ts declares buildParams${loaded.configPath ? ` (${loaded.configPath})` : ""}, but none resolved for this build — every params.<name> read will be undefined. Pass --param/--params-file, or check that this is the config you expect.`,
      }),
    );
  }

  // #1396 — opt-in ownership marking, resolved AFTER build parameters so
  // `ownership.env: { param: "env" }` takes the value `--param env=prod` (or
  // the declared env mapping, or the default) bound to params.env — one
  // source for the label and the marker. A reference that cannot be
  // satisfied is a build error, not a marker silently stamped without an env.
  let ownership: OwnershipMarker | undefined;
  // Environment for policy evaluation: explicit --env wins, else ownership.env
  // (read even when marking itself is off, so policy can still branch on it).
  let env: string | undefined;
  try {
    ownership = resolveOwnershipMarker(config, paramsResolution.provenance);
    env = options.env ?? resolveOwnershipEnv(config, paramsResolution.provenance);
  } catch (err) {
    errors.push(formatError({ message: err instanceof Error ? err.message : String(err) }));
    return { success: false, resourceCount: 0, fileCount: 0, errors, warnings };
  }
  // A literal `ownership.env` next to an `env` build parameter that resolved
  // to something else is the silent divergence #1396 reports — say so.
  const disagreement = ownershipEnvDisagreement(config, paramsResolution.provenance);
  if (disagreement) warnings.push(formatWarning({ message: disagreement }));

  // #1221 — dynamic-env legality. `--env` is validated against the declared
  // `environments` in cli/main.ts; a param-bound `ownership.env` supplied via
  // `--param env=<value>` reached here unchecked, so `--param env=pord`
  // stamped a marker for an environment the project never declared. Same
  // check, same site of truth: literal entries match by equality, entries
  // containing `*` (e.g. `"pr-*"`) match as glob patterns, so an unbounded
  // family like per-PR environments is declarable without listing each name.
  if (isOwnershipParamRef(config.ownership?.env)) {
    const dynamicEnvErr = unknownEnvError(env, config.environments);
    if (dynamicEnvErr) {
      errors.push(formatError({
        message: dynamicEnvErr,
        hint: 'Declare it in chant.config `environments` (a "pr-*" pattern entry covers a dynamic family), or pass a declared value.',
      }));
      return { success: false, resourceCount: 0, fileCount: 0, errors, warnings };
    }
  }

  // Run the build. #2002 — every option comes from the shared assembler
  // (../build-options.ts), which `evaluateProjectPolicies` calls too, so the
  // `policyGate` step decides on the same project this command builds.
  const result = await build(
    infraPath,
    options.serializers,
    undefined,
    resolveProjectBuildOptions({
      config,
      configDir,
      plugins: options.plugins,
      modes,
      ownership,
      buildParams: paramsResolution.provenance,
    }),
  );

  // #1022 — report per-file fold vs run so it's visible what still runs.
  // #1424 — one line by default; the per-file lines and their reasons are
  // --verbose. A file that ran is the expected outcome for source that
  // computes values in functions, and a dozen "is not foldable" notes read
  // like errors to someone meeting the project for the first time.
  if (fold && result.foldDecisions.length > 0) {
    if (options.verbose) {
      for (const decision of result.foldDecisions) {
        const rel = relative(infraPath, decision.file) || decision.file;
        const detail =
          decision.mode === "fold"
            ? `${decision.resourceCount ?? 0} resource(s), no module execution`
            : (decision.reason ?? "fell back to run");
        console.error(formatInfo(`[fold:${decision.mode}] ${rel} — ${detail}`));
      }
    } else {
      console.error(formatInfo(summarizeFoldDecisions(result.foldDecisions)));
    }
  }

  // chant #1083 — rank fold blockers by dominator retained-count over the
  // forward import-failure graph, and report the reverse-taint bucket
  // (#1044) separately. Opt-in (`--fold-rank`) and independent of
  // `--verbose`: the per-file listing above says WHAT ran; this says WHICH
  // of those files is worth fixing first.
  if (fold && (options.foldRank || options.foldRankCollapsedFile) && result.foldDecisions.length > 0) {
    const ranking = await rankFoldBlockers(result.foldDecisions);
    console.error(formatInfo(formatFoldRanking(ranking, infraPath)));
    if (options.foldRankCollapsedFile) {
      const collapsedPath = resolve(options.foldRankCollapsedFile);
      mkdirSync(dirname(collapsedPath), { recursive: true });
      const lines = toCollapsedFormat(ranking, { relativeTo: infraPath });
      writeFileSync(collapsedPath, lines.length > 0 ? `${lines.join("\n")}\n` : "");
      console.error(formatInfo(`[fold-rank] collapsed-format export: ${collapsedPath} (${lines.length} line(s))`));
    }
  }

  // Format errors — grouped by message, because one refusal can surface once
  // per resource file. A project whose params module throws (a guard like
  // "this seam cannot back that tier") throws in EVERY file that imports it,
  // and fourteen copies of one sentence bury the sentence
  // (INTENTIUS/fountain-ops#62). The first file to hit it is named, the rest
  // become a count; errors with genuinely different messages keep their own
  // lines, and a message that appears once is printed exactly as before.
  const byMessage = new Map<string, { first: (typeof result.errors)[number]; files: number }>();
  for (const error of result.errors) {
    const key = `${error.name ?? ""}:${error.message}`;
    const seen = byMessage.get(key);
    if (seen) seen.files += 1;
    else byMessage.set(key, { first: error, files: 1 });
  }
  for (const { first: error, files } of byMessage.values()) {
    const formatted = formatError({
      file: "file" in error ? (error as unknown as Record<string, unknown>).file as string | undefined : undefined,
      line: "line" in error ? (error as unknown as Record<string, unknown>).line as number | undefined : undefined,
      column: "column" in error ? (error as unknown as Record<string, unknown>).column as number | undefined : undefined,
      message: files > 1 ? `${error.message} (and the same from ${files - 1} more files)` : error.message,
      name: error.name,
    });
    errors.push(formatted);
  }

  // Format warnings
  for (const warning of result.warnings) {
    warnings.push(formatWarning({ message: warning }));
  }

  // Run post-synth checks from plugins — each plugin only sees its own lexicon's output
  //
  // chant #1138 — every diagnostic collected below (a lexicon-shipped check's
  // AND a project's `lint.policies`') is resolved against `lint.rules` before
  // it becomes an error/warning line, through the exact same
  // `applyConfiguredSeverity` (../../lint/post-synth.ts) that keys off
  // `diag.checkId` the way `lintCommand` keys an AST/COMP* diagnostic off its
  // rule id — so `lint.rules: { WAW019: "off" }` suppresses a post-synth
  // finding just as it suppresses a pre-synth one. A finding it suppresses is
  // counted, not dropped silently — see `suppressedPostSynthCount` below.
  let suppressedPostSynthCount = 0;

  // Core-owned post-synth checks over effect receipts (#1833). Receipts are
  // recognized by marker, lexicon-independently, so this set runs over the
  // FULL build result — unscoped, and regardless of which plugins loaded.
  // Same severity-resolution funnel as every other post-synth finding.
  if (result.errors.length === 0) {
    const receiptDiags = runPostSynthChecks(coreReceiptChecks(), result, env);
    const { diagnostics: activeDiags, suppressed } = applyConfiguredSeverity(receiptDiags, config.lint?.rules);
    suppressedPostSynthCount += suppressed.length;
    for (const diag of activeDiags) {
      const prefix = diag.entity ? `[${diag.entity}] ` : "";
      const lexiconSuffix = diag.lexicon ? ` (${diag.lexicon})` : "";
      if (diag.severity === "error") {
        errors.push(formatError({ message: `${prefix}${diag.message}${lexiconSuffix}` }));
      } else {
        warnings.push(formatWarning({ message: `${prefix}${diag.message}${lexiconSuffix}` }));
      }
    }
  }

  // Core-owned post-synth check over serialized output text (#1526). The
  // "[object Object]" marker means a reference got stringified instead of
  // resolved; it can appear in any lexicon's emitted text, so this runs over
  // the FULL build result the same way the receipt checks above do.
  if (result.errors.length === 0) {
    const outputDiags = runPostSynthChecks(coreOutputChecks(), result, env);
    const { diagnostics: activeDiags, suppressed } = applyConfiguredSeverity(outputDiags, config.lint?.rules);
    suppressedPostSynthCount += suppressed.length;
    for (const diag of activeDiags) {
      const prefix = diag.entity ? `[${diag.entity}] ` : "";
      const lexiconSuffix = diag.lexicon ? ` (${diag.lexicon})` : "";
      if (diag.severity === "error") {
        errors.push(formatError({ message: `${prefix}${diag.message}${lexiconSuffix}` }));
      } else {
        warnings.push(formatWarning({ message: `${prefix}${diag.message}${lexiconSuffix}` }));
      }
    }
  }

  // Core-owned post-synth check over the project's OKF knowledge bundle
  // (#1865, design #1059): a concept's `binds` naming no discovered entity is
  // a stale binding, surfaced as a COR026 warning. `resolveKnowledgeDir` +
  // `loadOkfBundle` never fail — a missing/absent `knowledge/` directory
  // loads an empty bundle, so this is a no-op for a project that has none.
  if (result.errors.length === 0) {
    const bundle = await loadOkfBundle(resolveKnowledgeDir(config, configDir));
    const knowledgeDiags = runPostSynthChecks(coreKnowledgeChecks(bundle), result, env);
    const { diagnostics: activeDiags, suppressed } = applyConfiguredSeverity(knowledgeDiags, config.lint?.rules);
    suppressedPostSynthCount += suppressed.length;
    for (const diag of activeDiags) {
      const prefix = diag.entity ? `[${diag.entity}] ` : "";
      const lexiconSuffix = diag.lexicon ? ` (${diag.lexicon})` : "";
      if (diag.severity === "error") {
        errors.push(formatError({ message: `${prefix}${diag.message}${lexiconSuffix}` }));
      } else {
        warnings.push(formatWarning({ message: `${prefix}${diag.message}${lexiconSuffix}` }));
      }
    }
  }

  if (result.errors.length === 0 && options.plugins) {
    for (const plugin of options.plugins) {
      if (!plugin.postSynthChecks) continue;
      const checks = plugin.postSynthChecks();
      if (checks.length === 0) continue;

      // Scope outputs to this plugin's lexicon so cross-lexicon outputs don't
      // interfere. Outputs are keyed by the serializer's lexicon name (the
      // build partition key), which differs from plugin.name for a dialect like
      // forgejo (plugin "forgejo", serializer "github").
      const outputKey = plugin.serializer.name;
      const scopedOutputs = new Map<string, string | SerializerResult>();
      const pluginOutput = result.outputs.get(outputKey);
      if (pluginOutput !== undefined) {
        scopedOutputs.set(outputKey, pluginOutput);
      }

      const scopedResult = { ...result, outputs: scopedOutputs };
      const postDiags = runPostSynthChecks(checks, scopedResult, env);
      const { diagnostics: activeDiags, suppressed } = applyConfiguredSeverity(postDiags, config.lint?.rules);
      suppressedPostSynthCount += suppressed.length;
      for (const diag of activeDiags) {
        const prefix = diag.entity ? `[${diag.entity}] ` : "";
        const lexiconSuffix = diag.lexicon ? ` (${diag.lexicon})` : "";
        if (diag.severity === "error") {
          errors.push(formatError({ message: `${prefix}${diag.message}${lexiconSuffix}` }));
        } else {
          warnings.push(formatWarning({ message: `${prefix}${diag.message}${lexiconSuffix}` }));
        }
      }
    }

    // Project-authored organizational policy — cross-cutting, so it sees every
    // lexicon's output at once (not scoped per-plugin), with the current env.
    //
    // #1131 — under `--sandbox` this is where the LAST piece of project-
    // authored code the CLI used to execute in its own process moves behind
    // the boundary: `runProjectPolicies` hands the merged, serialized build
    // result to a post-merge sandboxed child, which imports the policy modules
    // and runs their checks there, and only plain `PostSynthDiagnostic`s come
    // back. Unsandboxed, it is the same in-process load-and-run as before.
    //
    // #1138 — `applyConfiguredSeverity` runs HERE, in the parent, after the
    // sandboxed child (when armed) has already returned — never inside it.
    // The child only knows the policy paths and the encoded build result, not
    // this project's resolved `lint.rules`, and by design nothing about the
    // suppression surface needs to cross that boundary: both the plain and
    // the `--sandbox` path funnel through this identical call with the
    // identical `config.lint?.rules`, so a sandboxed and an unsandboxed build
    // of the same project apply the same config to the same diagnostics.
    if (policies.length > 0) {
      const policyDiags = await runProjectPolicies({
        policies,
        configDir,
        buildResult: result,
        env,
        preloaded: preloadedPolicyChecks,
      });
      const { diagnostics: activePolicyDiags, suppressed } = applyConfiguredSeverity(policyDiags, config.lint?.rules);
      suppressedPostSynthCount += suppressed.length;
      for (const diag of activePolicyDiags) {
        const prefix = diag.entity ? `[${diag.entity}] ` : "";
        const where = diag.lexicon ? ` (${diag.lexicon})` : "";
        const msg = `[policy:${diag.checkId}] ${prefix}${diag.message}${where}`;
        if (diag.severity === "error") errors.push(formatError({ message: msg }));
        else warnings.push(formatWarning({ message: msg }));
      }
    }

    if (suppressedPostSynthCount > 0) {
      warnings.push(
        formatWarning({
          message: `${suppressedPostSynthCount} post-synth finding(s) suppressed via lint.rules (severity "off")`,
        }),
      );
    }
  }

  // Empty-output guard: source files were discovered but no lexicon produced
  // any output. Almost always indicates broken imports resolving to undefined
  // (e.g. missing root re-exports from a lexicon) or modules that exported no
  // Declarables. Without this guard, chant writes "{}" and exits 0.
  if (
    result.sourceFileCount > 0 &&
    result.outputs.size === 0 &&
    result.errors.length === 0 &&
    errors.length === 0
  ) {
    errors.push(
      formatError({
        message: `Discovered ${result.sourceFileCount} source file(s) but produced no output. Likely causes: imports resolving to undefined (missing exports from a lexicon root), or no Declarables/Composites exported. Check that imported names exist in the target package.`,
      }),
    );
  }

  // Handle output
  if (result.errors.length === 0 && errors.length === 0) {
    // Extract primary content and collect additional files from SerializerResult.
    // Each entry remembers which lexicon produced it, so a same-basename
    // collision between two sources (below) can name both.
    const additionalFiles = new Map<string, { content: string; source: string }>();

    // Basenames (from some SerializerResult.files) that must reach disk
    // BYTE-FOR-BYTE — e.g. committed ciphertext
    // (`declareSecret({ provenance: "committed-encrypted", file })`). The
    // additional-file writer below round-trips anything JSON.parse accepts,
    // key-sorting it and possibly re-emitting it as YAML, which would break
    // e.g. the `sops` MAC on committed ciphertext. A serializer opts a file
    // out of that round trip structurally, via `SerializerResult.verbatimFiles`
    // (chant#1937) — "the parse happens to fail" is not a safety guarantee.
    const verbatimFiles = new Set<string>();

    // A same basename emitted by two sources with different content would
    // otherwise silently overwrite (last-writer-wins, since `additionalFiles`
    // is keyed by basename alone). Identical content from two sources is
    // fine — dedup — but differing content is refused, naming both sources,
    // the same way the committed-encrypted resolution stage refuses a
    // basename collision among its own declarations.
    function addAdditionalFile(filename: string, content: string, source: string): void {
      const existing = additionalFiles.get(filename);
      if (existing === undefined) {
        additionalFiles.set(filename, { content, source });
        return;
      }
      if (existing.content === content) return;
      errors.push(
        formatError({
          message:
            `Additional file "${filename}" collides: "${existing.source}" and "${source}" ` +
            `both emit it with different content — additional files share one flat ` +
            `namespace, so two sources whose filenames match would otherwise silently ` +
            `overwrite each other.`,
        }),
      );
    }

    function getPrimaryContent(raw: string | SerializerResult, source: string): string {
      if (typeof raw === "string") return raw;
      if (raw.files) {
        for (const [filename, content] of Object.entries(raw.files)) {
          addAdditionalFile(filename, content, source);
        }
      }
      if (raw.verbatimFiles) {
        for (const filename of raw.verbatimFiles) {
          verbatimFiles.add(filename);
        }
      }
      return raw.primary;
    }

    // Try to parse content as JSON; return raw string if not JSON.
    function tryParseJson(content: string): { json: unknown } | { raw: string } {
      try {
        return { json: JSON.parse(content) };
      } catch {
        return { raw: content };
      }
    }

    // Single lexicon: output the template directly
    // Multiple lexicons: wrap in lexicon keys
    let output: string = "{}";
    if (result.outputs.size === 1) {
      const [lexiconName, raw] = [...result.outputs.entries()][0];
      const content = getPrimaryContent(raw, lexiconName);
      const parsed = tryParseJson(content);
      if ("json" in parsed) {
        output = JSON.stringify(parsed.json, sortedJsonReplacer, 2);
        if (options.format === "yaml") {
          output = jsonToYaml(JSON.parse(output));
        }
      } else {
        output = parsed.raw;
      }
    } else {
      // Multiple lexicons: JSON outputs get combined under lexicon keys,
      // non-JSON outputs (e.g. YAML) are appended after a separator.
      const combined: Record<string, unknown> = {};
      const nonJsonSections: string[] = [];
      const sortedLexiconNames = [...result.outputs.keys()].sort();
      for (const lexiconName of sortedLexiconNames) {
        const content = getPrimaryContent(result.outputs.get(lexiconName)!, lexiconName);
        const parsed = tryParseJson(content);
        if ("json" in parsed) {
          combined[lexiconName] = parsed.json;
        } else {
          nonJsonSections.push(`# --- ${lexiconName} ---\n${parsed.raw}`);
        }
      }

      const parts: string[] = [];
      if (Object.keys(combined).length > 0) {
        let jsonOutput = JSON.stringify(combined, sortedJsonReplacer, 2);
        if (options.format === "yaml") {
          jsonOutput = jsonToYaml(JSON.parse(jsonOutput));
        }
        parts.push(jsonOutput);
      }
      parts.push(...nonJsonSections);
      if (parts.length > 0) {
        output = parts.join("\n\n");
      }
    }

    // Op worker artifacts (`ops/<name>/{workflow,worker,activities}.ts`) always
    // go to `<project>/dist/ops/` — the fixed location `chant run <op> --temporal`
    // reads (`join(projectPath, "dist", "ops", ...)`) — independent of `--output`,
    // which routes the primary resource manifest. Without this, a bare `chant build`
    // only printed them to stderr and `--output foo.yaml` scattered them next to
    // `foo.yaml`, so the durable-run worker was never where `run --temporal` looks.
    const projectDist = resolve(options.path ?? ".", "dist");
    let opsWritten = 0;
    for (const [filename, entry] of [...additionalFiles]) {
      if (!filename.startsWith("ops/")) continue;
      additionalFiles.delete(filename);
      try {
        const targetPath = join(projectDist, filename);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, entry.content);
        opsWritten += 1;
      } catch (err) {
        errors.push(
          formatError({
            message: `Failed to write Op worker file ${filename}: ${err instanceof Error ? err.message : String(err)}`,
          }),
        );
      }
    }
    if (opsWritten > 0) {
      console.error(formatInfo(`Wrote ${opsWritten} Op worker file(s) under ${join(options.path ?? ".", "dist", "ops")}/`));
    }

    if (options.output) {
      // Write to file — ensure parent directories exist for both the primary
      // output path and any nested additional-file paths (e.g. ops/<name>/...).
      try {
        const outputPath = resolve(options.output);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, output);

        // Write additional files (e.g. nested stack templates) alongside the primary output
        if (additionalFiles.size > 0) {
          const outputDir = dirname(outputPath);
          for (const [filename, entry] of additionalFiles) {
            let fileContent = entry.content;
            // Format additional files consistently — except the ones declared
            // verbatim, which are copied exactly as they were committed.
            if (!verbatimFiles.has(filename)) {
              try {
                const fileParsed = JSON.parse(entry.content);
                fileContent = JSON.stringify(fileParsed, sortedJsonReplacer, 2);
                if (options.format === "yaml") {
                  fileContent = jsonToYaml(JSON.parse(fileContent));
                }
              } catch {
                // If not JSON, write as-is
              }
            }
            const targetPath = join(outputDir, filename);
            mkdirSync(dirname(targetPath), { recursive: true });
            writeFileSync(targetPath, fileContent);
          }
        }
      } catch (err) {
        errors.push(
          formatError({
            message: `Failed to write output file: ${err instanceof Error ? err.message : String(err)}`,
          })
        );
      }
    } else if (verbatimFiles.size > 0) {
      // A build carrying committed ciphertext and no --output has nowhere to
      // put the sidecar. Echoing it to a terminal is not useful and dropping
      // it silently is worse: the primary output would reference a Secret
      // whose file never got written, and the miss would surface as a pod
      // failing to start, far from its cause. Refuse, naming the flag.
      const names = [...verbatimFiles].sort().join(", ");
      errors.push(
        formatError({
          message:
            `This build emits committed-encrypted secret file(s) (${names}) as sidecars, ` +
            `which need a directory to be written into. Re-run with --output <path> ` +
            `(the sidecars land beside it).`,
        }),
      );
    } else {
      // Print to stdout
      console.log(output);
      // Log additional files to stderr if any
      for (const [filename, entry] of additionalFiles) {
        console.error(`\n--- ${filename} ---`);
        console.error(entry.content);
      }
    }
  }

  const resourceCount = result.entities.size;
  const fileCount = result.sourceFileCount;

  if (fileCount === 0 && errors.length === 0) {
    console.error(formatInfo("No source files found — create .ts files in the target directory"));
  }

  if (options.verbose && errors.length === 0) {
    console.error(
      formatSuccess(
        `Built ${formatBold(String(resourceCount))} resources successfully`
      )
    );
  }

  return {
    success: errors.length === 0,
    resourceCount,
    fileCount,
    errors,
    warnings,
    buildParams: paramsResolution.provenance,
  };
}

/**
 * `fold: 8 files folded, 13 ran (--verbose for reasons)` — the non-verbose
 * report of a fold build's per-file decisions (#1424). The "(--verbose for
 * reasons)" hint appears only when something ran, since that is the only case
 * with a reason to read.
 */
export function summarizeFoldDecisions(decisions: readonly { mode: string }[]): string {
  const folded = decisions.filter((d) => d.mode === "fold").length;
  const ran = decisions.length - folded;
  const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
  const hint = ran > 0 ? " (--verbose for reasons)" : "";
  return `fold: ${files(folded)} folded, ${ran} ran${hint}`;
}

/**
 * `chant build --fold --fold-rank`'s text report (chant #1083): blockers
 * ranked by dominator retained-count, highest first, then the reverse-taint
 * bucket (#1044) called out separately since the tree can't express that
 * edge (see `../../discovery/fold-rank.ts`'s module doc).
 */
export function formatFoldRanking(ranking: FoldRankResult, infraPath: string): string {
  const rel = (file: string): string => relative(infraPath, file) || file;
  const lines: string[] = [];
  if (ranking.blockers.length === 0) {
    lines.push("fold-rank: no run-mode files to rank");
  } else {
    lines.push(`fold-rank: ${ranking.blockers.length} blocker(s), ${ranking.totalBlocked} file(s) blocked`);
    for (const b of ranking.blockers) {
      const via = b.topLevel ? "" : ` (behind ${rel(b.dominatedBy!)})`;
      const reason = b.reason ? ` — ${b.reason}` : "";
      lines.push(`  retained ${b.retained}: ${rel(b.file)}${via}${reason}`);
    }
  }
  if (ranking.reverseTainted.length > 0) {
    lines.push(
      `fold-rank: ${ranking.reverseTainted.length} file(s) held back only by the reverse rule (#1044) — would fold in isolation, blocked by a run-mode importer, not modeled in the tree above:`,
    );
    for (const t of ranking.reverseTainted) {
      lines.push(`  ${rel(t.file)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Simple JSON to YAML converter
 */
function jsonToYaml(obj: unknown, indent = 0): string {
  const spaces = "  ".repeat(indent);

  if (obj === null) return "null";
  if (obj === undefined) return "~";
  if (typeof obj === "boolean") return obj ? "true" : "false";
  if (typeof obj === "number") return String(obj);
  if (typeof obj === "string") {
    // Quote strings that need it
    if (obj.includes("\n") || obj.includes(":") || obj.includes("#")) {
      return `"${obj.replace(/"/g, '\\"')}"`;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    return obj
      .map((item) => `${spaces}- ${jsonToYaml(item, indent + 1).trimStart()}`)
      .join("\n");
  }

  if (typeof obj === "object") {
    const entries = Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return "{}";
    return entries
      .map(([key, value]) => {
        const yamlValue = jsonToYaml(value, indent + 1);
        // A non-empty container (object OR array) renders as a block: the key on
        // its own line, the value indented beneath it. Arrays were previously
        // excluded here, which inlined `Tags: - Key: t` as invalid YAML.
        const isContainer = typeof value === "object" && value !== null;
        const isEmpty = isContainer && (Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0);
        if (isContainer && !isEmpty) {
          return `${spaces}${key}:\n${yamlValue}`;
        }
        return `${spaces}${key}: ${yamlValue.trimStart()}`;
      })
      .join("\n");
  }

  return String(obj);
}

/**
 * Print errors to stderr
 */
export function printErrors(errors: string[]): void {
  for (const error of errors) {
    console.error(error);
  }
}

/**
 * Print warnings to stderr
 */
export function printWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    console.error(warning);
  }
}

/**
 * Run build in watch mode. Runs an initial build, then watches for changes
 * and triggers rebuilds. Returns a cleanup function.
 */
export function buildCommandWatch(
  options: BuildOptions,
  onRebuild?: (result: BuildResult) => void,
): () => void {
  const infraPath = resolve(options.path);

  console.error(formatInfo(`[${formatTimestamp()}] Watching for changes...`));

  // Run initial build
  buildCommand(options).then((result) => {
    printWarnings(result.warnings);
    printErrors(result.errors);
    onRebuild?.(result);
    console.error(formatInfo(`[${formatTimestamp()}] Waiting for changes...`));
  });

  // Watch for changes and trigger rebuilds
  const cleanup = watchDirectory(infraPath, async (changedFiles) => {
    console.error("");
    console.error(
      formatInfo(
        `[${formatTimestamp()}] Changes detected: ${formatChangedFiles(changedFiles, infraPath)}`,
      ),
    );

    try {
      const result = await buildCommand(options);
      printWarnings(result.warnings);
      printErrors(result.errors);
      onRebuild?.(result);
    } catch (err) {
      console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    }

    console.error(formatInfo(`[${formatTimestamp()}] Waiting for changes...`));
  });

  return cleanup;
}
