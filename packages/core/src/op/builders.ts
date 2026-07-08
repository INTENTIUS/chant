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

/**
 * Create a local k3d cluster (vanilla Kubernetes in Docker) and merge its
 * kubeconfig / switch context — k3d's defaults. Idempotent: skips creation if a
 * cluster of the same name already exists. Defaults to the `longInfra` profile
 * (creating a cluster may pull the k3s image); override via `opts.profile`.
 *
 * `opts` accepts `servers`, `agents`, `image`, `ports` (e.g.
 * `["8080:80@loadbalancer"]`), `registryCreate`, `configFile`, and `timeout`.
 */
export const k3dUp = (name: string, opts?: Record<string, unknown>): ActivityStep => {
  const { args, profile } = takeProfile(opts);
  return activity("k3dUp", { name, ...args }, profile ?? "longInfra");
};

/** Delete a local k3d cluster. Defaults to the `fastIdempotent` profile (override via `opts.profile`). */
export const k3dDown = (name: string, opts?: Record<string, unknown>): ActivityStep => {
  const { args, profile } = takeProfile(opts);
  return activity("k3dDown", { name, ...args }, profile ?? "fastIdempotent");
};

/**
 * Boot a local Floci AWS emulator in Docker and point subsequent steps at it —
 * sets `AWS_ENDPOINT_URL` + test creds in the process env so a following
 * `cloudformation` apply targets the emulator (local executor). Idempotent:
 * reuses a running container of the same name. Defaults to the `longInfra`
 * profile (the image may pull); override via `opts.profile`.
 *
 * `opts` accepts `name`, `port`, `image`, `dockerSocket` (mount the docker
 * socket for the ECR backing registry), `region`, `readyService`, `timeoutMs`.
 */
export const flociUp = (opts?: Record<string, unknown>): ActivityStep => {
  const { args, profile } = takeProfile(opts);
  return activity("flociUp", args, profile ?? "longInfra");
};

/** Stop and remove the local Floci emulator container. Defaults to the `fastIdempotent` profile (override via `opts.profile`). */
export const flociDown = (opts?: Record<string, unknown>): ActivityStep => {
  const { args, profile } = takeProfile(opts);
  return activity("flociDown", args, profile ?? "fastIdempotent");
};

/**
 * Ensure an Azure resource group exists before an ARM apply. `az deployment
 * group create` (the `arm` apply target) fails without its group, so place this
 * before the deploy phase. Idempotent. Defaults to the `fastIdempotent` profile
 * (override via `opts.profile`). `opts` accepts `location` (default `eastus`).
 */
export const azGroupEnsure = (resourceGroup: string, opts?: Record<string, unknown>): ActivityStep => {
  const { args, profile } = takeProfile(opts);
  return activity("azGroupEnsure", { resourceGroup, ...args }, profile ?? "fastIdempotent");
};

/** Delete an Azure resource group and its contents (non-blocking). Defaults to the `fastIdempotent` profile (override via `opts.profile`). */
export const azGroupDelete = (resourceGroup: string, opts?: Record<string, unknown>): ActivityStep => {
  const { args, profile } = takeProfile(opts);
  return activity("azGroupDelete", { resourceGroup, ...args }, profile ?? "fastIdempotent");
};

/**
 * Apply chant's built ARM template directly to the ARM resource API — the Azure
 * twin of {@link gcpApply}. Targets floci-az's resource CRUD (which `az deployment`
 * can't, floci-az having no deployments provider) or real Azure by endpoint
 * override; ensures the resource group first. Defaults to the `longInfra` profile.
 *
 * `opts` requires `resourceGroup`; accepts `location`, `endpoint` (floci-az
 * `http://localhost:4577`), and `subscriptionId`.
 */
export const azApply = (templatePath: string, opts?: Record<string, unknown>): ActivityStep => {
  const { args, profile } = takeProfile(opts);
  return activity("azApply", { templatePath, ...args }, profile ?? "longInfra");
};

/**
 * Apply chant's built GCP (CNRM) resources directly to the GCS REST API,
 * targeting a local floci-gcp emulator or real GCP by endpoint override — the
 * native GCP applier (#706 starter #711), currently handling `StorageBucket`.
 * Defaults to the `longInfra` profile (override via `opts.profile`).
 *
 * `opts` accepts `endpoint` (default `STORAGE_EMULATOR_HOST` env / real GCS) and
 * `project` (default `GOOGLE_CLOUD_PROJECT` env / the CNRM project-id annotation).
 */
export const gcpApply = (manifestPath: string, opts?: Record<string, unknown>): ActivityStep => {
  const { args, profile } = takeProfile(opts);
  return activity("gcpApply", { manifestPath, ...args }, profile ?? "longInfra");
};

/** Delete the GCP (CNRM) resources in a built manifest — the inverse of {@link gcpApply}. Defaults to the `longInfra` profile (override via `opts.profile`). */
export const gcpDelete = (manifestPath: string, opts?: Record<string, unknown>): ActivityStep => {
  const { args, profile } = takeProfile(opts);
  return activity("gcpDelete", { manifestPath, ...args }, profile ?? "longInfra");
};

/**
 * Gate an apply on organizational policy: build the project and run its
 * `lint.policies` over the resolved resources, blocking the workflow on any
 * violation. Place it before the apply phase. `env` (or `ownership.env`) lets a
 * policy branch on environment. Single-attempt (`policyCheck` profile) — a
 * deterministic violation is not retried.
 */
export const policyGate = (opts?: { env?: string; path?: string }): ActivityStep =>
  activity(
    "policyGate",
    { path: opts?.path ?? ".", ...(opts?.env ? { env: opts.env } : {}) },
    "policyCheck",
  );
