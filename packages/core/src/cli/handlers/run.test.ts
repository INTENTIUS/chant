import { describe, test, expect, vi, beforeEach } from "vitest";
import { createMockTemporalClient } from "@intentius/chant-test-utils";
import type { ParsedArgs } from "../registry";
import { EventEmitter } from "node:events";

const discoverOpsMock = vi.fn();
const loadChantConfigMock = vi.fn();
const loadTemporalClientMock = vi.fn();
const resolveProfileMock = vi.fn();
const existsSyncMock = vi.fn();
const spawnChildMock = vi.fn();
const generateReportMock = vi.fn();
const writeReportMock = vi.fn();
const waitForTemporalSpy = vi.fn();

vi.mock("../../op/discover", () => ({ discoverOps: () => discoverOpsMock() }));
vi.mock("../../config", () => ({ loadChantConfig: (...args: unknown[]) => loadChantConfigMock(...args) }));
vi.mock("./run-client", () => ({
  loadTemporalClient: () => loadTemporalClientMock(),
  connectionOptions: (profile: { address: string }) => ({ address: profile.address }),
  resolveProfile: (...args: unknown[]) => resolveProfileMock(...args),
  resolveWorkflowId: (name: string) => `chant-op-${name}`,
}));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: (p: string) => existsSyncMock(p) };
});
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: (...args: unknown[]) => spawnChildMock(...args) };
});
vi.mock("./run-report", () => ({
  generateReport: (...args: unknown[]) => generateReportMock(...args),
  writeReport: (...args: unknown[]) => writeReportMock(...args),
}));

// Speed up runOp polling — POLL_INTERVAL_MS is 3000 in production. We use
// fake timers in the runOp suite below; vi.advanceTimersByTime drives the loop.

const { runOpList, runOpStatus, runOpLog, runOpSignal, runOpCancel, runOp } = await import("./run");

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
