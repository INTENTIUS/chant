import { describe, test, expect, vi, beforeEach } from "vitest";
import type { OpConfig } from "../types";

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
  });

  test("start runs the Op and reports it completed, with the executor's own result", async () => {
    loadActivitiesMock.mockResolvedValue(new Map([["ok", vi.fn(async () => ({ done: true }))]]));
    const runtime = createLocalOpRuntime();

    const handle = await runtime.start(op("hello", [{ kind: "activity", fn: "ok", args: {} }]), {});
    const status = await handle.result();

    expect(runtime.name).toBe("local");
    expect(status.state).toBe("completed");
    expect(status.result?.ok).toBe(true);
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
    expect(status.result?.ok).toBe(false);
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

  test("a gated Op is refused before any step runs", async () => {
    loadActivitiesMock.mockResolvedValue(new Map());
    const runtime = createLocalOpRuntime();

    await expect(runtime.start(op("gated", [{ kind: "gate", signalName: "approve-prod" }]), {}))
      .rejects.toThrow(/approve-prod/);
    expect(loadActivitiesMock).not.toHaveBeenCalled();
  });

  test("status, log and list answer from the runs this process made", async () => {
    loadActivitiesMock.mockResolvedValue(new Map([["ok", vi.fn(async () => ({}))]]));
    const runtime = createLocalOpRuntime();
    const config = op("hello", [{ kind: "activity", fn: "ok", args: {} }]);

    expect(await runtime.status("hello")).toBeUndefined();
    expect(await runtime.log("hello")).toEqual([]);

    await (await runtime.start(config, {})).result();
    await (await runtime.start(config, {})).result();

    expect((await runtime.status("hello"))?.state).toBe("completed");
    expect(await runtime.log("hello")).toHaveLength(2);
    expect(await runtime.log("hello", { limit: 1 })).toHaveLength(1);
    expect((await runtime.list([config])).get("hello")?.state).toBe("completed");
  });

  test("cancel says why a foreground run has nothing to cancel", async () => {
    const runtime = createLocalOpRuntime();
    await expect(runtime.cancel("hello", { force: true })).rejects.toThrow(/foreground/);
  });
});
