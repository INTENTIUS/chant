/**
 * `MockCloudExecutor` — an in-memory fake of the *agnostic* `CloudExecutor`
 * (../cloud-executor.ts) for tests: the `docker` build/push client and the
 * Neo4j bolt probe, the two clients core still owns. No live docker, ever, in
 * a test run — every method records its call and returns a canned result.
 *
 * The AWS clients' mock moved to the aws lexicon alongside their
 * implementations (`@intentius/chant-lexicon-aws/components`).
 */

import type { CloudExecutor, DockerBuildArgs, DockerLoadArgs, DockerPushArgs, DockerSaveArgs, DockerTagArgs, Neo4jProbeArgs } from "../cloud-executor";

export interface RecordedCall {
  client: string;
  method: string;
  args: unknown;
}

export interface FakeClusterConfig {
  /** Number of bolt endpoints (out of however many `cluster` lists) that report healthy. Default: all of them. */
  healthyCount?: number;
}

export interface MockCloudExecutorOptions {
  /** Neo4j cluster health, keyed by the comma-joined endpoint string `wait-cluster-healthy` probes. */
  clusters?: Record<string, FakeClusterConfig>;
  /** Force every docker call to fail (simulates a build/push failure). */
  failDocker?: boolean;
}

/** An injected agnostic `CloudExecutor` plus the call log and cluster-health controls tests use. */
export interface MockCloudExecutor {
  executor: CloudExecutor;
  calls: RecordedCall[];
  /** Change how many cluster members report healthy after construction (simulates a follower catching up). */
  setClusterHealth(cluster: string, healthyCount: number): void;
}

/** Build a fresh mock agnostic `CloudExecutor`. Every method is deterministic and synchronous-fast — no real polling delay. */
export function createMockCloudExecutor(options: MockCloudExecutorOptions = {}): MockCloudExecutor {
  const calls: RecordedCall[] = [];
  const record = (client: string, method: string, args: unknown) => calls.push({ client, method, args });

  const clusters = new Map<string, number>(
    Object.entries(options.clusters ?? {}).map(([k, v]) => [k, v.healthyCount ?? Number.MAX_SAFE_INTEGER]),
  );

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

  return {
    executor: { docker, neo4j },
    calls,
    setClusterHealth: (cluster, healthyCount) => clusters.set(cluster, healthyCount),
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
