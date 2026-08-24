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

/** Run an npm build script in the given project directory. `opts.script` selects the script (default `build`, e.g. `build:aws`); `opts.env` adds env vars. */
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

/** Poll any operator-backed Kubernetes resource until it reports ready, driven by a data-only readiness spec (CRD-aware; #365). Defaults to the `k8sWait` profile (override via `opts.profile`). */
export const waitForReady = (kind: string, name: string, opts?: Record<string, unknown>): ActivityStep => {
  const { args, profile } = takeProfile(opts);
  return activity("waitForReady", { kind, name, ...args }, profile ?? "k8sWait");
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
 * Create a local k3d cluster (vanilla Kubernetes in Docker). Idempotent: skips
 * creation if a cluster of the same name already exists. Defaults to the
 * `longInfra` profile (creating a cluster may pull the k3s image); override via
 * `opts.profile`.
 *
 * The implementation lives in the k3d lexicon (chant #1410) — the project's
 * `chant.config.ts` must list `"k3d"` in `lexicons` for the activity to load.
 * Unlike the upstream CLI, the activity leaves the caller's default kubeconfig
 * and current context alone by default (chant #1411); pass
 * `updateDefaultKubeconfig: true` / `switchCurrentContext: true` to opt back
 * in. It resolves `{ context, kubeconfigPath? }` for reaching the cluster.
 *
 * `opts` accepts `servers`, `agents`, `image`, `ports` (e.g.
 * `["8080:80@loadbalancer"]`), `registryCreate`, `configFile`, `timeout`,
 * `updateDefaultKubeconfig`, and `switchCurrentContext`.
 */
export const k3dUp = (name: string, opts?: Record<string, unknown>): ActivityStep => {
  const { args, profile } = takeProfile(opts);
  return activity("k3dUp", { name, ...args }, profile ?? "longInfra");
};

/**
 * Delete a local k3d cluster. Defaults to the `fastIdempotent` profile
 * (override via `opts.profile`). Implementation lives in the k3d lexicon
 * (chant #1410) — requires `"k3d"` in the project's `lexicons`.
 */
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
 * Boot a local floci-az (Azure emulator) and return its ARM `endpoint` — the
 * typed twin of {@link flociUp} for `azApply`, so the emulator lifecycle is a
 * modeled step, not a `docker run` shell. Provided by the azure lexicon; loaded
 * when the project lists `azure`. Idempotent; defaults to the `longInfra`
 * profile. `opts` accepts `name`, `port`, `image`, `timeoutMs`, `intervalMs`.
 */
export const flociAzUp = (opts?: Record<string, unknown>): ActivityStep => {
  const { args, profile } = takeProfile(opts);
  return activity("flociAzUp", args, profile ?? "longInfra");
};

/** Stop and remove the local floci-az container. Defaults to the `fastIdempotent` profile (override via `opts.profile`). */
export const flociAzDown = (opts?: Record<string, unknown>): ActivityStep => {
  const { args, profile } = takeProfile(opts);
  return activity("flociAzDown", args, profile ?? "fastIdempotent");
};

/**
 * Boot a local floci-gcp (GCP emulator) and return its `endpoint` — the typed
 * twin of {@link flociUp} for `gcpApply`, so the emulator lifecycle is a modeled
 * step, not a `docker run` shell. Provided by the gcp lexicon; loaded when the
 * project lists `gcp`. Idempotent; defaults to the `longInfra` profile. `opts`
 * accepts `name`, `port`, `image`, `timeoutMs`, `intervalMs`.
 */
export const flociGcpUp = (opts?: Record<string, unknown>): ActivityStep => {
  const { args, profile } = takeProfile(opts);
  return activity("flociGcpUp", args, profile ?? "longInfra");
};

/** Stop and remove the local floci-gcp container. Defaults to the `fastIdempotent` profile (override via `opts.profile`). */
export const flociGcpDown = (opts?: Record<string, unknown>): ActivityStep => {
  const { args, profile } = takeProfile(opts);
  return activity("flociGcpDown", args, profile ?? "fastIdempotent");
};

/**
 * Assert an HTTP endpoint responds as expected — a typed verify step replacing
 * `shell("curl -fs ...")`. Fails the phase if the status/body doesn't match.
 * Defaults to the `fastIdempotent` profile. `opts` accepts `method`, `status`
 * (default any 2xx), `contains` (body substring), `retries`, `intervalMs`.
 */
export const httpCheck = (url: string, opts?: Record<string, unknown>): ActivityStep => {
  const { args, profile } = takeProfile(opts);
  return activity("httpCheck", { url, ...args }, profile ?? "fastIdempotent");
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
 * `http://localhost:4577`), `subscriptionId`, and `prune` (owned-only prune of
 * chant-managed resources no longer in the template — destructive, off by default).
 */
export const azApply = (templatePath: string, opts?: Record<string, unknown>): ActivityStep => {
  const { args, profile } = takeProfile(opts);
  return activity("azApply", { templatePath, ...args }, profile ?? "longInfra");
};

/** Delete the Azure (ARM) resources in a built template — the inverse of {@link azApply}. Defaults to the `longInfra` profile (override via `opts.profile`). `opts` requires `resourceGroup`. */
export const azDelete = (templatePath: string, opts?: Record<string, unknown>): ActivityStep => {
  const { args, profile } = takeProfile(opts);
  return activity("azDelete", { templatePath, ...args }, profile ?? "longInfra");
};

/**
 * Deploy a built CloudFormation template by calling the CloudFormation API
 * directly (create-or-update + poll) — the direct twin of {@link azApply} /
 * {@link gcpApply} for AWS, targeting a local Floci emulator or real AWS by
 * endpoint override. Speaks the CFN API over HTTP rather than shelling `aws` —
 * `nativeApply({ target: "cloudformation" })` routes here too (#1449). Provided by
 * the aws lexicon; loaded when the project lists `aws`. Defaults to the
 * `longInfra` profile. `opts` requires `stackName`; accepts `endpoint`, `region`,
 * `capabilities`, `timeoutMs`, `intervalMs`.
 */
export const awsApply = (templatePath: string, opts?: Record<string, unknown>): ActivityStep => {
  const { args, profile } = takeProfile(opts);
  return activity("awsApply", { templatePath, ...args }, profile ?? "longInfra");
};

/** Delete a CloudFormation stack — the inverse of {@link awsApply}. Defaults to the `longInfra` profile (override via `opts.profile`). `opts` requires `stackName`. */
export const awsDelete = (templatePath: string, opts?: Record<string, unknown>): ActivityStep => {
  const { args, profile } = takeProfile(opts);
  return activity("awsDelete", { templatePath, ...args }, profile ?? "longInfra");
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

// ── Sprites (#762) — imperative, checkpointable sandbox steps ──────────────────
//
// The builder and the executor-side activity function share a name (e.g.
// `spriteCreate`), and that is intentional: the builder here returns an
// `activity("spriteCreate", ...)` step; `loadActivities` loads the function of
// the same name from the temporal lexicon to run the HTTP. They live in
// different modules and are both exported — exactly how `flapsUp`/`flapsDown`
// already work. Op files import these builders; the executor resolves the
// function by name. Endpoint override + bearer are read by the activity from
// `SPRITES_BASE_URL` / `SPRITES_API_TOKEN` (or an explicit `endpoint` arg).

/** Create a sprite with a caller-chosen `name` (used as its id). Defaults to the `longInfra` profile (override via `profile`). */
export const spriteCreate = (args: {
  name: string;
  image?: string;
  size?: string;
  policy?: unknown;
  endpoint?: string;
  token?: string;
  profile?: ActivityStep["profile"];
}): ActivityStep => {
  const { profile, ...rest } = args;
  return activity("spriteCreate", rest, profile ?? "longInfra");
};

/** Run a command in a sprite; a non-zero exit fails the step. Defaults to the `longInfra` profile (override via `profile`). */
export const spriteExec = (args: {
  id: string;
  cmd: string;
  timeoutMs?: number;
  endpoint?: string;
  token?: string;
  profile?: ActivityStep["profile"];
}): ActivityStep => {
  const { profile, ...rest } = args;
  return activity("spriteExec", rest, profile ?? "longInfra");
};

/** Checkpoint a sprite under a caller-chosen `comment` (the transactional boundary). Defaults to the `longInfra` profile (override via `profile`). */
export const spriteCheckpoint = (args: {
  id: string;
  comment?: string;
  endpoint?: string;
  token?: string;
  profile?: ActivityStep["profile"];
}): ActivityStep => {
  const { profile, ...rest } = args;
  return activity("spriteCheckpoint", rest, profile ?? "longInfra");
};

/**
 * Restore a sprite — the checkpoint-as-compensation step (S5). Target an
 * explicit `checkpoint` id, or the newest checkpoint carrying `comment`, or (with
 * neither) the newest checkpoint overall. Defaults to the `longInfra` profile
 * (override via `profile`).
 */
export const spriteRestore = (args: {
  id: string;
  checkpoint?: string;
  comment?: string;
  endpoint?: string;
  token?: string;
  profile?: ActivityStep["profile"];
}): ActivityStep => {
  const { profile, ...rest } = args;
  return activity("spriteRestore", rest, profile ?? "longInfra");
};

/** List a sprite's checkpoints (`[{ id, comment, create_time, is_auto }]`). Defaults to the `fastIdempotent` profile (override via `profile`). */
export const listCheckpoints = (args: {
  id: string;
  endpoint?: string;
  token?: string;
  profile?: ActivityStep["profile"];
}): ActivityStep => {
  const { profile, ...rest } = args;
  return activity("listCheckpoints", rest, profile ?? "fastIdempotent");
};

/** Destroy a sprite (idempotent). Defaults to the `fastIdempotent` profile (override via `profile`). */
export const spriteDestroy = (args: {
  id: string;
  endpoint?: string;
  token?: string;
  profile?: ActivityStep["profile"];
}): ActivityStep => {
  const { profile, ...rest } = args;
  return activity("spriteDestroy", rest, profile ?? "fastIdempotent");
};

// ── Sprite filesystem steps (#848) — stage inputs / read results without exec ──
//
// Same builder/activity split as the lifecycle steps above: these author
// `activity("spriteWriteFile", ...)` steps; `loadActivities(["fly"])` binds them
// to the implementations in fly's `op/activities/sprite-fs.ts`. All default to
// `fastIdempotent` — write/remove converge on the same end state under retry.

/** Write a file into a sprite. Defaults to the `fastIdempotent` profile (override via `profile`). */
export const spriteWriteFile = (args: {
  id: string;
  path: string;
  content: string;
  mode?: string;
  mkdir?: boolean;
  workingDir?: string;
  endpoint?: string;
  token?: string;
  profile?: ActivityStep["profile"];
}): ActivityStep => {
  const { profile, ...rest } = args;
  return activity("spriteWriteFile", rest, profile ?? "fastIdempotent");
};

/** Read a file from a sprite (returns `{ content }`). Defaults to the `fastIdempotent` profile (override via `profile`). */
export const spriteReadFile = (args: {
  id: string;
  path: string;
  workingDir?: string;
  endpoint?: string;
  token?: string;
  profile?: ActivityStep["profile"];
}): ActivityStep => {
  const { profile, ...rest } = args;
  return activity("spriteReadFile", rest, profile ?? "fastIdempotent");
};

/** List a directory in a sprite (returns `[{ name, type, size? }]`). Defaults to the `fastIdempotent` profile (override via `profile`). */
export const spriteListDir = (args: {
  id: string;
  path: string;
  workingDir?: string;
  endpoint?: string;
  token?: string;
  profile?: ActivityStep["profile"];
}): ActivityStep => {
  const { profile, ...rest } = args;
  return activity("spriteListDir", rest, profile ?? "fastIdempotent");
};

/** Remove a path in a sprite (idempotent). Defaults to the `fastIdempotent` profile (override via `profile`). */
export const spriteRemove = (args: {
  id: string;
  path: string;
  recursive?: boolean;
  asRoot?: boolean;
  workingDir?: string;
  endpoint?: string;
  token?: string;
  profile?: ActivityStep["profile"];
}): ActivityStep => {
  const { profile, ...rest } = args;
  return activity("spriteRemove", rest, profile ?? "fastIdempotent");
};

// ── Sprite config reconcile steps (#849) — desired-state on a live Sprite ──────
//
// Apply-activities, not a declarable resource: `spriteApplyNetworkPolicy`
// whole-object-replaces the outbound policy; `spriteApplyServices` create-or-
// updates each desired background service (optionally starting them in
// dependency order). Validation runs pure before any HTTP. `loadActivities(["fly"])`
// binds the impls in fly's `op/activities/sprite-config.ts`.

/** Reconcile a sprite's outbound network policy (whole-object replace). Defaults to the `fastIdempotent` profile (override via `profile`). */
export const spriteApplyNetworkPolicy = (args: {
  id: string;
  rules: Array<{ domain: string; action: "allow" | "deny" }>;
  endpoint?: string;
  token?: string;
  profile?: ActivityStep["profile"];
}): ActivityStep => {
  const { profile, ...rest } = args;
  return activity("spriteApplyNetworkPolicy", rest, profile ?? "fastIdempotent");
};

/** Reconcile a sprite's background services (create-or-update, optionally start). Defaults to the `fastIdempotent` profile (override via `profile`). */
export const spriteApplyServices = (args: {
  id: string;
  services: Array<{
    name: string;
    cmd: string;
    args?: string[];
    env?: Record<string, string>;
    dir?: string;
    needs?: string[];
    http_port?: number;
  }>;
  start?: boolean;
  endpoint?: string;
  token?: string;
  profile?: ActivityStep["profile"];
}): ActivityStep => {
  const { profile, ...rest } = args;
  return activity("spriteApplyServices", rest, profile ?? "fastIdempotent");
};

// ── Sprite keep-alive Task steps (#847) — hold a Sprite active for a session ──
//
// A hold stops the Sprite pausing while a session runs; release frees it. A
// session that can outlast the 1-hour task cap refreshes in its own loop.
// `loadActivities(["fly"])` binds the impls in fly's `op/activities/sprite-tasks.ts`.

/** Create a keep-alive task holding the sprite active. Defaults to the `fastIdempotent` profile (override via `profile`). */
export const spriteTaskCreate = (args: {
  id: string;
  name: string;
  expire?: number | string;
  endpoint?: string;
  token?: string;
  profile?: ActivityStep["profile"];
}): ActivityStep => {
  const { profile, ...rest } = args;
  return activity("spriteTaskCreate", rest, profile ?? "fastIdempotent");
};

/** Refresh a keep-alive task's expiry. Defaults to the `fastIdempotent` profile (override via `profile`). */
export const spriteTaskRefresh = (args: {
  id: string;
  name: string;
  expire?: number | string;
  endpoint?: string;
  token?: string;
  profile?: ActivityStep["profile"];
}): ActivityStep => {
  const { profile, ...rest } = args;
  return activity("spriteTaskRefresh", rest, profile ?? "fastIdempotent");
};

/** Release a keep-alive task (idempotent). Defaults to the `fastIdempotent` profile (override via `profile`). */
export const spriteTaskRelease = (args: {
  id: string;
  name: string;
  endpoint?: string;
  token?: string;
  profile?: ActivityStep["profile"];
}): ActivityStep => {
  const { profile, ...rest } = args;
  return activity("spriteTaskRelease", rest, profile ?? "fastIdempotent");
};

/**
 * Boot a local spritzer (Fly Sprites API emulator) in Docker — the typed twin of
 * `flociGcpUp` for Sprites. Resolves to the `spritesUp` activity. Defaults to the
 * `longInfra` profile (the image may pull); override via `profile`.
 */
export const spritesUp = (args: {
  name?: string;
  port?: number;
  image?: string;
  profile?: ActivityStep["profile"];
} = {}): ActivityStep => {
  const { profile, ...rest } = args;
  return activity("spritesUp", rest, profile ?? "longInfra");
};

/** Stop and remove the local spritzer container. Resolves to the `spritesDown` activity. Defaults to the `fastIdempotent` profile (override via `profile`). */
export const spritesDown = (args: {
  name?: string;
  profile?: ActivityStep["profile"];
} = {}): ActivityStep => {
  const { profile, ...rest } = args;
  return activity("spritesDown", rest, profile ?? "fastIdempotent");
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
