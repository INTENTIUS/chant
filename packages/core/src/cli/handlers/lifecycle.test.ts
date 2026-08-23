import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { sep } from "node:path";
import { createMockPlugin, staticDescribeResources, staticObservation, staticDeepObservation, staticListArtifacts } from "@intentius/chant-test-utils";
import type { LexiconPlugin, ResourceMetadata } from "../../lexicon";
import { deepObservation } from "../../deep-observation";
import type { BuildResult } from "../../build";
import type { ParsedArgs } from "../registry";

/**
 * The aws emulator capability, as the real plugin declares it. `--live`
 * endpoint injection reads the endpoint var off this rather than off a map
 * keyed by lexicon name (#1345), so a mock that omits it gets no injection —
 * the same thing that would happen in production.
 */
const awsEmulatorStub = {
  spec: { name: "chant-floci", image: "floci/floci:1.5.34", containerPort: 4566, healthPath: "/_localstack/health" },
  env: (endpoint: string) => ({ AWS_ENDPOINT_URL: endpoint, AWS_ACCESS_KEY_ID: "test" }),
};


const buildMock = vi.fn();
const fetchLifecycleMock = vi.fn();
const readSnapshotMock = vi.fn();
const readEnvironmentSnapshotsMock = vi.fn();
const listSnapshotsMock = vi.fn();
const takeSnapshotMock = vi.fn();
const loadChantConfigMock = vi.fn();
const pushLifecycleMock = vi.fn();
const readBlobFromPathMock = vi.fn();
const writeBlobToPathMock = vi.fn();

vi.mock("../../build", () => ({ build: (...args: unknown[]) => buildMock(...args) }));
vi.mock("../../lifecycle/git", () => ({
  fetchLifecycle: () => fetchLifecycleMock(),
  pushLifecycle: () => pushLifecycleMock(),
  readSnapshot: (...args: unknown[]) => readSnapshotMock(...args),
  readEnvironmentSnapshots: (...args: unknown[]) => readEnvironmentSnapshotsMock(...args),
  listSnapshots: (...args: unknown[]) => listSnapshotsMock(...args),
  snapshotStorageKey: (lexicon: string, stack?: string) => (stack ? `${stack}__${lexicon}` : lexicon),
  // The accepted-observation baseline (#1014) rides the same orphan-branch
  // plumbing as the snapshots, so it is mocked at the same seam.
  readBlobFromPath: (...args: unknown[]) => readBlobFromPathMock(...args),
  writeBlobToPath: (...args: unknown[]) => writeBlobToPathMock(...args),
}));
vi.mock("../../lifecycle/snapshot", () => ({
  takeSnapshot: (...args: unknown[]) => takeSnapshotMock(...args),
}));
vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return {
    ...actual,
    loadChantConfig: (...args: unknown[]) => loadChantConfigMock(...args),
  };
});

const { runLifecycleDiff, runLifecyclePlan, runLifecycleSnapshot, runLifecycleShow, runLifecycleLog, runLifecycleUnknown } = await import("./lifecycle");

function makeArgs(overrides: Partial<ParsedArgs>): ParsedArgs {
  return {
    command: "state",
    path: "diff",
    format: "",
    fix: false,
    watch: false,
    verbose: false,
    help: false,
    live: false,
    ...overrides,
  };
}

function makeBuildResult(entitiesByLexicon: Record<string, string[]>): BuildResult {
  const entities = new Map();
  for (const [lexicon, names] of Object.entries(entitiesByLexicon)) {
    for (const name of names) {
      entities.set(name, { lexicon, entityType: `${lexicon}::Mock`, props: {} });
    }
  }
  return {
    outputs: new Map(Object.keys(entitiesByLexicon).map((l) => [l, "{}"])),
    entities,
    dependencies: new Map(),
    errors: [],
    warnings: [],
    manifest: {
      lexicons: Object.keys(entitiesByLexicon),
      outputs: {},
      deployOrder: Object.keys(entitiesByLexicon),
    },
    sourceFileCount: 1,
  } as unknown as BuildResult;
}

const meta = (overrides: Partial<ResourceMetadata> = {}): ResourceMetadata => ({
  type: "AWS::S3::Bucket",
  status: "CREATE_COMPLETE",
  physicalId: "bucket-1",
  ...overrides,
});

describe("runLifecycleDiff --live", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutBuf: string[];
  let stderrBuf: string[];

  beforeEach(() => {
    stdoutBuf = [];
    stderrBuf = [];
    stdoutSpy = vi.spyOn(console, "log").mockImplementation((s: string) => { stdoutBuf.push(s); });
    stderrSpy = vi.spyOn(console, "error").mockImplementation((s: string) => { stderrBuf.push(s); });
    buildMock.mockReset();
    fetchLifecycleMock.mockReset();
    readSnapshotMock.mockReset();
    loadChantConfigMock.mockReset();
    loadChantConfigMock.mockResolvedValue({ config: {} });
    readBlobFromPathMock.mockReset();
    readBlobFromPathMock.mockResolvedValue(null); // no accepted baseline recorded
    writeBlobToPathMock.mockReset();
    writeBlobToPathMock.mockResolvedValue("sha");
    pushLifecycleMock.mockReset();
    pushLifecycleMock.mockResolvedValue(true);
  });

  test("surfaces drift between previous snapshot and live state", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }));
    fetchLifecycleMock.mockResolvedValue(undefined);
    readSnapshotMock.mockResolvedValue(JSON.stringify({
      lexicon: "aws",
      environment: "prod",
      commit: "abc",
      timestamp: "2026-04-01T00:00:00Z",
      resources: { bucket: meta({ status: "CREATE_COMPLETE" }) },
    }));

    const plugins: LexiconPlugin[] = [
      createMockPlugin({
        name: "aws",
        emulator: awsEmulatorStub,
        describeResources: staticDescribeResources({
          bucket: meta({ status: "UPDATE_COMPLETE" }),
        }),
      }),
    ];

    const ctx = {
      args: makeArgs({ command: "state", path: "diff", extraPositional: "prod", live: true }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    };

    const exit = await runLifecycleDiff(ctx);

    expect(exit).toBe(0);
    const output = stdoutBuf.join("\n");
    expect(output).toContain("DRIFTED");
    expect(output).toContain("bucket");
    expect(output).toContain("status:");
    expect(output).toContain("CREATE_COMPLETE");
    expect(output).toContain("UPDATE_COMPLETE");
  });

  // #1089 — a hole in the read is rendered as a hole, and never silently
  // inflates the missing/drift counts that the all-clear line reads.
  test("renders an UNOBSERVED section and qualifies the all-clear", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ k8s: ["widget"] }));
    fetchLifecycleMock.mockResolvedValue(undefined);
    readSnapshotMock.mockResolvedValue(null);

    const plugins: LexiconPlugin[] = [
      createMockPlugin({
        name: "k8s",
        describeResources: staticObservation({}, {
          widget: { type: "K8s::X::Widget", reason: "unsupported-kind", detail: "no kubectl mapping" },
        }),
      }),
    ];

    const exit = await runLifecycleDiff({
      args: makeArgs({ path: "diff", extraPositional: "prod", live: true }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    });

    expect(exit).toBe(0);
    const stdout = stdoutBuf.join("\n");
    expect(stdout).toContain("UNOBSERVED");
    expect(stdout).toContain("widget");
    expect(stdout).toContain("no reader for this resource kind");
    // Not counted as missing — "declared, not in cloud" is a claim we can't make.
    expect(stdout).toContain("0 missing");
    expect(stderrBuf.join("\n")).toContain("could not be observed");
  });

  test("a throwing describeResources reports its entities unobserved instead of skipping the lexicon", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }));
    fetchLifecycleMock.mockResolvedValue(undefined);
    readSnapshotMock.mockResolvedValue(null);

    const plugins: LexiconPlugin[] = [
      createMockPlugin({
        name: "aws",
        emulator: awsEmulatorStub,
        describeResources: async () => { throw new Error("Unable to locate credentials"); },
      }),
    ];

    const exit = await runLifecycleDiff({
      args: makeArgs({ path: "diff", extraPositional: "prod", live: true }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    });

    expect(exit).toBe(0);
    expect(stderrBuf.join("\n")).toContain("not as absent");
    const stdout = stdoutBuf.join("\n");
    expect(stdout).toContain("UNOBSERVED");
    expect(stdout).toContain("bucket");
    expect(stdout).toContain("0 missing");
  });

  test("builds from config.sourceDir on a mixed-layout project", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }));
    fetchLifecycleMock.mockResolvedValue(undefined);
    readSnapshotMock.mockResolvedValue(null);
    loadChantConfigMock.mockResolvedValue({ config: { sourceDir: "src" } });

    const plugins: LexiconPlugin[] = [
      createMockPlugin({ name: "aws", emulator: awsEmulatorStub, describeResources: staticDescribeResources({}) }),
    ];
    const exit = await runLifecycleDiff({
      args: makeArgs({ path: "diff", extraPositional: "prod", extraPositional2: "aws", live: true }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    });

    expect(exit).toBe(0);
    const builtPath = buildMock.mock.calls[0][0] as string;
    expect(builtPath.endsWith(`${sep}src`)).toBe(true);
  });

  test("--src overrides config.sourceDir for the build root", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }));
    fetchLifecycleMock.mockResolvedValue(undefined);
    readSnapshotMock.mockResolvedValue(null);
    loadChantConfigMock.mockResolvedValue({ config: { sourceDir: "src" } });

    const plugins: LexiconPlugin[] = [
      createMockPlugin({ name: "aws", emulator: awsEmulatorStub, describeResources: staticDescribeResources({}) }),
    ];
    const exit = await runLifecycleDiff({
      args: makeArgs({ path: "diff", extraPositional: "prod", extraPositional2: "aws", live: true, src: "infra" }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    });

    expect(exit).toBe(0);
    const builtPath = buildMock.mock.calls[0][0] as string;
    expect(builtPath.endsWith(`${sep}infra`)).toBe(true);
  });

  // #932 — a multi-stack project builds each stack from its own source and
  // observes each against its own live CloudFormation stack (not one stack/env).
  test("multi-stack: config.stacks builds each stack scoped and observes its own stack name", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }));
    fetchLifecycleMock.mockResolvedValue(undefined);
    readSnapshotMock.mockResolvedValue(null);
    loadChantConfigMock.mockResolvedValue({ config: { stacks: [
      { name: "loom-backend", src: "src/loom-backend" },
      { name: "loom-agents", src: "src/loom-agents" },
    ] } });

    const observedStacks: (string | undefined)[] = [];
    const plugins: LexiconPlugin[] = [
      createMockPlugin({
        name: "aws",
        emulator: awsEmulatorStub,
        describeResources: async (options: { stack?: string }) => {
          observedStacks.push(options.stack);
          return {};
        },
      }),
    ];

    const exit = await runLifecycleDiff({
      args: makeArgs({ path: "diff", extraPositional: "prod", live: true }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    });

    expect(exit).toBe(0);
    // Each stack built from its own source directory.
    const builtPaths = buildMock.mock.calls.map((c) => c[0] as string);
    expect(builtPaths.some((p) => p.endsWith(`${sep}src${sep}loom-backend`))).toBe(true);
    expect(builtPaths.some((p) => p.endsWith(`${sep}src${sep}loom-agents`))).toBe(true);
    // Each observed against its own live stack name.
    expect(observedStacks).toEqual(["loom-backend", "loom-agents"]);
    // Each read its own stack-scoped snapshot key.
    const readKeys = readSnapshotMock.mock.calls.map((c) => c[1]);
    expect(readKeys).toContain("loom-backend__aws");
    expect(readKeys).toContain("loom-agents__aws");
  });

  // #1264 — each stack declares the region it deploys to. The diff dropped it
  // on the way to the live read, so a multi-region estate compared every stack
  // against the ambient region and reported the out-of-region ones as absent.
  test("multi-stack: each stack's declared region reaches the thin and deep reads", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }));
    fetchLifecycleMock.mockResolvedValue(undefined);
    readSnapshotMock.mockResolvedValue(null);
    loadChantConfigMock.mockResolvedValue({ config: { stacks: [
      { name: "app-us-east-1", src: "src/us-east-1", region: "us-east-1" },
      { name: "app-us-west-2", src: "src/us-west-2", region: "us-west-2" },
    ] } });

    const thinReads: Array<{ stack?: string; region?: string }> = [];
    const deepReads: Array<{ stack?: string; region?: string }> = [];
    const plugins: LexiconPlugin[] = [
      createMockPlugin({
        name: "aws",
        emulator: awsEmulatorStub,
        describeResources: async (options: { stack?: string; region?: string }) => {
          thinReads.push({ stack: options.stack, region: options.region });
          return {};
        },
        observeResourcesDeep: async (options: { stack?: string; region?: string }) => {
          deepReads.push({ stack: options.stack, region: options.region });
          return deepObservation({});
        },
      }),
    ];

    const exit = await runLifecycleDiff({
      args: makeArgs({ path: "diff", extraPositional: "prod", live: true }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    });

    expect(exit).toBe(0);
    expect(thinReads).toEqual([
      { stack: "app-us-east-1", region: "us-east-1" },
      { stack: "app-us-west-2", region: "us-west-2" },
    ]);
    expect(deepReads).toEqual([
      { stack: "app-us-east-1", region: "us-east-1" },
      { stack: "app-us-west-2", region: "us-west-2" },
    ]);
  });

  test("stack without a declared region: no region reaches the live read", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }));
    fetchLifecycleMock.mockResolvedValue(undefined);
    readSnapshotMock.mockResolvedValue(null);
    loadChantConfigMock.mockResolvedValue({ config: { stacks: [{ name: "app", src: "src/app" }] } });

    const reads: Array<Record<string, unknown>> = [];
    const plugins: LexiconPlugin[] = [
      createMockPlugin({
        name: "aws",
        emulator: awsEmulatorStub,
        describeResources: async (options: Record<string, unknown>) => {
          reads.push(options);
          return {};
        },
      }),
    ];

    await runLifecycleDiff({
      args: makeArgs({ path: "diff", extraPositional: "prod", live: true }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    });

    expect(reads).toHaveLength(1);
    expect(reads[0].stack).toBe("app");
    expect("region" in reads[0]).toBe(false);
  });

  test("warns and skips lexicons without describeResources", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ k8s: ["pod"] }));
    fetchLifecycleMock.mockResolvedValue(undefined);
    readSnapshotMock.mockResolvedValue(null);

    const plugins: LexiconPlugin[] = [
      createMockPlugin({ name: "k8s" }),
    ];

    const ctx = {
      args: makeArgs({ command: "state", path: "diff", extraPositional: "prod", live: true }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    };

    const exit = await runLifecycleDiff(ctx);

    expect(exit).toBe(1);
    const stderr = stderrBuf.join("\n");
    expect(stderr).toContain("k8s");
    expect(stderr).toContain("does not implement describeResources");
  });

  test("--live with a listArtifacts-only plugin diffs artifacts (no resources path)", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ helm: [] }));
    fetchLifecycleMock.mockResolvedValue(undefined);
    // Previous snapshot has no artifact entry for the new release → expect ARTIFACTS ADDED
    readSnapshotMock.mockResolvedValue(JSON.stringify({
      lexicon: "helm",
      environment: "prod",
      commit: "x",
      timestamp: "t",
      resources: {},
      artifacts: {},
    }));

    const plugins: LexiconPlugin[] = [
      createMockPlugin({
        name: "helm",
        listArtifacts: staticListArtifacts({
          "release/default/web": { type: "Helm::Release", physicalId: "default/web", status: "deployed" },
        }),
      }),
    ];

    const ctx = {
      args: makeArgs({ command: "state", path: "diff", extraPositional: "prod", live: true }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    };

    const exit = await runLifecycleDiff(ctx);

    expect(exit).toBe(0);
    const output = stdoutBuf.join("\n");
    expect(output).toContain("ARTIFACTS ADDED");
    expect(output).toContain("release/default/web");
  });

  test("--live --json carries the observed artifact metadata, not just the key deltas (behold#146)", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ helm: [] }));
    fetchLifecycleMock.mockResolvedValue(undefined);
    // No previous snapshot at all — the first-run case where the diff is pure
    // `added` keys and, before this, a JSON consumer had no status to read.
    readSnapshotMock.mockResolvedValue(null);

    const plugins: LexiconPlugin[] = [
      createMockPlugin({
        name: "helm",
        listArtifacts: staticListArtifacts({
          "release/default/web": {
            type: "Helm::Release",
            physicalId: "default/web",
            status: "deployed",
            attributes: { chart: "web-1.2.3", revision: "3" },
          },
        }),
      }),
    ];

    const ctx = {
      args: makeArgs({ command: "state", path: "diff", extraPositional: "prod", live: true, json: true }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    };

    const exit = await runLifecycleDiff(ctx);

    expect(exit).toBe(0);
    const payload = JSON.parse(stdoutBuf.join("\n")) as {
      lexicons: Record<string, { artifacts?: { added: string[] }; observedArtifacts?: Record<string, { status?: string; attributes?: Record<string, unknown> }> }>;
    };
    expect(payload.lexicons.helm.artifacts?.added).toContain("release/default/web");
    const seen = payload.lexicons.helm.observedArtifacts?.["release/default/web"];
    expect(seen?.status).toBe("deployed");
    expect(seen?.attributes?.chart).toBe("web-1.2.3");
  });

  test("--live lists artifacts for a configured lexicon with NO built entities — the deploy-step estate shape", async () => {
    // kubemicrovm-ops: helm is a configured lexicon whose releases exist only
    // as component helm-upgrade steps, so the built manifest carries no helm
    // key at all. Keying the walk on the manifest alone silently dropped the
    // artifact axis — four live releases, observedArtifacts absent.
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }));
    fetchLifecycleMock.mockResolvedValue(undefined);
    readSnapshotMock.mockResolvedValue(null);

    const plugins: LexiconPlugin[] = [
      createMockPlugin({ name: "aws" }),
      createMockPlugin({
        name: "helm",
        listArtifacts: staticListArtifacts({
          "release/cert-manager/cert-manager": { type: "Helm::Release", physicalId: "cert-manager/cert-manager", status: "deployed" },
        }),
      }),
    ];

    const ctx = {
      args: makeArgs({ command: "state", path: "diff", extraPositional: "prod", live: true, json: true }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    };

    const exit = await runLifecycleDiff(ctx);

    expect(exit).toBe(0);
    const payload = JSON.parse(stdoutBuf.join("\n")) as {
      lexicons: Record<string, { observedArtifacts?: Record<string, { status?: string }> }>;
    };
    expect(payload.lexicons.helm?.observedArtifacts?.["release/cert-manager/cert-manager"]?.status).toBe("deployed");
  });

  test("legacy digest mode still works without --live", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }));
    fetchLifecycleMock.mockResolvedValue(undefined);
    readSnapshotMock.mockResolvedValue(null);

    const plugins: LexiconPlugin[] = [createMockPlugin({ name: "aws" })];

    const ctx = {
      args: makeArgs({ command: "state", path: "diff", extraPositional: "prod", live: false }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    };

    const exit = await runLifecycleDiff(ctx);

    expect(exit).toBe(0);
    const output = stdoutBuf.join("\n");
    expect(output).toContain("aws");
    expect(output).toContain("bucket");
    expect(output).toContain("added");
  });

  // #1014 — property-level drift, gated purely on the deep capability.
  describe("deep observation (#1014)", () => {
    const withDeep = (over: Parameters<typeof createMockPlugin>[0] = {}) =>
      createMockPlugin({
        name: "aws",
        emulator: awsEmulatorStub,
        describeResources: staticObservation({ bucket: meta() }),
        observeResourcesDeep: staticDeepObservation({
          bucket: {
            type: "AWS::S3::Bucket",
            properties: { Versioning: "Suspended", Logging: { Target: "audit" } },
          },
        }),
        ...over,
      });

    const runDiff = async (plugins: LexiconPlugin[], args: Partial<ParsedArgs> = {}) => {
      buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }));
      // Declared: versioning on, nothing about logging.
      const build = makeBuildResult({ aws: ["bucket"] });
      build.entities.set("bucket", {
        lexicon: "aws",
        entityType: "AWS::S3::Bucket",
        props: { Versioning: "Enabled" },
      } as never);
      buildMock.mockResolvedValue(build);
      fetchLifecycleMock.mockResolvedValue(undefined);
      readSnapshotMock.mockResolvedValue(null);
      return runLifecycleDiff({
        args: makeArgs({ command: "state", path: "diff", extraPositional: "prod", live: true, ...args }),
        plugins,
        serializers: plugins.map((p) => p.serializer),
      } as never);
    };

    test("reports the changed property and the undeclared one", async () => {
      await runDiff([withDeep()]);
      const output = stdoutBuf.join("\n");
      expect(output).toContain("aws (properties)");
      expect(output).toContain("Versioning: Enabled → Suspended");
      expect(output).toContain("Logging.Target: <undeclared> → audit");
    });

    test("a lexicon with no deep reader prints nothing extra", async () => {
      await runDiff([createMockPlugin({ name: "aws", describeResources: staticObservation({ bucket: meta() }) })]);
      expect(stdoutBuf.join("\n")).not.toContain("(properties)");
    });

    test("an accepted deviation in the baseline stops re-alerting", async () => {
      readBlobFromPathMock.mockResolvedValue(
        JSON.stringify({
          baseline: "v1",
          environment: "prod",
          lexicons: { aws: { bucket: { accepted: [{ path: "Logging.Target", value: "audit" }] } } },
        }),
      );
      await runDiff([withDeep()]);
      const output = stdoutBuf.join("\n");
      expect(output).toContain("Versioning: Enabled → Suspended");
      expect(output).not.toContain("Logging.Target: <undeclared>");
      expect(output).toContain("ACCEPTED (in the baseline; not drift)");
    });

    test("--json carries the property drift under the lexicon's `deep` key", async () => {
      await runDiff([withDeep()], { json: true });
      const payload = JSON.parse(stdoutBuf.join("\n")) as {
        lexicons: { aws: { deep: { drifted: Array<{ changes: Array<{ path: string }> }> } } };
      };
      expect(payload.lexicons.aws.deep.drifted[0].changes.map((c) => c.path).sort()).toEqual([
        "Logging.Target",
        "Versioning",
      ]);
    });

    test("a deep read that could not look is a hole, not drift", async () => {
      await runDiff([
        withDeep({
          observeResourcesDeep: staticDeepObservation(
            {},
            { bucket: { type: "AWS::S3::Bucket", reason: "no-credentials", detail: "token expired" } },
          ),
        }),
      ]);
      const output = `${stdoutBuf.join("\n")}\n${stderrBuf.join("\n")}`;
      expect(output).toContain("PROPERTIES UNOBSERVED");
      expect(output).toContain("no credentials");
      expect(output).toContain("could not be observed — that part of the estate is unknown, not clean");
    });

    test("--update-baseline writes what was reported and pushes it", async () => {
      await runDiff([withDeep()], { updateBaseline: true });
      expect(writeBlobToPathMock).toHaveBeenCalledTimes(1);
      const [environment, filename, content] = writeBlobToPathMock.mock.calls[0] as [string, string, string];
      expect(environment).toBe("prod");
      expect(filename).toBe("observation-baseline.json");
      const written = JSON.parse(content) as {
        lexicons: { aws: { bucket: { accepted: Array<{ path: string; value: unknown }> } } };
      };
      expect(written.lexicons.aws.bucket.accepted.map((a) => a.path)).toEqual(["Logging.Target", "Versioning"]);
      expect(pushLifecycleMock).toHaveBeenCalled();
      expect(stderrBuf.join("\n")).toContain("accepted 2 deviation(s)");
    });

    test("--update-baseline with nothing reported writes nothing", async () => {
      await runDiff([
        withDeep({ observeResourcesDeep: staticDeepObservation({}) }),
      ], { updateBaseline: true });
      expect(writeBlobToPathMock).not.toHaveBeenCalled();
      expect(stderrBuf.join("\n")).toContain("nothing to accept");
    });
  });

  // #1166 — an environment can declare its own endpoint (a local emulator like
  // Floci), applied to the ambient var of every observing lexicon that has one
  // unless the ambient shell already set it.
  describe("declared endpoint (#1166)", () => {
    const prevEndpoint = process.env.AWS_ENDPOINT_URL;

    afterEach(() => {
      if (prevEndpoint === undefined) delete process.env.AWS_ENDPOINT_URL;
      else process.env.AWS_ENDPOINT_URL = prevEndpoint;
    });

    test("applies the declared endpoint to AWS_ENDPOINT_URL for the live describe, then restores it", async () => {
      delete process.env.AWS_ENDPOINT_URL;
      buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }));
      fetchLifecycleMock.mockResolvedValue(undefined);
      readSnapshotMock.mockResolvedValue(null);
      loadChantConfigMock.mockResolvedValue({
        config: { environments: [{ name: "floci", endpoint: "http://localhost:4566" }] },
      });

      let seenDuringDescribe: string | undefined;
      const plugins: LexiconPlugin[] = [
        createMockPlugin({
          name: "aws",
          emulator: awsEmulatorStub,
          describeResources: async () => {
            seenDuringDescribe = process.env.AWS_ENDPOINT_URL;
            return {};
          },
        }),
      ];

      const exit = await runLifecycleDiff({
        args: makeArgs({ path: "diff", extraPositional: "floci", live: true }),
        plugins,
        serializers: plugins.map((p) => p.serializer),
      });

      expect(exit).toBe(0);
      expect(seenDuringDescribe).toBe("http://localhost:4566");
      expect(process.env.AWS_ENDPOINT_URL).toBeUndefined(); // restored
      expect(stderrBuf.join("\n")).toMatch(/environment "floci" declares endpoint http:\/\/localhost:4566/);
    });

    test("ambient AWS_ENDPOINT_URL still wins over the declared endpoint", async () => {
      process.env.AWS_ENDPOINT_URL = "http://real-endpoint.example";
      buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }));
      fetchLifecycleMock.mockResolvedValue(undefined);
      readSnapshotMock.mockResolvedValue(null);
      loadChantConfigMock.mockResolvedValue({
        config: { environments: [{ name: "floci", endpoint: "http://localhost:4566" }] },
      });

      let seenDuringDescribe: string | undefined;
      const plugins: LexiconPlugin[] = [
        createMockPlugin({
          name: "aws",
          emulator: awsEmulatorStub,
          describeResources: async () => {
            seenDuringDescribe = process.env.AWS_ENDPOINT_URL;
            return {};
          },
        }),
      ];

      const exit = await runLifecycleDiff({
        args: makeArgs({ path: "diff", extraPositional: "floci", live: true }),
        plugins,
        serializers: plugins.map((p) => p.serializer),
      });

      expect(exit).toBe(0);
      expect(seenDuringDescribe).toBe("http://real-endpoint.example");
      expect(process.env.AWS_ENDPOINT_URL).toBe("http://real-endpoint.example");
      expect(stderrBuf.join("\n")).toMatch(/ambient AWS_ENDPOINT_URL already set/);
    });
  });
});

describe("runLifecyclePlan", () => {
  let stdoutBuf: string[];
  let stderrBuf: string[];

  beforeEach(() => {
    stdoutBuf = [];
    stderrBuf = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { stdoutBuf.push(s); });
    vi.spyOn(console, "error").mockImplementation((s: string) => { stderrBuf.push(s); });
    buildMock.mockReset();
    fetchLifecycleMock.mockReset();
    fetchLifecycleMock.mockResolvedValue(undefined);
    readSnapshotMock.mockReset();
    readSnapshotMock.mockResolvedValue(null);
    loadChantConfigMock.mockReset();
    loadChantConfigMock.mockResolvedValue({ config: {} });
  });

  test("happy path: proposes a create for a declared, unobserved-nowhere-else entity", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }));
    const plugins: LexiconPlugin[] = [
      createMockPlugin({ name: "aws", emulator: awsEmulatorStub, describeResources: staticDescribeResources({}) }),
    ];
    const exit = await runLifecyclePlan({
      args: makeArgs({ path: "plan", extraPositional: "prod" }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    });
    expect(exit).toBe(0);
    expect(stdoutBuf.join("\n")).toContain("bucket");
  });

  // #1620 — the resolved read address rides plan entries the same way it rides
  // the live diff. Regression: the plan path dropped the observation's queried
  // map, so only unobserved rows ever carried an address while the docs
  // promised it per-entry.
  test("--json carries the observation's queried address on observed entries", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ k8s: ["web"] }));
    const plugins: LexiconPlugin[] = [
      createMockPlugin({
        name: "k8s",
        describeResources: async () => ({
          observation: "v1" as const,
          resources: { web: meta({ type: "K8s::Apps::Deployment" }) },
          queried: { web: "/apis/apps/v1/namespaces/default/deployments/web" },
        }),
      }),
    ];
    const exit = await runLifecyclePlan({
      args: makeArgs({ path: "plan", extraPositional: "prod", json: true }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    });
    expect(exit).toBe(0);
    const plan = JSON.parse(stdoutBuf.join("\n"));
    const web = plan.entries.find((e: { name: string }) => e.name === "web");
    expect(web.queried).toBe("/apis/apps/v1/namespaces/default/deployments/web");
  });

  // #1166 — plan is always a live read (no `--live` flag of its own), so a
  // declared environment endpoint applies here exactly as it does for
  // `chant graph --live` / `chant lifecycle diff --live`.
  describe("declared endpoint (#1166)", () => {
    const prevEndpoint = process.env.AWS_ENDPOINT_URL;

    afterEach(() => {
      if (prevEndpoint === undefined) delete process.env.AWS_ENDPOINT_URL;
      else process.env.AWS_ENDPOINT_URL = prevEndpoint;
    });

    test("applies the declared endpoint to AWS_ENDPOINT_URL for the plan's describe, then restores it", async () => {
      delete process.env.AWS_ENDPOINT_URL;
      buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }));
      loadChantConfigMock.mockResolvedValue({
        config: { environments: [{ name: "floci", endpoint: "http://localhost:4566" }] },
      });

      let seenDuringDescribe: string | undefined;
      const plugins: LexiconPlugin[] = [
        createMockPlugin({
          name: "aws",
          emulator: awsEmulatorStub,
          describeResources: async () => {
            seenDuringDescribe = process.env.AWS_ENDPOINT_URL;
            return {};
          },
        }),
      ];

      const exit = await runLifecyclePlan({
        args: makeArgs({ path: "plan", extraPositional: "floci" }),
        plugins,
        serializers: plugins.map((p) => p.serializer),
      });

      expect(exit).toBe(0);
      expect(seenDuringDescribe).toBe("http://localhost:4566");
      expect(process.env.AWS_ENDPOINT_URL).toBeUndefined();
      expect(stderrBuf.join("\n")).toMatch(/environment "floci" declares endpoint http:\/\/localhost:4566/);
    });

    test("ambient AWS_ENDPOINT_URL still wins over the declared endpoint", async () => {
      process.env.AWS_ENDPOINT_URL = "http://real-endpoint.example";
      buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }));
      loadChantConfigMock.mockResolvedValue({
        config: { environments: [{ name: "floci", endpoint: "http://localhost:4566" }] },
      });

      let seenDuringDescribe: string | undefined;
      const plugins: LexiconPlugin[] = [
        createMockPlugin({
          name: "aws",
          emulator: awsEmulatorStub,
          describeResources: async () => {
            seenDuringDescribe = process.env.AWS_ENDPOINT_URL;
            return {};
          },
        }),
      ];

      const exit = await runLifecyclePlan({
        args: makeArgs({ path: "plan", extraPositional: "floci" }),
        plugins,
        serializers: plugins.map((p) => p.serializer),
      });

      expect(exit).toBe(0);
      expect(seenDuringDescribe).toBe("http://real-endpoint.example");
      expect(process.env.AWS_ENDPOINT_URL).toBe("http://real-endpoint.example");
      expect(stderrBuf.join("\n")).toMatch(/ambient AWS_ENDPOINT_URL already set/);
    });
  });
});

describe("runLifecycleSnapshot", () => {
  let stdoutBuf: string[];
  let stderrBuf: string[];

  beforeEach(() => {
    stdoutBuf = [];
    stderrBuf = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { stdoutBuf.push(s); });
    vi.spyOn(console, "error").mockImplementation((s: string) => { stderrBuf.push(s); });
    buildMock.mockReset();
    takeSnapshotMock.mockReset();
    loadChantConfigMock.mockReset();
    loadChantConfigMock.mockResolvedValue({ config: { environments: ["prod"] } });
  });

  test("missing environment arg → exit 1 with helpful message", async () => {
    const ctx = {
      args: makeArgs({ command: "state", path: "snapshot" }),
      plugins: [],
      serializers: [],
    };
    const exit = await runLifecycleSnapshot(ctx);
    expect(exit).toBe(1);
    expect(stderrBuf.join("\n")).toContain("Environment is required");
  });

  test("environment not in config → exit 1", async () => {
    const ctx = {
      args: makeArgs({ command: "state", path: "snapshot", extraPositional: "unknown" }),
      plugins: [],
      serializers: [],
    };
    const exit = await runLifecycleSnapshot(ctx);
    expect(exit).toBe(1);
    expect(stderrBuf.join("\n")).toContain('Unknown environment "unknown"');
  });

  test("no plugins implement describeResources → exit 1 with hint", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["x"] }));
    const plugins: LexiconPlugin[] = [createMockPlugin({ name: "aws" })];
    const ctx = {
      args: makeArgs({ command: "state", path: "snapshot", extraPositional: "prod" }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    };
    const exit = await runLifecycleSnapshot(ctx);
    expect(exit).toBe(1);
    expect(stderrBuf.join("\n")).toContain("No plugins implement describeResources");
  });

  test("happy path: writes snapshot via takeSnapshot and reports counts", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }));
    takeSnapshotMock.mockResolvedValue({
      snapshots: [{ lexicon: "aws", environment: "prod", resources: { bucket: meta() } }],
      commit: "sha",
      warnings: [],
      errors: [],
    });
    const plugins: LexiconPlugin[] = [
      createMockPlugin({
        name: "aws",
        emulator: awsEmulatorStub,
        describeResources: staticDescribeResources({ bucket: meta() }),
      }),
    ];
    const ctx = {
      args: makeArgs({ command: "state", path: "snapshot", extraPositional: "prod" }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    };
    const exit = await runLifecycleSnapshot(ctx);
    expect(exit).toBe(0);
    expect(stderrBuf.join("\n")).toContain("Snapshot saved");
    expect(takeSnapshotMock).toHaveBeenCalledTimes(1);
  });

  // #1261 — each stack declares the region it deploys to. Dropping it here
  // observed every stack against the ambient region, so a multi-region estate
  // snapshotted only the stacks that shared it and reported the rest as
  // "no valid resources or artifacts returned".
  test("multi-stack: each stack's declared region reaches takeSnapshot", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }));
    takeSnapshotMock.mockResolvedValue({
      snapshots: [{ lexicon: "aws", environment: "prod", resources: { bucket: meta() } }],
      commit: "sha",
      warnings: [],
      errors: [],
    });
    loadChantConfigMock.mockResolvedValue({ config: { environments: ["prod"], stacks: [
      { name: "app-us-east-1", src: "src/us-east-1", region: "us-east-1" },
      { name: "app-us-west-2", src: "src/us-west-2", region: "us-west-2" },
    ] } });
    const plugins: LexiconPlugin[] = [
      createMockPlugin({ name: "aws", describeResources: staticDescribeResources({ bucket: meta() }) }),
    ];

    const exit = await runLifecycleSnapshot({
      args: makeArgs({ command: "state", path: "snapshot", extraPositional: "prod" }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    });

    expect(exit).toBe(0);
    // toMatchObject, not toEqual: this test is about region reaching the
    // snapshot, and pinning the whole options object makes it fail whenever an
    // unrelated option is added.
    const opts = takeSnapshotMock.mock.calls.map((c) => c[3]);
    expect(opts[0]).toMatchObject({ stack: "app-us-east-1", region: "us-east-1" });
    expect(opts[1]).toMatchObject({ stack: "app-us-west-2", region: "us-west-2" });
  });

  // #1267 — --deep is opt-in and reaches takeSnapshot; without it the snapshot
  // stays thin, which is what every pre-#1267 snapshot was.
  test("--deep reaches takeSnapshot; absent means identity", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }));
    takeSnapshotMock.mockResolvedValue({
      snapshots: [{ lexicon: "aws", environment: "prod", resources: { bucket: meta() } }],
      commit: "sha",
      warnings: [],
      errors: [],
    });
    const plugins: LexiconPlugin[] = [
      createMockPlugin({ name: "aws", describeResources: staticDescribeResources({ bucket: meta() }) }),
    ];
    const ctx = (deep?: boolean) => ({
      args: makeArgs({ command: "state", path: "snapshot", extraPositional: "prod", ...(deep ? { deep: true } : {}) }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    });

    await runLifecycleSnapshot(ctx(true));
    expect(takeSnapshotMock.mock.calls[0][3]).toMatchObject({ deep: true });

    takeSnapshotMock.mockClear();
    await runLifecycleSnapshot(ctx());
    expect(takeSnapshotMock.mock.calls[0][3]).toMatchObject({ deep: undefined });
  });

  test("stack without a declared region: region stays undefined", async () => {
    buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }));
    takeSnapshotMock.mockResolvedValue({
      snapshots: [{ lexicon: "aws", environment: "prod", resources: { bucket: meta() } }],
      commit: "sha",
      warnings: [],
      errors: [],
    });
    loadChantConfigMock.mockResolvedValue({ config: { environments: ["prod"], stacks: [
      { name: "app", src: "src/app" },
    ] } });
    const plugins: LexiconPlugin[] = [
      createMockPlugin({ name: "aws", describeResources: staticDescribeResources({ bucket: meta() }) }),
    ];

    await runLifecycleSnapshot({
      args: makeArgs({ command: "state", path: "snapshot", extraPositional: "prod" }),
      plugins,
      serializers: plugins.map((p) => p.serializer),
    });

    expect(takeSnapshotMock.mock.calls[0][3]).toMatchObject({ stack: "app", region: undefined });
  });

  // #1166 — a snapshot is always a live read, so a declared environment
  // endpoint applies here too, unless the ambient shell already set it.
  describe("declared endpoint (#1166)", () => {
    const prevEndpoint = process.env.AWS_ENDPOINT_URL;

    afterEach(() => {
      if (prevEndpoint === undefined) delete process.env.AWS_ENDPOINT_URL;
      else process.env.AWS_ENDPOINT_URL = prevEndpoint;
    });

    test("applies the declared endpoint to AWS_ENDPOINT_URL for takeSnapshot, then restores it", async () => {
      delete process.env.AWS_ENDPOINT_URL;
      buildMock.mockResolvedValue(makeBuildResult({ aws: ["bucket"] }));
      loadChantConfigMock.mockResolvedValue({
        config: { environments: [{ name: "floci", endpoint: "http://localhost:4566" }] },
      });
      let seenDuringSnapshot: string | undefined;
      takeSnapshotMock.mockImplementation(async () => {
        seenDuringSnapshot = process.env.AWS_ENDPOINT_URL;
        return { snapshots: [], commit: "sha", warnings: [], errors: [] };
      });
      const plugins: LexiconPlugin[] = [
        createMockPlugin({ name: "aws", emulator: awsEmulatorStub, describeResources: staticDescribeResources({}) }),
      ];
      const exit = await runLifecycleSnapshot({
        args: makeArgs({ command: "state", path: "snapshot", extraPositional: "floci" }),
        plugins,
        serializers: plugins.map((p) => p.serializer),
      });
      expect(exit).toBe(0);
      expect(seenDuringSnapshot).toBe("http://localhost:4566");
      expect(process.env.AWS_ENDPOINT_URL).toBeUndefined();
      expect(stderrBuf.join("\n")).toMatch(/environment "floci" declares endpoint http:\/\/localhost:4566/);
    });
  });
});

describe("runLifecycleShow", () => {
  let stdoutBuf: string[];
  let stderrBuf: string[];

  beforeEach(() => {
    stdoutBuf = [];
    stderrBuf = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { stdoutBuf.push(s); });
    vi.spyOn(console, "error").mockImplementation((s: string) => { stderrBuf.push(s); });
    fetchLifecycleMock.mockReset();
    readSnapshotMock.mockReset();
    readEnvironmentSnapshotsMock.mockReset();
  });

  test("missing environment arg → exit 1", async () => {
    const ctx = {
      args: makeArgs({ command: "state", path: "show" }),
      plugins: [], serializers: [],
    };
    expect(await runLifecycleShow(ctx)).toBe(1);
    expect(stderrBuf.join("\n")).toContain("Environment is required");
  });

  test("specific lexicon: prints snapshot table when found", async () => {
    fetchLifecycleMock.mockResolvedValue(undefined);
    readSnapshotMock.mockResolvedValue(JSON.stringify({
      lexicon: "aws", environment: "prod", commit: "x", timestamp: "t",
      resources: { bucket: { type: "AWS::S3::Bucket", physicalId: "b-1", status: "OK" } },
    }));
    const ctx = {
      args: makeArgs({ command: "state", path: "show", extraPositional: "prod", extraPositional2: "aws" }),
      plugins: [], serializers: [],
    };
    expect(await runLifecycleShow(ctx)).toBe(0);
    const out = stdoutBuf.join("\n");
    expect(out).toContain("bucket");
    expect(out).toContain("AWS::S3::Bucket");
  });

  test("specific lexicon: returns 1 when no snapshot found", async () => {
    fetchLifecycleMock.mockResolvedValue(undefined);
    readSnapshotMock.mockResolvedValue(null);
    const ctx = {
      args: makeArgs({ command: "state", path: "show", extraPositional: "prod", extraPositional2: "aws" }),
      plugins: [], serializers: [],
    };
    expect(await runLifecycleShow(ctx)).toBe(1);
    expect(stderrBuf.join("\n")).toContain("No snapshot found");
  });

  test("no lexicon: lists all lexicons in env", async () => {
    fetchLifecycleMock.mockResolvedValue(undefined);
    readEnvironmentSnapshotsMock.mockResolvedValue(new Map([
      ["aws", JSON.stringify({ lexicon: "aws", environment: "prod", commit: "x", timestamp: "t", resources: {} })],
      ["gcp", JSON.stringify({ lexicon: "gcp", environment: "prod", commit: "x", timestamp: "t", resources: {} })],
    ]));
    const ctx = {
      args: makeArgs({ command: "state", path: "show", extraPositional: "prod" }),
      plugins: [], serializers: [],
    };
    expect(await runLifecycleShow(ctx)).toBe(0);
    const out = stdoutBuf.join("\n");
    expect(out).toContain("prod/aws");
    expect(out).toContain("prod/gcp");
  });
});

describe("runLifecycleLog", () => {
  let stdoutBuf: string[];
  let stderrBuf: string[];

  beforeEach(() => {
    stdoutBuf = [];
    stderrBuf = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { stdoutBuf.push(s); });
    vi.spyOn(console, "error").mockImplementation((s: string) => { stderrBuf.push(s); });
    fetchLifecycleMock.mockReset();
    listSnapshotsMock.mockReset();
  });

  test("returns 1 with message when no entries exist", async () => {
    fetchLifecycleMock.mockResolvedValue(undefined);
    listSnapshotsMock.mockResolvedValue([]);
    const ctx = {
      args: makeArgs({ command: "state", path: "log" }),
      plugins: [], serializers: [],
    };
    expect(await runLifecycleLog(ctx)).toBe(1);
    expect(stderrBuf.join("\n")).toContain("No state snapshots");
  });

  test("prints commit / date / message rows for each entry", async () => {
    fetchLifecycleMock.mockResolvedValue(undefined);
    listSnapshotsMock.mockResolvedValue([
      { commit: "abcdef1234567890", date: "2026-05-01T00:00:00Z", message: "Snapshot prod" },
      { commit: "fedcba9876543210", date: "2026-05-02T00:00:00Z", message: "Snapshot staging" },
    ]);
    const ctx = {
      args: makeArgs({ command: "state", path: "log" }),
      plugins: [], serializers: [],
    };
    expect(await runLifecycleLog(ctx)).toBe(0);
    const out = stdoutBuf.join("\n");
    expect(out).toContain("abcdef1");
    expect(out).toContain("Snapshot prod");
    expect(out).toContain("Snapshot staging");
  });
});

describe("runLifecycleUnknown", () => {
  test("returns 1 with subcommand list", async () => {
    const stderrBuf: string[] = [];
    vi.spyOn(console, "error").mockImplementation((s: string) => { stderrBuf.push(s); });
    const ctx = {
      args: makeArgs({ command: "state", path: "garbage" }),
      plugins: [], serializers: [],
    };
    expect(await runLifecycleUnknown(ctx)).toBe(1);
    const stderr = stderrBuf.join("\n");
    expect(stderr).toContain("snapshot");
    expect(stderr).toContain("show");
    expect(stderr).toContain("diff");
    expect(stderr).toContain("log");
  });
});
