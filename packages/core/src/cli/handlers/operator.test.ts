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
const { runOperator, runOperatorStatus, runApprove } = await import("./operator");

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
