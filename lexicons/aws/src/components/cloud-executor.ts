/**
 * Injectable cloud I/O boundary for the AWS-leaf capability implementations
 * (#557, epic #551), living in the aws lexicon so a project's cloud verbs are
 * contributed by its active lexicon rather than baked into core (see
 * docs/components/cloud-boundary). Every AWS-leaf capability here goes through
 * a `CloudExecutor` instead of shelling out directly, so:
 *
 *  - production code gets a real executor that shells out to the `aws` and
 *    `docker` CLIs (this codebase shells out to native CLIs rather than
 *    depending on AWS SDK v3 packages);
 *  - tests get a `MockCloudExecutor` (./__tests__/mock-cloud-executor.ts) that
 *    records calls and returns canned results — no live AWS, no live docker.
 *
 * The `docker` client is genuinely agnostic and shared: its type + real
 * implementation (`realDocker`) come from core; only the AWS-specific clients
 * (ECR, CloudFormation, ECS, CodeDeploy, Lambda, EMR, SSM host, S3, CloudFront,
 * snapshot) are defined here.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realDocker, type DockerClient } from "@intentius/chant/components/verbs/cloud-executor";
import { q } from "@intentius/chant/components/verbs/process-runner";

export type { DockerClient };

const execFileAsync = promisify(exec);

// ── ECR (registry auth/login only — push/pull go through docker) ──────────

export interface EcrClient {
  /** Authenticate the local docker client against a registry (`aws ecr get-login-password | docker login`). */
  login(registry: string): Promise<void>;
}

// ── CloudFormation ──────────────────────────────────────────────────────────

export interface CfnChange {
  action: "Add" | "Modify" | "Remove" | "Import" | "Dynamic";
  logicalResourceId: string;
  resourceType: string;
  /** True when CloudFormation must replace (destroy + recreate) this resource to apply the change. */
  replacement: boolean;
  /** Resource-specific detail, when the executor's changeset backend provides it (e.g. property/scope). */
  details?: string[];
}

export interface CfnChangeSet {
  changeSetName: string;
  stackName: string;
  status: string;
  /** True the first time this stack is created (no prior stack exists). */
  isCreate: boolean;
  changes: CfnChange[];
}

export interface CfnCreateChangeSetArgs {
  stackName: string;
  templatePath: string;
  parameters?: Record<string, string>;
}

export interface CfnExecuteChangeSetArgs {
  stackName: string;
  changeSetName: string;
}

export interface CfnStackStatus {
  stackStatus: string;
  outputs: Record<string, string>;
}

export interface CloudFormationClient {
  /** Create (but do not execute) a changeset, returning its proposed changes for preview/safety checks. */
  createChangeSet(args: CfnCreateChangeSetArgs): Promise<CfnChangeSet>;
  /** Execute a previously created changeset. */
  executeChangeSet(args: CfnExecuteChangeSetArgs): Promise<void>;
  /** Delete a changeset without executing it (used when a safety policy blocks the apply). */
  deleteChangeSet(args: CfnExecuteChangeSetArgs): Promise<void>;
  /** Poll a stack until it reaches a terminal status (`*_COMPLETE`/`*_FAILED`), returning final status + outputs. */
  waitForStack(stackName: string, opts?: { intervalMs?: number; timeoutMs?: number }): Promise<CfnStackStatus>;
  /** Current stack status + outputs, without waiting. */
  describeStack(stackName: string): Promise<CfnStackStatus>;
  /** Trigger CloudFormation's native rollback-to-last-known-good-state for a stack (saga compensation). */
  rollbackStack(stackName: string): Promise<void>;
}

// ── ECS ──────────────────────────────────────────────────────────────────��─

export interface EcsUpdateServiceArgs {
  cluster: string;
  service: string;
  taskDefinition?: string;
  desiredCount?: number;
  forceNewDeployment?: boolean;
}

export interface EcsServiceState {
  runningCount: number;
  desiredCount: number;
  /** True once `runningCount === desiredCount` and no deployments are in flight. */
  stable: boolean;
}

export interface EcsRunTaskArgs {
  cluster: string;
  /** Task definition family (`:revision` optional) to run. */
  taskDefinition: string;
  /** Container to apply the command override to. Defaults to the task def's single container when omitted. */
  container?: string;
  /** Command (argv) override — e.g. the migration runner's invocation. */
  command?: string[];
  /** Launch type. Default: "FARGATE". */
  launchType?: "FARGATE" | "EC2";
  /** awsvpc subnets (required for FARGATE). */
  subnets?: string[];
  /** awsvpc security groups. */
  securityGroups?: string[];
  /** Whether the task gets a public IP (needed for FARGATE tasks in a public subnet pulling images). Default: false. */
  assignPublicIp?: boolean;
}

export interface EcsRunTaskResult {
  /** Terminal task status (`STOPPED`). */
  lastStatus: string;
  /** Exit code of the (first) container, once the task has stopped; undefined if the container never started (e.g. image pull failure). */
  exitCode: number | undefined;
  /** Reason the task stopped, when it did not run to a clean container exit. */
  stoppedReason?: string;
}

export interface EcsClient {
  /** Roll a new task definition/desired count out to a service; returns the new deployment's id. */
  updateService(args: EcsUpdateServiceArgs): Promise<{ deploymentId: string }>;
  /** Current running/desired counts for a service, used by `wait-steady-state`. */
  describeService(cluster: string, service: string): Promise<EcsServiceState>;
  /** Roll a service back to a previously recorded task definition/count (saga compensation). */
  rollbackService(args: EcsUpdateServiceArgs): Promise<void>;
  /** Run a one-off task (e.g. a DB migration) and return its arn for `waitForTask`. */
  runTask(args: EcsRunTaskArgs): Promise<{ taskArn: string }>;
  /** Wait for a one-off task to stop, returning its terminal status and container exit code. */
  waitForTask(cluster: string, taskArn: string): Promise<EcsRunTaskResult>;
}

// ── CodeDeploy ──────────────────────────────────────────────────────────────

export interface CodeDeployCreateArgs {
  application: string;
  deploymentGroup: string;
  revision: { type: "s3"; uri: string } | { type: "github"; repository: string; commitId: string };
  strategy?: "in-place" | "blue-green";
}

export interface CodeDeployStatus {
  status: string;
  /** True for a terminal status (`Succeeded`, `Failed`, `Stopped`). */
  terminal: boolean;
}

export interface CodeDeployClient {
  /** Create a deployment of a revision to a deployment group; returns the deployment id. */
  createDeployment(args: CodeDeployCreateArgs): Promise<{ deploymentId: string }>;
  /** Poll a deployment until it reaches a terminal status. */
  waitForDeployment(deploymentId: string, opts?: { intervalMs?: number; timeoutMs?: number }): Promise<CodeDeployStatus>;
  /** Stop an in-flight deployment and roll the deployment group back to the last known-good revision (native auto-rollback, invoked as saga compensation). */
  stopAndRollback(deploymentId: string): Promise<void>;
}

// ── host (registry-less image delivery — #564's `load-image-on-host`) ──────

export interface HostCopyFileArgs {
  /** Target host (SSM instance id, hostname, or host group — same identifier space as `copy-to-host`/`remote-exec`). */
  host: string;
  /** Source path of the file to copy (typically an archive-relative image tarball path). */
  from: string;
  /** Destination path on the host. */
  to: string;
}

export interface HostDockerLoadArgs {
  /** Target host the tarball was copied to. */
  host: string;
  /** Path of the tarball on the host (matches `HostCopyFileArgs.to`). */
  path: string;
}

export interface HostClient {
  /** Copy a file (an image tarball from the build archive) onto a host, via SSM Run Command / SCP-over-SSH depending on config — the same transport `copy-to-host` documents. */
  copyFile(args: HostCopyFileArgs): Promise<void>;
  /** Run `docker load` on the host against a previously copied tarball; returns the digest `docker load` reports, straight into the host's local Docker store (no registry involved). */
  dockerLoad(args: HostDockerLoadArgs): Promise<{ digest: string }>;
  /** Run a shell command on a host via SSM Run Command, waiting for it to finish; returns captured stdout and exit code (rejects on a non-zero SSM invocation). */
  exec(args: { host: string; command: string; cwd?: string }): Promise<{ stdout: string; exitCode: number }>;
}

// ── Lambda (#558's one new capability: lambda-deploy) ───────────────────────

export interface LambdaUpdateCodeArgs {
  functionName: string;
  /** Container image URI (registry/repo@sha256:...) for an image-package Lambda. */
  imageUri: string;
}

export interface LambdaPublishVersionArgs {
  functionName: string;
}

export interface LambdaUpdateAliasArgs {
  functionName: string;
  alias: string;
  version: string;
}

export interface LambdaClient {
  /** Point the function at a new container image; returns the function ARN (unqualified). */
  updateFunctionCode(args: LambdaUpdateCodeArgs): Promise<{ functionArn: string }>;
  /** Wait for the function's last update to finish applying (`Successful`/`Failed`). */
  waitForUpdate(functionName: string): Promise<{ status: string }>;
  /** Publish an immutable numbered version from the function's current `$LATEST`. */
  publishVersion(args: LambdaPublishVersionArgs): Promise<{ version: string; functionArn: string }>;
  /** Repoint a named alias at a published version (e.g. "live" -> "42"). */
  updateAlias(args: LambdaUpdateAliasArgs): Promise<{ aliasArn: string }>;
  /** Current published version an alias points at, so rollback can restore it. */
  getAliasVersion(functionName: string, alias: string): Promise<string | undefined>;
  /** Synchronously invoke a function (e.g. a migration runner) with an optional JSON payload; returns the status code, response payload text, and any function error. */
  invoke(args: { functionName: string; payload?: string }): Promise<{ statusCode: number; payload: string; functionError?: string }>;
}

// ── EMR (job submission — #561's one new client) ─────────────────────────────

export interface EmrStartJobRunArgs {
  /** EMR Serverless application id, or EMR-on-EC2 cluster id. */
  clusterOrApplicationId: string;
  /** Entry point artifact reference (resolved by the graph before this executor is called, e.g. an S3 URI). */
  jar: string;
  args?: string[];
  executionRoleArn?: string;
}

export interface EmrJobRunStatus {
  /** Terminal job state (`COMPLETED`, `FAILED`, `CANCELLED`), or an in-flight state (`RUNNING`, `PENDING`) while polling. */
  state: string;
}

export interface EmrAddStepArgs {
  /** EMR-on-EC2 cluster id to submit the step to. */
  clusterId: string;
  /** Step name (shown in the EMR console). */
  name: string;
  /** Jar the step runs — an S3 jar, or `command-runner.jar` with a `spark-submit …` arg list. */
  jar: string;
  args?: string[];
  /** What EMR does if the step fails. Default: "CONTINUE". */
  actionOnFailure?: "CONTINUE" | "CANCEL_AND_WAIT" | "TERMINATE_CLUSTER";
}

export interface EmrClient {
  /** Start a job run (EMR Serverless application or EMR-on-EC2 cluster) against a published artifact; returns the run id for polling. */
  startJobRun(args: EmrStartJobRunArgs): Promise<{ runId: string }>;
  /** Submit a step to a long-running EMR-on-EC2 cluster; returns the step id for polling. */
  addStep(args: EmrAddStepArgs): Promise<{ stepId: string }>;
  /** Poll a job run until it reaches a terminal state (`COMPLETED`/`FAILED`/`CANCELLED`). */
  waitForJobRun(runId: string, opts?: { intervalMs?: number; timeoutMs?: number }): Promise<EmrJobRunStatus>;
  /** Current state of a job run, without waiting. */
  describeJobRun(runId: string): Promise<EmrJobRunStatus>;
  /** Cancel an in-flight job run (saga compensation). */
  cancelJobRun(runId: string): Promise<void>;
}

// ── The aggregate executor ───────────────────────────────────────────────────

/**
 * The full injectable cloud I/O surface the AWS-leaf capabilities depend on.
 * A capability module never imports `node:child_process`/an AWS SDK/`net`
 * directly — it takes a `CloudExecutor` (defaulted to `realCloudExecutor()`
 * at module scope, overridable via each capability family's
 * `create*Capability(executor)` factory) so tests can swap in a full mock.
 */
// ── S3 / CloudFront (deploy-time asset sync + CDN invalidation) ───────────────

export interface S3SyncArgs {
  from: string;
  to: string;
  /** Delete destination keys not present in the source. */
  delete?: boolean;
}

export interface S3Client {
  /** `aws s3 sync from to [--delete]`; returns how many objects were uploaded/deleted. */
  sync(args: S3SyncArgs): Promise<{ uploaded: number; deleted: number }>;
  /** `aws s3 cp from to` — upload a single local file to an S3 URI. */
  cp(args: { from: string; to: string }): Promise<void>;
}

export interface CloudFrontInvalidateArgs {
  distributionId: string;
  paths: string[];
}

export interface CloudFrontClient {
  /** `aws cloudfront create-invalidation`; returns the invalidation batch id. */
  createInvalidation(args: CloudFrontInvalidateArgs): Promise<{ invalidationId: string }>;
}

// ── Snapshot (safety family: on-demand backup before a sticky apply) ──────────

export type SnapshotResourceKind = "dynamodb-table" | "rds-instance" | "opensearch-domain" | "ebs-volume";

export interface SnapshotClient {
  /** Take an on-demand snapshot/backup of a resource, dispatched by kind; returns the backup/snapshot identifier `rollback-previous` restores from. */
  create(args: { resource: string; resourceKind: SnapshotResourceKind }): Promise<{ snapshotId: string }>;
  /** Restore a resource from a prior snapshot/backup, dispatched by the snapshot-id shape (DynamoDB/RDS ARN); waits for the restore to become available. */
  restore(args: { resource: string; snapshotId: string }): Promise<void>;
}

export interface CloudExecutor {
  docker: DockerClient;
  ecr: EcrClient;
  cloudformation: CloudFormationClient;
  ecs: EcsClient;
  codeDeploy: CodeDeployClient;
  lambda: LambdaClient;
  emr: EmrClient;
  host: HostClient;
  s3: S3Client;
  cloudfront: CloudFrontClient;
  snapshot: SnapshotClient;
}

// ── Real executor — shells out to `docker`/`aws`; used outside tests ────────

/**
 * Inject `--endpoint-url` into an `aws …` command when an endpoint is set, so the
 * same component can target a local AWS emulator (Floci, LocalStack, …) or any
 * custom endpoint without a wrapper. We add the flag ourselves rather than rely
 * on the CLI reading `AWS_ENDPOINT_URL` — older `aws` v2 releases (<2.13) don't.
 * Non-`aws` commands (docker, …) pass through untouched.
 */
export function applyAwsEndpoint(command: string, endpoint: string | undefined): string {
  if (!endpoint || !/^aws\s/.test(command)) return command;
  return command.replace(/^aws\s/, `aws --endpoint-url ${q(endpoint)} `);
}

function run(command: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(applyAwsEndpoint(command, process.env.AWS_ENDPOINT_URL), {
    maxBuffer: 64 * 1024 * 1024,
  });
}

const realEcr: EcrClient = {
  async login(registry) {
    await run(`aws ecr get-login-password | docker login --username AWS --password-stdin ${q(registry)}`);
  },
};

/** CREATE for a stack that doesn't exist (or is stuck in REVIEW_IN_PROGRESS from a prior unexecuted CREATE), else UPDATE. */
async function cfnChangeSetType(stackName: string): Promise<"CREATE" | "UPDATE"> {
  try {
    const { stdout } = await run(`aws cloudformation describe-stacks --stack-name ${q(stackName)}`);
    const status = (JSON.parse(stdout) as { Stacks?: Array<{ StackStatus?: string }> }).Stacks?.[0]?.StackStatus;
    return status === "REVIEW_IN_PROGRESS" ? "CREATE" : "UPDATE";
  } catch {
    return "CREATE"; // describe-stacks errors when the stack doesn't exist
  }
}

const realCloudFormation: CloudFormationClient = {
  async createChangeSet(args) {
    const changeSetName = `cs-${Date.now()}`;
    const params = Object.entries(args.parameters ?? {})
      .map(([k, v]) => `ParameterKey=${k},ParameterValue=${v}`)
      .join(" ");
    const paramFlag = params ? ` --parameters ${params}` : "";
    // A change set defaults to type UPDATE, which fails on a stack that doesn't
    // exist yet ("Stack ... does not exist"). Pick CREATE for a new stack, and
    // for one still in REVIEW_IN_PROGRESS (a prior CREATE change set never
    // executed), mirroring what `aws cloudformation deploy` does under the hood.
    const changeSetType = await cfnChangeSetType(args.stackName);
    await run(
      `aws cloudformation create-change-set --stack-name ${q(args.stackName)} --change-set-name ${q(changeSetName)} ` +
        `--change-set-type ${changeSetType} ` +
        `--template-body file://${args.templatePath} --capabilities CAPABILITY_NAMED_IAM${paramFlag}`,
    );
    await run(
      `aws cloudformation wait change-set-create-complete --stack-name ${q(args.stackName)} --change-set-name ${q(changeSetName)}`,
    ).catch(() => undefined); // "no changes" also lands here; describe below reports the real status.
    const { stdout } = await run(
      `aws cloudformation describe-change-set --stack-name ${q(args.stackName)} --change-set-name ${q(changeSetName)}`,
    );
    const described = JSON.parse(stdout) as {
      Status: string;
      Changes?: Array<{
        ResourceChange: {
          Action: string;
          LogicalResourceId: string;
          ResourceType: string;
          Replacement?: string;
          Details?: Array<{ Target?: { Name?: string } }>;
        };
      }>;
    };
    return {
      changeSetName,
      stackName: args.stackName,
      status: described.Status,
      isCreate: described.Status === "CREATE_COMPLETE" && !described.Changes?.length,
      changes: (described.Changes ?? []).map((c) => ({
        action: c.ResourceChange.Action as CfnChange["action"],
        logicalResourceId: c.ResourceChange.LogicalResourceId,
        resourceType: c.ResourceChange.ResourceType,
        replacement: c.ResourceChange.Replacement === "True",
        details: c.ResourceChange.Details?.map((d) => d.Target?.Name).filter((x): x is string => !!x),
      })),
    };
  },
  async executeChangeSet(args) {
    await run(
      `aws cloudformation execute-change-set --stack-name ${q(args.stackName)} --change-set-name ${q(args.changeSetName)}`,
    );
  },
  async deleteChangeSet(args) {
    await run(
      `aws cloudformation delete-change-set --stack-name ${q(args.stackName)} --change-set-name ${q(args.changeSetName)}`,
    );
  },
  async describeStack(stackName) {
    const { stdout } = await run(`aws cloudformation describe-stacks --stack-name ${q(stackName)}`);
    const described = JSON.parse(stdout) as {
      Stacks: Array<{ StackStatus: string; Outputs?: Array<{ OutputKey: string; OutputValue: string }> }>;
    };
    const stack = described.Stacks[0];
    const outputs: Record<string, string> = {};
    for (const o of stack?.Outputs ?? []) outputs[o.OutputKey] = o.OutputValue;
    return { stackStatus: stack?.StackStatus ?? "UNKNOWN", outputs };
  },
  async waitForStack(stackName, opts) {
    const intervalMs = opts?.intervalMs ?? 10_000;
    const deadline = opts?.timeoutMs ? Date.now() + opts.timeoutMs : undefined;
    while (true) {
      const status = await realCloudFormation.describeStack(stackName);
      if (!status.stackStatus.endsWith("_IN_PROGRESS")) return status;
      if (deadline && Date.now() > deadline) throw new Error(`waitForStack "${stackName}" timed out`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  },
  async rollbackStack(stackName) {
    await run(`aws cloudformation rollback-stack --stack-name ${q(stackName)}`);
  },
};

const realEcs: EcsClient = {
  async updateService(args) {
    const parts = [`aws ecs update-service`, `--cluster ${q(args.cluster)}`, `--service ${q(args.service)}`];
    if (args.taskDefinition) parts.push(`--task-definition ${q(args.taskDefinition)}`);
    if (args.desiredCount !== undefined) parts.push(`--desired-count ${args.desiredCount}`);
    if (args.forceNewDeployment) parts.push(`--force-new-deployment`);
    const { stdout } = await run(parts.join(" "));
    const described = JSON.parse(stdout) as { service: { deployments: Array<{ id: string }> } };
    return { deploymentId: described.service.deployments[0]?.id ?? "" };
  },
  async describeService(cluster, service) {
    const { stdout } = await run(
      `aws ecs describe-services --cluster ${q(cluster)} --services ${q(service)}`,
    );
    const described = JSON.parse(stdout) as {
      services: Array<{ runningCount: number; desiredCount: number; deployments: unknown[] }>;
    };
    const svc = described.services[0];
    const running = svc?.runningCount ?? 0;
    const desired = svc?.desiredCount ?? 0;
    return { runningCount: running, desiredCount: desired, stable: running === desired && (svc?.deployments.length ?? 0) <= 1 };
  },
  async rollbackService(args) {
    await realEcs.updateService(args);
  },
  async runTask(args) {
    const parts = [
      `aws ecs run-task`,
      `--cluster ${q(args.cluster)}`,
      `--task-definition ${q(args.taskDefinition)}`,
      `--launch-type ${args.launchType ?? "FARGATE"}`,
    ];
    if (args.subnets?.length) {
      const net = {
        awsvpcConfiguration: {
          subnets: args.subnets,
          securityGroups: args.securityGroups ?? [],
          assignPublicIp: args.assignPublicIp ? "ENABLED" : "DISABLED",
        },
      };
      parts.push(`--network-configuration ${q(JSON.stringify(net))}`);
    }
    if (args.command?.length) {
      const overrides = { containerOverrides: [{ name: args.container ?? "", command: args.command }] };
      parts.push(`--overrides ${q(JSON.stringify(overrides))}`);
    }
    const { stdout } = await run(parts.join(" "));
    const described = JSON.parse(stdout) as { tasks: Array<{ taskArn: string }>; failures?: Array<{ reason: string }> };
    const taskArn = described.tasks[0]?.taskArn;
    if (!taskArn) throw new Error(`ecs run-task on "${args.cluster}" started no task: ${JSON.stringify(described.failures ?? [])}`);
    return { taskArn };
  },
  async waitForTask(cluster, taskArn) {
    await run(`aws ecs wait tasks-stopped --cluster ${q(cluster)} --tasks ${q(taskArn)}`);
    const { stdout } = await run(`aws ecs describe-tasks --cluster ${q(cluster)} --tasks ${q(taskArn)}`);
    const described = JSON.parse(stdout) as {
      tasks: Array<{ lastStatus: string; stoppedReason?: string; containers: Array<{ exitCode?: number }> }>;
    };
    const task = described.tasks[0];
    return {
      lastStatus: task?.lastStatus ?? "UNKNOWN",
      exitCode: task?.containers?.[0]?.exitCode,
      ...(task?.stoppedReason ? { stoppedReason: task.stoppedReason } : {}),
    };
  },
};

const realCodeDeploy: CodeDeployClient = {
  async createDeployment(args) {
    const revisionFlag =
      args.revision.type === "s3"
        ? `--s3-location bundleType=zip,bucket=${q(args.revision.uri.replace("s3://", "").split("/")[0])},key=${q(
            args.revision.uri.replace("s3://", "").split("/").slice(1).join("/"),
          )}`
        : `--github-location repository=${q(args.revision.repository)},commitId=${q(args.revision.commitId)}`;
    const { stdout } = await run(
      `aws deploy create-deployment --application-name ${q(args.application)} ` +
        `--deployment-group-name ${q(args.deploymentGroup)} --revision revisionType=${
          args.revision.type === "s3" ? "S3" : "GitHub"
        },${revisionFlag}`,
    );
    const described = JSON.parse(stdout) as { deploymentId: string };
    return { deploymentId: described.deploymentId };
  },
  async waitForDeployment(deploymentId, opts) {
    const intervalMs = opts?.intervalMs ?? 10_000;
    const deadline = opts?.timeoutMs ? Date.now() + opts.timeoutMs : undefined;
    while (true) {
      const { stdout } = await run(`aws deploy get-deployment --deployment-id ${q(deploymentId)}`);
      const described = JSON.parse(stdout) as { deploymentInfo: { status: string } };
      const status = described.deploymentInfo.status;
      if (["Succeeded", "Failed", "Stopped"].includes(status)) return { status, terminal: true };
      if (deadline && Date.now() > deadline) throw new Error(`waitForDeployment "${deploymentId}" timed out`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  },
  async stopAndRollback(deploymentId) {
    // CodeDeploy's native auto-rollback-on-failure already reverts to the last
    // known-good revision when a deployment fails; explicitly stopping with
    // rollback covers the case where the caller is compensating a deployment
    // that is still in flight.
    await run(`aws deploy stop-deployment --deployment-id ${q(deploymentId)} --auto-rollback-enabled`);
  },
};

const realHost: HostClient = {
  async copyFile(args) {
    // SSM Run Command, per the same transport `copy-to-host` documents: stage
    // the tarball via an S3 hop (`aws s3 cp` then a remote `aws s3 cp` inside
    // the command document) is the common pattern for files too large for an
    // inline SSM document; kept to a single conceptual step here since the
    // executor boundary is what tests substitute, not this shell recipe.
    await run(
      `aws ssm send-command --instance-ids ${q(args.host)} --document-name AWS-RunShellScript ` +
        `--parameters ${q(JSON.stringify({ commands: [`aws s3 cp ${args.from} ${args.to}`] }))}`,
    );
  },
  async dockerLoad(args) {
    const { stdout } = await run(
      `aws ssm send-command --instance-ids ${q(args.host)} --document-name AWS-RunShellScript ` +
        `--parameters ${q(JSON.stringify({ commands: [`docker load -i ${args.path}`] }))}`,
    );
    const match = stdout.match(/[Ll]oaded image(?: ID)?:\s*(\S+)/);
    return { digest: match?.[1] ?? stdout.trim() };
  },
  async exec(args) {
    const command = args.cwd ? `cd ${args.cwd} && ${args.command}` : args.command;
    const { stdout: idOut } = await run(
      `aws ssm send-command --instance-ids ${q(args.host)} --document-name AWS-RunShellScript ` +
        `--parameters ${q(JSON.stringify({ commands: [command] }))} --query 'Command.CommandId' --output text`,
    );
    const commandId = idOut.trim();
    for (;;) {
      await sleep(2000);
      const { stdout } = await run(
        `aws ssm get-command-invocation --command-id ${q(commandId)} --instance-id ${q(args.host)} --output json`,
      ).catch(() => ({ stdout: "" }));
      if (!stdout) continue; // invocation not registered yet
      const inv = JSON.parse(stdout) as { Status: string; ResponseCode?: number; StandardOutputContent?: string; StandardErrorContent?: string };
      if (["Success", "Failed", "Cancelled", "TimedOut"].includes(inv.Status)) {
        if (inv.Status !== "Success") {
          throw new Error(`remote-exec on ${args.host} ${inv.Status}: ${inv.StandardErrorContent?.trim() ?? ""}`);
        }
        return { stdout: inv.StandardOutputContent ?? "", exitCode: inv.ResponseCode ?? 0 };
      }
    }
  },
};

const realLambda: LambdaClient = {
  async updateFunctionCode(args) {
    const { stdout } = await run(
      `aws lambda update-function-code --function-name ${q(args.functionName)} --image-uri ${q(args.imageUri)}`,
    );
    const described = JSON.parse(stdout) as { FunctionArn: string };
    return { functionArn: described.FunctionArn };
  },
  async waitForUpdate(functionName) {
    await run(`aws lambda wait function-updated-v2 --function-name ${q(functionName)}`);
    const { stdout } = await run(`aws lambda get-function --function-name ${q(functionName)}`);
    const described = JSON.parse(stdout) as { Configuration: { LastUpdateStatus: string } };
    return { status: described.Configuration.LastUpdateStatus };
  },
  async publishVersion(args) {
    const { stdout } = await run(`aws lambda publish-version --function-name ${q(args.functionName)}`);
    const described = JSON.parse(stdout) as { Version: string; FunctionArn: string };
    return { version: described.Version, functionArn: described.FunctionArn };
  },
  async updateAlias(args) {
    const { stdout } = await run(
      `aws lambda update-alias --function-name ${q(args.functionName)} --name ${q(args.alias)} --function-version ${q(args.version)}`,
    );
    const described = JSON.parse(stdout) as { AliasArn: string };
    return { aliasArn: described.AliasArn };
  },
  async getAliasVersion(functionName, alias) {
    try {
      const { stdout } = await run(`aws lambda get-alias --function-name ${q(functionName)} --name ${q(alias)}`);
      const described = JSON.parse(stdout) as { FunctionVersion: string };
      return described.FunctionVersion;
    } catch {
      return undefined; // alias does not exist yet (first deploy) — nothing to restore on rollback.
    }
  },
  async invoke(args) {
    // `aws lambda invoke` writes the response payload to a file arg and its
    // metadata (StatusCode/FunctionError) to stdout, so use a throwaway temp
    // dir for both the request payload (fileb:// — raw bytes, version-agnostic)
    // and the response, and clean it up regardless of outcome.
    const dir = mkdtempSync(join(tmpdir(), "chant-lambda-"));
    const outFile = join(dir, "response.json");
    try {
      let payloadFlag = "";
      if (args.payload !== undefined) {
        const payloadFile = join(dir, "payload.json");
        writeFileSync(payloadFile, args.payload);
        payloadFlag = ` --payload fileb://${payloadFile}`;
      }
      const { stdout } = await run(
        `aws lambda invoke --function-name ${q(args.functionName)}${payloadFlag} ${q(outFile)}`,
      );
      const meta = JSON.parse(stdout) as { StatusCode: number; FunctionError?: string };
      return {
        statusCode: meta.StatusCode,
        payload: readFileSync(outFile, "utf8"),
        ...(meta.FunctionError ? { functionError: meta.FunctionError } : {}),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

const realEmr: EmrClient = {
  async startJobRun(args) {
    const parts = [
      `aws emr-serverless start-job-run`,
      `--application-id ${q(args.clusterOrApplicationId)}`,
      `--execution-role-arn ${q(args.executionRoleArn ?? "")}`,
      `--job-driver ${q(JSON.stringify({ sparkSubmit: { entryPoint: args.jar, entryPointArguments: args.args ?? [] } }))}`,
    ];
    const { stdout } = await run(parts.join(" "));
    const described = JSON.parse(stdout) as { jobRunId: string };
    return { runId: described.jobRunId };
  },
  async addStep(args) {
    const step = {
      Name: args.name,
      ActionOnFailure: args.actionOnFailure ?? "CONTINUE",
      HadoopJarStep: { Jar: args.jar, Args: args.args ?? [] },
    };
    const { stdout } = await run(
      `aws emr add-steps --cluster-id ${q(args.clusterId)} --steps ${q(JSON.stringify([step]))}`,
    );
    const described = JSON.parse(stdout) as { StepIds: string[] };
    const stepId = described.StepIds?.[0];
    if (!stepId) throw new Error(`emr add-steps on "${args.clusterId}" returned no step id`);
    return { stepId };
  },
  async describeJobRun(runId) {
    const { stdout } = await run(`aws emr-serverless get-job-run --job-run-id ${q(runId)}`);
    const described = JSON.parse(stdout) as { jobRun: { state: string } };
    return { state: described.jobRun.state };
  },
  async waitForJobRun(runId, opts) {
    const intervalMs = opts?.intervalMs ?? 10_000;
    const deadline = opts?.timeoutMs ? Date.now() + opts.timeoutMs : undefined;
    const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
    while (true) {
      const status = await realEmr.describeJobRun(runId);
      if (terminal.has(status.state)) return status;
      if (deadline && Date.now() > deadline) throw new Error(`waitForJobRun "${runId}" timed out`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  },
  async cancelJobRun(runId) {
    await run(`aws emr-serverless cancel-job-run --job-run-id ${q(runId)}`);
  },
};


const realS3: S3Client = {
  async sync(args) {
    const flags = args.delete ? " --delete" : "";
    const { stdout } = await run(`aws s3 sync ${q(args.from)} ${q(args.to)}${flags} --no-progress`);
    // `aws s3 sync` prints one `upload: …` / `delete: …` line per object touched.
    const count = (re: RegExp) => stdout.split("\n").filter((l) => re.test(l)).length;
    return { uploaded: count(/^upload:/), deleted: count(/^delete:/) };
  },
  async cp(args) {
    await run(`aws s3 cp ${q(args.from)} ${q(args.to)} --no-progress`);
  },
};

const realCloudFront: CloudFrontClient = {
  async createInvalidation(args) {
    const paths = args.paths.map(q).join(" ");
    const { stdout } = await run(
      `aws cloudfront create-invalidation --distribution-id ${q(args.distributionId)} --paths ${paths}`,
    );
    const id = (JSON.parse(stdout) as { Invalidation?: { Id?: string } }).Invalidation?.Id;
    return { invalidationId: id ?? "" };
  },
};

const realSnapshot: SnapshotClient = {
  async create({ resource, resourceKind }) {
    const id = `${resource}-${Date.now()}`;
    switch (resourceKind) {
      case "dynamodb-table": {
        const { stdout } = await run(
          `aws dynamodb create-backup --table-name ${q(resource)} --backup-name ${q(id)} --query 'BackupDetails.BackupArn' --output text`,
        );
        return { snapshotId: stdout.trim() };
      }
      case "rds-instance": {
        const { stdout } = await run(
          `aws rds create-db-snapshot --db-instance-identifier ${q(resource)} --db-snapshot-identifier ${q(id)} --query 'DBSnapshot.DBSnapshotArn' --output text`,
        );
        return { snapshotId: stdout.trim() };
      }
      case "ebs-volume": {
        const { stdout } = await run(
          `aws ec2 create-snapshot --volume-id ${q(resource)} --description ${q(`chant snapshot-before ${id}`)} --query 'SnapshotId' --output text`,
        );
        return { snapshotId: stdout.trim() };
      }
      case "opensearch-domain":
        // OpenSearch manual snapshots require a pre-registered S3 repository + a
        // signed _snapshot REST call, not a one-shot CLI verb — out of scope here.
        throw new Error(
          `snapshot-before: opensearch-domain needs a registered S3 snapshot repository; not yet supported (resource "${resource}")`,
        );
    }
  },
  async restore({ resource, snapshotId }) {
    // Dispatch by the snapshot-id shape produced by `create` above.
    if (snapshotId.includes(":dynamodb:") || snapshotId.includes("/backup/")) {
      await run(`aws dynamodb restore-table-from-backup --target-table-name ${q(resource)} --backup-arn ${q(snapshotId)}`);
      await run(`aws dynamodb wait table-exists --table-name ${q(resource)}`);
      return;
    }
    if (snapshotId.includes(":rds:") || snapshotId.startsWith("rds:")) {
      await run(`aws rds restore-db-instance-from-db-snapshot --db-instance-identifier ${q(resource)} --db-snapshot-identifier ${q(snapshotId)}`);
      await run(`aws rds wait db-instance-available --db-instance-identifier ${q(resource)}`);
      return;
    }
    throw new Error(`rollback-previous: cannot infer the restore mechanism from snapshot id "${snapshotId}" (expected a DynamoDB or RDS backup ARN)`);
  },
};

/** Build a `CloudExecutor` that shells out to real `docker`/`aws` CLIs and probes real bolt ports. Never used in tests. */
export function realCloudExecutor(): CloudExecutor {
  return {
    docker: realDocker,
    ecr: realEcr,
    cloudformation: realCloudFormation,
    ecs: realEcs,
    codeDeploy: realCodeDeploy,
    lambda: realLambda,
    emr: realEmr,
    host: realHost,
    s3: realS3,
    cloudfront: realCloudFront,
    snapshot: realSnapshot,
  };
}

/** Lazily-constructed process-wide default so importing a capability module never shells out at import time. */
let defaultExecutor: CloudExecutor | undefined;

/** The default `CloudExecutor` each capability factory falls back to when none is supplied. */
export function defaultCloudExecutor(): CloudExecutor {
  if (!defaultExecutor) defaultExecutor = realCloudExecutor();
  return defaultExecutor;
}

/** Sleep for `ms`. Shared by every polling capability (`wait-*`) between attempts. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
