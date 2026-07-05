/**
 * `MockCloudExecutor` — an in-memory fake of `CloudExecutor` (../cloud-executor.ts)
 * for tests. No live AWS, no live docker: every method records its call and
 * returns/derives a canned result, with enough state (a fake stack registry, a
 * fake deployment registry, a fake cluster registry) to exercise realistic
 * scenarios — a changeset that proposes a replacement, a stack that takes a
 * few polls to go terminal, a CodeDeploy deployment that fails then rolls back,
 * a cluster that becomes healthy after enough members join.
 *
 * Every capability factory in `../*.ts` accepts a `CloudExecutor`, so a test
 * builds one `MockCloudExecutor` and passes it to every `create*Capability`
 * under test — never touching the real, `child_process`/`net`-backed
 * executor in `../cloud-executor.ts`.
 */

import type {
  CfnChange,
  CfnCreateChangeSetArgs,
  CfnExecuteChangeSetArgs,
  CfnStackStatus,
  CloudExecutor,
  CodeDeployCreateArgs,
  CodeDeployStatus,
  DockerBuildArgs,
  DockerLoadArgs,
  DockerPushArgs,
  DockerSaveArgs,
  DockerTagArgs,
  EcsClient,
  EcsServiceState,
  EcsUpdateServiceArgs,
  EmrClient,
  EmrStartJobRunArgs,
  HostClient,
  HostCopyFileArgs,
  HostDockerLoadArgs,
  LambdaClient,
  LambdaUpdateAliasArgs,
  LambdaUpdateCodeArgs,
  Neo4jProbeArgs,
} from "../cloud-executor";

export interface RecordedCall {
  client: string;
  method: string;
  args: unknown;
}

/** Scripted behavior for one fake CloudFormation stack. */
export interface FakeStackConfig {
  /** Changes CloudFormation would propose for the next changeset created against this stack. Default: no changes (no-op update). */
  changes?: CfnChange[];
  /** Outputs the stack reports once terminal. */
  outputs?: Record<string, string>;
  /** Terminal status reported after `executeChangeSet` (or from the start, if the stack pre-exists). Default: "UPDATE_COMPLETE". */
  terminalStatus?: string;
  /** True if this is a brand-new stack (no prior stack) — affects `isCreate`. Default: false. */
  isCreate?: boolean;
}

export interface FakeDeploymentConfig {
  /** Terminal status CodeDeploy reports for this deployment. Default: "Succeeded". */
  terminalStatus?: "Succeeded" | "Failed" | "Stopped";
}

export interface FakeClusterConfig {
  /** Number of bolt endpoints (out of however many `cluster` lists) that report healthy. Default: all of them. */
  healthyCount?: number;
}

export interface FakeLambdaConfig {
  /** Alias -> version this function's alias currently resolves to, before any deploy in the test runs. */
  aliasVersions?: Record<string, string>;
  /** Force `waitForUpdate` to report a failed code update (simulates a bad image). */
  failUpdate?: boolean;
}

/** Scripted behavior for one fake EMR job run. */
export interface FakeJobRunConfig {
  /** Terminal state reported once the run "completes". Default: "COMPLETED". */
  terminalState?: "COMPLETED" | "FAILED" | "CANCELLED";
}

export interface MockCloudExecutorOptions {
  stacks?: Record<string, FakeStackConfig>;
  deployments?: Record<string, FakeDeploymentConfig>;
  clusters?: Record<string, FakeClusterConfig>;
  /** ECS service states keyed by `cluster/service`, evolved by `updateService`/`rollbackService` calls. */
  ecsServices?: Record<string, EcsServiceState>;
  /** Force every docker/ecr call to fail (simulates a build/push failure). */
  failDocker?: boolean;
  /** Force every `host` (registry-less `load-image-on-host`) call to fail (simulates an unreachable host). */
  failHost?: boolean;
  /** Lambda functions keyed by function name. */
  lambdas?: Record<string, FakeLambdaConfig>;
  /** Scripted job runs keyed by the run id the test expects (see `MockCloudExecutor.setJobRun` for post-construction control, e.g. before the run id is known). */
  jobRuns?: Record<string, FakeJobRunConfig>;
  /** Object counts `s3.sync` reports (uploaded always; deleted only when the call passes `delete: true`). */
  s3Sync?: { uploaded?: number; deleted?: number };
}

/** An injected `CloudExecutor` plus the call log and stack-status controls tests use to script scenarios and assert on I/O. */
export interface MockCloudExecutor {
  executor: CloudExecutor;
  calls: RecordedCall[];
  /** Change a stack's terminal status/outputs/changes after construction (e.g. to simulate a later poll succeeding). */
  setStack(name: string, config: FakeStackConfig): void;
  /** Change a deployment's terminal status after construction. */
  setDeployment(id: string, config: FakeDeploymentConfig): void;
  /** Change how many cluster members report healthy after construction (simulates a follower catching up). */
  setClusterHealth(cluster: string, healthyCount: number): void;
  /** Change a job run's terminal state after construction (e.g. once its runId is known from a prior `startJobRun` call). */
  setJobRun(runId: string, config: FakeJobRunConfig): void;
}

/** Build a fresh mock `CloudExecutor`. Every method is deterministic and synchronous-fast — no real polling delay. */
export function createMockCloudExecutor(options: MockCloudExecutorOptions = {}): MockCloudExecutor {
  const calls: RecordedCall[] = [];
  const record = (client: string, method: string, args: unknown) => calls.push({ client, method, args });

  const stacks = new Map<string, FakeStackConfig>(Object.entries(options.stacks ?? {}));
  const deployments = new Map<string, FakeDeploymentConfig>(Object.entries(options.deployments ?? {}));
  const clusters = new Map<string, number>(
    Object.entries(options.clusters ?? {}).map(([k, v]) => [k, v.healthyCount ?? Number.MAX_SAFE_INTEGER]),
  );
  const ecsServices = new Map<string, EcsServiceState>(Object.entries(options.ecsServices ?? {}));
  const pendingChangeSets = new Map<string, { stackName: string; changes: CfnChange[] }>();
  const lambdaConfigs = new Map<string, FakeLambdaConfig>(Object.entries(options.lambdas ?? {}));
  const lambdaAliasVersions = new Map<string, Map<string, string>>(
    Object.entries(options.lambdas ?? {}).map(([fn, cfg]) => [fn, new Map(Object.entries(cfg.aliasVersions ?? {}))]),
  );
  const jobRuns = new Map<string, FakeJobRunConfig>(Object.entries(options.jobRuns ?? {}));
  let changeSetCounter = 0;
  let deploymentCounter = 0;
  let lambdaVersionCounter = 0;
  let jobRunCounter = 0;

  function stackStatus(name: string): CfnStackStatus {
    const config = stacks.get(name);
    return { stackStatus: config?.terminalStatus ?? "UPDATE_COMPLETE", outputs: config?.outputs ?? {} };
  }

  const docker: CloudExecutor["docker"] = {
    async build(args: DockerBuildArgs) {
      record("docker", "build", args);
      if (options.failDocker) throw new Error(`docker build failed for ${args.context}`);
      return { digest: `sha256:${fakeDigest("build", args.context, args.tag)}` };
    },
    async save(args: DockerSaveArgs) {
      record("docker", "save", args);
    },
    async load(args: DockerLoadArgs) {
      record("docker", "load", args);
      return { digest: `sha256:${fakeDigest("load", args.inFile)}` };
    },
    async tag(args: DockerTagArgs) {
      record("docker", "tag", args);
    },
    async push(args: DockerPushArgs) {
      record("docker", "push", args);
      if (options.failDocker) throw new Error(`docker push failed for ${args.image}`);
      return { digest: `sha256:${fakeDigest("push", args.image)}` };
    },
    async remoteDigest(image: string) {
      record("docker", "remoteDigest", image);
      return `sha256:${fakeDigest("remote", image)}`;
    },
  };

  const ecr: CloudExecutor["ecr"] = {
    async login(registry: string) {
      record("ecr", "login", registry);
    },
  };

  const cloudformation: CloudExecutor["cloudformation"] = {
    async createChangeSet(args: CfnCreateChangeSetArgs) {
      record("cloudformation", "createChangeSet", args);
      changeSetCounter += 1;
      const changeSetName = `mock-changeset-${changeSetCounter}`;
      const config = stacks.get(args.stackName);
      const changes = config?.changes ?? [];
      pendingChangeSets.set(changeSetName, { stackName: args.stackName, changes });
      return {
        changeSetName,
        stackName: args.stackName,
        status: "CREATE_COMPLETE",
        isCreate: config?.isCreate ?? false,
        changes,
      };
    },
    async executeChangeSet(args: CfnExecuteChangeSetArgs) {
      record("cloudformation", "executeChangeSet", args);
      pendingChangeSets.delete(args.changeSetName);
    },
    async deleteChangeSet(args: CfnExecuteChangeSetArgs) {
      record("cloudformation", "deleteChangeSet", args);
      pendingChangeSets.delete(args.changeSetName);
    },
    async describeStack(stackName: string) {
      record("cloudformation", "describeStack", stackName);
      return stackStatus(stackName);
    },
    async waitForStack(stackName: string) {
      record("cloudformation", "waitForStack", stackName);
      return stackStatus(stackName);
    },
    async rollbackStack(stackName: string) {
      record("cloudformation", "rollbackStack", stackName);
      stacks.set(stackName, { ...stacks.get(stackName), terminalStatus: "ROLLBACK_COMPLETE" });
    },
  };

  const ecs: EcsClient = {
    async updateService(args: EcsUpdateServiceArgs) {
      record("ecs", "updateService", args);
      const key = `${args.cluster}/${args.service}`;
      const desired = args.desiredCount ?? ecsServices.get(key)?.desiredCount ?? 1;
      ecsServices.set(key, { runningCount: desired, desiredCount: desired, stable: true });
      return { deploymentId: `mock-deployment-${key}` };
    },
    async describeService(cluster: string, service: string) {
      record("ecs", "describeService", { cluster, service });
      return ecsServices.get(`${cluster}/${service}`) ?? { runningCount: 1, desiredCount: 1, stable: true };
    },
    async rollbackService(args: EcsUpdateServiceArgs) {
      record("ecs", "rollbackService", args);
      const key = `${args.cluster}/${args.service}`;
      const current = ecsServices.get(key);
      ecsServices.set(key, { runningCount: current?.desiredCount ?? 1, desiredCount: current?.desiredCount ?? 1, stable: true });
    },
  };

  const codeDeploy: CloudExecutor["codeDeploy"] = {
    async createDeployment(args: CodeDeployCreateArgs) {
      record("codeDeploy", "createDeployment", args);
      deploymentCounter += 1;
      return { deploymentId: `mock-deployment-${deploymentCounter}` };
    },
    async waitForDeployment(deploymentId: string) {
      record("codeDeploy", "waitForDeployment", deploymentId);
      const config = deployments.get(deploymentId);
      const status = config?.terminalStatus ?? "Succeeded";
      const result: CodeDeployStatus = { status, terminal: true };
      return result;
    },
    async stopAndRollback(deploymentId: string) {
      record("codeDeploy", "stopAndRollback", deploymentId);
      deployments.set(deploymentId, { terminalStatus: "Stopped" });
    },
  };

  const neo4j: CloudExecutor["neo4j"] = {
    async probe(args: Neo4jProbeArgs) {
      record("neo4j", "probe", args);
      const endpoints = args.cluster
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const healthy = clusters.get(args.cluster) ?? endpoints.length;
      return { healthyCount: Math.min(healthy, endpoints.length), total: endpoints.length };
    },
  };

  const lambda: LambdaClient = {
    async updateFunctionCode(args: LambdaUpdateCodeArgs) {
      record("lambda", "updateFunctionCode", args);
      return { functionArn: `arn:aws:lambda:us-east-1:123456789012:function:${args.functionName}` };
    },
    async waitForUpdate(functionName: string) {
      record("lambda", "waitForUpdate", functionName);
      const failed = lambdaConfigs.get(functionName)?.failUpdate;
      return { status: failed ? "Failed" : "Successful" };
    },
    async publishVersion(args) {
      record("lambda", "publishVersion", args);
      lambdaVersionCounter += 1;
      return {
        version: String(lambdaVersionCounter),
        functionArn: `arn:aws:lambda:us-east-1:123456789012:function:${args.functionName}:${lambdaVersionCounter}`,
      };
    },
    async updateAlias(args: LambdaUpdateAliasArgs) {
      record("lambda", "updateAlias", args);
      const versions = lambdaAliasVersions.get(args.functionName) ?? new Map<string, string>();
      versions.set(args.alias, args.version);
      lambdaAliasVersions.set(args.functionName, versions);
      return { aliasArn: `arn:aws:lambda:us-east-1:123456789012:function:${args.functionName}:${args.alias}` };
    },
    async getAliasVersion(functionName: string, alias: string) {
      record("lambda", "getAliasVersion", { functionName, alias });
      return lambdaAliasVersions.get(functionName)?.get(alias);
    },
  };

  const emr: EmrClient = {
    async startJobRun(args: EmrStartJobRunArgs) {
      record("emr", "startJobRun", args);
      jobRunCounter += 1;
      return { runId: `mock-job-run-${jobRunCounter}` };
    },
    async describeJobRun(runId: string) {
      record("emr", "describeJobRun", runId);
      return { state: jobRuns.get(runId)?.terminalState ?? "COMPLETED" };
    },
    async waitForJobRun(runId: string) {
      record("emr", "waitForJobRun", runId);
      return { state: jobRuns.get(runId)?.terminalState ?? "COMPLETED" };
    },
    async cancelJobRun(runId: string) {
      record("emr", "cancelJobRun", runId);
      jobRuns.set(runId, { terminalState: "CANCELLED" });
    },
  };

  const host: HostClient = {
    async copyFile(args: HostCopyFileArgs) {
      record("host", "copyFile", args);
      if (options.failHost) throw new Error(`host copy failed for ${args.host}`);
    },
    async dockerLoad(args: HostDockerLoadArgs) {
      record("host", "dockerLoad", args);
      if (options.failHost) throw new Error(`host docker load failed for ${args.host}`);
      return { digest: `sha256:${fakeDigest("host-load", args.host, args.path)}` };
    },
  };

  const s3: CloudExecutor["s3"] = {
    async sync(args) {
      record("s3", "sync", args);
      return {
        uploaded: options.s3Sync?.uploaded ?? 0,
        deleted: args.delete ? (options.s3Sync?.deleted ?? 0) : 0,
      };
    },
    async cp(args) {
      record("s3", "cp", args);
    },
  };
  const cloudfront: CloudExecutor["cloudfront"] = {
    async createInvalidation(args) {
      record("cloudfront", "createInvalidation", args);
      return { invalidationId: "I-MOCK0001" };
    },
  };

  return {
    executor: { docker, ecr, cloudformation, ecs, codeDeploy, neo4j, lambda, emr, host, s3, cloudfront },
    calls,
    setStack: (name, config) => stacks.set(name, { ...stacks.get(name), ...config }),
    setDeployment: (id, config) => deployments.set(id, { ...deployments.get(id), ...config }),
    setClusterHealth: (cluster, healthyCount) => clusters.set(cluster, healthyCount),
    setJobRun: (runId, config) => jobRuns.set(runId, { ...jobRuns.get(runId), ...config }),
  };
}

/** Deterministic fake digest suffix derived from its inputs — stable across calls with the same args, distinct otherwise. */
function fakeDigest(...parts: string[]): string {
  let hash = 0;
  const input = parts.join("|");
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, "0").repeat(4).slice(0, 64);
}
