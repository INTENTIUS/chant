import { describe, test, expect, vi, beforeEach } from "vitest";
import { createMockTemporalClient } from "@intentius/chant-test-utils";
import type { ParsedArgs } from "../registry";

const discoverOpsMock = vi.fn();
const loadChantConfigMock = vi.fn();
const loadTemporalClientMock = vi.fn();
const resolveProfileMock = vi.fn();

vi.mock("../../op/discover", () => ({ discoverOps: () => discoverOpsMock() }));
vi.mock("../../config", () => ({ loadChantConfig: (...args: unknown[]) => loadChantConfigMock(...args) }));
vi.mock("./run-client", () => ({
  loadTemporalClient: () => loadTemporalClientMock(),
  connectionOptions: (profile: { address: string }) => ({ address: profile.address }),
  resolveProfile: (...args: unknown[]) => resolveProfileMock(...args),
  resolveWorkflowId: (name: string) => `chant-op-${name}`,
}));

const { runOpList, runOpStatus, runOpLog, runOpSignal, runOpCancel } = await import("./run");

function makeArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: "run", path: ".",
    format: "", fix: false, watch: false, verbose: false, help: false, live: false,
    ...overrides,
  };
}

function makeOp(name: string, depends: string[] = []): [string, { config: { name: string; phases: unknown[]; taskQueue?: string; depends?: string[]; overview: string } }] {
  return [name, { config: { name, phases: [], depends, overview: `${name} overview` } }];
}

function setupTemporalClient(mock: ReturnType<typeof createMockTemporalClient>) {
  loadTemporalClientMock.mockResolvedValue({
    Connection: { connect: vi.fn(async () => ({})) },
    Client: vi.fn(() => mock.client) as unknown as new () => unknown,
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
});
