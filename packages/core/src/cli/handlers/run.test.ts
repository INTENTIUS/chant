import { describe, test, expect, vi, beforeEach } from "vitest";
import type { ParsedArgs } from "../registry";

const discoverOpsMock = vi.fn();
const loadChantConfigMock = vi.fn();
const writeFileSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const runComponentsMock = vi.fn();
const listComponentsMock = vi.fn();
const maybeRecordAutoReleaseMock = vi.fn();
const maybePersistBuildManifestMock = vi.fn();
const loadPluginsMock = vi.fn();
const recordGateApprovalMock = vi.fn();

const { memoryGateLedgerPort } = await vi.importActual<typeof import("../../op/gate")>("../../op/gate");
let gateLedger = memoryGateLedgerPort();

vi.mock("../../op/discover", () => ({ discoverOps: () => discoverOpsMock() }));
vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return { ...actual, loadChantConfig: (...args: unknown[]) => loadChantConfigMock(...args) };
});
vi.mock("../../components/auto-release", () => ({
  maybeRecordAutoRelease: (...args: unknown[]) => maybeRecordAutoReleaseMock(...args),
}));
vi.mock("../../components/manifest-persistence", () => ({
  maybePersistBuildManifest: (...args: unknown[]) => maybePersistBuildManifestMock(...args),
}));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
    mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
  };
});
vi.mock("../../components/cli-support", () => ({
  runComponents: (...args: unknown[]) => runComponentsMock(...args),
  listComponents: (...args: unknown[]) => listComponentsMock(...args),
}));
vi.mock("../plugins", () => ({
  loadPlugins: (...args: unknown[]) => loadPluginsMock(...args),
}));
vi.mock("./operator", () => ({
  recordGateApproval: (...args: unknown[]) => recordGateApprovalMock(...args),
}));
// The gate ledger a local run consults (#2119) is the `chant/lifecycle` orphan
// branch by default. Point it at memory here: these tests exercise the CLI's
// gate handling, and a unit test must never write a fact to the real repo.
vi.mock("../../op/gate", async () => {
  const actual = await vi.importActual<typeof import("../../op/gate")>("../../op/gate");
  return { ...actual, gitGateLedgerPort: () => gateLedger };
});
// The local runtime appends each run's record to that same branch (#2118).
// Real behavior in a project, and exactly what this suite must not do in
// chant's own checkout, since the append is against `process.cwd()`. Only the
// write and the read-back are stubbed — `buildRunRecord` stays real, so
// `--json` is still asserted against the record the executor actually built.
vi.mock("../../lifecycle/run-ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lifecycle/run-ledger")>();
  return {
    ...actual,
    appendRunRecord: async (input: Parameters<typeof actual.appendRunRecord>[0]) => ({
      commit: "0".repeat(40),
      record: { version: 1 as const, ...input, id: input.id ?? "test-run-id" },
    }),
    readRunLedger: async () => ({ records: [], malformed: 0 }),
  };
});

const { runOpList, runOpStatus, runOpLog, runOpSignalRenamed, runOpApprove, runOpCancel, runOp, runOpComponents } =
  await import("./run");

function makeArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: "run", path: ".",
    format: "", fix: false, watch: false, verbose: false, help: false, live: false,
    ...overrides,
  };
}

function makeOp(name: string, depends: string[] = []): [string, { config: { name: string; phases: unknown[]; depends?: string[]; overview: string } }] {
  return [name, { config: { name, phases: [], depends, overview: `${name} overview` } }];
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

describe("runOpSignalRenamed", () => {
  test("`run signal` points at `run approve` and never sends anything", async () => {
    const stderr = makeStderrSpy();
    const exit = await runOpSignalRenamed({
      args: makeArgs({ extraPositional: "alb-deploy", extraPositional2: "gate-dns" }),
      plugins: [], serializers: [],
    });
    expect(exit).toBe(1);
    const out = stderr.join("\n");
    expect(out).toContain("`chant run signal` is now `chant run approve`");
    expect(out).toContain("chant run approve alb-deploy gate-dns");
  });
});

describe("runOpCancel", () => {
  beforeEach(() => {
    discoverOpsMock.mockReset();
    loadChantConfigMock.mockReset().mockResolvedValue({ config: {} });
    loadPluginsMock.mockReset().mockResolvedValue([]);
  });

  test("missing op name -> exit 1", async () => {
    const stderr = makeStderrSpy();
    const exit = await runOpCancel({ args: makeArgs({ extraPositional: undefined }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("Op name is required");
  });

  test("requires --force -> exit 1 without it", async () => {
    const stderr = makeStderrSpy();
    const exit = await runOpCancel({
      args: makeArgs({ extraPositional: "alb-deploy", force: false }),
      plugins: [], serializers: [],
    });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("--force");
  });
});

// ── runOp (the main `chant run <name>` command) ───────────────────────

describe("runOp", () => {
  beforeEach(() => {
    discoverOpsMock.mockReset();
    loadChantConfigMock.mockReset().mockResolvedValue({ config: {} });
    loadPluginsMock.mockReset().mockResolvedValue([]);
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

});

// ── local mode dispatcher + guards ──────────────────────────────────────────

function localOp(name: string, steps: unknown[]) {
  return [name, { config: { name, overview: `${name} overview`, phases: [{ name: "Phase", steps }] } }] as const;
}

describe("runOp dispatcher", () => {
  beforeEach(() => {
    discoverOpsMock.mockReset();
    loadChantConfigMock.mockReset().mockResolvedValue({ config: {} });
    loadPluginsMock.mockReset().mockResolvedValue([]);
  });

  test("no --on → the built-in local runtime runs the Op in this process", async () => {
    discoverOpsMock.mockResolvedValue({
      ops: new Map([localOp("hello", [{ kind: "activity", fn: "shellCmd", args: { cmd: "true" } }])]),
      errors: [],
    });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = await runOp({ args: makeArgs({ path: "hello" }), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    expect(loadPluginsMock).not.toHaveBeenCalled();
    stderrWrite.mockRestore();
  });

  test("--report → exit 1 naming the removal, nothing run (#2116)", async () => {
    discoverOpsMock.mockResolvedValue({ ops: new Map([makeOp("hello")]), errors: [] });
    const stderr = makeStderrSpy();
    const exit = await runOp({ args: makeArgs({ path: "hello", report: true }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("#2116 removed");
    expect(discoverOpsMock).not.toHaveBeenCalled();
  });

  test("gate in local mode → exit 3 and the approve line (#2119)", async () => {
    gateLedger = memoryGateLedgerPort();
    discoverOpsMock.mockResolvedValue({
      ops: new Map([localOp("gated", [{ kind: "gate", gate: "approve-prod" }])]),
      errors: [],
    });
    // `renderHuman` writes straight to process.stderr, not through console.error.
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = await runOp({ args: makeArgs({ path: "gated" }), plugins: [], serializers: [] });
    expect(exit).toBe(3);
    const out = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
    stderrWrite.mockRestore();
    expect(out).toContain('is gated on "approve-prod"');
    expect(out).toContain("chant approve gated approve-prod");
    expect(gateLedger.appended).toHaveLength(1);
  });

  test("an approved gate lets the run through and exits 0", async () => {
    gateLedger = memoryGateLedgerPort({
      pending: [{
        version: 1, kind: "pending", op: "gated", gate: "approve-prod",
        timestamp: "2026-09-05T10:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
      }],
      resolutions: [{
        version: 1, op: "gated", gate: "approve-prod",
        resolvedBy: "alex", timestamp: "2026-09-05T11:00:00.000Z",
      }],
    });
    discoverOpsMock.mockResolvedValue({
      ops: new Map([localOp("gated", [
        { kind: "gate", gate: "approve-prod" },
        { kind: "activity", fn: "shellCmd", args: { cmd: "true" } },
      ])]),
      errors: [],
    });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = await runOp({ args: makeArgs({ path: "gated" }), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    expect(stderrWrite.mock.calls.map((c) => String(c[0])).join("")).toContain("[approved] alex");
    stderrWrite.mockRestore();
  });

  test("--json → the run's ledger record on stdout (#2118)", async () => {
    discoverOpsMock.mockResolvedValue({
      ops: new Map([localOp("hello", [{ kind: "activity", fn: "shellCmd", args: { cmd: "true" } }])]),
      errors: [],
    });
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = await runOp({ args: makeArgs({ path: "hello", json: true }), plugins: [], serializers: [] });
    expect(exit).toBe(0);
    const printed = stdoutWrite.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(printed.trim());
    expect(parsed.op).toBe("hello");
    expect(parsed.version).toBe(1);
    expect(parsed.status).toBe("ok");
    expect(parsed.phases[0].steps[0]).toMatchObject({ fn: "shellCmd", status: "ok" });
    vi.restoreAllMocks();
  });
});

/**
 * chant #2003 — `--sandbox` is a global flag and `../main.ts` arms the
 * process-wide policy latch off it for every command, so `chant run <op>
 * --sandbox` on an Op with a `policyGate` step used to reach `loadPolicyChecks`
 * mid-run and show the user a message written for a chant maintainer ("This is
 * a chant bug"). At the CLI level, not on `loadPolicyChecks`: the defect was
 * that the combination got that far, not what the refusal says.
 */
describe("runOp: --sandbox with a policyGate step (chant #2003)", () => {
  const policyGateOp = (name: string) =>
    localOp(name, [{ kind: "activity", fn: "policyGate", args: { path: "." } }]);

  beforeEach(() => {
    discoverOpsMock.mockReset();
    loadChantConfigMock.mockReset().mockResolvedValue({ config: { lexicons: ["stub"] } });
    loadPluginsMock.mockReset().mockResolvedValue([]);
  });

  test("refuses before any phase runs, naming the combination", async () => {
    discoverOpsMock.mockResolvedValue({ ops: new Map([policyGateOp("gate")]), errors: [] });
    const stderr = makeStderrSpy();

    const exit = await runOp({ args: makeArgs({ path: "gate", sandbox: true }), plugins: [], serializers: [] });

    expect(exit).toBe(1);
    const out = stderr.join("\n");
    expect(out).toContain("policyGate");
    expect(out).toContain("--sandbox");
    // The message the user used to get instead.
    expect(out).not.toContain("This is a chant bug");
  });

  test("a policyGate nested in an effect step is found too", async () => {
    discoverOpsMock.mockResolvedValue({
      ops: new Map([
        localOp("gate", [
          { kind: "effect", steps: [{ kind: "activity", fn: "policyGate", args: { path: "." } }] },
        ]),
      ]),
      errors: [],
    });
    const stderr = makeStderrSpy();

    const exit = await runOp({ args: makeArgs({ path: "gate", sandbox: true }), plugins: [], serializers: [] });

    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("policyGate");
  });

  test("without --sandbox the same Op is not refused", async () => {
    discoverOpsMock.mockResolvedValue({ ops: new Map([policyGateOp("gate")]), errors: [] });
    const start = vi.fn(async () => ({
      op: "gate",
      runId: "stub-1",
      result: async () => ({ op: "gate", runId: "stub-1", state: "completed", startedAt: "2026-01-01T00:00:00.000Z" }),
    }));
    makeStdoutSpy();
    const stderr = makeStderrSpy();

    // On a stub runtime, so reaching `start` proves the pre-flight let it
    // through without the policyGate itself having to run here.
    const exit = await runOp({
      args: makeArgs({ path: "gate", on: "stub" }),
      plugins: [{ name: "stub", opRuntime: { name: "stub", start } } as never], serializers: [],
    });

    expect(exit).toBe(0);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stderr.join("\n")).not.toContain("policyGate");
  });

  // #2192 — `--profile` is core's flag and the runtime's meaning. The handler
  // only has to hand it over; fountain's own tests cover what it does with it.
  test("--profile reaches the hosting runtime's start options", async () => {
    discoverOpsMock.mockResolvedValue({ ops: new Map([makeOp("prod-apply")]), errors: [] });
    const start = vi.fn(async () => ({
      op: "prod-apply",
      runId: "stub-1",
      result: async () => ({ op: "prod-apply", runId: "stub-1", state: "completed", startedAt: "2026-01-01T00:00:00.000Z" }),
    }));
    makeStdoutSpy();
    makeStderrSpy();

    const exit = await runOp({
      args: makeArgs({ path: "prod-apply", on: "stub", profile: "staging" }),
      plugins: [{ name: "stub", opRuntime: { name: "stub", start } } as never], serializers: [],
    });

    expect(exit).toBe(0);
    expect(start).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ profile: "staging" }));
  });

  test("without --profile the runtime is left to its own default", async () => {
    discoverOpsMock.mockResolvedValue({ ops: new Map([makeOp("prod-apply")]), errors: [] });
    let seen: Record<string, unknown> | undefined;
    const start = vi.fn(async (_op: unknown, opts: Record<string, unknown>) => {
      seen = opts;
      return {
        op: "prod-apply",
        runId: "stub-1",
        result: async () => ({ op: "prod-apply", runId: "stub-1", state: "completed", startedAt: "2026-01-01T00:00:00.000Z" }),
      };
    });
    makeStdoutSpy();
    makeStderrSpy();

    await runOp({
      args: makeArgs({ path: "prod-apply", on: "stub" }),
      plugins: [{ name: "stub", opRuntime: { name: "stub", start } } as never], serializers: [],
    });

    expect(seen).toBeDefined();
    expect(seen).not.toHaveProperty("profile");
  });

  test("--sandbox on an Op with no policyGate step is untouched", async () => {
    discoverOpsMock.mockResolvedValue({
      ops: new Map([localOp("hello", [{ kind: "activity", fn: "shellCmd", args: { cmd: "true" } }])]),
      errors: [],
    });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const exit = await runOp({ args: makeArgs({ path: "hello", sandbox: true }), plugins: [], serializers: [] });

    expect(exit).toBe(0);
    stderrWrite.mockRestore();
  });
});

/**
 * #2116 — `run list/status/log/cancel --components` reported a component's
 * durable run state. Nothing keeps one any more, so each refuses with a line
 * that says so and points at the command that still answers. The Op-path
 * counterparts run on the resolved runtime, covered below.
 */
describe("run <sub> --components refuses (#2116)", () => {
  const cases: Array<[string, (ctx: { args: ParsedArgs; plugins: never[]; serializers: never[] }) => Promise<number>]> = [
    ["list", runOpList],
    ["status", runOpStatus],
    ["log", runOpLog],
    ["cancel", runOpCancel],
  ];

  test.each(cases)("run %s --components -> exit 1 naming the removal", async (_name, handler) => {
    const stderr = makeStderrSpy();
    const exit = await handler({
      args: makeArgs({ components: true, force: true, extraPositional: "x", extraPositional2: "y" }),
      plugins: [], serializers: [],
    });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("durable run state, which #2116 removed");
  });

  test("run list --components points at `chant list --components`", async () => {
    const stderr = makeStderrSpy();
    const exit = await runOpList({ args: makeArgs({ components: true }), plugins: [], serializers: [] });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("chant list --components");
    expect(listComponentsMock).not.toHaveBeenCalled();
  });
});

// ── the runtime seam (#2121) ────────────────────────────────────────────────

describe("run subcommands on the resolved runtime", () => {
  function makeStubRuntime(overrides: Record<string, unknown> = {}) {
    return {
      name: "stub",
      start: vi.fn(async (op: { name: string }) => ({
        op: op.name,
        runId: "stub-1",
        result: async () => ({
          op: op.name, runId: "stub-1", state: "completed", startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:00:05.000Z",
        }),
      })),
      status: vi.fn(async (op: string) => ({
        op, runId: "stub-1", state: "running", startedAt: "2026-01-01T00:00:00.000Z",
      })),
      // A provider's `log` returns run-ledger records (#2118), newest first.
      log: vi.fn(async (op: string) => [
        {
          version: 1, id: "stub-1", op, env: "staging", status: "ok",
          started: "2026-01-01T00:00:00.000Z", ended: "2026-01-01T00:00:05.000Z",
          labels: {}, outcomes: {}, phases: [],
        },
      ]),
      list: vi.fn(async (ops: Array<{ name: string }>) =>
        new Map(ops.map((o) => [o.name, { op: o.name, runId: "stub-1", state: "completed", startedAt: "2026-01-01T00:00:00.000Z" }]))),
      cancel: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  function stubPlugin(runtime: unknown) {
    return { name: "stub", opRuntime: runtime } as never;
  }

  beforeEach(() => {
    discoverOpsMock.mockReset();
    loadChantConfigMock.mockReset().mockResolvedValue({ config: { lexicons: ["stub"] } });
    loadPluginsMock.mockReset().mockResolvedValue([]);
  });

  test("--on stub reaches the stub lexicon's start", async () => {
    const runtime = makeStubRuntime();
    discoverOpsMock.mockResolvedValue({ ops: new Map([makeOp("hello")]), errors: [] });
    makeStdoutSpy();
    const exit = await runOp({
      args: makeArgs({ path: "hello", on: "stub" }),
      plugins: [stubPlugin(runtime)], serializers: [],
    });
    expect(exit).toBe(0);
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect((runtime.start.mock.calls[0][0] as { name: string }).name).toBe("hello");
  });

  test("run status/log/list/cancel --on stub reach their methods", async () => {
    const runtime = makeStubRuntime();
    discoverOpsMock.mockResolvedValue({ ops: new Map([makeOp("hello")]), errors: [] });
    makeStdoutSpy();
    makeStderrSpy();
    const ctx = (over: Partial<ParsedArgs>) => ({
      args: makeArgs({ on: "stub", ...over }),
      plugins: [stubPlugin(runtime)], serializers: [],
    });

    expect(await runOpStatus(ctx({ extraPositional: "hello" }))).toBe(0);
    expect(await runOpLog(ctx({ extraPositional: "hello" }))).toBe(0);
    expect(await runOpList(ctx({}))).toBe(0);
    expect(await runOpCancel(ctx({ extraPositional: "hello", force: true }))).toBe(0);

    expect(runtime.status).toHaveBeenCalledWith("hello");
    expect(runtime.log).toHaveBeenCalledWith("hello", undefined);
    expect(runtime.list).toHaveBeenCalledTimes(1);
    expect(runtime.cancel).toHaveBeenCalledWith("hello", { force: true });
  });

  test("--on nope → exit 1 naming the configured lexicons", async () => {
    discoverOpsMock.mockResolvedValue({ ops: new Map([makeOp("hello")]), errors: [] });
    loadChantConfigMock.mockResolvedValue({ config: { lexicons: ["aws", "k8s"] } });
    const stderr = makeStderrSpy();
    const exit = await runOp({
      args: makeArgs({ path: "hello", on: "nope" }),
      plugins: [], serializers: [],
    });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("is not a configured lexicon");
    expect(stderr.join("\n")).toContain("aws, k8s");
  });

  test("--on a lexicon with no opRuntime → exit 1 naming the lexicon", async () => {
    discoverOpsMock.mockResolvedValue({ ops: new Map([makeOp("hello")]), errors: [] });
    const stderr = makeStderrSpy();
    const exit = await runOp({
      args: makeArgs({ path: "hello", on: "plain" }),
      plugins: [{ name: "plain" } as never], serializers: [],
    });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain('lexicon "plain" does not host Op runs');
  });

  test("--components on a runtime that cannot host them → one line, exit 1", async () => {
    const runtime = makeStubRuntime();
    const stderr = makeStderrSpy();
    const exit = await runOpComponents({
      args: makeArgs({ path: "search-service", components: true, on: "stub" }),
      plugins: [stubPlugin(runtime)], serializers: [],
    });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain('--components is not supported on the "stub" runtime');
    expect(runComponentsMock).not.toHaveBeenCalled();
  });
});

describe("runOpApprove", () => {
  beforeEach(() => {
    recordGateApprovalMock.mockReset();
    loadChantConfigMock.mockReset().mockResolvedValue({ config: { lexicons: ["stub"] } });
    loadPluginsMock.mockReset().mockResolvedValue([]);
  });

  test("missing op or gate name → exit 1, nothing recorded", async () => {
    const stderr = makeStderrSpy();
    const exit = await runOpApprove({
      args: makeArgs({ extraPositional: "alb-deploy" }),
      plugins: [], serializers: [],
    });
    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain("chant run approve <op> <gate>");
    expect(recordGateApprovalMock).not.toHaveBeenCalled();
  });

  test("writes the resolution, then calls the provider's resolveGate", async () => {
    const record = { version: 1, op: "alb-deploy", gate: "release", resolvedBy: "alex", timestamp: "2026-01-01T00:00:00.000Z" };
    recordGateApprovalMock.mockResolvedValue({ ok: true, record });
    const resolveGate = vi.fn(async () => undefined);
    const stderr = makeStderrSpy();

    const exit = await runOpApprove({
      args: makeArgs({ on: "stub", extraPositional: "alb-deploy", extraPositional2: "release", approver: "alex" }),
      plugins: [{ name: "stub", opRuntime: { name: "stub", resolveGate } } as never], serializers: [],
    });

    expect(exit).toBe(0);
    expect(recordGateApprovalMock).toHaveBeenCalledWith("alb-deploy", "release", {
      actor: "alex", note: undefined, url: undefined,
    });
    expect(resolveGate).toHaveBeenCalledWith("alb-deploy", "release", record);
    expect(stderr.join("\n")).toContain('Runtime "stub" was notified');
  });

  test("a provider with no resolveGate still records the fact and exits 0", async () => {
    const record = { version: 1, op: "alb-deploy", gate: "release", resolvedBy: "ci", timestamp: "2026-01-01T00:00:00.000Z" };
    recordGateApprovalMock.mockResolvedValue({ ok: true, record });
    const stderr = makeStderrSpy();

    const exit = await runOpApprove({
      args: makeArgs({ extraPositional: "alb-deploy", extraPositional2: "release" }),
      plugins: [], serializers: [],
    });

    expect(exit).toBe(0);
    expect(recordGateApprovalMock).toHaveBeenCalledTimes(1);
    expect(stderr.join("\n")).toContain("when the op next runs");
  });

  test("a refused ledger write → exit 1 without waking the runtime", async () => {
    recordGateApprovalMock.mockResolvedValue({ ok: false });
    const resolveGate = vi.fn(async () => undefined);
    const exit = await runOpApprove({
      args: makeArgs({ on: "stub", extraPositional: "alb-deploy", extraPositional2: "release" }),
      plugins: [{ name: "stub", opRuntime: { name: "stub", resolveGate } } as never], serializers: [],
    });
    expect(exit).toBe(1);
    expect(resolveGate).not.toHaveBeenCalled();
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
    runComponentsMock.mockResolvedValue({ success: true, selected: ["svc"], run: { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, status: "ok", records: [] }], ok: true, status: "ok" } });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const exit = await runOp({ args: makeArgs({ path: "svc", components: true }), plugins: [], serializers: [] });

    expect(exit).toBe(0);
    expect(runComponentsMock).toHaveBeenCalledWith(expect.any(String), "svc", { env: undefined, componentOutputs: {}, buildParams: [] });
    expect(discoverOpsMock).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  // chant #1116 — the component driver never checked --report, so it was
  // silently ignored and the command fell through to a real dispatch.
  // Hard-error instead, before runComponents is ever reached.
  test("--report combined with --components → exit 1 before any dispatch, no fall-through (#1116)", async () => {
    discoverOpsMock.mockReset();
    const stderr = makeStderrSpy();

    const exit = await runOp({ args: makeArgs({ path: "svc", components: true, report: true }), plugins: [], serializers: [] });

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
    runComponentsMock.mockResolvedValue({ success: true, selected: ["svc"], run: { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, status: "ok", records: [] }], ok: true, status: "ok" } });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const exit = await runOp({ args: makeArgs({ path: "svc", components: true, report: false }), plugins: [], serializers: [] });

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
    const exit = await runOpComponents({ args: makeArgs({ path: "." }), plugins: [], serializers: [] });
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
        run: { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, status: "ok", records: [] }], ok: true, status: "ok" },
      });
      const stderr = makeStderrSpy();

      const exit = await runOpComponents({ args: makeArgs({ path: "svc" }), plugins: [], serializers: [] });

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
        run: { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, status: "ok", records: [] }], ok: true, status: "ok" },
      });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const stderr = makeStderrSpy();

      const exit = await runOpComponents({
        args: makeArgs({ path: "svc", param: ["tier=production"] }),
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

      const exit = await runOpComponents({ args: makeArgs({ path: "svc" }), plugins: [], serializers: [] });

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
        args: makeArgs({ path: "svc", param: ["tier=bogus"] }),
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
        results: [{ component: "svc", ok: true, status: "ok", records: [{ component: "svc", phase: "Apply", kind: "cfn-deploy", status: "ok", durationMs: 5 }] }],
        ok: true,
        status: "ok",
      },
    });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const exit = await runOpComponents({ args: makeArgs({ path: "svc" }), plugins: [], serializers: [] });

    expect(exit).toBe(0);
    expect(runComponentsMock).toHaveBeenCalledWith(expect.any(String), "svc", { env: undefined, componentOutputs: {}, buildParams: [] });
    const printed = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(printed).toContain("interpret run completed");
    vi.restoreAllMocks();
  });

  test("threads --env through to runComponents", async () => {
    runComponentsMock.mockResolvedValue({ success: true, selected: ["svc"], run: { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, status: "ok", records: [] }], ok: true, status: "ok" } });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runOpComponents({ args: makeArgs({ path: "svc", env: "staging" }), plugins: [], serializers: [] });

    expect(runComponentsMock).toHaveBeenCalledWith(expect.any(String), "svc", { env: "staging", componentOutputs: {}, buildParams: [] });
    vi.restoreAllMocks();
  });

  test("--json emits the DriverRunResult as JSON on stdout", async () => {
    const run = { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, status: "ok", records: [] }], ok: true, status: "ok" };
    runComponentsMock.mockResolvedValue({ success: true, selected: ["svc"], run });
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const exit = await runOpComponents({ args: makeArgs({ path: "svc", json: true }), plugins: [], serializers: [] });

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
          run: { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, status: "ok", records: [] }], ok: true, status: "ok" },
        };
      },
    );
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const exit = await runOpComponents({
      args: makeArgs({ path: "svc", progressJson: true }),
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
      run: { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, status: "ok", records: [] }], ok: true, status: "ok" },
    });
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runOpComponents({ args: makeArgs({ path: "svc" }), plugins: [], serializers: [] });

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
          { component: "shared-alb", ok: true, status: "ok", records: [] },
          { component: "search-service", ok: true, status: "ok", records: [] },
        ],
        ok: true,
        status: "ok",
      },
    });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const exit = await runOpComponents({ args: makeArgs({ path: "all" }), plugins: [], serializers: [] });

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
        results: [{ component: "svc", ok: false, status: "fail", records: [{ component: "svc", phase: "Apply", kind: "cfn-deploy", status: "fail", durationMs: 5, error: "boom" }] }],
        ok: false,
        status: "fail",
        failedComponent: "svc",
      },
    });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const exit = await runOpComponents({ args: makeArgs({ path: "svc" }), plugins: [], serializers: [] });

    expect(exit).toBe(1);
    const printed = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(printed).toContain("interpret run failed");
    vi.restoreAllMocks();
  });

  test("unknown component → exit 1 with the runComponents error message", async () => {
    runComponentsMock.mockResolvedValue({ success: false, selected: [], error: 'Component "missing" not found. Known components: svc' });
    const stderr = makeStderrSpy();

    const exit = await runOpComponents({ args: makeArgs({ path: "missing" }), plugins: [], serializers: [] });

    expect(exit).toBe(1);
    expect(stderr.join("\n")).toContain('Component "missing" not found');
  });

  test("a gate in the component → exit 3 and the approve line (#2119)", async () => {
    runComponentsMock.mockResolvedValue({
      success: false,
      selected: ["svc"],
      gated: {
        component: "svc",
        gate: {
          version: 1, kind: "pending", op: "svc", gate: "release-approval",
          timestamp: "2026-09-05T12:00:00.000Z", expiresAt: "2026-09-07T12:00:00.000Z",
        },
      },
    });
    const stderr = makeStderrSpy();

    const exit = await runOpComponents({ args: makeArgs({ path: "svc" }), plugins: [], serializers: [] });

    expect(exit).toBe(3);
    const out = stderr.join("\n");
    expect(out).toContain('gated on "release-approval"');
    expect(out).toContain("chant approve svc release-approval");
    expect(out).toContain("expires : 2026-09-07T12:00:00.000Z");
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
          results: [{ component: "svc", ok: true, status: "ok", records: [{ component: "svc", phase: "Publish", kind: "publish-image", status: "ok", durationMs: 5, output: { digest: "sha256:abc" } }] }],
          ok: true,
          status: "ok",
        },
      });
      maybeRecordAutoReleaseMock.mockResolvedValue({ recorded: true, commit: "a".repeat(40), record: { version: 1, component: "svc", env: "staging", digest: "sha256:abc", gitSha: "x", runId: "local-1", timestamp: "t", actor: "a" } });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const exit = await runOpComponents({ args: makeArgs({ path: "svc", env: "staging" }), plugins: [], serializers: [] });

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
          results: [{ component: "svc", ok: false, status: "fail", records: [{ component: "svc", phase: "Apply", kind: "cfn-deploy", status: "fail", durationMs: 5, error: "boom" }] }],
          ok: false,
          status: "fail",
          failedComponent: "svc",
        },
      });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const exit = await runOpComponents({ args: makeArgs({ path: "svc" }), plugins: [], serializers: [] });

      expect(exit).toBe(1);
      expect(maybeRecordAutoReleaseMock).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    test("--no-release-record → maybeRecordAutoRelease is called with disabled: true", async () => {
      runComponentsMock.mockResolvedValue({
        success: true,
        selected: ["svc"],
        run: { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, status: "ok", records: [] }], ok: true, status: "ok" },
      });
      maybeRecordAutoReleaseMock.mockResolvedValue({ recorded: false, reason: "opted-out" });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const exit = await runOpComponents({ args: makeArgs({ path: "svc", noReleaseRecord: true }), plugins: [], serializers: [] });

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
        run: { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, status: "ok", records: [] }], ok: true, status: "ok" },
      });
      loadChantConfigMock.mockResolvedValue({ config: { release: { autoRecord: false } } });
      maybeRecordAutoReleaseMock.mockResolvedValue({ recorded: false, reason: "opted-out" });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      await runOpComponents({ args: makeArgs({ path: "svc" }), plugins: [], serializers: [] });

      const [, options] = maybeRecordAutoReleaseMock.mock.calls[0];
      expect(options).toMatchObject({ disabled: true });
      vi.restoreAllMocks();
    });

    test("a release-write error is surfaced as a warning but does not change the exit code", async () => {
      runComponentsMock.mockResolvedValue({
        success: true,
        selected: ["svc"],
        run: { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, status: "ok", records: [] }], ok: true, status: "ok" },
      });
      maybeRecordAutoReleaseMock.mockResolvedValue({ recorded: false, reason: "error", error: "ledger push failed" });
      const stderr = makeStderrSpy();
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const exit = await runOpComponents({ args: makeArgs({ path: "svc" }), plugins: [], serializers: [] });

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
          status: "ok",
        },
      });
      maybePersistBuildManifestMock.mockResolvedValue({ persisted: true, commit: "a".repeat(40), manifestDigest: "sha256:manifestabc" });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const exit = await runOpComponents({ args: makeArgs({ path: "svc", env: "staging" }), plugins: [], serializers: [] });

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
          results: [{ component: "svc", ok: false, status: "fail", records: [{ component: "svc", phase: "Apply", kind: "cfn-deploy", status: "fail", durationMs: 5, error: "boom" }] }],
          ok: false,
          status: "fail",
          failedComponent: "svc",
        },
      });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const exit = await runOpComponents({ args: makeArgs({ path: "svc" }), plugins: [], serializers: [] });

      expect(exit).toBe(1);
      expect(maybePersistBuildManifestMock).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    test("--no-release-record also disables manifest persistence (shared opt-out)", async () => {
      runComponentsMock.mockResolvedValue({
        success: true,
        selected: ["svc"],
        run: { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, status: "ok", records: [] }], ok: true, status: "ok" },
      });
      maybePersistBuildManifestMock.mockResolvedValue({ persisted: false, reason: "opted-out" });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const exit = await runOpComponents({ args: makeArgs({ path: "svc", noReleaseRecord: true }), plugins: [], serializers: [] });

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
        run: { order: ["svc"], waves: [["svc"]], results: [{ component: "svc", ok: true, status: "ok", records: [] }], ok: true, status: "ok" },
      });
      maybePersistBuildManifestMock.mockResolvedValue({ persisted: false, reason: "error", error: "manifest push failed" });
      const stderr = makeStderrSpy();
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const exit = await runOpComponents({ args: makeArgs({ path: "svc" }), plugins: [], serializers: [] });

      expect(exit).toBe(0);
      expect(stderr.join("\n")).toContain("manifest push failed");
      vi.restoreAllMocks();
    });
  });
});
