import { describe, expect, it } from "vitest";
import { comparePlanShape, normalizePlanShape, planShapeDigest, PlanShapeMovedError, type PlanShape, type PlanShapeEntry } from "./plan-shape";

const entry = (over: Partial<PlanShapeEntry> = {}): PlanShapeEntry => ({
  address: "Eni",
  type: "T",
  action: "update",
  replacement: "no",
  properties: ["A", "B"],
  unknown: ["B"],
  ...over,
});
const shape = (...entries: PlanShapeEntry[]): PlanShape => ({ member: "m", lexicon: "x", unknownInputs: ["p"], entries });

describe("plan shape", () => {
  it("digests the same for the same shape in another order", () => {
    const a = shape(entry({ address: "a" }), entry({ address: "b", properties: ["Z", "Y"] }));
    const b = shape(entry({ address: "b", properties: ["Y", "Z"] }), entry({ address: "a" }));
    expect(planShapeDigest(a)).toBe(planShapeDigest(b));
    expect(normalizePlanShape(b).entries.map((e) => e.address)).toEqual(["a", "b"]);
  });

  it("accepts an identical change and one narrowed where an unknown input drives it", () => {
    expect(comparePlanShape(shape(entry()), shape(entry()))).toEqual([]);
    expect(comparePlanShape(shape(entry()), shape(entry({ properties: ["A"] })))).toEqual([]);
    expect(comparePlanShape(shape(entry({ replacement: "yes" })), shape(entry({ replacement: "no" })))).toEqual([]);
    expect(comparePlanShape(shape(entry({ properties: ["B"] })), shape())).toEqual([]);
  });

  it("refuses an added resource, an added property, another action, more replacement", () => {
    expect(comparePlanShape(shape(entry()), shape(entry(), entry({ address: "n" })))).toHaveLength(1);
    expect(comparePlanShape(shape(entry()), shape(entry({ properties: ["A", "B", "C"] })))[0].reason).toContain("also changes C");
    expect(comparePlanShape(shape(entry()), shape(entry({ action: "delete" })))[0].reason).toContain("action was update");
    expect(comparePlanShape(shape(entry()), shape(entry({ replacement: "yes" })))[0].reason).toContain("replacement was no");
  });

  it("refuses a change that vanishes or weakens with no unknown input behind it", () => {
    expect(comparePlanShape(shape(entry({ unknown: [] })), shape())).toHaveLength(1);
    expect(comparePlanShape(shape(entry({ unknown: [], replacement: "yes" })), shape(entry({ unknown: [], replacement: "no" })))).toHaveLength(1);
    expect(comparePlanShape(shape(entry()), shape(entry({ properties: ["B"] })))[0].reason).toContain("no longer changes A");
  });

  it("the refusal names the differences and marks the plan as moved", () => {
    const err = new PlanShapeMovedError("m", [{ address: "Eni", reason: "r" }]);
    expect(err.planMoved).toBe(true);
    expect(err.message).toContain("Eni: r");
  });
});
