/**
 * host / code delivery family — run against a mutable host.
 *
 * `code-deploy` (AWS CodeDeploy) is the managed, nearly AWS-only leaf: create
 * a deployment of a revision (S3/GitHub) to a deployment group, appspec-driven
 * lifecycle hooks (BeforeInstall/AfterInstall/ApplicationStart/ValidateService),
 * in-place or blue/green, native automatic rollback, wait for terminal status.
 * Pairs with `publish-artifact` — the revision is the published S3 bundle
 * (`@publish.uri`).
 *
 * `copy-to-host` / `remote-exec` (SSM Run Command or SSH) are the portable,
 * lower-level generic verbs for host bootstrap, on-host migrations, and
 * single-host compose where CodeDeploy is not used or not available
 * (no clean Azure/GCP peer — see docs/components/cloud-boundary).
 *
 * `code-deploy` is a real implementation (#557, epic #551) over the
 * injectable `CloudExecutor` (./cloud-executor.ts) — the capability the
 * Neo4j fan-out pilot uses once per instance. `copy-to-host` and `remote-exec`
 * are also real, over the executor's `host.exec` (SSM Run Command, waited to
 * completion); the SSH transport is not yet implemented.
 */

import type { Capability } from "../capability";
import { defaultCloudExecutor, type CloudExecutor } from "./cloud-executor";

// ── code-deploy (AWS CodeDeploy) ─────────────────────────────────────────────

export interface CodeDeployInput {
  /** CodeDeploy application name. Default: derived from `ctx.component` when omitted (per-instance fan-out steps, e.g. the Neo4j pilot, don't repeat it per node). */
  application?: string;
  /** CodeDeploy deployment group name. Default: `<application>-<instance>` when `instance` is given, else `<application>`. */
  deploymentGroup?: string;
  /**
   * Revision location — an S3 bundle (typically `"@publish.uri"`), a GitHub
   * reference, or a bare wired string (e.g. `"@Seed.templateUri"`, as the
   * Neo4j pilot passes) treated as an S3 URI shorthand.
   */
  revision: { type: "s3"; uri: string } | { type: "github"; repository: string; commitId: string } | string;
  /** Deployment strategy. Default: "in-place". */
  strategy?: "in-place" | "blue-green";
  /** Cluster-relative instance index, for a per-instance fan-out step (e.g. one Neo4j node). Folded into the deployment group name when `deploymentGroup` is not given explicitly. */
  instance?: number;
}

export interface CodeDeployOutput {
  /** CodeDeploy deployment id, for polling terminal status. */
  deploymentId: string;
  /** Terminal deployment status once complete (`Succeeded`, `Failed`, `Stopped`). */
  status: string;
}

/** Normalize `CodeDeployInput.revision` to the strict `{type, uri|repository+commitId}` shape the executor takes. */
function normalizeRevision(revision: CodeDeployInput["revision"]): CodeDeployCreateArgsRevision {
  return typeof revision === "string" ? { type: "s3", uri: revision } : revision;
}

type CodeDeployCreateArgsRevision =
  | { type: "s3"; uri: string }
  | { type: "github"; repository: string; commitId: string };

/** Resolve the application/deployment-group names, defaulting from `ctx.component`/`instance` when the input omits them (matches the Neo4j pilot's per-instance shorthand). */
function resolveTargets(
  ctx: { component: string },
  input: CodeDeployInput,
): { application: string; deploymentGroup: string } {
  const application = input.application ?? ctx.component;
  const deploymentGroup =
    input.deploymentGroup ?? (input.instance !== undefined ? `${application}-${input.instance}` : application);
  return { application, deploymentGroup };
}

/**
 * Deploy a revision to a host (fleet) via AWS CodeDeploy: create the
 * deployment, then wait for a terminal status. Rollback re-invokes
 * `stopAndRollback` against the deployment id this step created (captured in
 * a closure-scoped map keyed by application/deploymentGroup, since the
 * driver's saga rollback calls `rollback(ctx, sameInput)` rather than passing
 * `run`'s output) — riding CodeDeploy's own native automatic rollback to the
 * last known-good revision rather than a chant-scripted compensation, the
 * "auto" rollback style the Neo4j pilot's docs comment contrasts with the
 * ALB/ECS pilot's component-declared one.
 */
export function createCodeDeployCapability(
  executor: CloudExecutor = defaultCloudExecutor(),
): Capability<CodeDeployInput, CodeDeployOutput> {
  const lastDeploymentByTarget = new Map<string, string>();

  return {
    kind: "code-deploy",
    async run(ctx, input) {
      const { application, deploymentGroup } = resolveTargets(ctx, input);
      const { deploymentId } = await executor.codeDeploy.createDeployment({
        application,
        deploymentGroup,
        revision: normalizeRevision(input.revision),
        strategy: input.strategy,
      });
      lastDeploymentByTarget.set(`${application}/${deploymentGroup}`, deploymentId);
      const { status } = await executor.codeDeploy.waitForDeployment(deploymentId);
      if (status !== "Succeeded") {
        throw new Error(`code-deploy "${application}/${deploymentGroup}": deployment ${deploymentId} ended ${status}`);
      }
      return { deploymentId, status };
    },
    async rollback(ctx, input) {
      const { application, deploymentGroup } = resolveTargets(ctx, input);
      const deploymentId = lastDeploymentByTarget.get(`${application}/${deploymentGroup}`);
      if (!deploymentId) return; // nothing this capability instance deployed for this target — nothing to unwind.
      await executor.codeDeploy.stopAndRollback(deploymentId);
    },
  };
}

/** Default `code-deploy` capability, backed by the real `CloudExecutor`. */
export const codeDeployCapability: Capability<CodeDeployInput, CodeDeployOutput> = createCodeDeployCapability();

// ── copy-to-host ─────────────────────────────────────────────────────────────

export interface CopyToHostInput {
  /** Source path (local, or archive-relative reference). */
  from: string;
  /** Target host (SSM instance id, hostname, or host group). */
  host: string;
  /** Destination path on the host. */
  to: string;
}

export interface CopyToHostOutput {
  /** Number of bytes copied. */
  bytesCopied: number;
}

/**
 * Copy a file to a host via SSM Run Command: the host pulls `from` (an S3 URI)
 * to `to` with `aws s3 cp`, then `stat`s the result for the byte count. `from`
 * must be reachable from the host (typically a prior `publish-artifact`'s URI).
 */
export function createCopyToHostCapability(executor: CloudExecutor = defaultCloudExecutor()): Capability<CopyToHostInput, CopyToHostOutput> {
  return {
    kind: "copy-to-host",
    async run(_ctx, input) {
      const { stdout } = await executor.host.exec({
        host: input.host,
        command: `aws s3 cp ${input.from} ${input.to} >/dev/null 2>&1 && stat -c %s ${input.to}`,
      });
      return { bytesCopied: Number.parseInt(stdout.trim(), 10) || 0 };
    },
  };
}

/** Default `copy-to-host` capability, backed by the real `CloudExecutor`. */
export const copyToHostCapability: Capability<CopyToHostInput, CopyToHostOutput> = createCopyToHostCapability();

// ── remote-exec ──────────────────────────────────────────────────────────────

export interface RemoteExecInput {
  /** Target host (SSM instance id, hostname, or host group). */
  host: string;
  /** Command to run on the host. */
  command: string;
  /** Working directory on the host. */
  cwd?: string;
  /** Transport. Default: "ssm". */
  via?: "ssm" | "ssh";
}

export interface RemoteExecOutput {
  /** Process exit code. */
  exitCode: number;
  /** Captured stdout. */
  stdout: string;
}

/**
 * Run a command on a remote host via SSM Run Command, waiting for it to finish
 * and returning its stdout + exit code. SSH transport is not yet supported.
 */
export function createRemoteExecCapability(executor: CloudExecutor = defaultCloudExecutor()): Capability<RemoteExecInput, RemoteExecOutput> {
  return {
    kind: "remote-exec",
    async run(_ctx, input) {
      if (input.via === "ssh") {
        throw new Error(`remote-exec: ssh transport not yet supported for host "${input.host}" — use the default ssm transport`);
      }
      return executor.host.exec({ host: input.host, command: input.command, cwd: input.cwd });
    },
  };
}

/** Default `remote-exec` capability, backed by the real `CloudExecutor`. */
export const remoteExecCapability: Capability<RemoteExecInput, RemoteExecOutput> = createRemoteExecCapability();
