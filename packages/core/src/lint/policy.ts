/**
 * Project-authored organizational policy: loading the policy pack and evaluating
 * it against a freshly built project. `chant build` runs policies inline; the
 * `policyGate` Op step runs this to gate an apply on the same checks.
 */
import { resolve, dirname } from "node:path";
import { loadChantConfigUpward, resolveOwnershipEnv, resolveOwnershipMarker } from "../config";
import { resolveBuildParams } from "../build-params";
import { resolveProjectLexicons, loadPlugins } from "../cli/plugins";
import { resolveBuildModes, resolveProjectBuildOptions } from "../cli/build-options";
import { formatWarning } from "../cli/format";
import { build } from "../build";
import { runPostSynthChecks, isPostSynthCheck } from "./post-synth";
import type { PostSynthCheck, PostSynthDiagnostic } from "./post-synth";
import { applyConfiguredSeverity } from "./config";
import { importPolicyModule, isSandboxPolicyExecutionArmed } from "./policy-import";

/**
 * Load project policy checks (one or more `PostSynthCheck` exports) from files,
 * **into this process**.
 *
 * chant #1131 — refuses while `./policy-sandbox.ts` is armed. Under `--sandbox`
 * the policy modules are imported and their checks run inside a child process
 * (`runProjectPolicies`); reaching this function anyway means a call site is
 * about to execute project-authored code in the CLI's own process, which is
 * precisely the thing the flag promises does not happen. Failing loudly is the
 * only honest option — falling through would make `--sandbox` mean less than it
 * says without anything visible to notice.
 */
export async function loadPolicyChecks(paths: string[], configDir: string): Promise<PostSynthCheck[]> {
  if (isSandboxPolicyExecutionArmed()) {
    throw new Error(
      `Cannot load lint.policies (${paths.join(", ")}) in the chant process under --sandbox: a policy module is project-authored code, and it must be imported inside the sandbox boundary. This is a chant bug — the caller should route through runProjectPolicies() (packages/core/src/lint/policy-sandbox.ts).`,
    );
  }

  const checks: PostSynthCheck[] = [];
  for (const p of paths) {
    const resolved = resolve(configDir, p);
    let mod: Record<string, unknown>;
    try {
      mod = await importPolicyModule(resolved);
    } catch (err) {
      throw new Error(
        `Failed to load policy "${p}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    for (const value of Object.values(mod)) {
      if (isPostSynthCheck(value)) checks.push(value);
    }
  }
  return checks;
}

export interface PolicyEvaluation {
  /** All policy diagnostics (errors + warnings), after `lint.rules` severity overrides. */
  diagnostics: PostSynthDiagnostic[];
  /** The error-severity subset (post-override) — these are policy *violations* that gate. */
  violations: PostSynthDiagnostic[];
  /** The environment policies were evaluated against (if any). */
  env?: string;
  /**
   * chant #1138 — diagnostics `lint.rules` turned `"off"`, present here rather
   * than dropped so a caller (`policyGate`, below) can report a count instead
   * of the finding just vanishing.
   */
  suppressed: PostSynthDiagnostic[];
  /**
   * chant #2002 — divergences between this evaluation and what `chant build`
   * would do, named rather than left silent. Today that is a project whose
   * resolved `build.sandbox` is `true`: the gate builds unsandboxed, because
   * running it inside the boundary needs the per-execution arming decision
   * tracked on #1157. Also written to stderr — the gate's caller is an
   * activity wrapper that surfaces output, not a structured result.
   */
  warnings: string[];
}

/**
 * Build a project and run its `lint.policies` over the resolved resources,
 * standalone — used by the `policyGate` Op step to gate an apply on the same
 * organizational policy `chant build` enforces. Loads the project's lexicons,
 * builds, then runs the policy pack with `env` (explicit, else `ownership.env`).
 *
 * chant #2002 — "the same organizational policy `chant build` enforces" only
 * holds if it is the same build. The build options are assembled by
 * `../cli/build-options.ts`'s `resolveProjectBuildOptions`, the single function
 * `chant build` also calls, rather than by a second list here; a build option
 * added for one caller and not the other is what let a gate pass a build
 * `chant build` fails.
 */
export async function evaluateProjectPolicies(opts: {
  path: string;
  env?: string;
}): Promise<PolicyEvaluation> {
  const buildPath = resolve(opts.path);

  const lexiconNames = await resolveProjectLexicons(buildPath);
  const plugins = await loadPlugins(lexiconNames);
  const serializers = plugins.map((p) => p.serializer);

  // chant #1117 — walks up from the build dir to the project root, same as
  // `chant build` (`../cli/commands/build.ts`'s `loadChantConfigUpward`), not
  // just the build dir's immediate parent.
  const loaded = await loadChantConfigUpward(buildPath);
  const config = loaded.config;
  const configDir = loaded.configPath ? dirname(loaded.configPath) : buildPath;
  // #1396 — `ownership.env` may reference a build parameter, so the declared
  // parameters are resolved first (from their env mappings and defaults, the
  // same inputs an Op step has) and the build sees them too.
  const params = resolveBuildParams(config.buildParams, { env: process.env });
  if (params.errors.length > 0) {
    throw new Error(`Build parameters did not resolve — cannot evaluate policy:\n  ${params.errors.join("\n  ")}`);
  }
  const env = opts.env ?? resolveOwnershipEnv(config, params.provenance);

  // chant #2002 — the build options come from the shared assembler
  // (`../cli/build-options.ts`), the same one `chant build` uses, so the gate
  // decides on the project `chant build` produces: folded by default (#1134),
  // with the project's config reaching the serializers, and with
  // config-declared build roots contributing their entities. Assembling a
  // second, shorter list here is what let the two drift apart.
  const modes = resolveBuildModes(config);
  const warnings: string[] = [];
  if (modes.sandbox) {
    // Resolved, reported, and not yet honoured. Building inside the boundary
    // needs per-execution arming (#1157) — until that lands, saying so is the
    // difference between a known gap and a silent one.
    warnings.push(
      `build.sandbox is enabled for this project, but the policy gate builds it in this process — the project's source files and its lint.policies modules execute here, unsandboxed (chant #1157). Run \`chant build --sandbox\` for a sandboxed build of the same project.`,
    );
  }
  for (const warning of warnings) console.error(formatWarning({ message: warning }));

  const result = await build(
    buildPath,
    serializers,
    undefined,
    resolveProjectBuildOptions({
      config,
      configDir,
      plugins,
      modes: { fold: modes.fold, sandbox: false },
      ownership: resolveOwnershipMarker(config, params.provenance),
      buildParams: params.provenance,
    }),
  );
  if (result.errors.length > 0) {
    throw new Error("Build failed — cannot evaluate policy on a broken build");
  }

  const checks = config.lint?.policies?.length
    ? await loadPolicyChecks(config.lint.policies, configDir)
    : [];
  if (checks.length === 0) {
    return { diagnostics: [], violations: [], env, suppressed: [], warnings };
  }

  const raw = runPostSynthChecks(checks, result, env);
  // chant #1138 — same `lint.rules` resolution `chant build` applies
  // (`../cli/commands/build.ts`), so a check `lint.rules` turned "off"/
  // "warning" doesn't gate an apply here even though `chant build` no longer
  // fails on it either, and vice versa for a check turned UP to "error".
  const { diagnostics, suppressed } = applyConfiguredSeverity(raw, config.lint?.rules);
  const violations = diagnostics.filter((d) => d.severity === "error");
  return { diagnostics, violations, env, suppressed, warnings };
}
