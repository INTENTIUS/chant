/**
 * Injectable cloud I/O boundary for the *agnostic* capability implementations
 * that remain in core: the `docker` build/push client and the Neo4j bolt-port
 * probe. Every capability here that talks to a real tool goes through a
 * `CloudExecutor` instead of shelling out directly, so production code gets a
 * real, `child_process`/`net`-backed executor and tests get a
 * `MockCloudExecutor` (./__tests__/mock-cloud-executor.ts) that records calls
 * and returns canned results — no live docker, ever, in a test run.
 *
 * The AWS-specific clients (CloudFormation, ECS, Lambda, EMR, CodeDeploy, SSM
 * host, S3, CloudFront, snapshot, ECR) used to live here too. They now live in
 * the aws lexicon (`@intentius/chant-lexicon-aws/components`), contributed
 * through the capability-plugin seam — see docs/components/cloud-boundary. The
 * `docker` client stays in core because it is genuinely cloud-agnostic and
 * shared: `docker-build` (agnostic) uses it here, and the aws lexicon's
 * `publish-image` reuses the exported `realDocker` rather than duplicating it.
 */

import { exec } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import { isAbsolute, join } from "node:path";

export const execFileAsync = promisify(exec);

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

// ── Neo4j cluster probe (bolt) ───────────────────────────────────────────────

export interface Neo4jProbeArgs {
  /** Cluster identifier — a comma-separated list of `host:port` bolt endpoints. */
  cluster: string;
}

export interface Neo4jClusterClient {
  /** Probe every member's bolt port; returns how many are reachable/healthy. */
  probe(args: Neo4jProbeArgs): Promise<{ healthyCount: number; total: number }>;
}

// ── the agnostic executor surface ────────────────────────────────────────────

export interface CloudExecutor {
  docker: DockerClient;
  neo4j: Neo4jClusterClient;
}

// ── Real executor — shells out to `docker`; used outside tests ───────────────

/** Run a shell command, capturing stdout/stderr. Internal to the docker client; the aws lexicon's executor has its own (endpoint-aware) runner. */
function run(command: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, { maxBuffer: 64 * 1024 * 1024 });
}

/** Shell-quote a single argument for POSIX shells (wrap in single quotes, escaping embedded ones). Internal; the shared, exported `q` lives in ./process-runner. */
function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const realDocker: DockerClient = {
  async build(args) {
    const parts = [`docker build`, `-t ${q(args.tag)}`];
    if (args.dockerfile) {
      // dockerfile is relative to `context` (its documented contract); docker's `-f` resolves a relative path against cwd, not the context dir, so join them here (chant#936).
      const dockerfilePath = isAbsolute(args.dockerfile) ? args.dockerfile : join(args.context, args.dockerfile);
      parts.push(`-f ${q(dockerfilePath)}`);
    }
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

/** Build a `CloudExecutor` that shells out to the real `docker` CLI and probes real bolt ports. Never used in tests. */
export function realCloudExecutor(): CloudExecutor {
  return { docker: realDocker, neo4j: realNeo4j };
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
