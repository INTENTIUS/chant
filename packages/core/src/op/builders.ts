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

/** Run `npm run build` (or `chant build`) in the given project directory. */
export const build = (path: string, opts?: Record<string, unknown>): ActivityStep =>
  activity("chantBuild", { path, ...opts });

/** Run `kubectl apply -f <manifest>`. Uses `longInfra` profile. */
export const kubectlApply = (manifest: string, opts?: Record<string, unknown>): ActivityStep =>
  activity("kubectlApply", { manifest, ...opts }, "longInfra");

/** Run `helm upgrade --install`. Uses `longInfra` profile. */
export const helmInstall = (
  name: string,
  chart: string,
  opts?: { values?: string; namespace?: string; [k: string]: unknown },
): ActivityStep => activity("helmInstall", { name, chart, ...opts }, "longInfra");

/** Poll for stack readiness (kubectl rollout, CloudFormation complete, etc). Uses `k8sWait` profile. */
export const waitForStack = (name: string, opts?: Record<string, unknown>): ActivityStep =>
  activity("waitForStack", { name, ...opts }, "k8sWait");

/** Trigger and wait for a GitLab CI pipeline to complete. Uses `longInfra` profile. */
export const gitlabPipeline = (name: string, opts?: Record<string, unknown>): ActivityStep =>
  activity("gitlabPipeline", { name, ...opts }, "longInfra");

/** Take a chant state snapshot for the given environment. */
export const stateSnapshot = (env: string): ActivityStep =>
  activity("stateSnapshot", { env });

/** Run an arbitrary shell command. */
export const shell = (cmd: string, opts?: { env?: Record<string, string> }): ActivityStep =>
  activity("shellCmd", { cmd, ...opts });

/** Run `chant teardown` in the given project directory. Uses `longInfra` profile. */
export const teardown = (path: string): ActivityStep =>
  activity("chantTeardown", { path }, "longInfra");
