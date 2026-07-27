import { resolve } from "node:path";
import {
  runPostSynthChecks,
  type PostSynthCheck,
  type PostSynthContext,
  type PostSynthDiagnostic,
} from "./post-synth";
import { loadPolicyChecks } from "./policy";
import {
  armSandboxPolicyExecution,
  isSandboxPolicyExecutionArmed,
  resetSandboxPolicyExecutionForTests,
} from "./policy-import";
import type { EncodablePolicyBuildResult } from "../discovery/sandbox/policy-wire";

/**
 * chant #1131 — decides WHERE a project's `lint.policies` checks run.
 *
 * A policy is project-authored code. Every other piece of project code moved
 * behind the `--sandbox` boundary in chant #1045 (run-fallback source), #1093
 * (composite factories, constructors, intrinsic tags) and #1113
 * (`chant.config.ts`), and all three had to leave this one out: the config
 * declares its policies as *paths*, so putting the config behind the boundary
 * did not put them there with it. `chant build` imported each policy module and
 * called its `check` function in the CLI's own process, after discovery was
 * over, with the CLI's filesystem, network, environment and process-spawn
 * access. This module closes it.
 *
 * ## Why an armed process mode rather than a threaded option
 *
 * The same reason `../config-sandbox.ts` gives. `./policy.ts`'s
 * `loadPolicyChecks` is exported from chant-core's public surface and called
 * from more than one place (`../cli/commands/build.ts` for a build, and
 * `evaluateProjectPolicies` for the `policyGate` Op step). Threading a
 * `sandbox` flag to each is fail-OPEN: miss one and project code executes in
 * the CLI process with nothing to notice. Arming the process once, before any
 * policy is loaded, is fail-CLOSED — `loadPolicyChecks` REFUSES while armed, so
 * a call site nobody remembered gets a loud error rather than a silent
 * execution.
 *
 * ## What arms it
 *
 * Both ways of turning sandboxing on, unlike `../config-sandbox.ts`. That
 * asymmetry is not an oversight: the config has a bootstrap limit (reading
 * `build.sandbox` out of `chant.config.ts` means running it, so only the CLI
 * flag, known before any config is touched, can cover the config's own
 * evaluation). Policies have no such limit — they are loaded long after the
 * config is known — so `build.sandbox: true` in a project's config sandboxes
 * them just as `--sandbox` does, and `../cli/commands/build.ts` arms this from
 * the RESOLVED value.
 *
 * There is deliberately no disarm: a security mode that can be turned off
 * partway through a process is not one.
 */

/**
 * The mode itself lives on `./policy-import.ts` — the leaf module that actually
 * performs an in-process policy import, so the refusal sits on the narrowest
 * possible thing and `./policy.ts` can consult it without importing this file
 * (which imports `./policy.ts`). Re-exported here because this is where the
 * decision is documented and where callers look.
 *
 * `armSandboxPolicyExecution` is called from `../cli/commands/build.ts` once
 * `build.sandbox`/`--sandbox` has resolved, and from `../cli/main.ts` off the
 * parsed flag.
 */
export { armSandboxPolicyExecution, isSandboxPolicyExecutionArmed, resetSandboxPolicyExecutionForTests };

export interface ProjectPolicyRun {
  /** `lint.policies` as declared in the config — relative paths, resolved against {@link configDir}. */
  policies: readonly string[];
  /** The `chant.config.*` directory (`lint.policies` paths are relative to it), also the child's read allowance. */
  configDir: string;
  /** The merged, serialized build result the checks run over. */
  buildResult: EncodablePolicyBuildResult & PostSynthContext["buildResult"];
  /** `--env`, else `ownership.env`. Becomes `ctx.env`. */
  env?: string;
  /**
   * Checks the caller already loaded into THIS process, before the build ran.
   *
   * `chant build` has always loaded `lint.policies` up front rather than at the
   * point of use, so a policy path that doesn't resolve fails the command
   * immediately — including when the build itself goes on to fail, which is
   * exactly when a typo'd path would otherwise go unnoticed. Preserving that
   * for the unsandboxed path is the whole reason this field exists.
   *
   * Ignored when armed: under `--sandbox` there is nothing loaded here to pass,
   * and `loadPolicyChecks` refuses outright.
   */
  preloaded?: PostSynthCheck[];
}

/**
 * Run a project's organizational policy checks over a finished build and return
 * their diagnostics. Sandboxed in a post-merge child when armed, in-process
 * otherwise.
 *
 * The unarmed path is byte-for-byte what `chant build` has always done: load
 * the modules, hand every check one `PostSynthContext`, concatenate what they
 * return. The armed path does the same thing on the other side of a process
 * boundary — see `../discovery/sandbox/policy-run.ts`.
 */
export async function runProjectPolicies(run: ProjectPolicyRun): Promise<PostSynthDiagnostic[]> {
  if (run.policies.length === 0) return [];

  if (!isSandboxPolicyExecutionArmed()) {
    const checks = run.preloaded ?? (await loadPolicyChecks([...run.policies], run.configDir));
    if (checks.length === 0) return [];
    return runPostSynthChecks(checks, run.buildResult, run.env);
  }

  // Dynamic, not static, for the same reason `../config-sandbox.ts` imports
  // `../discovery/sandbox/config-run` dynamically: this pulls in `esbuild`, a
  // large CJS package no unsandboxed build should pay to load.
  const { runPoliciesSandboxed } = await import("../discovery/sandbox/policy-run");
  const { diagnostics } = await runPoliciesSandboxed({
    policyPaths: run.policies.map((p) => resolve(run.configDir, p)),
    buildResult: run.buildResult,
    env: run.env,
    projectRoot: run.configDir,
  });
  return diagnostics;
}
