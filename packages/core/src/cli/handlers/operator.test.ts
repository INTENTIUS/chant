import { describe, test, expect, vi, beforeEach } from "vitest";
import type { ParsedArgs } from "../registry";

const discoverConvergeOpsMock = vi.fn();
const runOperatorRoundMock = vi.fn();
const runOperatorForeverMock = vi.fn();
const discoverOpsMock = vi.fn();
const loadActivitiesMock = vi.fn();
const loadProfilesMock = vi.fn();
const loadChantConfigMock = vi.fn();
const readLeaseMock = vi.fn();
const readConvergeLedgerMock = vi.fn();
const appendGateResolutionMock = vi.fn();
const readGateResolutionsMock = vi.fn();
const pushLifecycleMock = vi.fn();

vi.mock("../../op/operator", async () => {
  const actual = await vi.importActual<typeof import("../../op/operator")>("../../op/operator");
  return {
    ...actual,
    discoverConvergeOps: (...args: unknown[]) => discoverConvergeOpsMock(...args),
    runOperatorRound: (...args: unknown[]) => runOperatorRoundMock(...args),
    runOperatorForever: (...args: unknown[]) => runOperatorForeverMock(...args),
  };
});
vi.mock("../../op/discover", () => ({ discoverOps: () => discoverOpsMock() }));
vi.mock("../../op/activity-registry", () => ({
  loadActivities: (...args: unknown[]) => loadActivitiesMock(...args),
  loadProfiles: (...args: unknown[]) => loadProfilesMock(...args),
}));
vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return { ...actual, loadChantConfig: (...args: unknown[]) => loadChantConfigMock(...args) };
});
vi.mock("../../lifecycle/lease", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/lease")>("../../lifecycle/lease");
  return { ...actual, readLease: (...args: unknown[]) => readLeaseMock(...args) };
});
vi.mock("../../lifecycle/converge-ledger", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/converge-ledger")>("../../lifecycle/converge-ledger");
  return { ...actual, readConvergeLedger: (...args: unknown[]) => readConvergeLedgerMock(...args) };
});
vi.mock("../../lifecycle/gate-ledger", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/gate-ledger")>("../../lifecycle/gate-ledger");
  return {
    ...actual,
    appendGateResolution: (...args: unknown[]) => appendGateResolutionMock(...args),
    readGateResolutions: (...args: unknown[]) => readGateResolutionsMock(...args),
  };
});
vi.mock("../../lifecycle/git", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/git")>("../../lifecycle/git");
  return { ...actual, pushLifecycle: (...args: unknown[]) => pushLifecycleMock(...args) };
});

// Imported after the mocks above are registered.
const { runOperator, runOperatorStatus, runOperatorLog, runApprove } = await import("./operator");

function ctx(args: Partial<ParsedArgs>) {
  return {
    args: { command: "", path: ".", format: "", fix: false, watch: false, verbose: false, help: false, live: false, ...args } as ParsedArgs,
    plugins: [],
    serializers: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadChantConfigMock.mockResolvedValue({ config: { lexicons: [] } });
  loadActivitiesMock.mockResolvedValue(new Map());
  loadProfilesMock.mockResolvedValue({});
  discoverOpsMock.mockResolvedValue({ ops: new Map([["fountain-apply", {}]]), errors: [] });
  pushLifecycleMock.mockResolvedValue(true);
});

describe("runOperator", () => {
  test("prints a warning and exits 0 when no ConvergeOps are discovered", async () => {
    discoverConvergeOpsMock.mockResolvedValue({ ops: [], errors: [] });
    const code = await runOperator(ctx({}));
    expect(code).toBe(0);
    expect(runOperatorRoundMock).not.toHaveBeenCalled();
    expect(runOperatorForeverMock).not.toHaveBeenCalled();
  });

  test("--once runs exactly one round and exits 0 when nothing failed", async () => {
    discoverConvergeOpsMock.mockResolvedValue({ ops: [{ config: { name: "staging-converge" } }], errors: [] });
    runOperatorRoundMock.mockResolvedValue([{ kind: "ticked", op: "staging-converge", env: "staging", result: { op: "staging-converge", records: [], totalMs: 1, ok: true } }]);

    const code = await runOperator(ctx({ once: true }));
    expect(code).toBe(0);
    expect(runOperatorRoundMock).toHaveBeenCalledTimes(1);
    expect(runOperatorForeverMock).not.toHaveBeenCalled();
  });

  test("--once exits 1 when any op's tick failed this round", async () => {
    discoverConvergeOpsMock.mockResolvedValue({ ops: [{ config: { name: "staging-converge" } }], errors: [] });
    runOperatorRoundMock.mockResolvedValue([{ kind: "tick-failed", op: "staging-converge", env: "staging", error: "boom" }]);

    const code = await runOperator(ctx({ once: true }));
    expect(code).toBe(1);
  });

  test("without --once, runs the daemon loop (runOperatorForever) and exits 0 when it returns", async () => {
    discoverConvergeOpsMock.mockResolvedValue({ ops: [{ config: { name: "staging-converge" } }], errors: [] });
    runOperatorForeverMock.mockResolvedValue(undefined);

    const code = await runOperator(ctx({}));
    expect(code).toBe(0);
    expect(runOperatorForeverMock).toHaveBeenCalledTimes(1);
    expect(runOperatorRoundMock).not.toHaveBeenCalled();
  });

  test("--interval and --lease-ttl are parsed as durations and threaded through", async () => {
    discoverConvergeOpsMock.mockResolvedValue({ ops: [{ config: { name: "staging-converge" } }], errors: [] });
    runOperatorForeverMock.mockResolvedValue(undefined);

    await runOperator(ctx({ interval: "30s", leaseTtl: "2m" }));
    const passed = runOperatorForeverMock.mock.calls[0][0];
    expect(passed.intervalMs).toBe(30_000);
    expect(passed.leaseTtlMs).toBe(120_000);
  });

  test("--env is passed through to discovery and the round/loop", async () => {
    discoverConvergeOpsMock.mockResolvedValue({ ops: [{ config: { name: "prod-converge" } }], errors: [] });
    runOperatorRoundMock.mockResolvedValue([]);

    await runOperator(ctx({ once: true, env: "prod" }));
    expect(discoverConvergeOpsMock).toHaveBeenCalledWith({ env: "prod" });
    expect(runOperatorRoundMock.mock.calls[0][0].env).toBe("prod");
  });

  test("a failure loading activities is reported and exits 1", async () => {
    discoverConvergeOpsMock.mockResolvedValue({ ops: [{ config: { name: "staging-converge" } }], errors: [] });
    loadActivitiesMock.mockRejectedValue(new Error("no activities registered"));

    const code = await runOperator(ctx({ once: true }));
    expect(code).toBe(1);
  });
});

describe("runOperatorStatus", () => {
  test("prints a warning and exits 0 when no ConvergeOps are discovered", async () => {
    discoverConvergeOpsMock.mockResolvedValue({ ops: [], errors: [] });
    const code = await runOperatorStatus(ctx({}));
    expect(code).toBe(0);
  });

  test("--json emits one row per discovered ConvergeOp with last tick, lease, and pending gates", async () => {
    discoverConvergeOpsMock.mockResolvedValue({
      ops: [{ config: { name: "staging-converge", searchAttributes: { Env: "staging" } } }],
      errors: [],
    });
    readConvergeLedgerMock.mockResolvedValue({
      records: [
        {
          version: 1,
          op: "staging-converge",
          env: "staging",
          timestamp: "2026-01-01T00:00:00.000Z",
          firedRuleIds: ["drift-apply"],
          outcomes: [{ ruleId: "drift-apply", action: "gated", op: "fountain-apply", gateName: "rollout-gate" }],
          summary: { drifted: 1, remediated: 0, reported: 0, skippedBudget: 0, skippedFlap: 0, unobserved: 0, adopted: 0, gated: 1 },
          log: "converge(staging): ...",
        },
      ],
      malformed: 0,
    });
    readLeaseMock.mockResolvedValue({ sha: "abc", record: { op: "staging-converge", holder: "op-a", token: "t1", acquiredAt: "x", expiresAt: "y" } });
    readGateResolutionsMock.mockResolvedValue({ records: [], malformed: 0 }); // no resolution yet — still pending

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runOperatorStatus(ctx({ json: true }));
    expect(code).toBe(0);

    const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(printed).toHaveLength(1);
    expect(printed[0].op).toBe("staging-converge");
    expect(printed[0].lease).toEqual({ holder: "op-a", expiresAt: "y" });
    expect(printed[0].pendingGates).toEqual([{ rule: "drift-apply", op: "fountain-apply", gate: "rollout-gate" }]);
    logSpy.mockRestore();
  });

  // #2028 — the pending fact is the one a human has to act on, so it is the
  // one that has to carry a link. Before this the row was {rule, op, gate}
  // and the only affordance a renderer could offer was a shell command.
  test("a gated outcome's approval url rides onto the pending-gate row", async () => {
    discoverConvergeOpsMock.mockResolvedValue({
      ops: [{ config: { name: "staging-converge", searchAttributes: { Env: "staging" } } }],
      errors: [],
    });
    readConvergeLedgerMock.mockResolvedValue({
      records: [
        {
          version: 1,
          op: "staging-converge",
          env: "staging",
          timestamp: "2026-01-01T00:00:00.000Z",
          firedRuleIds: ["drift-apply"],
          outcomes: [{
            ruleId: "drift-apply",
            action: "gated",
            op: "fountain-apply",
            gateName: "rollout-gate",
            url: "https://github.com/INTENTIUS/chant/pull/2028",
          }],
          summary: { drifted: 1, remediated: 0, reported: 0, skippedBudget: 0, skippedFlap: 0, unobserved: 0, adopted: 0, gated: 1 },
          log: "converge(staging): ...",
        },
      ],
      malformed: 0,
    });
    readLeaseMock.mockResolvedValue({ sha: null, record: undefined });
    readGateResolutionsMock.mockResolvedValue({ records: [], malformed: 0 });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runOperatorStatus(ctx({ json: true }));
    const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(printed[0].pendingGates).toEqual([
      { rule: "drift-apply", op: "fountain-apply", gate: "rollout-gate", url: "https://github.com/INTENTIUS/chant/pull/2028" },
    ]);
    logSpy.mockRestore();
  });

  test("the human render prints the address under the pending gate", async () => {
    discoverConvergeOpsMock.mockResolvedValue({
      ops: [{ config: { name: "staging-converge", searchAttributes: { Env: "staging" } } }],
      errors: [],
    });
    readConvergeLedgerMock.mockResolvedValue({
      records: [
        {
          version: 1,
          op: "staging-converge",
          env: "staging",
          timestamp: "2026-01-01T00:00:00.000Z",
          firedRuleIds: ["drift-apply"],
          outcomes: [{ ruleId: "drift-apply", action: "gated", op: "fountain-apply", gateName: "rollout-gate", url: "https://pr.example/1" }],
          summary: { drifted: 1, remediated: 0, reported: 0, skippedBudget: 0, skippedFlap: 0, unobserved: 0, adopted: 0, gated: 1 },
          log: "converge(staging): ...",
        },
      ],
      malformed: 0,
    });
    readLeaseMock.mockResolvedValue({ sha: null, record: undefined });
    readGateResolutionsMock.mockResolvedValue({ records: [], malformed: 0 });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runOperatorStatus(ctx({}));
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("approve at: https://pr.example/1");
    logSpy.mockRestore();
  });

  test("a gate resolved after the tick that recorded it is no longer pending", async () => {
    discoverConvergeOpsMock.mockResolvedValue({
      ops: [{ config: { name: "staging-converge", searchAttributes: { Env: "staging" } } }],
      errors: [],
    });
    readConvergeLedgerMock.mockResolvedValue({
      records: [
        {
          version: 1,
          op: "staging-converge",
          env: "staging",
          timestamp: "2026-01-01T00:00:00.000Z",
          firedRuleIds: ["drift-apply"],
          outcomes: [{ ruleId: "drift-apply", action: "gated", op: "fountain-apply", gateName: "rollout-gate" }],
          summary: { drifted: 1, remediated: 0, reported: 0, skippedBudget: 0, skippedFlap: 0, unobserved: 0, adopted: 0, gated: 1 },
          log: "converge(staging): ...",
        },
      ],
      malformed: 0,
    });
    readLeaseMock.mockResolvedValue({ sha: null, record: undefined });
    readGateResolutionsMock.mockResolvedValue({
      records: [{ version: 1, op: "fountain-apply", gate: "rollout-gate", resolvedBy: "alex", timestamp: "2026-01-02T00:00:00.000Z" }],
      malformed: 0,
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runOperatorStatus(ctx({ json: true }));
    const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(printed[0].pendingGates).toEqual([]);
    logSpy.mockRestore();
  });
});

describe("runApprove", () => {
  test("requires both <op> and <gate>", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runApprove(ctx({ path: "." }))).toBe(1);
    expect(await runApprove(ctx({ path: "fountain-apply" }))).toBe(1);
    errSpy.mockRestore();
  });

  test("appends a gate-resolution record and pushes, resolving --actor over env fallbacks", async () => {
    appendGateResolutionMock.mockResolvedValue({
      commit: "sha",
      record: { version: 1, op: "fountain-apply", gate: "rollout-gate", resolvedBy: "alex", timestamp: "2026-01-01T00:00:00.000Z" },
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await runApprove(ctx({ path: "fountain-apply", extraPositional: "rollout-gate", actor: "alex", note: "https://pr/1" }));

    expect(code).toBe(0);
    expect(appendGateResolutionMock).toHaveBeenCalledWith(
      expect.objectContaining({ op: "fountain-apply", gate: "rollout-gate", resolvedBy: "alex", note: "https://pr/1" }),
    );
    expect(pushLifecycleMock).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  // #2028 — the resolution's link is typed, so a reader is not sniffing
  // free-text `note` for something that looks like a URL.
  test("--url is recorded typed, alongside --note's prose", async () => {
    vi.stubEnv("GITHUB_REF_NAME", "");
    vi.stubEnv("GITHUB_REPOSITORY", "");
    vi.stubEnv("CI_MERGE_REQUEST_PROJECT_URL", "");
    appendGateResolutionMock.mockResolvedValue({
      commit: "sha",
      record: { version: 1, op: "fountain-apply", gate: "rollout-gate", resolvedBy: "alex", timestamp: "2026-01-01T00:00:00.000Z", url: "https://github.com/org/repo/pull/9" },
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await runApprove(ctx({
      path: "fountain-apply", extraPositional: "rollout-gate", actor: "alex",
      note: "rolled staging first", url: "https://github.com/org/repo/pull/9",
    }));

    expect(code).toBe(0);
    expect(appendGateResolutionMock).toHaveBeenCalledWith(
      expect.objectContaining({ note: "rolled staging first", url: "https://github.com/org/repo/pull/9" }),
    );
    errSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  test("without --url, the surrounding PR/MR job is itself the address", async () => {
    vi.stubEnv("GITHUB_SERVER_URL", "https://github.com");
    vi.stubEnv("GITHUB_REPOSITORY", "INTENTIUS/chant");
    vi.stubEnv("GITHUB_REF_NAME", "2028/merge");
    appendGateResolutionMock.mockResolvedValue({
      commit: "sha",
      record: { version: 1, op: "fountain-apply", gate: "g", resolvedBy: "alex", timestamp: "2026-01-01T00:00:00.000Z" },
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await runApprove(ctx({ path: "fountain-apply", extraPositional: "g", actor: "alex" }))).toBe(0);
    expect(appendGateResolutionMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://github.com/INTENTIUS/chant/pull/2028" }),
    );
    errSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  test("a --url that is not an absolute http/https link is refused, and nothing is written", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await runApprove(ctx({ path: "fountain-apply", extraPositional: "g", url: "org/repo/pull/1" }));
    expect(code).toBe(1);
    expect(appendGateResolutionMock).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test("warns (but still records) when the op isn't among discovered *.op.ts declarations", async () => {
    discoverOpsMock.mockResolvedValue({ ops: new Map(), errors: [] });
    appendGateResolutionMock.mockResolvedValue({
      commit: "sha",
      record: { version: 1, op: "unknown-op", gate: "g", resolvedBy: "unknown", timestamp: "2026-01-01T00:00:00.000Z" },
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await runApprove(ctx({ path: "unknown-op", extraPositional: "g" }));
    expect(code).toBe(0);
    expect(appendGateResolutionMock).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

// ── chant operator log (#2029) ────────────────────────────────────────────────

describe("runOperatorLog", () => {
  function tick(over: Record<string, unknown> = {}) {
    return {
      version: 1,
      id: "11111111-2222-3333-4444-555555555555",
      op: "staging-converge",
      env: "staging",
      timestamp: "2026-01-01T00:00:00.000Z",
      firedRuleIds: [],
      outcomes: [],
      summary: { drifted: 0, remediated: 0, reported: 0, skippedBudget: 0, skippedFlap: 0, unobserved: 0, adopted: 0 },
      log: "converge(staging): drifted=0",
      ...over,
    };
  }

  beforeEach(() => {
    discoverConvergeOpsMock.mockResolvedValue({
      ops: [{ config: { name: "staging-converge", searchAttributes: { Env: "staging" } } }],
      errors: [],
    });
    readGateResolutionsMock.mockResolvedValue({ records: [], malformed: 0 });
  });

  test("--json emits the whole tick history, not just the newest row", async () => {
    readConvergeLedgerMock.mockResolvedValue({
      records: [
        tick({ id: "t1", timestamp: "2026-01-01T00:00:00.000Z" }),
        tick({ id: "t2", timestamp: "2026-01-01T01:00:00.000Z" }),
        tick({ id: "t3", timestamp: "2026-01-01T02:00:00.000Z" }),
      ],
      malformed: 0,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runOperatorLog(ctx({ json: true }))).toBe(0);

    const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(printed.entries.map((e: { record: { id: string } }) => e.record.id)).toEqual(["t1", "t2", "t3"]);
    expect(printed.malformed).toEqual({ converge: 0, gates: 0 });
    logSpy.mockRestore();
  });

  test("carries the malformed-line count, so a short timeline is never silently short", async () => {
    readConvergeLedgerMock.mockResolvedValue({ records: [tick()], malformed: 3 });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runOperatorLog(ctx({ json: true }));
    expect(JSON.parse(logSpy.mock.calls[0][0] as string).malformed.converge).toBe(3);

    logSpy.mockClear();
    await runOperatorLog(ctx({}));
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("3 ledger line(s) were unreadable");

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  test("gate resolutions are merged into the timeline, in timestamp order after the tick that gated", async () => {
    readConvergeLedgerMock.mockResolvedValue({
      records: [
        tick({
          id: "t1",
          timestamp: "2026-01-01T00:00:00.000Z",
          outcomes: [{ ruleId: "drift-apply", action: "gated", op: "fountain-apply", gateName: "rollout-gate", url: "https://pr.example/1" }],
        }),
        tick({ id: "t2", timestamp: "2026-01-03T00:00:00.000Z" }),
      ],
      malformed: 0,
    });
    readGateResolutionsMock.mockResolvedValue({
      records: [{ version: 1, op: "fountain-apply", gate: "rollout-gate", resolvedBy: "alex", timestamp: "2026-01-02T00:00:00.000Z", url: "https://pr.example/1" }],
      malformed: 0,
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runOperatorLog(ctx({ json: true }));
    const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(printed.entries.map((e: { kind: string }) => e.kind)).toEqual(["tick", "gate-resolution", "tick"]);
    expect(readGateResolutionsMock).toHaveBeenCalledWith("fountain-apply", expect.anything());
    logSpy.mockRestore();
  });

  test("--since drops everything older, --limit keeps the newest n (still oldest-first)", async () => {
    readConvergeLedgerMock.mockResolvedValue({
      records: [
        tick({ id: "t1", timestamp: "2026-01-01T00:00:00.000Z" }),
        tick({ id: "t2", timestamp: "2026-01-02T00:00:00.000Z" }),
        tick({ id: "t3", timestamp: "2026-01-03T00:00:00.000Z" }),
        tick({ id: "t4", timestamp: "2026-01-04T00:00:00.000Z" }),
      ],
      malformed: 0,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runOperatorLog(ctx({ json: true, since: "2026-01-02T00:00:00.000Z" }));
    expect(JSON.parse(logSpy.mock.calls[0][0] as string).entries.map((e: { record: { id: string } }) => e.record.id))
      .toEqual(["t2", "t3", "t4"]);

    logSpy.mockClear();
    await runOperatorLog(ctx({ json: true, limit: 2 }));
    expect(JSON.parse(logSpy.mock.calls[0][0] as string).entries.map((e: { record: { id: string } }) => e.record.id))
      .toEqual(["t3", "t4"]);

    logSpy.mockRestore();
  });

  test("--op restricts to one ConvergeOp", async () => {
    discoverConvergeOpsMock.mockResolvedValue({
      ops: [
        { config: { name: "staging-converge", searchAttributes: { Env: "staging" } } },
        { config: { name: "other-converge", searchAttributes: { Env: "staging" } } },
      ],
      errors: [],
    });
    readConvergeLedgerMock.mockResolvedValue({
      records: [tick({ id: "t1" }), tick({ id: "t2", op: "other-converge" })],
      malformed: 0,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runOperatorLog(ctx({ json: true, op: "other-converge" }));
    expect(JSON.parse(logSpy.mock.calls[0][0] as string).entries.map((e: { record: { id: string } }) => e.record.id))
      .toEqual(["t2"]);
    logSpy.mockRestore();
  });

  test("two ConvergeOps sharing one environment read that ledger once", async () => {
    discoverConvergeOpsMock.mockResolvedValue({
      ops: [
        { config: { name: "staging-converge", searchAttributes: { Env: "staging" } } },
        { config: { name: "other-converge", searchAttributes: { Env: "staging" } } },
      ],
      errors: [],
    });
    readConvergeLedgerMock.mockResolvedValue({ records: [tick()], malformed: 2 });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runOperatorLog(ctx({ json: true }));
    expect(readConvergeLedgerMock).toHaveBeenCalledTimes(1);
    // ...and its malformed count is not double-counted.
    expect(JSON.parse(logSpy.mock.calls[0][0] as string).malformed.converge).toBe(2);
    logSpy.mockRestore();
  });

  test("refuses an unparseable --since and a non-positive --limit without reading anything", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runOperatorLog(ctx({ since: "last tuesday" }))).toBe(1);
    expect(await runOperatorLog(ctx({ limit: 0 }))).toBe(1);
    expect(await runOperatorLog(ctx({ limit: 1.5 }))).toBe(1);
    expect(readConvergeLedgerMock).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test("prints the tick id, log line and gated outcomes in the human render", async () => {
    readConvergeLedgerMock.mockResolvedValue({
      records: [tick({
        id: "abcdef01-2222-3333-4444-555555555555",
        outcomes: [{ ruleId: "drift-apply", action: "gated", op: "fountain-apply", gateName: "rollout-gate", url: "https://pr.example/1" }],
      })],
      malformed: 0,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runOperatorLog(ctx({}));
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("[abcdef01]");
    expect(out).toContain("converge(staging): drifted=0");
    expect(out).toContain('gated  drift-apply → fountain-apply gate "rollout-gate"  https://pr.example/1');
    logSpy.mockRestore();
  });

  test("exits 0 with a warning when no ConvergeOps are discovered", async () => {
    discoverConvergeOpsMock.mockResolvedValue({ ops: [], errors: [] });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runOperatorLog(ctx({}))).toBe(0);
    errSpy.mockRestore();
  });
});
