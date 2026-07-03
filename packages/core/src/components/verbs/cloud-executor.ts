/**
 * Injectable cloud I/O boundary for the AWS-leaf capability implementations
 * (#557, epic #551). Every capability in this directory that talks to a real
 * cloud (docker, ECR, CloudFormation, ECS, CodeDeploy, a Neo4j bolt port) goes
 * through a `CloudExecutor` instead of shelling out or calling an SDK
 * directly, so:
 *
 *  - production code gets a `RealCloudExecutor` that shells out to the `aws`
 *    and `docker` CLIs (matching the existing convention in
 *    `@intentius/chant-lexicon-temporal`'s `op/activities/apply.ts` — this
 *    codebase shells out to native CLIs rather than depending on AWS SDK v3
 *    packages, which are not a dependency of this package);
 *  - tests get a `MockCloudExecutor` (./__tests__/mock-cloud-executor.ts) that
 *    records calls and returns canned results — no live AWS, no live docker,
 *    ever, in a test run.
 *
 * Every method is namespaced by service (`docker`, `ecr`, `cloudformation`,
 * `ecs`, `codeDeploy`, `neo4j`) and typed to the minimum surface the
 * capabilities in this directory need — not a general-purpose AWS SDK
 * replacement.
 */

import { exec } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(exec);

// ── docker ────────────────────────────────────────────────────────────────

export interface DockerBuildArgs {
  context: string;
  dockerfile?: string;
  buildArgs?: Record<string, string>;
  target?: string;
  /** Tag applied to the built image so it can be referenced by name (e.g. saved to a tarball). */
  tag: string;
}

export interface DockerSaveArgs {
  /** Image reference to save (tag or digest). */
  image: string;
  /** Destination tarball path. */
  outFile: string;
}

export interface DockerLoadArgs {
  /** Tarball path to load. */
  inFile: string;
}

export interface DockerTagArgs {
  source: string;
  target: string;
}

export interface DockerPushArgs {
  /** Fully qualified image reference to push (registry/repo:tag). */
  image: string;
}

export interface DockerClient {
  /** Build an image from a Dockerfile; returns the built image's content digest. */
  build(args: DockerBuildArgs): Promise<{ digest: string }>;
  /** Save an image to an OCI/tarball archive on disk. */
  save(args: DockerSaveArgs): Promise<void>;
  /** Load an image tarball into the local docker store; returns the loaded image's digest. */
  load(args: DockerLoadArgs): Promise<{ digest: string }>;
  /** Tag a local image with an additional reference (e.g. before push). */
  tag(args: DockerTagArgs): Promise<void>;
  /** Push a tagged image to its registry; returns the pushed image's registry digest. */
  push(args: DockerPushArgs): Promise<{ digest: string }>;
  /** Inspect a remote image's manifest digest without pulling it (used to verify a promoted tag). */
  remoteDigest(image: string): Promise<string>;
}

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

export interface EcsClient {
  /** Roll a new task definition/desired count out to a service; returns the new deployment's id. */
  updateService(args: EcsUpdateServiceArgs): Promise<{ deploymentId: string }>;
  /** Current running/desired counts for a service, used by `wait-steady-state`. */
  describeService(cluster: string, service: string): Promise<EcsServiceState>;
  /** Roll a service back to a previously recorded task definition/count (saga compensation). */
  rollbackService(args: EcsUpdateServiceArgs): Promise<void>;
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

// ── Neo4j cluster probe (bolt) ───────────────────────────────────────────────

export interface Neo4jProbeArgs {
  /** Cluster identifier — a comma-separated list of `host:port` bolt endpoints. */
  cluster: string;
}

export interface Neo4jClusterClient {
  /** Probe every member's bolt port; returns how many are reachable/healthy. */
  probe(args: Neo4jProbeArgs): Promise<{ healthyCount: number; total: number }>;
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
}

// ── The aggregate executor ───────────────────────────────────────────────────

/**
 * The full injectable cloud I/O surface the AWS-leaf capabilities depend on.
 * A capability module never imports `node:child_process`/an AWS SDK/`net`
 * directly — it takes a `CloudExecutor` (defaulted to `realCloudExecutor()`
 * at module scope, overridable via each capability family's
 * `create*Capability(executor)` factory) so tests can swap in a full mock.
 */
export interface CloudExecutor {
  docker: DockerClient;
  ecr: EcrClient;
  cloudformation: CloudFormationClient;
  ecs: EcsClient;
  codeDeploy: CodeDeployClient;
  neo4j: Neo4jClusterClient;
  lambda: LambdaClient;
}

// ── Real executor — shells out to `docker`/`aws`; used outside tests ────────

function run(command: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, { maxBuffer: 64 * 1024 * 1024 });
}

/** Shell-quote a single argument for POSIX shells (wrap in single quotes, escaping embedded ones). */
function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const realDocker: DockerClient = {
  async build(args) {
    const parts = [`docker build`, `-t ${q(args.tag)}`];
    if (args.dockerfile) parts.push(`-f ${q(args.dockerfile)}`);
    if (args.target) parts.push(`--target ${q(args.target)}`);
    for (const [k, v] of Object.entries(args.buildArgs ?? {})) parts.push(`--build-arg ${q(`${k}=${v}`)}`);
    parts.push(q(args.context));
    await run(parts.join(" "));
    const { stdout } = await run(`docker image inspect ${q(args.tag)} --format '{{.Id}}'`);
    return { digest: stdout.trim() };
  },
  async save(args) {
    await run(`docker save ${q(args.image)} -o ${q(args.outFile)}`);
  },
  async load(args) {
    const { stdout } = await run(`docker load -i ${q(args.inFile)}`);
    const match = stdout.match(/[Ll]oaded image(?: ID)?:\s*(\S+)/);
    return { digest: match?.[1] ?? stdout.trim() };
  },
  async tag(args) {
    await run(`docker tag ${q(args.source)} ${q(args.target)}`);
  },
  async push(args) {
    await run(`docker push ${q(args.image)}`);
    const { stdout } = await run(`docker image inspect ${q(args.image)} --format '{{index .RepoDigests 0}}'`);
    return { digest: stdout.trim() };
  },
  async remoteDigest(image) {
    const { stdout } = await run(`docker manifest inspect -v ${q(image)}`);
    return stdout.trim();
  },
};

const realEcr: EcrClient = {
  async login(registry) {
    await run(`aws ecr get-login-password | docker login --username AWS --password-stdin ${q(registry)}`);
  },
};

const realCloudFormation: CloudFormationClient = {
  async createChangeSet(args) {
    const changeSetName = `cs-${Date.now()}`;
    const params = Object.entries(args.parameters ?? {})
      .map(([k, v]) => `ParameterKey=${k},ParameterValue=${v}`)
      .join(" ");
    const paramFlag = params ? ` --parameters ${params}` : "";
    await run(
      `aws cloudformation create-change-set --stack-name ${q(args.stackName)} --change-set-name ${q(changeSetName)} ` +
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

const realNeo4j: Neo4jClusterClient = {
  async probe(args) {
    const endpoints = args.cluster
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const results = await Promise.all(endpoints.map((endpoint) => probeBoltPort(endpoint)));
    return { healthyCount: results.filter(Boolean).length, total: endpoints.length };
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
};

/** Probe one `host:port` bolt endpoint by opening (and immediately closing) a TCP socket. */
function probeBoltPort(endpoint: string, timeoutMs = 5000): Promise<boolean> {
  const [host, portStr] = endpoint.split(":");
  const port = Number(portStr ?? 7687);
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: timeoutMs });
    const finish = (healthy: boolean) => {
      socket.destroy();
      resolve(healthy);
    };
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** Build a `CloudExecutor` that shells out to real `docker`/`aws` CLIs and probes real bolt ports. Never used in tests. */
export function realCloudExecutor(): CloudExecutor {
  return {
    docker: realDocker,
    ecr: realEcr,
    cloudformation: realCloudFormation,
    ecs: realEcs,
    codeDeploy: realCodeDeploy,
    neo4j: realNeo4j,
    lambda: realLambda,
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
