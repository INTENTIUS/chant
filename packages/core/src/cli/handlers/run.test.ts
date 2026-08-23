import { describe, test, expect, vi, beforeEach } from "vitest";
import { createMockTemporalClient } from "@intentius/chant-test-utils";
import type { ParsedArgs } from "../registry";
import { EventEmitter } from "node:events";

const discoverOpsMock = vi.fn();
const loadChantConfigMock = vi.fn();
const loadTemporalClientMock = vi.fn();
const resolveProfileMock = vi.fn();
const existsSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const spawnChildMock = vi.fn();
const generateReportMock = vi.fn();
const writeReportMock = vi.fn();
const waitForTemporalSpy = vi.fn();
const runComponentsMock = vi.fn();
const resolveComponentTargetsMock = vi.fn();
const findComponentGateMock = vi.fn();
const loadComponentTemporalCodegenMock = vi.fn();
const maybeRecordAutoReleaseMock = vi.fn();
const maybePersistBuildManifestMock = vi.fn();
const listComponentsMock = vi.fn();

vi.mock("../../op/discover", () => ({ discoverOps: () => discoverOpsMock() }));
vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return { ...actual, loadChantConfig: (...args: unknown[]) => loadChantConfigMock(...args) };
});
vi.mock("../../components/auto-release", () => ({
  maybeRecordAutoRelease: (...args: unknown[]) => maybeRecordAutoReleaseMock(...args),
  extractRunDigestFromPhaseOutputs: (phaseOutputs: Record<string, Record<string, unknown>> | undefined) => {
    for (const output of Object.values(phaseOutputs ?? {})) {
      if (output && typeof output === "object" && "digest" in output) return (output as { digest: string }).digest;
    }
    return undefined;
  },
}));
vi.mock("../../components/manifest-persistence", () => ({
  maybePersistBuildManifest: (...args: unknown[]) => maybePersistBuildManifestMock(...args),
  extractRunManifestFromPhaseOutputs: (phaseOutputs: Record<string, Record<string, unknown>> | undefined) => {
    for (const output of Object.values(phaseOutputs ?? {})) {
      if (output && typeof output === "object" && "manifest" in output) return (output as { manifest: unknown }).manifest;
    }
    return undefined;
  },
}));
vi.mock("./run-client", () => ({
  loadTemporalClient: () => loadTemporalClientMock(),
  connectionOptions: (profile: { address: string }) => ({ address: profile.address }),
  resolveProfile: (...args: unknown[]) => resolveProfileMock(...args),
  resolveWorkflowId: (name: string) => `chant-op-${name}`,
}));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (p: string) => existsSyncMock(p),
    writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
    mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
  };
});
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: (...args: unknown[]) => spawnChildMock(...args) };
});
vi.mock("./run-report", () => ({
  generateReport: (...args: unknown[]) => generateReportMock(...args),
  writeReport: (...args: unknown[]) => writeReportMock(...args),
}));
vi.mock("../../components/cli-support", () => ({
  runComponents: (...args: unknown[]) => runComponentsMock(...args),
  resolveComponentTargets: (...args: unknown[]) => resolveComponentTargetsMock(...args),
  findComponentGate: (...args: unknown[]) => findComponentGateMock(...args),
  listComponents: (...args: unknown[]) => listComponentsMock(...args),
}));
vi.mock("../../components/temporal-codegen-loader", () => ({
  loadComponentTemporalCodegen: () => loadComponentTemporalCodegenMock(),
}));

// Speed up runOp polling — POLL_INTERVAL_MS is 3000 in production. We use
// fake timers in the runOp suite below; vi.advanceTimersByTime drives the loop.

const { runOpList, runOpStatus, runOpLog, runOpSignal, runOpCancel, runOp, runOpComponents } = await import("./run");

function makeArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: "run", path: ".",
    format: "", fix: false, watch: false, verbose: false, help: false, live: false,
    // These suites exercise the Temporal path; local mode is the CLI default,
    // so opt in explicitly here. Local-mode behavior is covered separately below.
    temporal: true,
    ...overrides,
  };
}

function makeOp(name: string, depends: string[] = []): [string, { config: { name: string; phases: unknown[]; taskQueue?: string; depends?: string[]; overview: string } }] {
  return [name, { config: { name, phases: [], depends, overview: `${name} overview` } }];
}

function setupTemporalClient(mock: ReturnType<typeof createMockTemporalClient>) {
  loadTemporalClientMock.mockResolvedValue({
    Connection: { connect: vi.fn(async () => ({})) },
    Client: vi.fn(function () { return mock.client; }) as unknown as new () => unknown,
  });
  loadChantConfigMock.mockResolvedValue({ config: {} });
  resolveProfileMock.mockReturnValue({ address: "localhost:7233", namespace: "default", taskQueue: "q" });
}

function makeStdoutSpy() {
  const buf: string[] = [];
  vi.spyOn(console, "log").mockImplementation((s: string) => { buf.push(s); });
  return buf;
}

function makeStderrSpy() {
  const buf: string[] = [];
  vi.spyOn(console, "error").mockImplementation((s: string) => { buf.push(s); });
  return buf;
}

describe("runOpList", () => {
  beforeEach(() => {
    discoverOpsMock.mockReset();
    loadTemporalClientMock.mockReset();
    loadChantConfigMock.mockReset();
    resolveProfileMock.mockReset();
  });

  test("warns when no Ops discovered, returns 0", async () => {
    discoverOpsMock.mockResolvedValue({ ops: new Map(), errors: [] });
    const stderr = makeStderrSpy();
    const exit = await runOpList({ args: makeArgs(), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    expect(stderr.join("\n")).toContain("No Op definitions found");
  });

  test("prints table with one row per Op when Temporal connection fails", async () => {
    discoverOpsMock.mockResolvedValue({
      ops: new Map([makeOp("alb-deploy"), makeOp("infra")]),
      errors: [],
    });
    // No Temporal — make loadTemporalClient throw so degraded path is exercised
    loadTemporalClientMock.mockRejectedValue(new Error("not installed"));
    const stdout = makeStdoutSpy();
    const exit = await runOpList({ args: makeArgs(), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    const out = stdout.join("\n");
    expect(out).toContain("NAME");
    expect(out).toContain("alb-deploy");
    expect(out).toContain("infra");
  });

  test("annotates Ops with Temporal status when client is available", async () => {
    discoverOpsMock.mockResolvedValue({ ops: new Map([makeOp("alb-deploy")]), errors: [] });
    setupTemporalClient(createMockTemporalClient({
      describeByWorkflowId: {
        "chant-op-alb-deploy": {
          workflowId: "chant-op-alb-deploy", runId: "r1",
          status: { name: "RUNNING" }, startTime: new Date(),
          taskQueue: "alb-deploy", type: { name: "albDeployWorkflow" },
        },
      },
    }));
    const stdout = makeStdoutSpy();
    const exit = await runOpList({ args: makeArgs(), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    expect(stdout.join("\n")).toContain("RUNNING");
  });
});

// ── chant run list --components (#599) ──────────────────────────────────────

describe("runOpList --components", () => {
  beforeEach(() => {
    listComponentsMock.mockReset();
    loadTemporalClientMock.mockReset();
    loadChantConfigMock.mockReset();
    resolveProfileMock.mockReset();
  });

  test("without --temporal → exit 1, actionable message, no discovery", async () => {
    const stderr = makeStderrSpy();
    const exit = await runOpList({ args: makeArgs({ components: true, temporal: false }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("not available in local mode");
    expect(listComponentsMock).not.toHaveBeenCalled();
  });

  test("warns when no components discovered, returns 0", async () => {
    listComponentsMock.mockResolvedValue({ success: true, components: [], errors: [] });
    const stderr = makeStderrSpy();
    const exit = await runOpList({ args: makeArgs({ components: true }), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    expect(stderr.join("\n")).toContain("No component definitions found");
  });

  test("discovery error → exit 1 with the error message", async () => {
    listComponentsMock.mockResolvedValue({ success: false, components: [], errors: ["bad component file"] });
    const stderr = makeStderrSpy();
    const exit = await runOpList({ args: makeArgs({ components: true }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("bad component file");
  });

  test("prints table with one row per component when Temporal connection fails", async () => {
    listComponentsMock.mockResolvedValue({
      success: true,
      components: [
        { name: "search-service", archetype: "service", dependsOn: ["shared-alb"], hasBuild: true, phases: ["Build", "Apply"], filePath: "src/search.component.ts" },
      ],
      errors: [],
    });
    loadTemporalClientMock.mockRejectedValue(new Error("not installed"));
    const stdout = makeStdoutSpy();
    const exit = await runOpList({ args: makeArgs({ components: true }), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    const out = stdout.join("\n");
    expect(out).toContain("NAME");
    expect(out).toContain("search-service");
    expect(out).toContain("shared-alb");
  });

  test("annotates components with Temporal status when client is available", async () => {
    listComponentsMock.mockResolvedValue({
      success: true,
      components: [
        { name: "gated-svc", archetype: "service", dependsOn: [], hasBuild: true, phases: ["Apply"], filePath: "src/gated.component.ts" },
      ],
      errors: [],
    });
    setupTemporalClient(createMockTemporalClient({
      describeByWorkflowId: {
        "chant-component-gated-svc": {
          workflowId: "chant-component-gated-svc", runId: "r1",
          status: { name: "RUNNING" }, startTime: new Date(),
          taskQueue: "gated-svc", type: { name: "gatedSvcComponentWorkflow" },
        },
      },
    }));
    const stdout = makeStdoutSpy();
    const exit = await runOpList({ args: makeArgs({ components: true }), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    expect(stdout.join("\n")).toContain("RUNNING");
  });
});

describe("runOpStatus", () => {
  beforeEach(() => {
    discoverOpsMock.mockReset();
    loadTemporalClientMock.mockReset();
    loadChantConfigMock.mockReset();
    resolveProfileMock.mockReset();
  });

  test("missing op name → exit 1", async () => {
    const stderr = makeStderrSpy();
    const exit = await runOpStatus({ args: makeArgs({ extraPositional: undefined }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("Op name is required");
  });

  test("connection error → exit 1 with message", async () => {
    loadTemporalClientMock.mockRejectedValue(new Error("UNAVAILABLE"));
    loadChantConfigMock.mockResolvedValue({ config: {} });
    resolveProfileMock.mockReturnValue({ address: "localhost:7233", namespace: "default", taskQueue: "q" });
    const stderr = makeStderrSpy();
    const exit = await runOpStatus({ args: makeArgs({ extraPositional: "alb-deploy" }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("UNAVAILABLE");
  });

  test("happy path: prints workflow id, run id, status, activity counts", async () => {
    setupTemporalClient(createMockTemporalClient({
      describeByWorkflowId: {
        "chant-op-alb-deploy": {
          workflowId: "chant-op-alb-deploy", runId: "r1",
          status: { name: "COMPLETED" },
          startTime: new Date("2026-05-01T00:00:00Z"),
          closeTime: new Date("2026-05-01T01:00:00Z"),
          taskQueue: "alb-deploy", type: { name: "albDeployWorkflow" },
        },
      },
      historyByWorkflowId: {
        "chant-op-alb-deploy": [
          { eventType: "ActivityTaskScheduled" },
          { eventType: "ActivityTaskScheduled" },
          { eventType: "ActivityTaskCompleted" },
        ],
      },
    }));
    const stdout = makeStdoutSpy();
    const exit = await runOpStatus({ args: makeArgs({ extraPositional: "alb-deploy" }), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    const out = stdout.join("\n");
    expect(out).toContain("chant-op-alb-deploy");
    expect(out).toContain("COMPLETED");
    expect(out).toContain("1/2 completed");
  });
});

// ── chant run status <name> --components (#599) ─────────────────────────────

describe("runOpStatus --components", () => {
  beforeEach(() => {
    loadTemporalClientMock.mockReset();
    loadChantConfigMock.mockReset();
    resolveProfileMock.mockReset();
  });

  test("missing component name → exit 1 with component-flavored message", async () => {
    const stderr = makeStderrSpy();
    const exit = await runOpStatus({ args: makeArgs({ extraPositional: undefined, components: true }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("Component name is required");
  });

  test("without --temporal → exit 1, actionable message", async () => {
    const stderr = makeStderrSpy();
    const exit = await runOpStatus({ args: makeArgs({ extraPositional: "gated-svc", components: true, temporal: false }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("not available in local mode");
  });

  test("connection error → exit 1 with message", async () => {
    loadTemporalClientMock.mockRejectedValue(new Error("UNAVAILABLE"));
    loadChantConfigMock.mockResolvedValue({ config: {} });
    resolveProfileMock.mockReturnValue({ address: "localhost:7233", namespace: "default", taskQueue: "q" });
    const stderr = makeStderrSpy();
    const exit = await runOpStatus({ args: makeArgs({ extraPositional: "gated-svc", components: true }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("UNAVAILABLE");
  });

  test("happy path: queries the component workflow id, prints status + activity counts", async () => {
    setupTemporalClient(createMockTemporalClient({
      describeByWorkflowId: {
        "chant-component-gated-svc": {
          workflowId: "chant-component-gated-svc", runId: "r1",
          status: { name: "RUNNING" },
          startTime: new Date("2026-05-01T00:00:00Z"),
          taskQueue: "gated-svc", type: { name: "gatedSvcComponentWorkflow" },
        },
      },
      historyByWorkflowId: {
        "chant-component-gated-svc": [
          { eventType: "ActivityTaskScheduled" },
          { eventType: "ActivityTaskScheduled" },
          { eventType: "ActivityTaskCompleted" },
        ],
      },
    }));
    const stdout = makeStdoutSpy();
    const exit = await runOpStatus({ args: makeArgs({ extraPositional: "gated-svc", components: true }), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    const out = stdout.join("\n");
    expect(out).toContain("Component: gated-svc");
    expect(out).toContain("chant-component-gated-svc");
    expect(out).toContain("RUNNING");
    expect(out).toContain("1/2 completed");
  });
});

describe("runOpLog", () => {
  beforeEach(() => {
    loadTemporalClientMock.mockReset();
    loadChantConfigMock.mockReset();
    resolveProfileMock.mockReset();
  });

  test("missing op name → exit 1", async () => {
    const stderr = makeStderrSpy();
    const exit = await runOpLog({ args: makeArgs({ extraPositional: undefined }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("Op name is required");
  });

  test("prints one row per matching workflow execution", async () => {
    setupTemporalClient(createMockTemporalClient({
      list: [
        { workflowId: "chant-op-alb-deploy", runId: "r1", type: { name: "albDeployWorkflow" }, status: { name: "COMPLETED" }, startTime: new Date("2026-05-01T00:00:00Z"), closeTime: new Date("2026-05-01T01:00:00Z") },
        { workflowId: "chant-op-alb-deploy", runId: "r2", type: { name: "albDeployWorkflow" }, status: { name: "RUNNING" }, startTime: new Date("2026-05-02T00:00:00Z") },
      ],
    }));
    const stdout = makeStdoutSpy();
    const exit = await runOpLog({ args: makeArgs({ extraPositional: "alb-deploy" }), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    const out = stdout.join("\n");
    expect(out).toContain("RUN-ID");
    expect(out).toContain("r1");
    expect(out).toContain("r2");
    expect(out).toContain("COMPLETED");
    expect(out).toContain("RUNNING");
  });
});

// ── chant run log <name> --components (#599) ────────────────────────────────

describe("runOpLog --components", () => {
  beforeEach(() => {
    loadTemporalClientMock.mockReset();
    loadChantConfigMock.mockReset();
    resolveProfileMock.mockReset();
    loadComponentTemporalCodegenMock.mockReset();
  });

  test("missing component name → exit 1 with component-flavored message", async () => {
    const stderr = makeStderrSpy();
    const exit = await runOpLog({ args: makeArgs({ extraPositional: undefined, components: true }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("Component name is required");
  });

  test("without --temporal → exit 1, actionable message", async () => {
    const stderr = makeStderrSpy();
    const exit = await runOpLog({ args: makeArgs({ extraPositional: "gated-svc", components: true, temporal: false }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("not available in local mode");
  });

  test("codegen unavailable → exit 1 with the loader's error message", async () => {
    setupTemporalClient(createMockTemporalClient());
    loadComponentTemporalCodegenMock.mockRejectedValue(new Error("no durable component codegen available"));
    const stderr = makeStderrSpy();
    const exit = await runOpLog({ args: makeArgs({ extraPositional: "gated-svc", components: true }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("no durable component codegen available");
  });

  test("prints one row per matching component workflow execution, keyed by the component's workflow type", async () => {
    setupTemporalClient(createMockTemporalClient({
      list: [
        { workflowId: "chant-component-gated-svc", runId: "r1", type: { name: "gatedSvcComponentWorkflow" }, status: { name: "COMPLETED" }, startTime: new Date("2026-05-01T00:00:00Z"), closeTime: new Date("2026-05-01T01:00:00Z") },
        { workflowId: "chant-component-gated-svc", runId: "r2", type: { name: "gatedSvcComponentWorkflow" }, status: { name: "RUNNING" }, startTime: new Date("2026-05-02T00:00:00Z") },
      ],
    }));
    loadComponentTemporalCodegenMock.mockResolvedValue({
      serializeComponent: vi.fn(),
      componentWorkflowFnName: (name: string) => `${name}ComponentWorkflow`,
    });
    const stdout = makeStdoutSpy();
    const exit = await runOpLog({ args: makeArgs({ extraPositional: "gated-svc", components: true }), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    const out = stdout.join("\n");
    expect(out).toContain("RUN-ID");
    expect(out).toContain("r1");
    expect(out).toContain("r2");
    expect(out).toContain("COMPLETED");
    expect(out).toContain("RUNNING");
  });
});

// ── chant run <name> --components --temporal: config defaults reach codegen ──
// The interpret/local path fills chant.config's sbom/signing/vulnPolicy
// defaults via runComponents; the durable path inlines the composition into
// generated workflow code, so it must apply the same pass before serializing
// — otherwise the Temporal path silently drops project defaults the local
// path honors.
describe("runComponentTemporal — applies chant.config defaults before codegen", () => {
  beforeEach(() => {
    loadTemporalClientMock.mockReset();
    loadChantConfigMock.mockReset();
    resolveProfileMock.mockReset();
    resolveComponentTargetsMock.mockReset();
    loadComponentTemporalCodegenMock.mockReset();
    writeFileSyncMock.mockReset();
    mkdirSyncMock.mockReset();
  });

  test("serializeComponent receives a component with config's sbom.format filled in", async () => {
    resolveComponentTargetsMock.mockResolvedValue({
      success: true,
      targets: [{
        name: "search-svc",
        dependsOn: [],
        deploy: [{ phase: "Build", steps: [{ kind: "generate-sbom", artifactType: "image", path: "img" }] }],
      }],
    });
    // config sets a project-wide SBOM format the step itself omits.
    loadChantConfigMock.mockResolvedValue({ config: { sbom: { format: "cyclonedx" } } });
    resolveProfileMock.mockReturnValue({ autoStart: false, address: "localhost:7233", namespace: "default", taskQueue: "q" });

    const serializeSpy = vi.fn().mockReturnValue({});
    loadComponentTemporalCodegenMock.mockResolvedValue({
      serializeComponent: serializeSpy,
      componentWorkflowFnName: (n: string) => `${n}ComponentWorkflow`,
    });
    // Fail the client connect right after codegen so the handler returns
    // without driving the whole workflow-start machinery — the spy has already
    // captured the (resolved) component by then.
    loadTemporalClientMock.mockRejectedValue(new Error("client-unavailable"));
    makeStderrSpy();

    await runOpComponents({ args: makeArgs({ path: "search-svc", components: true, temporal: true }), plugins: [], serializers: [] });

    expect(serializeSpy).toHaveBeenCalledTimes(1);
    const passedComponent = serializeSpy.mock.calls[0]![0] as { deploy: Array<{ steps: Array<{ format?: string }> }> };
    expect(passedComponent.deploy[0]!.steps[0]!.format).toBe("cyclonedx");
  });
});

describe("runOpSignal", () => {
  beforeEach(() => {
    loadTemporalClientMock.mockReset();
    loadChantConfigMock.mockReset();
    resolveProfileMock.mockReset();
  });

  test("missing op or signal name → exit 1", async () => {
    const stderr = makeStderrSpy();
    const exit = await runOpSignal({ args: makeArgs({ extraPositional: "op-only" }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("Usage:");
  });

  test("happy path: signal is sent and success message logged", async () => {
    const mockClient = createMockTemporalClient();
    setupTemporalClient(mockClient);
    const stderr = makeStderrSpy();
    const exit = await runOpSignal({
      args: makeArgs({ extraPositional: "alb-deploy", extraPositional2: "gate-dns" }),
      plugins: [], serializers: [],
    });
    expect(exit).toBe(0);
    expect(mockClient.calls.signalCalls).toEqual([
      { workflowId: "chant-op-alb-deploy", signalName: "gate-dns" },
    ]);
    expect(stderr.join("\n")).toContain("Signal");
    expect(stderr.join("\n")).toContain("gate-dns");
  });

  test("--components: signals the component workflow id, not the Op one (#589)", async () => {
    const mockClient = createMockTemporalClient();
    setupTemporalClient(mockClient);
    const stderr = makeStderrSpy();
    const exit = await runOpSignal({
      args: makeArgs({ extraPositional: "gated-svc", extraPositional2: "release-approval", components: true }),
      plugins: [], serializers: [],
    });
    expect(exit).toBe(0);
    expect(mockClient.calls.signalCalls).toEqual([
      { workflowId: "chant-component-gated-svc", signalName: "release-approval" },
    ]);
    expect(stderr.join("\n")).toContain("component");
  });
});

describe("runOpCancel", () => {
  beforeEach(() => {
    loadTemporalClientMock.mockReset();
    loadChantConfigMock.mockReset();
    resolveProfileMock.mockReset();
  });

  test("missing op name → exit 1", async () => {
    const stderr = makeStderrSpy();
    const exit = await runOpCancel({ args: makeArgs({ extraPositional: undefined }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("Op name is required");
  });

  test("requires --force → exit 1 without it", async () => {
    const stderr = makeStderrSpy();
    const exit = await runOpCancel({
      args: makeArgs({ extraPositional: "alb-deploy", force: false }),
      plugins: [], serializers: [],
    });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("--force");
  });

  test("with --force: cancel is sent and success logged", async () => {
    const mockClient = createMockTemporalClient();
    setupTemporalClient(mockClient);
    const stderr = makeStderrSpy();
    const exit = await runOpCancel({
      args: makeArgs({ extraPositional: "alb-deploy", force: true }),
      plugins: [], serializers: [],
    });
    expect(exit).toBe(0);
    expect(mockClient.calls.cancelCalls).toEqual([{ workflowId: "chant-op-alb-deploy" }]);
    expect(stderr.join("\n")).toContain("Cancellation requested");
  });

  test("--components: cancels the component workflow id, not the Op one (#589)", async () => {
    const mockClient = createMockTemporalClient();
    setupTemporalClient(mockClient);
    const stderr = makeStderrSpy();
    const exit = await runOpCancel({
      args: makeArgs({ extraPositional: "gated-svc", force: true, components: true }),
      plugins: [], serializers: [],
    });
    expect(exit).toBe(0);
    expect(mockClient.calls.cancelCalls).toEqual([{ workflowId: "chant-component-gated-svc" }]);
    expect(stderr.join("\n")).toContain("component");
  });
});

// ── runOp (the main `chant run <name>` command) ─────────────────────────────

function makeFakeChildProcess(): { proc: EventEmitter & { kill: () => void } } {
  const proc = Object.assign(new EventEmitter(), { kill: vi.fn() });
  return { proc };
}

describe("runOp", () => {
  beforeEach(() => {
    discoverOpsMock.mockReset();
    loadTemporalClientMock.mockReset();
    loadChantConfigMock.mockReset();
    resolveProfileMock.mockReset();
    existsSyncMock.mockReset();
    spawnChildMock.mockReset();
    generateReportMock.mockReset();
    writeReportMock.mockReset();
    waitForTemporalSpy.mockReset();
  });

  test("path defaults to '.' → exit 1 with hint", async () => {
    const stderr = makeStderrSpy();
    const exit = await runOp({ args: makeArgs({ path: "." }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("Op name is required");
  });

  test("unknown op name → exit 1 + lists available", async () => {
    discoverOpsMock.mockResolvedValue({ ops: new Map([makeOp("alb-deploy"), makeOp("infra")]), errors: [] });
    const stderr = makeStderrSpy();
    const exit = await runOp({ args: makeArgs({ path: "missing" }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    const out = stderr.join("\n");
    expect(out).toContain('Op "missing" not found');
    expect(out).toContain("alb-deploy");
    expect(out).toContain("infra");
  });

  test("unknown op + zero discovered ops → exit 1 with create-one hint", async () => {
    discoverOpsMock.mockResolvedValue({ ops: new Map(), errors: [] });
    const stderr = makeStderrSpy();
    const exit = await runOp({ args: makeArgs({ path: "missing" }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("No *.op.ts files found");
  });

  test("profile resolution failure → exit 1", async () => {
    discoverOpsMock.mockResolvedValue({ ops: new Map([makeOp("alb-deploy")]), errors: [] });
    loadChantConfigMock.mockResolvedValue({ config: {} });
    resolveProfileMock.mockImplementation(() => { throw new Error("Profile not found: prod"); });
    const stderr = makeStderrSpy();
    const exit = await runOp({ args: makeArgs({ path: "alb-deploy" }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("Profile not found: prod");
  });

  test("missing dist/ops/<name>/worker.ts → exit 1 with build hint", async () => {
    discoverOpsMock.mockResolvedValue({ ops: new Map([makeOp("alb-deploy")]), errors: [] });
    loadChantConfigMock.mockResolvedValue({ config: {} });
    resolveProfileMock.mockReturnValue({ address: "localhost:7233", namespace: "default", taskQueue: "q" });
    existsSyncMock.mockReturnValue(false);
    const stderr = makeStderrSpy();
    const exit = await runOp({ args: makeArgs({ path: "alb-deploy" }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("worker.ts not found");
    expect(stderr.join("\n")).toContain("`chant build` first");
  });

  test("--report path: prints generated report from describe + history", async () => {
    discoverOpsMock.mockResolvedValue({ ops: new Map([makeOp("alb-deploy")]), errors: [] });
    setupTemporalClient(createMockTemporalClient({
      describeByWorkflowId: {
        "chant-op-alb-deploy": {
          workflowId: "chant-op-alb-deploy", runId: "r1",
          status: { name: "COMPLETED" }, startTime: new Date(),
          taskQueue: "alb-deploy", type: { name: "albDeployWorkflow" },
        },
      },
      historyByWorkflowId: { "chant-op-alb-deploy": [] },
    }));
    generateReportMock.mockReturnValue("# Report\nDeploy completed.");
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const exit = await runOp({ args: makeArgs({ path: "alb-deploy", report: true }), plugins: [], serializers: [] });

    expect(exit).toBe(0);
    expect(generateReportMock).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).toHaveBeenCalledWith("# Report\nDeploy completed.");
    stdoutSpy.mockRestore();
  });

  test("happy path: spawns worker, starts workflow, polls until COMPLETED, writes report, exits 0", async () => {
    vi.useFakeTimers();
    try {
      discoverOpsMock.mockResolvedValue({ ops: new Map([makeOp("alb-deploy")]), errors: [] });
      const mockClient = createMockTemporalClient({
        describeByWorkflowId: {
          "chant-op-alb-deploy": {
            workflowId: "chant-op-alb-deploy", runId: "r1",
            status: { name: "COMPLETED" }, startTime: new Date(),
            taskQueue: "alb-deploy", type: { name: "albDeployWorkflow" },
          },
        },
        historyByWorkflowId: {
          "chant-op-alb-deploy": [{ eventType: "ActivityTaskScheduled" }, { eventType: "ActivityTaskCompleted" }],
        },
      });
      setupTemporalClient(mockClient);
      existsSyncMock.mockReturnValue(true);
      const { proc } = makeFakeChildProcess();
      spawnChildMock.mockReturnValue(proc);
      generateReportMock.mockReturnValue("# Report");
      writeReportMock.mockReturnValue("/tmp/report.md");
      const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const promise = runOp({ args: makeArgs({ path: "alb-deploy" }), plugins: [], serializers: [] });
      // Drive the polling loop forward.
      await vi.advanceTimersByTimeAsync(5000);

      const exit = await promise;
      expect(exit).toBe(0);
      expect(spawnChildMock).toHaveBeenCalledTimes(1);
      expect(spawnChildMock.mock.calls[0][0]).toBe("npx");
      expect(mockClient.calls.startCalls).toHaveLength(1);
      expect(mockClient.calls.startCalls[0].opts.workflowId).toBe("chant-op-alb-deploy");
      expect(generateReportMock).toHaveBeenCalledTimes(1);
      expect(writeReportMock).toHaveBeenCalledTimes(1);
      expect(proc.kill).toHaveBeenCalled();

      stderrWriteSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  test("workflow ends in FAILED → exit 1, worker still killed", async () => {
    vi.useFakeTimers();
    try {
      discoverOpsMock.mockResolvedValue({ ops: new Map([makeOp("alb-deploy")]), errors: [] });
      const mockClient = createMockTemporalClient({
        describeByWorkflowId: {
          "chant-op-alb-deploy": {
            workflowId: "chant-op-alb-deploy", runId: "r1",
            status: { name: "FAILED" }, startTime: new Date(),
            taskQueue: "alb-deploy", type: { name: "albDeployWorkflow" },
          },
        },
        historyByWorkflowId: { "chant-op-alb-deploy": [] },
      });
      setupTemporalClient(mockClient);
      existsSyncMock.mockReturnValue(true);
      const { proc } = makeFakeChildProcess();
      spawnChildMock.mockReturnValue(proc);
      generateReportMock.mockReturnValue("# Report");
      writeReportMock.mockReturnValue("/tmp/report.md");
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const promise = runOp({ args: makeArgs({ path: "alb-deploy" }), plugins: [], serializers: [] });
      await vi.advanceTimersByTimeAsync(5000);

      const exit = await promise;
      expect(exit).toBe(1);
      expect(proc.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── local mode dispatcher + guards ──────────────────────────────────────────

function localOp(name: string, steps: unknown[]) {
  return [name, { config: { name, overview: `${name} overview`, phases: [{ name: "Phase", steps }] } }] as const;
}

describe("runOp dispatcher", () => {
  beforeEach(() => {
    discoverOpsMock.mockReset();
    loadTemporalClientMock.mockReset();
    loadChantConfigMock.mockReset();
    resolveProfileMock.mockReset();
    existsSyncMock.mockReset();
    spawnChildMock.mockReset();
  });

  test("no flag → local executor (no Temporal client or worker spawned)", async () => {
    discoverOpsMock.mockResolvedValue({
      ops: new Map([localOp("hello", [{ kind: "activity", fn: "shellCmd", args: { cmd: "true" } }])]),
      errors: [],
    });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = await runOp({ args: makeArgs({ path: "hello", temporal: false }), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    expect(loadTemporalClientMock).not.toHaveBeenCalled();
    expect(spawnChildMock).not.toHaveBeenCalled();
    stderrWrite.mockRestore();
  });

  test("--temporal → Temporal path (missing worker.ts → exit 1)", async () => {
    discoverOpsMock.mockResolvedValue({ ops: new Map([makeOp("hello")]), errors: [] });
    loadChantConfigMock.mockResolvedValue({ config: {} });
    resolveProfileMock.mockReturnValue({ address: "localhost:7233", namespace: "default", taskQueue: "q" });
    existsSyncMock.mockReturnValue(false);
    const stderr = makeStderrSpy();
    const exit = await runOp({ args: makeArgs({ path: "hello", temporal: true }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("worker.ts not found");
  });

  test("gate in local mode → fast-fail before execution, suggests --temporal", async () => {
    discoverOpsMock.mockResolvedValue({
      ops: new Map([localOp("gated", [{ kind: "gate", signalName: "approve-prod" }])]),
      errors: [],
    });
    const stderr = makeStderrSpy();
    const exit = await runOp({ args: makeArgs({ path: "gated", temporal: false }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("--temporal");
    expect(loadTemporalClientMock).not.toHaveBeenCalled();
  });

  test("--local and --temporal together → exit 1 before any work", async () => {
    const stderr = makeStderrSpy();
    const exit = await runOp({ args: makeArgs({ path: "hello", local: true, temporal: true }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("mutually exclusive");
    expect(discoverOpsMock).not.toHaveBeenCalled();
    expect(loadTemporalClientMock).not.toHaveBeenCalled();
  });

  test("--json → structured result on stdout", async () => {
    discoverOpsMock.mockResolvedValue({
      ops: new Map([localOp("hello", [{ kind: "activity", fn: "shellCmd", args: { cmd: "true" } }])]),
      errors: [],
    });
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = await runOp({ args: makeArgs({ path: "hello", temporal: false, json: true }), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    const printed = stdoutWrite.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(printed.trim());
    expect(parsed.op).toBe("hello");
    expect(parsed.ok).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("Temporal-only subcommand guards", () => {
  const cases: Array<[string, (ctx: { args: ParsedArgs; plugins: never[]; serializers: never[] }) => Promise<number>]> = [
    ["list", runOpList],
    ["status", runOpStatus],
    ["log", runOpLog],
    ["signal", runOpSignal],
    ["cancel", runOpCancel],
  ];

  test.each(cases)("run %s without --temporal → exit 1 + actionable message", async (_name, handler) => {
    const stderr = makeStderrSpy();
    const exit = await handler({ args: makeArgs({ temporal: false, extraPositional: "x", extraPositional2: "y" }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("not available in local mode");
  });
});

// ── chant run --components <name|all> (#585) ────────────────────────────────

describe("runOp dispatcher: --components routes to runOpComponents", () => {
  beforeEach(() => {
    runComponentsMock.mockReset();
    loadChantConfigMock.mockReset().mockResolvedValue({ config: {} });
    maybeRecordAutoReleaseMock.mockReset().mockResolvedValue({ recorded: false, reason: "no-digest" });
    maybePersistBuildManifestMock.mockReset().mockResolvedValue({ persisted: false, reason: "no-manifest" });
  });

  test("runOp with --components dispatches to runComponents, not Op discovery", async () => {
    discoverOpsMock.mockReset();
    runComponentsMock.mockResolvedValue({ success: true, selected: ["svc"], run: { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, records: [] }], ok: true } });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const exit = await runOp({ args: makeArgs({ path: "svc", components: true, temporal: false }), plugins: [], serializers: [] });

    expect(exit).toBe(0);
    expect(runComponentsMock).toHaveBeenCalledWith(expect.any(String), "svc", { env: undefined, componentOutputs: {}, buildParams: [] });
    expect(discoverOpsMock).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  // chant #1116 — --report is Op/Temporal-only (reads a past workflow run);
  // the component driver never checked it, so it was silently ignored and the
  // command fell through to a real dispatch. Hard-error instead, before
  // runComponents is ever reached.
  test("--report combined with --components → exit 1 before any dispatch, no fall-through (#1116)", async () => {
    discoverOpsMock.mockReset();
    const stderr = makeStderrSpy();

    const exit = await runOp({ args: makeArgs({ path: "svc", components: true, report: true, temporal: false }), plugins: [], serializers: [] });

    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("not supported with --components");
    expect(stderr.join("\n")).toContain("#1116");
    expect(discoverOpsMock).not.toHaveBeenCalled();
    expect(runComponentsMock).not.toHaveBeenCalled();
  });

  // Plain --components (no --report) must be unaffected: it still reaches a
  // real dispatch through runComponents — mocked here, never a real cloud call.
  test("plain --components (no --report) still dispatches to runComponents (#1116 regression guard)", async () => {
    discoverOpsMock.mockReset();
    runComponentsMock.mockResolvedValue({ success: true, selected: ["svc"], run: { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, records: [] }], ok: true } });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const exit = await runOp({ args: makeArgs({ path: "svc", components: true, report: false, temporal: false }), plugins: [], serializers: [] });

    expect(exit).toBe(0);
    expect(runComponentsMock).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("runOpComponents", () => {
  beforeEach(() => {
    runComponentsMock.mockReset();
    loadChantConfigMock.mockReset().mockResolvedValue({ config: {} });
    maybeRecordAutoReleaseMock.mockReset().mockResolvedValue({ recorded: false, reason: "no-digest" });
    maybePersistBuildManifestMock.mockReset().mockResolvedValue({ persisted: false, reason: "no-manifest" });
  });

  test("no component name → exit 1 with hint", async () => {
    const stderr = makeStderrSpy();
    const exit = await runOpComponents({ args: makeArgs({ path: ".", temporal: false }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("Component name is required");
    expect(runComponentsMock).not.toHaveBeenCalled();
  });

  // ── build-time parameters (chant #1108) — resolved BEFORE dispatch ────────

  describe("build-time parameters", () => {
    test("chant.config.ts's declared buildParams resolve and log before dispatching to runComponents", async () => {
      loadChantConfigMock.mockResolvedValue({
        config: { buildParams: { tier: { type: "string", default: "light" } } },
      });
      runComponentsMock.mockResolvedValue({
        success: true,
        selected: ["svc"],
        run: { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, records: [] }], ok: true },
      });
      const stderr = makeStderrSpy();

      const exit = await runOpComponents({ args: makeArgs({ path: "svc", temporal: false }), plugins: [], serializers: [] });

      expect(exit).toBe(0);
      expect(runComponentsMock).toHaveBeenCalledWith(expect.any(String), "svc", expect.objectContaining({
        buildParams: [{ name: "tier", value: "light", source: "default" }],
      }));
      // The echo is a one-line count (#1424); the provenance forwarded above
      // is where the value is asserted.
      expect(stderr.join("\n")).toContain("1 build parameter resolved (1 default)");
    });

    test("--param overrides a declared default and is threaded through to runComponents", async () => {
      loadChantConfigMock.mockResolvedValue({
        config: { buildParams: { tier: { type: "string", default: "light" } } },
      });
      runComponentsMock.mockResolvedValue({
        success: true,
        selected: ["svc"],
        run: { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, records: [] }], ok: true },
      });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const stderr = makeStderrSpy();

      const exit = await runOpComponents({
        args: makeArgs({ path: "svc", temporal: false, param: ["tier=production"] }),
        plugins: [],
        serializers: [],
      });

      expect(exit).toBe(0);
      expect(runComponentsMock).toHaveBeenCalledWith(expect.any(String), "svc", expect.objectContaining({
        buildParams: [{ name: "tier", value: "production", source: "cli" }],
      }));
      expect(stderr.join("\n")).toContain("1 build parameter resolved (1 from cli)");
      vi.restoreAllMocks();
    });

    test("an unresolved required build-time parameter → exit 1 with a formatted error naming it, never reaches runComponents (the previously-{} probe, now a hard stop instead)", async () => {
      loadChantConfigMock.mockResolvedValue({
        config: { buildParams: { tier: { type: "string" } } },
      });
      const stderr = makeStderrSpy();

      const exit = await runOpComponents({ args: makeArgs({ path: "svc", temporal: false }), plugins: [], serializers: [] });

      expect(exit).toBe(1);
      expect(stderr.join("\n")).toMatch(/"tier"/);
      expect(runComponentsMock).not.toHaveBeenCalled();
    });

    test("an enum violation on --param → exit 1 with a formatted error, never reaches runComponents", async () => {
      loadChantConfigMock.mockResolvedValue({
        config: { buildParams: { tier: { type: "string", enum: ["light", "production"] } } },
      });
      const stderr = makeStderrSpy();

      const exit = await runOpComponents({
        args: makeArgs({ path: "svc", temporal: false, param: ["tier=bogus"] }),
        plugins: [],
        serializers: [],
      });

      expect(exit).toBe(1);
      expect(stderr.join("\n")).toMatch(/"tier"/);
      expect(stderr.join("\n")).toMatch(/bogus/);
      expect(runComponentsMock).not.toHaveBeenCalled();
    });
  });

  test("happy path: single component, human output, exit 0", async () => {
    runComponentsMock.mockResolvedValue({
      success: true,
      selected: ["svc"],
      run: {
        order: ["svc"],
        waves: [["svc"]],
        results: [{ component: "svc", ok: true, records: [{ component: "svc", phase: "Apply", kind: "cfn-deploy", status: "ok", durationMs: 5 }] }],
        ok: true,
      },
    });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const exit = await runOpComponents({ args: makeArgs({ path: "svc", temporal: false }), plugins: [], serializers: [] });

    expect(exit).toBe(0);
    expect(runComponentsMock).toHaveBeenCalledWith(expect.any(String), "svc", { env: undefined, componentOutputs: {}, buildParams: [] });
    const printed = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(printed).toContain("interpret run completed");
    vi.restoreAllMocks();
  });

  test("threads --env through to runComponents", async () => {
    runComponentsMock.mockResolvedValue({ success: true, selected: ["svc"], run: { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, records: [] }], ok: true } });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runOpComponents({ args: makeArgs({ path: "svc", env: "staging", temporal: false }), plugins: [], serializers: [] });

    expect(runComponentsMock).toHaveBeenCalledWith(expect.any(String), "svc", { env: "staging", componentOutputs: {}, buildParams: [] });
    vi.restoreAllMocks();
  });

  test("--json emits the DriverRunResult as JSON on stdout", async () => {
    const run = { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, records: [] }], ok: true };
    runComponentsMock.mockResolvedValue({ success: true, selected: ["svc"], run });
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const exit = await runOpComponents({ args: makeArgs({ path: "svc", json: true, temporal: false }), plugins: [], serializers: [] });

    expect(exit).toBe(0);
    const printed = stdoutWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(JSON.parse(printed.trim())).toEqual(run);
    vi.restoreAllMocks();
  });

  // ── --progress-json (M3, behold roadmap) ──────────────────────────────────

  test("--progress-json streams NDJSON progress events to stdout as runComponents emits them", async () => {
    runComponentsMock.mockImplementation(
      async (_path: string, _selector: string, options: { onProgress?: (e: unknown) => void }) => {
        options.onProgress?.({ type: "run-start", waves: [["svc"]] });
        options.onProgress?.({ type: "run-done", status: "ok" });
        return {
          success: true,
          selected: ["svc"],
          run: { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, records: [] }], ok: true },
        };
      },
    );
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const exit = await runOpComponents({
      args: makeArgs({ path: "svc", progressJson: true, temporal: false }),
      plugins: [],
      serializers: [],
    });

    expect(exit).toBe(0);
    const lines = stdoutWrite.mock.calls.map((c) => String(c[0])).filter((s) => s.trim().length > 0);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { type: "run-start", waves: [["svc"]] },
      { type: "run-done", status: "ok" },
    ]);
    // Every line is a single, complete JSON object — real NDJSON, not one big blob.
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    vi.restoreAllMocks();
  });

  test("without --progress-json, runComponents receives onProgress: undefined and nothing streams", async () => {
    runComponentsMock.mockResolvedValue({
      success: true,
      selected: ["svc"],
      run: { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, records: [] }], ok: true },
    });
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runOpComponents({ args: makeArgs({ path: "svc", temporal: false }), plugins: [], serializers: [] });

    expect(runComponentsMock).toHaveBeenCalledWith(expect.any(String), "svc", {
      env: undefined,
      componentOutputs: {},
      onProgress: undefined,
      buildParams: [],
    });
    expect(stdoutWrite).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  test("all: dispatches the 'all' selector and renders every component", async () => {
    runComponentsMock.mockResolvedValue({
      success: true,
      selected: ["shared-alb", "search-service"],
      run: {
        order: ["shared-alb", "search-service"],
        waves: [["shared-alb"], ["search-service"]],
        results: [
          { component: "shared-alb", ok: true, records: [] },
          { component: "search-service", ok: true, records: [] },
        ],
        ok: true,
      },
    });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const exit = await runOpComponents({ args: makeArgs({ path: "all", temporal: false }), plugins: [], serializers: [] });

    expect(exit).toBe(0);
    expect(runComponentsMock).toHaveBeenCalledWith(expect.any(String), "all", { env: undefined, componentOutputs: {}, buildParams: [] });
    const printed = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(printed).toContain("shared-alb");
    expect(printed).toContain("search-service");
    vi.restoreAllMocks();
  });

  test("a failed component run → exit 1", async () => {
    runComponentsMock.mockResolvedValue({
      success: false,
      selected: ["svc"],
      run: {
        order: ["svc"],
        waves: [["svc"]],
        results: [{ component: "svc", ok: false, records: [{ component: "svc", phase: "Apply", kind: "cfn-deploy", status: "fail", durationMs: 5, error: "boom" }] }],
        ok: false,
        failedComponent: "svc",
      },
    });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const exit = await runOpComponents({ args: makeArgs({ path: "svc", temporal: false }), plugins: [], serializers: [] });

    expect(exit).toBe(1);
    const printed = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(printed).toContain("interpret run failed");
    vi.restoreAllMocks();
  });

  test("unknown component → exit 1 with the runComponents error message", async () => {
    runComponentsMock.mockResolvedValue({ success: false, selected: [], error: 'Component "missing" not found. Known components: svc' });
    const stderr = makeStderrSpy();

    const exit = await runOpComponents({ args: makeArgs({ path: "missing", temporal: false }), plugins: [], serializers: [] });

    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain('Component "missing" not found');
  });

  test("a gate in the component (local mode) → exit 1 with an actionable, Temporal-pointing message", async () => {
    runComponentsMock.mockResolvedValue({
      success: false,
      selected: ["svc"],
      gateUnsupported: { component: "svc", signalName: "release-approval" },
    });
    const stderr = makeStderrSpy();

    const exit = await runOpComponents({ args: makeArgs({ path: "svc", temporal: false }), plugins: [], serializers: [] });

    expect(exit).toBe(1);
    const out = stderr.join("\n");
    expect(out).toContain('gate "release-approval"');
    expect(out).toContain("--temporal");
  });

  // ── auto-release recording post-run (#597) ────────────────────────────────

  describe("auto-release recording", () => {
    test("a successful run → maybeRecordAutoRelease is called once per successful component, with the run's records", async () => {
      runComponentsMock.mockResolvedValue({
        success: true,
        selected: ["svc"],
        run: {
          order: ["svc"],
          waves: [["svc"]],
          results: [{ component: "svc", ok: true, records: [{ component: "svc", phase: "Publish", kind: "publish-image", status: "ok", durationMs: 5, output: { digest: "sha256:abc" } }] }],
          ok: true,
        },
      });
      maybeRecordAutoReleaseMock.mockResolvedValue({ recorded: true, commit: "a".repeat(40), record: { version: 1, component: "svc", env: "staging", digest: "sha256:abc", gitSha: "x", runId: "local-1", timestamp: "t", actor: "a" } });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const exit = await runOpComponents({ args: makeArgs({ path: "svc", env: "staging", temporal: false }), plugins: [], serializers: [] });

      expect(exit).toBe(0);
      expect(maybeRecordAutoReleaseMock).toHaveBeenCalledTimes(1);
      const [runInfo, options] = maybeRecordAutoReleaseMock.mock.calls[0];
      expect(runInfo).toMatchObject({ component: "svc", env: "staging", success: true });
      expect(runInfo.records).toEqual([{ component: "svc", phase: "Publish", kind: "publish-image", status: "ok", durationMs: 5, output: { digest: "sha256:abc" } }]);
      expect(options).toMatchObject({ disabled: false });
      vi.restoreAllMocks();
    });

    test("a failed run → maybeRecordAutoRelease is never called (failed components write nothing)", async () => {
      runComponentsMock.mockResolvedValue({
        success: false,
        selected: ["svc"],
        run: {
          order: ["svc"],
          waves: [["svc"]],
          results: [{ component: "svc", ok: false, records: [{ component: "svc", phase: "Apply", kind: "cfn-deploy", status: "fail", durationMs: 5, error: "boom" }] }],
          ok: false,
          failedComponent: "svc",
        },
      });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const exit = await runOpComponents({ args: makeArgs({ path: "svc", temporal: false }), plugins: [], serializers: [] });

      expect(exit).toBe(1);
      expect(maybeRecordAutoReleaseMock).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    test("--no-release-record → maybeRecordAutoRelease is called with disabled: true", async () => {
      runComponentsMock.mockResolvedValue({
        success: true,
        selected: ["svc"],
        run: { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, records: [] }], ok: true },
      });
      maybeRecordAutoReleaseMock.mockResolvedValue({ recorded: false, reason: "opted-out" });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const exit = await runOpComponents({ args: makeArgs({ path: "svc", temporal: false, noReleaseRecord: true }), plugins: [], serializers: [] });

      expect(exit).toBe(0);
      expect(maybeRecordAutoReleaseMock).toHaveBeenCalledTimes(1);
      const [, options] = maybeRecordAutoReleaseMock.mock.calls[0];
      expect(options).toMatchObject({ disabled: true });
      vi.restoreAllMocks();
    });

    test("chant.config.ts release.autoRecord: false → disabled without the CLI flag", async () => {
      runComponentsMock.mockResolvedValue({
        success: true,
        selected: ["svc"],
        run: { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, records: [] }], ok: true },
      });
      loadChantConfigMock.mockResolvedValue({ config: { release: { autoRecord: false } } });
      maybeRecordAutoReleaseMock.mockResolvedValue({ recorded: false, reason: "opted-out" });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      await runOpComponents({ args: makeArgs({ path: "svc", temporal: false }), plugins: [], serializers: [] });

      const [, options] = maybeRecordAutoReleaseMock.mock.calls[0];
      expect(options).toMatchObject({ disabled: true });
      vi.restoreAllMocks();
    });

    test("a release-write error is surfaced as a warning but does not change the exit code", async () => {
      runComponentsMock.mockResolvedValue({
        success: true,
        selected: ["svc"],
        run: { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, records: [] }], ok: true },
      });
      maybeRecordAutoReleaseMock.mockResolvedValue({ recorded: false, reason: "error", error: "ledger push failed" });
      const stderr = makeStderrSpy();
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const exit = await runOpComponents({ args: makeArgs({ path: "svc", temporal: false }), plugins: [], serializers: [] });

      expect(exit).toBe(0);
      expect(stderr.join("\n")).toContain("ledger push failed");
      vi.restoreAllMocks();
    });
  });

  // ── build-manifest persistence post-run (#609) ──────────────────────────────

  describe("build-manifest persistence", () => {
    test("a successful run → maybePersistBuildManifest is called once per successful component, with the run's records", async () => {
      const buildOutput = { archivePath: "image.tar", digest: "sha256:abc", manifest: { version: 1, component: "svc", createdAt: "t", contents: [], manifestDigest: "sha256:manifestabc" } };
      runComponentsMock.mockResolvedValue({
        success: true,
        selected: ["svc"],
        run: {
          order: ["svc"],
          waves: [["svc"]],
          results: [{ component: "svc", ok: true, records: [{ component: "svc", phase: "Build", kind: "docker-build", status: "ok", durationMs: 5, output: buildOutput }] }],
          ok: true,
        },
      });
      maybePersistBuildManifestMock.mockResolvedValue({ persisted: true, commit: "a".repeat(40), manifestDigest: "sha256:manifestabc" });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const exit = await runOpComponents({ args: makeArgs({ path: "svc", env: "staging", temporal: false }), plugins: [], serializers: [] });

      expect(exit).toBe(0);
      expect(maybePersistBuildManifestMock).toHaveBeenCalledTimes(1);
      const [runInfo, options] = maybePersistBuildManifestMock.mock.calls[0];
      expect(runInfo).toMatchObject({ success: true });
      expect(runInfo.records).toEqual([{ component: "svc", phase: "Build", kind: "docker-build", status: "ok", durationMs: 5, output: buildOutput }]);
      expect(options).toMatchObject({ disabled: false });
      vi.restoreAllMocks();
    });

    test("a failed run → maybePersistBuildManifest is never called (failed/dry-run deploys persist nothing)", async () => {
      runComponentsMock.mockResolvedValue({
        success: false,
        selected: ["svc"],
        run: {
          order: ["svc"],
          waves: [["svc"]],
          results: [{ component: "svc", ok: false, records: [{ component: "svc", phase: "Apply", kind: "cfn-deploy", status: "fail", durationMs: 5, error: "boom" }] }],
          ok: false,
          failedComponent: "svc",
        },
      });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const exit = await runOpComponents({ args: makeArgs({ path: "svc", temporal: false }), plugins: [], serializers: [] });

      expect(exit).toBe(1);
      expect(maybePersistBuildManifestMock).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    test("--no-release-record also disables manifest persistence (shared opt-out)", async () => {
      runComponentsMock.mockResolvedValue({
        success: true,
        selected: ["svc"],
        run: { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, records: [] }], ok: true },
      });
      maybePersistBuildManifestMock.mockResolvedValue({ persisted: false, reason: "opted-out" });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const exit = await runOpComponents({ args: makeArgs({ path: "svc", temporal: false, noReleaseRecord: true }), plugins: [], serializers: [] });

      expect(exit).toBe(0);
      expect(maybePersistBuildManifestMock).toHaveBeenCalledTimes(1);
      const [, options] = maybePersistBuildManifestMock.mock.calls[0];
      expect(options).toMatchObject({ disabled: true });
      vi.restoreAllMocks();
    });

    test("a manifest-write error is surfaced as a warning but does not change the exit code", async () => {
      runComponentsMock.mockResolvedValue({
        success: true,
        selected: ["svc"],
        run: { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, records: [] }], ok: true },
      });
      maybePersistBuildManifestMock.mockResolvedValue({ persisted: false, reason: "error", error: "manifest push failed" });
      const stderr = makeStderrSpy();
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const exit = await runOpComponents({ args: makeArgs({ path: "svc", temporal: false }), plugins: [], serializers: [] });

      expect(exit).toBe(0);
      expect(stderr.join("\n")).toContain("manifest push failed");
      vi.restoreAllMocks();
    });
  });
});

// ── chant run --components <name> --temporal (#589) ─────────────────────────

describe("runOpComponents: --temporal routes to the durable path", () => {
  beforeEach(() => {
    resolveComponentTargetsMock.mockReset();
    findComponentGateMock.mockReset();
    loadComponentTemporalCodegenMock.mockReset();
    // chant #1108 — runOpComponents now resolves build-time parameters (which
    // needs chant.config.ts's declared `buildParams`) BEFORE dispatching to
    // either the local or --temporal path, so every test in this block hits
    // loadChantConfig at least once now, even ones that never reach the rest
    // of the durable path (e.g. "unknown component"). Individual tests below
    // still override this where they care about a specific config shape.
    loadChantConfigMock.mockReset().mockResolvedValue({ config: {} });
    resolveProfileMock.mockReset();
    loadTemporalClientMock.mockReset();
    spawnChildMock.mockReset();
    existsSyncMock.mockReset();
    findComponentGateMock.mockReturnValue(undefined);
    maybeRecordAutoReleaseMock.mockReset().mockResolvedValue({ recorded: false, reason: "no-digest" });
    maybePersistBuildManifestMock.mockReset().mockResolvedValue({ persisted: false, reason: "no-manifest" });
  });

  test("all --temporal → exit 1, not supported", async () => {
    const stderr = makeStderrSpy();
    const exit = await runOpComponents({ args: makeArgs({ path: "all", temporal: true }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("not supported");
    expect(resolveComponentTargetsMock).not.toHaveBeenCalled();
  });

  test("unknown component → exit 1 with the resolver's error message", async () => {
    resolveComponentTargetsMock.mockResolvedValue({ success: false, targets: [], error: 'Component "missing" not found.' });
    const stderr = makeStderrSpy();

    const exit = await runOpComponents({ args: makeArgs({ path: "missing", temporal: true }), plugins: [], serializers: [] });

    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain('Component "missing" not found');
  });

  // ── build-time parameters (chant #1108) — resolved before discovery here too ─

  test("resolved build-time parameters are forwarded into resolveComponentTargets on the --temporal path", async () => {
    process.env.LOOM_ENV = "staging";
    resolveComponentTargetsMock.mockResolvedValue({
      success: true,
      targets: [{ name: "gated-svc", dependsOn: [], deploy: [] }],
    });
    resolveProfileMock.mockReturnValue({ address: "localhost:7233", namespace: "default", taskQueue: "q" });
    loadComponentTemporalCodegenMock.mockResolvedValue({
      serializeComponent: () => ({ "components/gated-svc/worker.ts": "// worker" }),
      componentWorkflowFnName: (name: string) => `${name}ComponentWorkflow`,
    });
    const mockClient = createMockTemporalClient({
      describeByWorkflowId: {
        "chant-component-gated-svc": {
          workflowId: "chant-component-gated-svc", runId: "r1",
          status: { name: "COMPLETED" }, startTime: new Date(),
          taskQueue: "gated-svc", type: { name: "gatedSvcComponentWorkflow" },
        },
      },
      historyByWorkflowId: { "chant-component-gated-svc": [] },
    });
    // setupTemporalClient sets its own default loadChantConfigMock resolved
    // value, so the test's own (buildParams-declaring) config must be set
    // AFTER calling it, not before.
    setupTemporalClient(mockClient);
    loadChantConfigMock.mockResolvedValue({
      config: { buildParams: { env: { type: "string", env: "LOOM_ENV", default: "dev" } } },
    });
    const { proc } = makeFakeChildProcess();
    spawnChildMock.mockReturnValue(proc);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      vi.useFakeTimers();
      const promise = runOpComponents({ args: makeArgs({ path: "gated-svc", temporal: true }), plugins: [], serializers: [] });
      await vi.advanceTimersByTimeAsync(5000);
      const exit = await promise;

      expect(exit).toBe(0);
      expect(resolveComponentTargetsMock).toHaveBeenCalledWith(
        expect.any(String),
        "gated-svc",
        undefined,
        [{ name: "env", value: "staging", source: "env" }],
      );
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      delete process.env.LOOM_ENV;
    }
  });

  test("an unresolved required build-time parameter → exit 1, never reaches resolveComponentTargets", async () => {
    loadChantConfigMock.mockResolvedValue({
      config: { buildParams: { tier: { type: "string" } } },
    });
    const stderr = makeStderrSpy();

    const exit = await runOpComponents({ args: makeArgs({ path: "gated-svc", temporal: true }), plugins: [], serializers: [] });

    expect(exit).toBe(1);
    expect(stderr.join("\n")).toMatch(/"tier"/);
    expect(resolveComponentTargetsMock).not.toHaveBeenCalled();
  });

  test("compiles the component, spawns the worker, submits the workflow, polls to COMPLETED", async () => {
    vi.useFakeTimers();
    try {
      resolveComponentTargetsMock.mockResolvedValue({
        success: true,
        targets: [{ name: "gated-svc", dependsOn: [], deploy: [] }],
      });
      loadChantConfigMock.mockResolvedValue({ config: {} });
      resolveProfileMock.mockReturnValue({ address: "localhost:7233", namespace: "default", taskQueue: "q" });
      const serializeComponentMock = vi.fn().mockReturnValue({
        "components/gated-svc/workflow.ts": "// wf",
        "components/gated-svc/activities.ts": "// act",
        "components/gated-svc/worker.ts": "// worker",
      });
      loadComponentTemporalCodegenMock.mockResolvedValue({
        serializeComponent: serializeComponentMock,
        componentWorkflowFnName: (name: string) => `${name}ComponentWorkflow`,
      });
      const mockClient = createMockTemporalClient({
        describeByWorkflowId: {
          "chant-component-gated-svc": {
            workflowId: "chant-component-gated-svc", runId: "r1",
            status: { name: "COMPLETED" }, startTime: new Date(),
            taskQueue: "gated-svc", type: { name: "gatedSvcComponentWorkflow" },
          },
        },
        historyByWorkflowId: { "chant-component-gated-svc": [] },
      });
      setupTemporalClient(mockClient);
      const { proc } = makeFakeChildProcess();
      spawnChildMock.mockReturnValue(proc);
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const promise = runOpComponents({ args: makeArgs({ path: "gated-svc", temporal: true, env: "staging" }), plugins: [], serializers: [] });
      await vi.advanceTimersByTimeAsync(5000);
      const exit = await promise;

      expect(exit).toBe(0);
      expect(spawnChildMock).toHaveBeenCalledTimes(1);
      expect(spawnChildMock.mock.calls[0][0]).toBe("npx");
      expect(mockClient.calls.startCalls).toHaveLength(1);
      expect(mockClient.calls.startCalls[0].opts.workflowId).toBe("chant-component-gated-svc");
      expect(proc.kill).toHaveBeenCalled();
      // --env must reach the codegen call, not just the local-mode path (the bug this locks in: #589 review).
      expect(serializeComponentMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: "gated-svc" }),
        expect.objectContaining({ env: "staging" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("a failed (non-COMPLETED) workflow → exit 1", async () => {
    vi.useFakeTimers();
    try {
      resolveComponentTargetsMock.mockResolvedValue({
        success: true,
        targets: [{ name: "gated-svc", dependsOn: [], deploy: [] }],
      });
      loadChantConfigMock.mockResolvedValue({ config: {} });
      resolveProfileMock.mockReturnValue({ address: "localhost:7233", namespace: "default", taskQueue: "q" });
      loadComponentTemporalCodegenMock.mockResolvedValue({
        serializeComponent: () => ({ "components/gated-svc/worker.ts": "// worker" }),
        componentWorkflowFnName: (name: string) => `${name}ComponentWorkflow`,
      });
      const mockClient = createMockTemporalClient({
        describeByWorkflowId: {
          "chant-component-gated-svc": {
            workflowId: "chant-component-gated-svc", runId: "r1",
            status: { name: "FAILED" }, startTime: new Date(),
            taskQueue: "gated-svc", type: { name: "gatedSvcComponentWorkflow" },
          },
        },
        historyByWorkflowId: { "chant-component-gated-svc": [] },
      });
      setupTemporalClient(mockClient);
      const { proc } = makeFakeChildProcess();
      spawnChildMock.mockReturnValue(proc);
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const promise = runOpComponents({ args: makeArgs({ path: "gated-svc", temporal: true }), plugins: [], serializers: [] });
      await vi.advanceTimersByTimeAsync(5000);
      const exit = await promise;

      expect(exit).toBe(1);
      expect(proc.kill).toHaveBeenCalled();
      // (#597) a failed workflow never reaches auto-release recording.
      expect(maybeRecordAutoReleaseMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // ── auto-release recording post-run (#597) ────────────────────────────────

  describe("auto-release recording", () => {
    async function runCompletedWorkflow(overrides: Partial<ParsedArgs> = {}, resultByWorkflowId?: unknown) {
      resolveComponentTargetsMock.mockResolvedValue({
        success: true,
        targets: [{ name: "gated-svc", dependsOn: [], deploy: [] }],
      });
      loadChantConfigMock.mockResolvedValue({ config: {} });
      resolveProfileMock.mockReturnValue({ address: "localhost:7233", namespace: "default", taskQueue: "q" });
      loadComponentTemporalCodegenMock.mockResolvedValue({
        serializeComponent: () => ({ "components/gated-svc/worker.ts": "// worker" }),
        componentWorkflowFnName: (name: string) => `${name}ComponentWorkflow`,
      });
      const mockClient = createMockTemporalClient({
        describeByWorkflowId: {
          "chant-component-gated-svc": {
            workflowId: "chant-component-gated-svc", runId: "r1",
            status: { name: "COMPLETED" }, startTime: new Date(),
            taskQueue: "gated-svc", type: { name: "gatedSvcComponentWorkflow" },
          },
        },
        historyByWorkflowId: { "chant-component-gated-svc": [] },
        resultByWorkflowId: resultByWorkflowId ? { "chant-component-gated-svc": resultByWorkflowId } : undefined,
      });
      setupTemporalClient(mockClient);
      const { proc } = makeFakeChildProcess();
      spawnChildMock.mockReturnValue(proc);
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const promise = runOpComponents({ args: makeArgs({ path: "gated-svc", temporal: true, ...overrides }), plugins: [], serializers: [] });
      await vi.advanceTimersByTimeAsync(5000);
      const exit = await promise;
      return { exit };
    }

    test("a COMPLETED workflow → reads the digest via handle.result() and calls maybeRecordAutoRelease once", async () => {
      vi.useFakeTimers();
      try {
        maybeRecordAutoReleaseMock.mockResolvedValue({
          recorded: true, commit: "a".repeat(40),
          record: { version: 1, component: "gated-svc", env: "staging", digest: "sha256:temporal-digest", gitSha: "x", runId: "r1", timestamp: "t", actor: "a" },
        });

        const { exit } = await runCompletedWorkflow({ env: "staging" }, { phaseOutputs: { Publish: { digest: "sha256:temporal-digest" } }, componentOutputs: {} });

        expect(exit).toBe(0);
        expect(maybeRecordAutoReleaseMock).toHaveBeenCalledTimes(1);
        const [runInfo, options] = maybeRecordAutoReleaseMock.mock.calls[0];
        expect(runInfo).toMatchObject({ component: "gated-svc", env: "staging", success: true, digest: "sha256:temporal-digest", runId: "r1" });
        expect(options).toMatchObject({ disabled: false });
      } finally {
        vi.useRealTimers();
      }
    });

    test("--no-release-record → disabled: true is threaded through on the Temporal path too", async () => {
      vi.useFakeTimers();
      try {
        maybeRecordAutoReleaseMock.mockResolvedValue({ recorded: false, reason: "opted-out" });

        await runCompletedWorkflow({ noReleaseRecord: true });

        const [, options] = maybeRecordAutoReleaseMock.mock.calls[0];
        expect(options).toMatchObject({ disabled: true });
      } finally {
        vi.useRealTimers();
      }
    });

    test("no digest in the workflow result → maybeRecordAutoRelease still called, with digest: undefined", async () => {
      vi.useFakeTimers();
      try {
        maybeRecordAutoReleaseMock.mockResolvedValue({ recorded: false, reason: "no-digest" });

        const { exit } = await runCompletedWorkflow({}, { phaseOutputs: {}, componentOutputs: {} });

        expect(exit).toBe(0);
        const [runInfo] = maybeRecordAutoReleaseMock.mock.calls[0];
        expect(runInfo.digest).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── build-manifest persistence post-run (#609) ──────────────────────────────

  describe("build-manifest persistence", () => {
    async function runCompletedWorkflow(overrides: Partial<ParsedArgs> = {}, resultByWorkflowId?: unknown) {
      resolveComponentTargetsMock.mockResolvedValue({
        success: true,
        targets: [{ name: "gated-svc", dependsOn: [], deploy: [] }],
      });
      loadChantConfigMock.mockResolvedValue({ config: {} });
      resolveProfileMock.mockReturnValue({ address: "localhost:7233", namespace: "default", taskQueue: "q" });
      loadComponentTemporalCodegenMock.mockResolvedValue({
        serializeComponent: () => ({ "components/gated-svc/worker.ts": "// worker" }),
        componentWorkflowFnName: (name: string) => `${name}ComponentWorkflow`,
      });
      const mockClient = createMockTemporalClient({
        describeByWorkflowId: {
          "chant-component-gated-svc": {
            workflowId: "chant-component-gated-svc", runId: "r1",
            status: { name: "COMPLETED" }, startTime: new Date(),
            taskQueue: "gated-svc", type: { name: "gatedSvcComponentWorkflow" },
          },
        },
        historyByWorkflowId: { "chant-component-gated-svc": [] },
        resultByWorkflowId: resultByWorkflowId ? { "chant-component-gated-svc": resultByWorkflowId } : undefined,
      });
      setupTemporalClient(mockClient);
      const { proc } = makeFakeChildProcess();
      spawnChildMock.mockReturnValue(proc);
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const promise = runOpComponents({ args: makeArgs({ path: "gated-svc", temporal: true, ...overrides }), plugins: [], serializers: [] });
      await vi.advanceTimersByTimeAsync(5000);
      const exit = await promise;
      return { exit };
    }

    const sampleManifest = { version: 1, component: "gated-svc", createdAt: "t", contents: [], manifestDigest: "sha256:manifest-temporal" };

    test("a COMPLETED workflow → reads the manifest via handle.result() and calls maybePersistBuildManifest once", async () => {
      vi.useFakeTimers();
      try {
        maybePersistBuildManifestMock.mockResolvedValue({ persisted: true, commit: "a".repeat(40), manifestDigest: "sha256:manifest-temporal" });

        const { exit } = await runCompletedWorkflow({ env: "staging" }, { phaseOutputs: { Build: { manifest: sampleManifest } }, componentOutputs: {} });

        expect(exit).toBe(0);
        expect(maybePersistBuildManifestMock).toHaveBeenCalledTimes(1);
        const [runInfo, options] = maybePersistBuildManifestMock.mock.calls[0];
        expect(runInfo).toMatchObject({ success: true, manifest: sampleManifest });
        expect(options).toMatchObject({ disabled: false });
      } finally {
        vi.useRealTimers();
      }
    });

    test("--no-release-record also disables manifest persistence on the Temporal path", async () => {
      vi.useFakeTimers();
      try {
        maybePersistBuildManifestMock.mockResolvedValue({ persisted: false, reason: "opted-out" });

        await runCompletedWorkflow({ noReleaseRecord: true });

        const [, options] = maybePersistBuildManifestMock.mock.calls[0];
        expect(options).toMatchObject({ disabled: true });
      } finally {
        vi.useRealTimers();
      }
    });

    test("no manifest in the workflow result → maybePersistBuildManifest still called, with manifest: undefined", async () => {
      vi.useFakeTimers();
      try {
        maybePersistBuildManifestMock.mockResolvedValue({ persisted: false, reason: "no-manifest" });

        const { exit } = await runCompletedWorkflow({}, { phaseOutputs: {}, componentOutputs: {} });

        expect(exit).toBe(0);
        const [runInfo] = maybePersistBuildManifestMock.mock.calls[0];
        expect(runInfo.manifest).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
