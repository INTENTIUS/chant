import { describe, expect, test } from "vitest";
import {
  describeTargets,
  drillOutcome,
  evaluateTargets,
  formatSpan,
  latestDrillPerStore,
  parseDrillLedger,
  parseDrillTargets,
  type DrillRecord,
} from "./drill-record";

const H = 3_600_000;
const M = 60_000;

const rec = (store: string, ended: string, more: Partial<DrillRecord> = {}): DrillRecord => ({
  version: 1,
  id: `${store}-${ended}`,
  store,
  kind: "rds",
  env: "prod",
  scratch: "drill-x",
  started: ended,
  ended,
  backup: null,
  rtoMs: null,
  restoreMs: null,
  rpoMs: null,
  targets: {},
  met: null,
  shortfall: {},
  outcome: "passed",
  checks: [],
  tornDown: true,
  ...more,
});

describe("targets", () => {
  test("durations are read in milliseconds", () => {
    expect(parseDrillTargets({ rto: "4h", rpo: "15m" })).toEqual({ rtoMs: 4 * H, rpoMs: 15 * M });
    expect(parseDrillTargets({ rto: "1h30m" })).toEqual({ rtoMs: 90 * M });
    expect(parseDrillTargets(undefined)).toEqual({});
  });

  test("a value that is not a duration names the target", () => {
    expect(() => parseDrillTargets({ rto: "soon" })).toThrow(/rto: "soon" is not a duration/);
    expect(() => parseDrillTargets({ rpo: "0m" })).toThrow(/rpo: "0m" must be longer than zero/);
  });

  test("spans are written the way people read them", () => {
    expect(formatSpan(800)).toBe("800ms");
    expect(formatSpan(30_000)).toBe("30s");
    expect(formatSpan(4 * M + 30_000)).toBe("4m30s");
    expect(formatSpan(72 * M)).toBe("1h12m");
    expect(formatSpan(4 * H)).toBe("4h");
  });
});

describe("evaluateTargets", () => {
  const targets = { rtoMs: 4 * H, rpoMs: 15 * M };

  test("both within target is met", () => {
    expect(evaluateTargets({ rtoMs: 3 * H, rpoMs: 10 * M }, targets)).toEqual({ met: true, shortfall: {} });
  });

  test("equal to a target is met", () => {
    expect(evaluateTargets({ rtoMs: 4 * H, rpoMs: 15 * M }, targets).met).toBe(true);
  });

  test("a missed target says by how much", () => {
    expect(evaluateTargets({ rtoMs: 5 * H + 12 * M, rpoMs: 10 * M }, targets)).toEqual({ met: false, shortfall: { rtoMs: H + 12 * M } });
    expect(evaluateTargets({ rtoMs: 4 * H, rpoMs: 20 * M }, targets)).toEqual({ met: false, shortfall: { rpoMs: 5 * M } });
  });

  test("a missed target is missed even when the other has no measurement", () => {
    expect(evaluateTargets({ rtoMs: null, rpoMs: 20 * M }, targets).met).toBe(false);
  });

  test("no declared target, or a target with no measurement, leaves met null", () => {
    expect(evaluateTargets({ rtoMs: H, rpoMs: M }, {}).met).toBeNull();
    expect(evaluateTargets({ rtoMs: null, rpoMs: M }, { rtoMs: H }).met).toBeNull();
  });

  test("a target left out is not checked", () => {
    expect(evaluateTargets({ rtoMs: 9 * H, rpoMs: M }, { rpoMs: 15 * M }).met).toBe(true);
  });

  test("the failure sentence names each target, the measurement and the overrun", () => {
    expect(describeTargets("orders", { rtoMs: 5 * H + 12 * M, rpoMs: 10 * M }, targets)).toBe(
      "restore drill orders: RTO 5h12m against 4h, over by 1h12m; RPO 10m against 15m, met",
    );
    expect(describeTargets("orders", { rtoMs: null, rpoMs: 10 * M }, { rtoMs: 4 * H })).toBe("restore drill orders: RTO not measured against 4h");
  });
});

describe("drillOutcome", () => {
  test("a failure or a failed check is failed, a missed target is missed, the rest passed", () => {
    expect(drillOutcome(true, true, null)).toBe("failed");
    expect(drillOutcome(false, false, true)).toBe("failed");
    expect(drillOutcome(true, false, false)).toBe("missed");
    expect(drillOutcome(true, false, true)).toBe("passed");
    expect(drillOutcome(true, false, null)).toBe("passed");
  });
});

describe("the ledger", () => {
  test("lines are read oldest first and a line that is not a drill is counted", () => {
    const a = rec("a", "2026-01-01T00:00:00.000Z");
    const b = rec("b", "2026-01-02T00:00:00.000Z");
    const text = `${JSON.stringify(a)}\nnot json\n{"version":1}\n\n${JSON.stringify(b)}\n`;
    const out = parseDrillLedger(text);
    expect(out.records.map((r) => r.store)).toEqual(["a", "b"]);
    expect(out.malformed).toBe(2);
  });

  test("the newest drill of each store wins, sorted by store", () => {
    const out = latestDrillPerStore([
      rec("orders", "2026-01-03T00:00:00.000Z", { outcome: "missed" }),
      rec("users", "2026-01-01T00:00:00.000Z"),
      rec("orders", "2026-01-01T00:00:00.000Z"),
      rec("orders", "2026-01-05T00:00:00.000Z", { outcome: "failed" }),
    ]);
    expect(out.map((r) => [r.store, r.outcome])).toEqual([["orders", "failed"], ["users", "passed"]]);
  });
});
