import { describe, test, expect, vi, beforeEach } from "vitest";
import type { OpConfig } from "../types";
import type { OpRunRecord, OpRunRecordInput } from "../runtime";

const loadActivitiesMock = vi.fn();
const loadProfilesMock = vi.fn();
const loadChantConfigMock = vi.fn();

vi.mock("../activity-registry", async () => {
  const actual = await vi.importActual<typeof import("../activity-registry")>("../activity-registry");
  return {
    ...actual,
    loadActivities: (...args: unknown[]) => loadActivitiesMock(...args),
    loadProfiles: (...args: unknown[]) => loadProfilesMock(...args),
  };
});
vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return { ...actual, loadChantConfig: (...args: unknown[]) => loadChantConfigMock(...args) };
});

// The gate ledger a local run consults (#2119) is the `chant/lifecycle` orphan
// branch by default. Point it at memory here so a unit test never writes a
// fact to the real repo.
vi.mock("../gate", async () => {
  const actual = await vi.importActual<typeof import("../gate")>("../gate");
  return { ...actual, gitGateLedgerPort: () => actual.memoryGateLedgerPort() };
});

/** The run ledger, in memory — see the mock below. Cleared before each test. */
const runLedger: OpRunRecord[] = [];

// The run ledger this runtime appends to and answers from (#2118) is that same
// orphan branch. In memory here for the same reason the gate ledger is: a unit
// test must never leave a fact in the real repo. Everything else about the
// ledger path stays real, so these tests exercise the actual read-back.
vi.mock("../../lifecycle/run-ledger", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/run-ledger")>("../../lifecycle/run-ledger");
  return {
    ...actual,
    appendRunRecord: async (input: OpRunRecordInput) => {
      const record: OpRunRecord = { version: 1, ...input, id: input.id ?? `run-${runLedger.length}` };
      runLedger.push(record);
      return { commit: "0".repeat(40), record };
    },
    readRunLedger: async (_env: string, op: string) => ({
      records: runLedger.filter((r) => r.op === op),
      malformed: 0,
    }),
  };
});

const { createLocalOpRuntime } = await import("./local");

function op(name: string, steps: unknown[]): OpConfig {
  return {
    name,
    overview: `${name} overview`,
    phases: [{ name: "main", steps }],
  } as unknown as OpConfig;
}

describe("the local op runtime", () => {
  beforeEach(() => {
    loadActivitiesMock.mockReset();
    loadProfilesMock.mockReset().mockResolvedValue({ fastIdempotent: { timeout: "1m" } });
    loadChantConfigMock.mockReset().mockResolvedValue({ config: { lexicons: ["aws"] } });
    runLedger.length = 0;
  });

  test("start runs the Op and reports it completed, with the executor's own result", async () => {
    loadActivitiesMock.mockResolvedValue(new Map([["ok", vi.fn(async () => ({ done: true }))]]));
    const runtime = createLocalOpRuntime();

    const handle = await runtime.start(op("hello", [{ kind: "activity", fn: "ok", args: {} }]), {});
    const status = await handle.result();

    expect(runtime.name).toBe("local");
    expect(status.state).toBe("completed");
    expect(status.result?.status).toBe("ok");
    expect(status.records?.map((r) => r.fn)).toEqual(["ok"]);
  });

  test("the project's configured lexicons decide which appliers load", async () => {
    loadActivitiesMock.mockResolvedValue(new Map([["ok", vi.fn(async () => ({}))]]));
    const runtime = createLocalOpRuntime();
    await (await runtime.start(op("hello", [{ kind: "activity", fn: "ok", args: {} }]), {})).result();
    expect(loadActivitiesMock).toHaveBeenCalledWith(["aws"]);
  });

  test("a failing step settles as failed rather than throwing out of result()", async () => {
    loadActivitiesMock.mockResolvedValue(new Map([["boom", vi.fn(async () => { throw new Error("nope"); })]]));
    const runtime = createLocalOpRuntime();

    const handle = await runtime.start(op("bad", [{ kind: "activity", fn: "boom", args: {} }]), {});
    const status = await handle.result();

    expect(status.state).toBe("failed");
    expect(status.result?.status).toBe("fail");
  });

  test("progress is called once per settled step", async () => {
    loadActivitiesMock.mockResolvedValue(new Map([["ok", vi.fn(async () => ({}))]]));
    const runtime = createLocalOpRuntime();
    const seen: string[] = [];

    const handle = await runtime.start(
      op("hello", [
        { kind: "activity", fn: "ok", args: {} },
        { kind: "activity", fn: "ok", args: {} },
      ]),
      { progress: (record) => seen.push(record.fn) },
    );
    await handle.result();

    expect(seen).toEqual(["ok", "ok"]);
  });

  test("a gated Op settles as gated, naming the gate, and runs nothing after it (#2119)", async () => {
    const after = vi.fn(async () => ({}));
    loadActivitiesMock.mockResolvedValue(new Map([["after", after]]));
    const runtime = createLocalOpRuntime();

    const handle = await runtime.start(
      op("gated", [
        { kind: "gate", gate: "approve-prod" },
        { kind: "activity", fn: "after", args: {} },
      ]),
      {},
    );
    const status = await handle.result();

    expect(status.state).toBe("gated");
    expect(status.gate?.name).toBe("approve-prod");
    expect(status.result?.status).toBe("gated");
    expect(after).not.toHaveBeenCalled();
  });

  test("status, log and list answer from the run ledger (#2118)", async () => {
    loadActivitiesMock.mockResolvedValue(new Map([["ok", vi.fn(async () => ({}))]]));
    const runtime = createLocalOpRuntime();
    const config = op("hello", [{ kind: "activity", fn: "ok", args: {} }]);

    expect(await runtime.status("hello")).toBeUndefined();
    expect(await runtime.log("hello")).toEqual([]);

    await (await runtime.start(config, {})).result();
    await (await runtime.start(config, {})).result();

    // Two records on the ledger, not two entries in a process-local map.
    expect(runLedger.map((r) => r.op)).toEqual(["hello", "hello"]);
    expect((await runtime.status("hello"))?.state).toBe("completed");
    expect(await runtime.log("hello")).toHaveLength(2);
    expect(await runtime.log("hello", { limit: 1 })).toHaveLength(1);
    expect((await runtime.list([config])).get("hello")?.state).toBe("completed");

    // Newest first, and the ledger's own id is the run id a reader sees.
    const [newest] = await runtime.log("hello");
    expect(newest.id).toBe(runLedger[1].id);
    expect((await runtime.status("hello"))?.runId).toBe(runLedger[1].id);
  });

  test("a run the ledger could not record still answers from this process", async () => {
    loadActivitiesMock.mockResolvedValue(new Map([["ok", vi.fn(async () => ({}))]]));
    const runtime = createLocalOpRuntime();
    const config = op("hello", [{ kind: "activity", fn: "ok", args: {} }]);

    await (await runtime.start(config, {})).result();
    // Whatever the ledger holds is lost (an unwritable branch, a project that
    // is not a checkout); the in-memory history is the fallback.
    runLedger.length = 0;

    expect((await runtime.status("hello"))?.state).toBe("completed");
    expect((await runtime.list([config])).get("hello")?.state).toBe("completed");
  });

  test("cancel says why a foreground run has nothing to cancel", async () => {
    const runtime = createLocalOpRuntime();
    await expect(runtime.cancel("hello", { force: true })).rejects.toThrow(/foreground/);
  });
});
