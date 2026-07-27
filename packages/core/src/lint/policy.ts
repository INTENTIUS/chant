/**
 * Project-authored organizational policy: loading the policy pack and evaluating
 * it against a freshly built project. `chant build` runs policies inline; the
 * `policyGate` Op step runs this to gate an apply on the same checks.
 */
import { resolve, dirname } from "node:path";
import { loadChantConfigUpward } from "../config";
import { resolveProjectLexicons, loadPlugins } from "../cli/plugins";
import { build } from "../build";
import { runPostSynthChecks, isPostSynthCheck } from "./post-synth";
import type { PostSynthCheck, PostSynthDiagnostic } from "./post-synth";
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
  /** All policy diagnostics (errors + warnings). */
  diagnostics: PostSynthDiagnostic[];
  /** The error-severity subset — these are policy *violations* that gate. */
  violations: PostSynthDiagnostic[];
  /** The environment policies were evaluated against (if any). */
  env?: string;
}

/**
 * Build a project and run its `lint.policies` over the resolved resources,
 * standalone — used by the `policyGate` Op step to gate an apply on the same
 * organizational policy `chant build` enforces. Loads the project's lexicons,
 * builds, then runs the policy pack with `env` (explicit, else `ownership.env`).
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
  const env = opts.env ?? config.ownership?.env;

  const result = await build(buildPath, serializers);
  if (result.errors.length > 0) {
    throw new Error("Build failed — cannot evaluate policy on a broken build");
  }

  const checks = config.lint?.policies?.length
    ? await loadPolicyChecks(config.lint.policies, configDir)
    : [];
  if (checks.length === 0) {
    return { diagnostics: [], violations: [], env };
  }

  const diagnostics = runPostSynthChecks(checks, result, env);
  const violations = diagnostics.filter((d) => d.severity === "error");
  return { diagnostics, violations, env };
}
