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
 * Typed stubs only; see ../capability.ts for the "no cloud implementation yet" contract.
 */

import type { Capability } from "../capability";
import { stubCapability } from "./stub";

// ── code-deploy (AWS CodeDeploy) ─────────────────────────────────────────────

export interface CodeDeployInput {
  /** CodeDeploy application name. */
  application: string;
  /** CodeDeploy deployment group name. */
  deploymentGroup: string;
  /** Revision location — an S3 bundle (typically `"@publish.uri"`) or a GitHub reference. */
  revision: { type: "s3"; uri: string } | { type: "github"; repository: string; commitId: string };
  /** Deployment strategy. Default: "in-place". */
  strategy?: "in-place" | "blue-green";
}

export interface CodeDeployOutput {
  /** CodeDeploy deployment id, for polling terminal status. */
  deploymentId: string;
  /** Terminal deployment status once complete (`Succeeded`, `Failed`, `Stopped`). */
  status: string;
}

/** Deploy a revision to a host fleet via AWS CodeDeploy (appspec lifecycle hooks, native rollback). */
export const codeDeploy: Capability<CodeDeployInput, CodeDeployOutput> = stubCapability(
  "code-deploy",
  { rollback: true },
);

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

/** Copy a file/archive to a host, via SSM or SSH depending on config. Cloud-agnostic. */
export const copyToHost: Capability<CopyToHostInput, CopyToHostOutput> =
  stubCapability("copy-to-host");

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

/** Run a command on a remote host via SSM Run Command or SSH. Cloud-agnostic. */
export const remoteExec: Capability<RemoteExecInput, RemoteExecOutput> =
  stubCapability("remote-exec");
