import { describe, test, expect, vi, beforeEach } from "vitest";
import { createMockPlugin, staticDescribeResources } from "@intentius/chant-test-utils";
import type { LexiconPlugin, ResourceMetadata } from "../../lexicon";
import type { BuildResult } from "../../build";
import type { ParsedArgs } from "../registry";

const getHeadCommitMock = vi.fn();
const fetchLifecycleMock = vi.fn();
const pushLifecycleMock = vi.fn();

const appendReleaseRecordMock = vi.fn();
const readReleaseLedgerMock = vi.fn();
const listReleaseEnvironmentsMock = vi.fn();

const loadChantConfigMock = vi.fn();
const buildMock = vi.fn();
const discoverComponentsMock = vi.fn();
const findBuildManifestByArtifactDigestMock = vi.fn();

vi.mock("../../lifecycle/git", () => ({
  getHeadCommit: (...args: unknown[]) => getHeadCommitMock(...args),
  fetchLifecycle: (...args: unknown[]) => fetchLifecycleMock(...args),
  pushLifecycle: (...args: unknown[]) => pushLifecycleMock(...args),
  StaleLifecycleBranchError: class StaleLifecycleBranchError extends Error {},
}));

vi.mock("../../lifecycle/build-ledger-store", () => ({
  findBuildManifestByArtifactDigest: (...args: unknown[]) => findBuildManifestByArtifactDigestMock(...args),
}));

vi.mock("../../lifecycle/release-ledger", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/release-ledger")>("../../lifecycle/release-ledger");
  return {
    ...actual,
    appendReleaseRecord: (...args: unknown[]) => appendReleaseRecordMock(...args),
    readReleaseLedger: (...args: unknown[]) => readReleaseLedgerMock(...args),
    listReleaseEnvironments: (...args: unknown[]) => listReleaseEnvironmentsMock(...args),
  };
});

vi.mock("../../config", () => ({
  loadChantConfig: (...args: unknown[]) => loadChantConfigMock(...args),
}));

vi.mock("../../build", () => ({
  build: (...args: unknown[]) => buildMock(...args),
}));

vi.mock("../../components/discover", () => ({
  discoverComponents: (...args: unknown[]) => discoverComponentsMock(...args),
}));

const { runComponentsReleaseRecord, runComponentsStatus, runComponentsUnknown } = await import("./components");

function makeArgs(overrides: Partial<ParsedArgs>): ParsedArgs {
  return {
    command: "components",
    path: "release",
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
    for (const name of names) entities.set(name, { lexicon, entityType: `${lexicon}::Mock`, props: {} });
  }
  return {
    outputs: new Map(Object.keys(entitiesByLexicon).map((l) => [l, "{}"])),
    entities,
    dependencies: new Map(),
    errors: [],
    warnings: [],
    manifest: { lexicons: Object.keys(entitiesByLexicon), outputs: {}, deployOrder: [] },
    sourceFileCount: 1,
  } as unknown as BuildResult;
}

const meta = (overrides: Partial<ResourceMetadata> = {}): ResourceMetadata => ({
  type: "AWS::ECS::Service",
  status: "ACTIVE",
  physicalId: "svc-1",
  ownership: "owned",
  ...overrides,
});

describe("components handlers", () => {
  let stdoutBuf: string[];
  let stderrBuf: string[];

  beforeEach(() => {
    stdoutBuf = [];
    stderrBuf = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { stdoutBuf.push(s); });
    vi.spyOn(console, "error").mockImplementation((s: string) => { stderrBuf.push(s); });

    getHeadCommitMock.mockReset().mockResolvedValue("abc123headsha");
    fetchLifecycleMock.mockReset().mockResolvedValue(true);
    pushLifecycleMock.mockReset().mockResolvedValue(true);
    appendReleaseRecordMock.mockReset();
    readReleaseLedgerMock.mockReset().mockResolvedValue({ records: [], malformed: 0 });
    listReleaseEnvironmentsMock.mockReset().mockResolvedValue([]);
    loadChantConfigMock.mockReset().mockResolvedValue({ config: {} });
    buildMock.mockReset().mockResolvedValue(makeBuildResult({}));
    discoverComponentsMock.mockReset().mockResolvedValue({ components: new Map(), sourceFiles: [], errors: [] });
    findBuildManifestByArtifactDigestMock.mockReset().mockResolvedValue(undefined);

    delete process.env.GITHUB_RUN_ID;
    delete process.env.CI_PIPELINE_ID;
    delete process.env.GITHUB_ACTOR;
    delete process.env.GITLAB_USER_LOGIN;
    delete process.env.USER;
  });

  describe("runComponentsReleaseRecord", () => {
    test("requires an environment", async () => {
      const ctx = { args: makeArgs({ extraPositional: undefined }), plugins: [], serializers: [] };
      const exit = await runComponentsReleaseRecord(ctx);
      expect(exit).toBe(1);
      expect(stderrBuf.join("\n")).toContain("Environment is required");
    });

    test("requires --component and --digest", async () => {
      const ctx = { args: makeArgs({ extraPositional: "prod" }), plugins: [], serializers: [] };
      const exit = await runComponentsReleaseRecord(ctx);
      expect(exit).toBe(1);
      expect(stderrBuf.join("\n")).toContain("--component and --digest are required");
    });

    test("requires a resolvable actor", async () => {
      const ctx = {
        args: makeArgs({ extraPositional: "prod", component: "svc", digest: "sha256:abc", actor: undefined }),
        plugins: [],
        serializers: [],
      };
      const exit = await runComponentsReleaseRecord(ctx);
      expect(exit).toBe(1);
      expect(stderrBuf.join("\n")).toContain("actor");
    });

    test("appends a record with resolved git sha, run id, and explicit actor, then pushes", async () => {
      appendReleaseRecordMock.mockResolvedValue({
        commit: "a".repeat(40),
        record: {
          version: 1,
          component: "svc",
          env: "prod",
          digest: "sha256:abc",
          gitSha: "abc123headsha",
          runId: "local-123",
          timestamp: "2026-01-01T00:00:00.000Z",
          actor: "alice",
        },
      });

      const ctx = {
        args: makeArgs({ extraPositional: "prod", component: "svc", digest: "sha256:abc", actor: "alice" }),
        plugins: [],
        serializers: [],
      };
      const exit = await runComponentsReleaseRecord(ctx);

      expect(exit).toBe(0);
      expect(appendReleaseRecordMock).toHaveBeenCalledTimes(1);
      const [input] = appendReleaseRecordMock.mock.calls[0];
      expect(input).toMatchObject({ component: "svc", env: "prod", digest: "sha256:abc", gitSha: "abc123headsha", actor: "alice" });
      expect(typeof input.timestamp).toBe("string");
      expect(pushLifecycleMock).toHaveBeenCalledTimes(1);
    });

    test("--json prints the recorded record", async () => {
      const record = {
        version: 1 as const,
        component: "svc",
        env: "prod",
        digest: "sha256:abc",
        gitSha: "abc123headsha",
        runId: "local-123",
        timestamp: "2026-01-01T00:00:00.000Z",
        actor: "alice",
      };
      appendReleaseRecordMock.mockResolvedValue({ commit: "a".repeat(40), record });

      const ctx = {
        args: makeArgs({ extraPositional: "prod", component: "svc", digest: "sha256:abc", actor: "alice", json: true }),
        plugins: [],
        serializers: [],
      };
      await runComponentsReleaseRecord(ctx);
      expect(JSON.parse(stdoutBuf.join(""))).toMatchObject(record);
    });
  });

  describe("runComponentsStatus", () => {
    test("no release records anywhere -> warns and returns 0", async () => {
      listReleaseEnvironmentsMock.mockResolvedValue([]);
      const ctx = { args: makeArgs({ extraPositional: undefined }), plugins: [], serializers: [] };
      const exit = await runComponentsStatus(ctx);
      expect(exit).toBe(0);
      expect(stderrBuf.join("\n")).toContain("No release records found");
    });

    test("without --live, recorded rows report 'unknown' reconciliation", async () => {
      readReleaseLedgerMock.mockResolvedValue({
        records: [{
          version: 1,
          component: "svc",
          env: "prod",
          digest: "sha256:abc",
          gitSha: "sha1",
          runId: "run-1",
          timestamp: "2026-01-01T00:00:00.000Z",
          actor: "alice",
        }],
        malformed: 0,
      });

      const ctx = {
        args: makeArgs({ extraPositional: "prod", json: true }),
        plugins: [],
        serializers: [],
      };
      const exit = await runComponentsStatus(ctx);
      expect(exit).toBe(0);
      const rows = JSON.parse(stdoutBuf.join(""));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ component: "svc", reconciliation: "unknown" });
    });

    test("--live reconciles against describeResources via ownership/change-set", async () => {
      readReleaseLedgerMock.mockResolvedValue({
        records: [{
          version: 1,
          component: "svc",
          env: "prod",
          digest: "sha256:abc",
          gitSha: "sha1",
          runId: "run-1",
          timestamp: "2026-01-01T00:00:00.000Z",
          actor: "alice",
        }],
        malformed: 0,
      });
      buildMock.mockResolvedValue(makeBuildResult({ aws: ["svc"] }));

      const plugins: LexiconPlugin[] = [
        createMockPlugin({
          name: "aws",
          describeResources: staticDescribeResources({ svc: meta() }),
        }),
      ];

      const ctx = {
        args: makeArgs({ extraPositional: "prod", live: true, json: true }),
        plugins,
        serializers: plugins.map((p) => p.serializer),
      };
      const exit = await runComponentsStatus(ctx);
      expect(exit).toBe(0);
      const rows = JSON.parse(stdoutBuf.join(""));
      expect(rows[0]).toMatchObject({ component: "svc", reconciliation: "reconciled" });
    });

    test("--live flags an unrecorded live+owned component", async () => {
      readReleaseLedgerMock.mockResolvedValue({ records: [], malformed: 0 });
      listReleaseEnvironmentsMock.mockResolvedValue(["prod"]);
      buildMock.mockResolvedValue(makeBuildResult({ aws: ["mystery"] }));
      discoverComponentsMock.mockResolvedValue({
        components: new Map([["mystery", { component: { name: "mystery", dependsOn: [], deploy: [] }, exportName: "mystery", filePath: "x.component.ts" }]]),
        sourceFiles: [],
        errors: [],
      });

      const plugins: LexiconPlugin[] = [
        createMockPlugin({
          name: "aws",
          describeResources: staticDescribeResources({ mystery: meta() }),
        }),
      ];

      const ctx = {
        args: makeArgs({ extraPositional: "prod", live: true, json: true }),
        plugins,
        serializers: plugins.map((p) => p.serializer),
      };
      const exit = await runComponentsStatus(ctx);
      expect(exit).toBe(0);
      const rows = JSON.parse(stdoutBuf.join(""));
      expect(rows[0]).toMatchObject({ component: "mystery", reconciliation: "unrecorded" });
    });

    // #598: a component may declare `liveNames` when its own name differs
    // from the live entity/resource name(s) it owns. `runComponentsStatus`
    // must join on that mapping instead of assuming component name == entity
    // name, while components with no `liveNames` keep the identity join.
    test("--live reconciles a component whose liveNames differ from its own name (#598)", async () => {
      readReleaseLedgerMock.mockResolvedValue({
        records: [{
          version: 1,
          component: "search-svc",
          env: "prod",
          digest: "sha256:abc",
          gitSha: "sha1",
          runId: "run-1",
          timestamp: "2026-01-01T00:00:00.000Z",
          actor: "alice",
        }],
        malformed: 0,
      });
      // The live/lexicon-declared entity is named differently from the
      // component itself — exactly the case #568 flagged as unsupported.
      buildMock.mockResolvedValue(makeBuildResult({ aws: ["search-service-v2"] }));
      discoverComponentsMock.mockResolvedValue({
        components: new Map([[
          "search-svc",
          {
            component: { name: "search-svc", dependsOn: [], deploy: [], liveNames: ["search-service-v2"] },
            exportName: "searchSvc",
            filePath: "search.component.ts",
          },
        ]]),
        sourceFiles: [],
        errors: [],
      });

      const plugins: LexiconPlugin[] = [
        createMockPlugin({
          name: "aws",
          describeResources: staticDescribeResources({ "search-service-v2": meta() }),
        }),
      ];

      const ctx = {
        args: makeArgs({ extraPositional: "prod", live: true, json: true }),
        plugins,
        serializers: plugins.map((p) => p.serializer),
      };
      const exit = await runComponentsStatus(ctx);
      expect(exit).toBe(0);
      const rows = JSON.parse(stdoutBuf.join(""));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ component: "search-svc", reconciliation: "reconciled" });
    });

    test("--live still joins by identity when a component has no liveNames (no regression)", async () => {
      readReleaseLedgerMock.mockResolvedValue({
        records: [{
          version: 1,
          component: "svc",
          env: "prod",
          digest: "sha256:abc",
          gitSha: "sha1",
          runId: "run-1",
          timestamp: "2026-01-01T00:00:00.000Z",
          actor: "alice",
        }],
        malformed: 0,
      });
      buildMock.mockResolvedValue(makeBuildResult({ aws: ["svc"] }));
      discoverComponentsMock.mockResolvedValue({
        components: new Map([[
          "svc",
          { component: { name: "svc", dependsOn: [], deploy: [] }, exportName: "svc", filePath: "svc.component.ts" },
        ]]),
        sourceFiles: [],
        errors: [],
      });

      const plugins: LexiconPlugin[] = [
        createMockPlugin({
          name: "aws",
          describeResources: staticDescribeResources({ svc: meta() }),
        }),
      ];

      const ctx = {
        args: makeArgs({ extraPositional: "prod", live: true, json: true }),
        plugins,
        serializers: plugins.map((p) => p.serializer),
      };
      const exit = await runComponentsStatus(ctx);
      expect(exit).toBe(0);
      const rows = JSON.parse(stdoutBuf.join(""));
      expect(rows[0]).toMatchObject({ component: "svc", reconciliation: "reconciled" });
    });

    // #614: the JSON contract gains `build.reproducibility` and
    // `componentBom`. #609 wires a real persisted-manifest lookup
    // (findBuildManifestByArtifactDigest) in front of these fields — when no
    // manifest was ever persisted for the recorded digest (the default mock
    // behavior here, and the honest state for a digest that predates #609 or
    // was recorded via `chant components release` alone), both fields stay
    // `null` — this test locks in that they still exist in the stable JSON
    // shape (never omitted) rather than the CLI silently dropping them.
    test("JSON rows always include build.reproducibility and componentBom keys, null absent a persisted manifest", async () => {
      readReleaseLedgerMock.mockResolvedValue({
        records: [{
          version: 1,
          component: "svc",
          env: "prod",
          digest: "sha256:abc",
          gitSha: "sha1",
          runId: "run-1",
          timestamp: "2026-01-01T00:00:00.000Z",
          actor: "alice",
        }],
        malformed: 0,
      });

      const ctx = {
        args: makeArgs({ extraPositional: "prod", json: true }),
        plugins: [],
        serializers: [],
      };
      const exit = await runComponentsStatus(ctx);
      expect(exit).toBe(0);
      const rows = JSON.parse(stdoutBuf.join(""));
      expect(rows[0].build).toBeNull();
      expect(rows[0]).toHaveProperty("componentBom", null);
      expect(findBuildManifestByArtifactDigestMock).toHaveBeenCalledWith("sha256:abc");
    });

    // #609 end-to-end: when a manifest *was* persisted for the recorded
    // digest, `build`/`componentBom` resolve to real data derived from it via
    // `buildLedgerEntries`/`componentBomSummary` — the same derivation
    // build-ledger.test.ts exercises directly, now reached through the CLI.
    test("JSON rows resolve build.reproducibility and componentBom from a persisted manifest (#609)", async () => {
      readReleaseLedgerMock.mockResolvedValue({
        records: [{
          version: 1,
          component: "svc",
          env: "prod",
          digest: "sha256:image1",
          gitSha: "sha1",
          runId: "run-1",
          timestamp: "2026-01-01T00:00:00.000Z",
          actor: "alice",
        }],
        malformed: 0,
      });

      findBuildManifestByArtifactDigestMock.mockImplementation(async (digest: string) => {
        if (digest !== "sha256:image1") return undefined;
        return {
          version: 1,
          component: "svc",
          createdAt: "2026-01-01T00:00:00.000Z",
          manifestDigest: "sha256:manifestxyz",
          contents: [
            { kind: "image", path: "image.tar", digest: "sha256:image1", mediaType: "application/vnd.oci.image.layout.v1.tar", reproducibility: { basis: "best-effort" } },
            {
              kind: "sbom", path: "image.tar.sbom.json", digest: "sha256:sbomdoc",
              mediaType: "application/spdx+json", subjectDigest: "sha256:image1",
              bomKind: "software", packageCount: 7, generator: "syft",
            },
          ],
        };
      });

      const ctx = {
        args: makeArgs({ extraPositional: "prod", json: true }),
        plugins: [],
        serializers: [],
      };
      const exit = await runComponentsStatus(ctx);
      expect(exit).toBe(0);
      const rows = JSON.parse(stdoutBuf.join(""));

      expect(rows[0].build).toMatchObject({
        manifestDigest: "sha256:manifestxyz",
        sbom: { mediaType: "application/spdx+json", packageCount: 7, generator: "syft", source: "archive" },
        reproducibility: { basis: "best-effort" },
      });
      expect(rows[0].componentBom).toMatchObject({
        totalPackageCount: 7,
        isAssembly: false,
        leaves: [{ path: "image.tar.sbom.json", bomKind: "software", subjectDigest: "sha256:image1", packageCount: 7, generator: "syft" }],
      });
    });

    test("reports malformed ledger lines as a warning without failing", async () => {
      readReleaseLedgerMock.mockResolvedValue({ records: [], malformed: 2 });
      const ctx = { args: makeArgs({ extraPositional: "prod" }), plugins: [], serializers: [] };
      const exit = await runComponentsStatus(ctx);
      expect(exit).toBe(0);
      expect(stderrBuf.join("\n")).toContain("malformed");
    });
  });

  describe("runComponentsUnknown", () => {
    test("reports the unknown subcommand", async () => {
      const ctx = { args: makeArgs({ path: "bogus" }), plugins: [], serializers: [] };
      const exit = await runComponentsUnknown(ctx);
      expect(exit).toBe(1);
      expect(stderrBuf.join("\n")).toContain("Unknown components subcommand");
    });
  });
});
