import { OpResource } from "./resource";
import type { OpConfig, PhaseDefinition, StepDefinition, ActivityStep, GateStep } from "./types";

// ── Core builders ─────────────────────────────────────────────────────────────

/**
 * Declare a named, phased Temporal workflow.
 *
 * @example
 * ```ts
 * export default Op({
 *   name: "alb-deploy",
 *   overview: "Build and deploy the ALB multi-service stack",
 *   phases: [
 *     phase("Build", [build("examples/gitlab-aws-alb-infra")], { parallel: true }),
 *     phase("Deploy", [kubectlApply("dist/alb-infra.yaml")]),
 *   ],
 * });
 * ```
 */
export function Op(config: OpConfig): InstanceType<typeof OpResource> {
  return new OpResource(config as unknown as Record<string, unknown>);
}

/** Define a named execution phase containing one or more steps. */
export function phase(
  name: string,
  steps: StepDefinition[],
  opts?: { parallel?: boolean },
): PhaseDefinition {
  return { name, steps, ...(opts?.parallel ? { parallel: true } : {}) };
}

/** Reference a pre-built or custom activity by function name. */
export function activity(
  fn: string,
  args?: Record<string, unknown>,
  profile?: ActivityStep["profile"],
): ActivityStep {
  return {
    kind: "activity",
    fn,
    ...(args && Object.keys(args).length > 0 ? { args } : {}),
    ...(profile ? { profile } : {}),
  };
}

/** Insert a human gate — the workflow pauses until the named signal is received. */
export function gate(
  signalName: string,
  opts?: { timeout?: string; description?: string },
): GateStep {
  return {
    kind: "gate",
    signalName,
    ...(opts?.timeout ? { timeout: opts.timeout } : {}),
    ...(opts?.description ? { description: opts.description } : {}),
  };
}

// ── Pre-built activity shortcuts ──────────────────────────────────────────────

/**
 * Pull an optional `profile` override out of an opts bag, returning the
 * remaining keys (which become activity args) separately.
 *
 * Without this, a `profile` passed in opts would spread into the activity's
 * **args** rather than set the step's `profile` — a silent no-op on the step's
 * timeout. The activity then runs under the default profile, so a step the
 * author tagged `longInfra` (20m) would still get the 5m default. Routing it
 * here lets every shortcut accept a `profile` override that actually takes.
 */
function takeProfile(
  opts: Record<string, unknown> | undefined,
): { args: Record<string, unknown>; profile?: ActivityStep["profile"] } {
  if (!opts) return { args: {} };
  const { profile, ...args } = opts as { profile?: ActivityStep["profile"] } & Record<string, unknown>;
  return { args, profile };
}

/** Run `npm run build` (or `chant build`) in the given project directory. */
export const build = (path: string, opts?: Record<string, unknown>): ActivityStep => {
  const { args, profile } = takeProfile(opts);
  return activity("chantBuild", { path, ...args }, profile);
};

/** Run `kubectl apply -f <manifest>`. Defaults to the `longInfra` profile (override via `opts.profile`). */
export const kubectlApply = (manifest: string, opts?: Record<string, unknown>): ActivityStep => {
  const { args, profile } = takeProfile(opts);
  return activity("kubectlApply", { manifest, ...args }, profile ?? "longInfra");
};

/** Run `helm upgrade --install`. Defaults to the `longInfra` profile (override via `opts.profile`). */
export const helmInstall = (
  name: string,
  chart: string,
  opts?: { values?: string; namespace?: string; profile?: ActivityStep["profile"]; [k: string]: unknown },
): ActivityStep => {
  const { args, profile } = takeProfile(opts);
  return activity("helmInstall", { name, chart, ...args }, profile ?? "longInfra");
};

/** Poll for stack readiness (kubectl rollout, CloudFormation complete, etc). Defaults to the `k8sWait` profile (override via `opts.profile`). */
export const waitForStack = (name: string, opts?: Record<string, unknown>): ActivityStep => {
  const { args, profile } = takeProfile(opts);
  return activity("waitForStack", { name, ...args }, profile ?? "k8sWait");
};

/** Trigger and wait for a GitLab CI pipeline to complete. Defaults to the `longInfra` profile (override via `opts.profile`). */
export const gitlabPipeline = (name: string, opts?: Record<string, unknown>): ActivityStep => {
  const { args, profile } = takeProfile(opts);
  return activity("gitlabPipeline", { name, ...args }, profile ?? "longInfra");
};

/** Take a chant lifecycle snapshot for the given environment. */
export const lifecycleSnapshot = (env: string): ActivityStep =>
  activity("lifecycleSnapshot", { env });

/**
 * Run an arbitrary shell command. Tag long-running commands with a `profile`
 * (e.g. `longInfra` for a multi-GB image push) so they get the right
 * start-to-close timeout under both the local executor and Temporal.
 */
export const shell = (
  cmd: string,
  opts?: { env?: Record<string, string>; profile?: ActivityStep["profile"] },
): ActivityStep =>
  activity("shellCmd", { cmd, ...(opts?.env ? { env: opts.env } : {}) }, opts?.profile);

/** Run `chant teardown` in the given project directory. Uses `longInfra` profile. */
export const teardown = (path: string): ActivityStep =>
  activity("chantTeardown", { path }, "longInfra");
