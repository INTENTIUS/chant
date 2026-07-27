import { realpathSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { PostSynthDiagnostic } from "../../lint/post-synth";
import { bundleDriver } from "./bundle";
import { generatePolicyDriverSource } from "./driver";
import { forkSandboxed } from "./fork";
import {
  encodePolicyBuildResult,
  formatPolicyWireOffenders,
  type EncodablePolicyBuildResult,
  type PolicyDiagnosticOffender,
} from "./policy-wire";
import { ENV_VAR } from "../../env";

/**
 * chant #1131 — runs a project's `lint.policies` checks inside a sandboxed
 * child, over the build result the parent has already merged and serialized,
 * and brings back plain `PostSynthDiagnostic`s.
 *
 * This closes the last residual chant #1093 and #1113 documented. `--sandbox`
 * isolated project *source* (#1045), then project *fold-time* code (#1093),
 * then the project's `chant.config.ts` (#1113) — but `chant build` still
 * imported every `lint.policies` module and called its `check` function in the
 * CLI's own process, after discovery, with the CLI's full filesystem, network,
 * environment and process-spawn access. The config crossing as data did not
 * take the policies with it: they are declared in it as *paths*.
 *
 * ## Why a second child rather than the first one
 *
 * A policy is a callback over the *whole* resolved build, and no such thing
 * exists inside the #1045 discovery child. That child sees only the
 * run-fallback subset — folded files are collected in the parent, the merge
 * happens in the parent, and serialization (which is what most policies
 * actually read) happens later still. Running policies there would hand them a
 * partial, unserialized view and call it the same check. So the boundary moves
 * to where the complete result exists: after the merge, in a child of its own.
 *
 * Deliberately the same machinery, not a parallel one — the same three modules
 * `./config-run.ts` reuses:
 *  - `./bundle.ts` bundles the generated driver (`./driver.ts`'s
 *    `generatePolicyDriverSource`) with esbuild, so the child needs no runtime
 *    module resolution and no TypeScript loader.
 *  - `./fork.ts` spawns it with the identical `--permission` profile the
 *    run-fallback and config children get — one function, so the three cannot
 *    drift.
 *  - `./child-errors.ts` (inside the driver) classifies whatever it throws, so
 *    a permission denial names the policy file instead of leaking
 *    `ERR_ACCESS_DENIED`.
 *
 * The one addition is direction: the policy child receives its input over the
 * same IPC channel it answers on (`SandboxForkOptions.send`). See that field's
 * doc for why sending before the child boots is safe.
 *
 * ## What the child can and cannot do
 *
 * Exactly what a run-fallback file can: read the bundle directory and the
 * project directory, nothing else; no writes, no spawning, no worker threads;
 * an environment of `PATH` plus `CHANT_ENV` when set. That last one matches
 * `./config-run.ts` for the same reason — `--env` is a value the user typed on
 * the command line, and a policy that branches on the environment is the
 * documented pattern (`ctx.env` carries it too, so this is belt-and-braces for
 * a policy reading `process.env.CHANT_ENV` directly rather than a new
 * capability).
 *
 * A policy that writes a report file, shells out to a scanner, or reads
 * `~/.aws/credentials` therefore now FAILS, loudly, naming the file and the
 * operation. That is the point of the flag, and it is a real behavior change
 * for such a policy under `--sandbox` — see `docs/.../architecture/sandbox.mdx`.
 */

/** A policy child is one bundle, one import per policy module, and a pass over data. Generous relative to that, tight enough that a hung policy is reported rather than waited on. */
const POLICY_CHILD_TIMEOUT_MS = 120_000;

interface PolicyChildResponse {
  kind: "chant-policy";
  ok: boolean;
  diagnostics?: PostSynthDiagnostic[];
  offenders?: PolicyDiagnosticOffender[];
  error?: { name: string; file: string; message: string; type: string };
}

/**
 * chant #1148 — `[policy:<module-basename>]`, joined when a project declares
 * more than one policy module (all of them share the one child — see the
 * module doc above). One policy module is the only shape this repo's own
 * corpus exercises (`lexicons/k8s/examples/org-policy`), so this is the
 * common case, not a hypothetical.
 */
function policyOutputPrefix(policyPaths: readonly string[]): string {
  return `[policy:${policyPaths.map((p) => basename(p)).join(",")}]`;
}

function isPolicyChildResponse(value: unknown): value is PolicyChildResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "chant-policy" &&
    typeof (value as { ok?: unknown }).ok === "boolean"
  );
}

export interface SandboxPolicyResult {
  /** What the policy pack reported — plain data, validated inside the child before it crossed (see `./policy-wire.ts`'s `scanPolicyDiagnostics`). */
  diagnostics: PostSynthDiagnostic[];
  /** esbuild bundling wall-clock time. */
  bundleMs: number;
  /** Bundle size in bytes. */
  bundleBytes: number;
  /** Encoded build-result payload size in bytes — what crossed the IPC channel. */
  payloadBytes: number;
}

export interface SandboxPolicyOptions {
  /** Absolute paths to the project's `lint.policies` modules, in declaration order. */
  policyPaths: readonly string[];
  /** The merged, serialized build result the checks run over. */
  buildResult: EncodablePolicyBuildResult;
  /** The environment/stack this build was evaluated for (`--env`, else `ownership.env`) — becomes `ctx.env`. */
  env?: string;
  /** Directory the child is granted `--allow-fs-read` for: the project root (the `chant.config.*` directory, which `lint.policies` paths are resolved against). */
  projectRoot: string;
}

/**
 * Evaluate `policyPaths` against `buildResult` inside a sandboxed child.
 *
 * Throws — rather than degrading to an in-process run — when the policies
 * cannot be evaluated inside the boundary or their diagnostics cannot cross it
 * as JSON. Under `--sandbox` a policy pack that "almost" ran is not a safe
 * thing to proceed with, and quietly falling back would give away the property
 * the flag exists to provide.
 */
export async function runPoliciesSandboxed(options: SandboxPolicyOptions): Promise<SandboxPolicyResult> {
  const { policyPaths, buildResult, env, projectRoot } = options;

  // Encoded FIRST, in the parent, before anything is bundled or spawned: this
  // is where a build result that cannot cross is rejected by name (a
  // `nestedStack()` child project, a serializer output that isn't data), and
  // there is no point paying for a bundle to find that out.
  const payload = {
    kind: "chant-policy-request" as const,
    buildResult: encodePolicyBuildResult(buildResult),
    env: env ?? null,
  };
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf-8");

  const driverSource = generatePolicyDriverSource(policyPaths);
  const { bundlePath, bundleDir, externalReadPaths, durationMs, bytes } = await bundleDriver(driverSource);

  try {
    let projectRealpath: string;
    try {
      projectRealpath = realpathSync(resolve(projectRoot));
    } catch {
      projectRealpath = resolve(projectRoot);
    }

    const childEnv: Record<string, string> = { PATH: process.env.PATH ?? "" };
    const activeEnv = process.env[ENV_VAR];
    if (activeEnv) childEnv[ENV_VAR] = activeEnv;

    const response = await forkSandboxed(
      {
        bundlePath,
        bundleDir,
        projectRealpath,
        externalReadPaths,
        env: childEnv,
        timeoutMs: POLICY_CHILD_TIMEOUT_MS,
        label: `sandboxed evaluation of lint.policies (${policyPaths.length} module(s))`,
        send: payload,
        // chant #1148 — a policy's own console.log/error no longer goes
        // nowhere; see `./fork.ts`'s `outputPrefix` doc.
        outputPrefix: policyOutputPrefix(policyPaths),
      },
      isPolicyChildResponse,
    );

    if (!response.ok) {
      if (response.offenders && response.offenders.length > 0) {
        throw new Error(formatPolicyWireOffenders("a policy check's return value", response.offenders));
      }
      throw new Error(
        response.error?.message
          ? `Failed to run lint.policies inside the --sandbox boundary: ${response.error.message}`
          : `Failed to run lint.policies inside the --sandbox boundary`,
      );
    }

    return { diagnostics: response.diagnostics ?? [], bundleMs: durationMs, bundleBytes: bytes, payloadBytes };
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
  }
}
