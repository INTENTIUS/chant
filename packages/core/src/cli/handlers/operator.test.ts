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
const appendPendingGateMock = vi.fn();
const readGateResolutionsMock = vi.fn();
const readGateLedgerMock = vi.fn();
const readRunLedgerMock = vi.fn();
const pushLifecycleMock = vi.fn();
const requireLifecycleLedgerMock = vi.fn();

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
vi.mock("../../lifecycle/run-ledger", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/run-ledger")>("../../lifecycle/run-ledger");
  return { ...actual, readRunLedger: (...args: unknown[]) => readRunLedgerMock(...args) };
});
vi.mock("../../lifecycle/gate-ledger", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/gate-ledger")>("../../lifecycle/gate-ledger");
  return {
    ...actual,
    appendGateResolution: (...args: unknown[]) => appendGateResolutionMock(...args),
    appendPendingGate: (...args: unknown[]) => appendPendingGateMock(...args),
    readGateResolutions: (...args: unknown[]) => readGateResolutionsMock(...args),
    readGateLedger: (...args: unknown[]) => readGateLedgerMock(...args),
  };
});
vi.mock("../../lifecycle/git", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/git")>("../../lifecycle/git");
  return {
    ...actual,
    pushLifecycle: (...args: unknown[]) => pushLifecycleMock(...args),
    // Mocked, not merely defaulted: the real one shells to `git fetch`, and
    // these tests run in the chant checkout itself (#2303).
    requireLifecycleLedger: (...args: unknown[]) => requireLifecycleLedgerMock(...args),
  };
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
  requireLifecycleLedgerMock.mockResolvedValue(undefined);
  readGateResolutionsMock.mockResolvedValue({ records: [], malformed: 0 });
  readGateLedgerMock.mockResolvedValue({ resolutions: [], pending: [], malformed: 0 });
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
    runOperatorRoundMock.mockResolvedValue([{ kind: "ticked", op: "staging-converge", env: "staging", result: { op: "staging-converge", records: [], totalMs: 1, status: "ok", startedAt: "2026-01-01T00:00:00.000Z" } }]);

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
      ops: [{ config: { name: "staging-converge", labels: { Env: "staging" } } }],
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
      ops: [{ config: { name: "staging-converge", labels: { Env: "staging" } } }],
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
      ops: [{ config: { name: "staging-converge", labels: { Env: "staging" } } }],
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
      ops: [{ config: { name: "staging-converge", labels: { Env: "staging" } } }],
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
  // #2119 — a gate a plain `chant run <op>` stopped at is a pending fact on
  // that op's own ledger, with no converge tick anywhere behind it.
  test("lists a pending fact for a non-converge op", async () => {
    discoverConvergeOpsMock.mockResolvedValue({ ops: [], errors: [] });
    discoverOpsMock.mockResolvedValue({ ops: new Map([["prod-apply", {}]]), errors: [] });
    readGateLedgerMock.mockResolvedValue({
      resolutions: [],
      pending: [{
        version: 1, kind: "pending", op: "prod-apply", gate: "rollout-gate",
        description: "release manager signs off",
        timestamp: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
        url: "https://pr.example/9",
      }],
      malformed: 0,
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runOperatorStatus(ctx({}))).toBe(0);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("pending gates (no converge tick)");
    expect(out).toContain("chant approve prod-apply rollout-gate");
    expect(out).toContain("expires: 2099-01-01T00:00:00.000Z");
    expect(out).toContain("approve at: https://pr.example/9");
    logSpy.mockRestore();
  });

  test("an expired pending fact is not listed", async () => {
    discoverConvergeOpsMock.mockResolvedValue({ ops: [], errors: [] });
    discoverOpsMock.mockResolvedValue({ ops: new Map([["prod-apply", {}]]), errors: [] });
    readGateLedgerMock.mockResolvedValue({
      resolutions: [],
      pending: [{
        version: 1, kind: "pending", op: "prod-apply", gate: "rollout-gate",
        timestamp: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-03T00:00:00.000Z",
      }],
      malformed: 0,
    });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runOperatorStatus(ctx({}))).toBe(0);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("pending gates");
    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});

/**
 * A digest shaped the way `computePlanDigest` produces them (#2300).
 */
const PLAN_A = `sha256:${"a".repeat(64)}`;

/**
 * The standing pending fact `chant approve` reads the plan off since #2300.
 * Every approve test seeds one, because a gate with nothing pending has no
 * plan to approve and the command refuses rather than recording an approval
 * of whatever runs next — which is its own test below.
 */
function seedPending(op: string, gate: string, planDigest: string | undefined): void {
  readGateLedgerMock.mockResolvedValue({
    resolutions: [],
    pending: [{
      version: 1, kind: "pending", op, gate,
      timestamp: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
      ...(planDigest !== undefined ? { planDigest } : {}),
    }],
    malformed: 0,
  });
}

describe("runApprove", () => {
  test("requires both <op> and <gate>", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runApprove(ctx({ path: "." }))).toBe(1);
    expect(await runApprove(ctx({ path: "fountain-apply" }))).toBe(1);
    errSpy.mockRestore();
  });

  test("appends a gate-resolution record and pushes, resolving --actor over env fallbacks", async () => {
    seedPending("fountain-apply", "rollout-gate", PLAN_A);
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

  // #2192 — every example README teaches `--approver you`; the handler read
  // only `--actor` and fell through to $GITHUB_ACTOR / $USER, so the ledger
  // recorded the shell user. Same precedence as `chant run approve`.
  test("--approver wins over --actor and over the CI/shell identity", async () => {
    vi.stubEnv("GITHUB_ACTOR", "ci-bot");
    vi.stubEnv("USER", "alex");
    seedPending("deploy-gated", "approve-deploy", PLAN_A);
    appendGateResolutionMock.mockResolvedValue({
      commit: "sha",
      record: { version: 1, op: "deploy-gated", gate: "approve-deploy", resolvedBy: "you", timestamp: "2026-01-01T00:00:00.000Z" },
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await runApprove(ctx({
      path: "deploy-gated", extraPositional: "approve-deploy", approver: "you", actor: "alex",
    }));

    expect(code).toBe(0);
    expect(appendGateResolutionMock).toHaveBeenCalledWith(
      expect.objectContaining({ op: "deploy-gated", gate: "approve-deploy", resolvedBy: "you" }),
    );
    errSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  // #2028 — the resolution's link is typed, so a reader is not sniffing
  // free-text `note` for something that looks like a URL.
  test("--url is recorded typed, alongside --note's prose", async () => {
    vi.stubEnv("GITHUB_REF_NAME", "");
    vi.stubEnv("GITHUB_REPOSITORY", "");
    vi.stubEnv("CI_MERGE_REQUEST_PROJECT_URL", "");
    seedPending("fountain-apply", "rollout-gate", PLAN_A);
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
    seedPending("fountain-apply", "g", PLAN_A);
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

  // #2119 — `--expire` clears a standing pending fact without approving it.
  test("--expire supersedes the standing pending fact and writes no resolution", async () => {
    readGateLedgerMock.mockResolvedValue({
      resolutions: [],
      pending: [{
        version: 1, kind: "pending", op: "fountain-apply", gate: "rollout-gate",
        description: "release manager signs off",
        timestamp: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
      }],
      malformed: 0,
    });
    appendPendingGateMock.mockResolvedValue({ commit: "sha", record: {} });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await runApprove(ctx({ path: "fountain-apply", extraPositional: "rollout-gate", expire: true }));

    expect(code).toBe(0);
    expect(appendGateResolutionMock).not.toHaveBeenCalled();
    const written = appendPendingGateMock.mock.calls[0][0];
    expect(written.op).toBe("fountain-apply");
    expect(written.gate).toBe("rollout-gate");
    expect(written.description).toBe("release manager signs off");
    // Already expired the moment it is written: the next run re-decides.
    expect(written.expiresAt).toBe(written.timestamp);
    expect(pushLifecycleMock).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test("--expire with nothing standing writes nothing and still exits 0", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await runApprove(ctx({ path: "fountain-apply", extraPositional: "rollout-gate", expire: true }));
    expect(code).toBe(0);
    expect(appendPendingGateMock).not.toHaveBeenCalled();
    expect(appendGateResolutionMock).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test("warns (but still records) when the op isn't among discovered *.op.ts declarations", async () => {
    discoverOpsMock.mockResolvedValue({ ops: new Map(), errors: [] });
    seedPending("unknown-op", "g", PLAN_A);
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
      ops: [{ config: { name: "staging-converge", labels: { Env: "staging" } } }],
      errors: [],
    });
    readGateResolutionsMock.mockResolvedValue({ records: [], malformed: 0 });
    readRunLedgerMock.mockResolvedValue({ records: [], malformed: 0 });
  });

  /** One Op-run record (#2118) as `readRunLedger` returns it. */
  function run(over: Record<string, unknown> = {}) {
    return {
      version: 1,
      id: "99999999-8888-7777-6666-555555555555",
      op: "staging-converge",
      env: "staging",
      started: "2026-01-01T00:29:00.000Z",
      ended: "2026-01-01T00:30:00.000Z",
      status: "ok",
      labels: { Converge: "true", Env: "staging" },
      outcomes: { Drift: false },
      phases: [{ name: "Converge", status: "ok", steps: [{ fn: "convergeTick", status: "ok", durationMs: 60_000 }] }],
      ...over,
    };
  }

  test("run records are merged into the timeline, ordered by the instant they ended (#2118)", async () => {
    readConvergeLedgerMock.mockResolvedValue({
      records: [
        tick({ id: "t1", timestamp: "2026-01-01T00:00:00.000Z" }),
        tick({ id: "t2", timestamp: "2026-01-01T01:00:00.000Z" }),
      ],
      malformed: 0,
    });
    readRunLedgerMock.mockResolvedValue({ records: [run({ id: "r1" })], malformed: 0 });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runOperatorLog(ctx({ json: true }))).toBe(0);

    const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(printed.entries.map((e: { kind: string; record: { id: string } }) => [e.kind, e.record.id])).toEqual([
      ["tick", "t1"],
      ["run", "r1"],
      ["tick", "t2"],
    ]);
    expect(readRunLedgerMock).toHaveBeenCalledWith("staging", "staging-converge", expect.anything());
    logSpy.mockRestore();
  });

  test("a run renders one line naming its status and captured outcomes", async () => {
    readConvergeLedgerMock.mockResolvedValue({ records: [], malformed: 0 });
    readRunLedgerMock.mockResolvedValue({ records: [run({ id: "r1", status: "gated" })], malformed: 0 });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runOperatorLog(ctx({}))).toBe(0);

    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("staging-converge@staging");
    expect(out).toContain("run gated phases=1 steps=1");
    expect(out).toContain("Drift=false");
    logSpy.mockRestore();
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
    expect(printed.malformed).toEqual({ converge: 0, gates: 0, runs: 0 });
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
        { config: { name: "staging-converge", labels: { Env: "staging" } } },
        { config: { name: "other-converge", labels: { Env: "staging" } } },
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
        { config: { name: "staging-converge", labels: { Env: "staging" } } },
        { config: { name: "other-converge", labels: { Env: "staging" } } },
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

/**
 * #2303 finding 2, at the handler. The mechanism is proved against real git
 * in `op/gate.test.ts`; what these hold is that `chant approve` actually goes
 * through the guard, and stops rather than writing when it refuses — the
 * append must not be reached, because reaching it is what discarded the
 * pending fact in the first place.
 */
/**
 * #2300 — an approval is for a plan. `chant approve` records the plan it
 * approves, so the resolution says what was reviewed rather than only who
 * reviewed and when.
 */
describe("runApprove — the resolution names the plan it approves (#2300)", () => {
  test("by default it approves the standing pending fact's plan, so the common path stays one command", async () => {
    seedPending("fountain-apply", "rollout-gate", PLAN_A);
    appendGateResolutionMock.mockResolvedValue({
      commit: "sha",
      record: { version: 1, op: "fountain-apply", gate: "rollout-gate", resolvedBy: "alex", timestamp: "2026-01-01T00:00:00.000Z", planDigest: PLAN_A },
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await runApprove(ctx({ path: "fountain-apply", extraPositional: "rollout-gate", actor: "alex" }))).toBe(0);
    expect(appendGateResolutionMock).toHaveBeenCalledWith(expect.objectContaining({ planDigest: PLAN_A }));
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(`approves the plan ${PLAN_A}`);
    errSpy.mockRestore();
  });

  test("--plan names one explicitly, and wins over the standing fact's", async () => {
    const other = `sha256:${"b".repeat(64)}`;
    seedPending("fountain-apply", "rollout-gate", PLAN_A);
    appendGateResolutionMock.mockResolvedValue({
      commit: "sha",
      record: { version: 1, op: "fountain-apply", gate: "rollout-gate", resolvedBy: "alex", timestamp: "2026-01-01T00:00:00.000Z", planDigest: other },
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await runApprove(ctx({ path: "fountain-apply", extraPositional: "rollout-gate", actor: "alex", plan: other }))).toBe(0);
    expect(appendGateResolutionMock).toHaveBeenCalledWith(expect.objectContaining({ planDigest: other }));
    errSpy.mockRestore();
  });

  // With nothing pending there is no plan on the ledger to approve, and
  // recording a resolution anyway is exactly how an approval came to mean
  // "the next run" (INTENTIUS/choudoufu#1026).
  test("with no pending record it refuses, writes nothing, and names the fix", async () => {
    readGateLedgerMock.mockResolvedValue({ resolutions: [], pending: [], malformed: 0 });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await runApprove(ctx({ path: "fountain-apply", extraPositional: "rollout-gate", actor: "alex" }));

    expect(code).toBe(1);
    expect(appendGateResolutionMock).not.toHaveBeenCalled();
    expect(pushLifecycleMock).not.toHaveBeenCalled();
    const out = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("has no pending fact, so there is no plan to approve");
    expect(out).toContain("chant run fountain-apply");
    expect(out).toContain("--plan <digest>");
    errSpy.mockRestore();
  });

  // ...but `--plan` is the escape hatch, so approving a plan whose digest you
  // already hold does not need a run to have recorded a pending fact first.
  test("--plan approves with nothing pending", async () => {
    readGateLedgerMock.mockResolvedValue({ resolutions: [], pending: [], malformed: 0 });
    appendGateResolutionMock.mockResolvedValue({
      commit: "sha",
      record: { version: 1, op: "fountain-apply", gate: "rollout-gate", resolvedBy: "alex", timestamp: "2026-01-01T00:00:00.000Z", planDigest: PLAN_A },
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await runApprove(ctx({ path: "fountain-apply", extraPositional: "rollout-gate", actor: "alex", plan: PLAN_A }))).toBe(0);
    expect(appendGateResolutionMock).toHaveBeenCalledWith(expect.objectContaining({ planDigest: PLAN_A }));
    errSpy.mockRestore();
  });

  test("a --plan that is not a digest is refused before anything is written", async () => {
    seedPending("fountain-apply", "rollout-gate", PLAN_A);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await runApprove(ctx({
      path: "fountain-apply", extraPositional: "rollout-gate", actor: "alex", plan: "chant.tfplan",
    }));

    expect(code).toBe(1);
    expect(appendGateResolutionMock).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("--plan must be a plan digest");
    errSpy.mockRestore();
  });

  // A gate that binds no plan records no digest on its pending fact, so the
  // resolution carries none either — and nothing refuses, because nothing
  // ever claimed to bind a plan there.
  test("a gate that binds no plan approves as it always did", async () => {
    seedPending("fountain-apply", "rollout-gate", undefined);
    appendGateResolutionMock.mockResolvedValue({
      commit: "sha",
      record: { version: 1, op: "fountain-apply", gate: "rollout-gate", resolvedBy: "alex", timestamp: "2026-01-01T00:00:00.000Z" },
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await runApprove(ctx({ path: "fountain-apply", extraPositional: "rollout-gate", actor: "alex" }))).toBe(0);
    expect(appendGateResolutionMock.mock.calls[0][0]).not.toHaveProperty("planDigest");
    errSpy.mockRestore();
  });
});

describe("runApprove — the ledger branch is read before it is appended to (#2303)", () => {
  test("reads the branch before recording the resolution", async () => {
    seedPending("fountain-apply", "rollout-gate", PLAN_A);
    appendGateResolutionMock.mockResolvedValue({
      commit: "sha",
      record: { version: 1, op: "fountain-apply", gate: "rollout-gate", resolvedBy: "alex", timestamp: "2026-01-01T00:00:00.000Z" },
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await runApprove(ctx({ path: "fountain-apply", extraPositional: "rollout-gate", actor: "alex" }))).toBe(0);

    expect(requireLifecycleLedgerMock).toHaveBeenCalled();
    expect(requireLifecycleLedgerMock.mock.invocationCallOrder[0]).toBeLessThan(
      appendGateResolutionMock.mock.invocationCallOrder[0],
    );
    errSpy.mockRestore();
  });

  test("refuses by name, and writes nothing, when the branch cannot be read", async () => {
    requireLifecycleLedgerMock.mockRejectedValue(
      new Error(
        'the chant/lifecycle ledger branch is not in this checkout and could not be fetched from "origin"',
      ),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await runApprove(ctx({ path: "fountain-apply", extraPositional: "rollout-gate", actor: "alex" }));

    expect(code).toBe(1);
    expect(appendGateResolutionMock).not.toHaveBeenCalled();
    expect(pushLifecycleMock).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("chant/lifecycle ledger branch");
    errSpy.mockRestore();
  });

  test("--expire is guarded the same way", async () => {
    requireLifecycleLedgerMock.mockRejectedValue(new Error("the chant/lifecycle ledger branch has diverged"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await runApprove(ctx({ path: "fountain-apply", extraPositional: "rollout-gate", expire: true }));

    expect(code).toBe(1);
    expect(appendPendingGateMock).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

/**
 * #2309 review. `pushLifecycle().catch(() => undefined)` at both write sites
 * meant a rejected push printed unconditional success and exited 0 — the
 * operator walks away believing the gate is answered for everybody, while the
 * resolution exists only in their own checkout.
 */
describe("runApprove — a push that does not land is reported (#2309 review)", () => {
  test("a rejected push warns and marks the success line local-only", async () => {
    seedPending("fountain-apply", "rollout-gate", PLAN_A);
    appendGateResolutionMock.mockResolvedValue({
      commit: "sha",
      record: { version: 1, op: "fountain-apply", gate: "rollout-gate", resolvedBy: "alex", timestamp: "2026-01-01T00:00:00.000Z" },
    });
    pushLifecycleMock.mockRejectedValue(new Error("Another snapshot completed for chant/lifecycle"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await runApprove(ctx({ path: "fountain-apply", extraPositional: "rollout-gate", actor: "alex" }));

    const out = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toMatch(/push to the remote was rejected/);
    expect(out).toMatch(/local only . the push did not land/);
    // Still exit 0: the local append is a correct local fact.
    expect(code).toBe(0);
    errSpy.mockRestore();
  });

  test("a project with no remote says nothing was pushed", async () => {
    seedPending("fountain-apply", "rollout-gate", PLAN_A);
    appendGateResolutionMock.mockResolvedValue({
      commit: "sha",
      record: { version: 1, op: "fountain-apply", gate: "rollout-gate", resolvedBy: "alex", timestamp: "2026-01-01T00:00:00.000Z" },
    });
    pushLifecycleMock.mockResolvedValue(false);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runApprove(ctx({ path: "fountain-apply", extraPositional: "rollout-gate", actor: "alex" }));

    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/No remote is configured/);
    errSpy.mockRestore();
  });
});
