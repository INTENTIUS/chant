import { describe, expect, test } from "vitest";
import {
  coveredRound,
  normalizePlanShape,
  PlanShapeMovedError,
  planShapeCovers,
  planShapeDifferences,
  planShapeDigest,
  type PlanShape,
  type PlanShapeEntry,
} from "./covered-round";
import type { ChangeSetDocument } from "../change-set";

const shape = (over: Partial<PlanShape> = {}): PlanShape => ({
  member: "svc",
  entries: [
    { logicalId: "Fn", action: "create" },
    { logicalId: "Role", action: "update", replacement: "conditional" },
  ],
  unknownInputs: ["vpc.id"],
  ...over,
});

describe("planShapeCovers", () => {
  test("the same ids and actions with the unknown input filled in is covered", () => {
    expect(planShapeCovers(shape(), shape({ unknownInputs: [], replacement: undefined } as never))).toBeUndefined();
  });

  test("a resource the preview did not show is not covered", () => {
    const fresh = shape({ unknownInputs: [], entries: [...shape().entries, { logicalId: "Bucket", action: "create" }] });
    expect(planShapeCovers(shape(), fresh)).toBe("svc now plans to create Bucket, which the first plan did not");
  });

  test("a different action is not covered", () => {
    const fresh = shape({ unknownInputs: [], entries: [{ logicalId: "Fn", action: "delete" }] });
    expect(planShapeCovers(shape(), fresh)).toBe("svc now plans to delete Fn, where the first plan showed create");
  });

  test("a replacement the preview did not show is not covered; a conditional one resolving either way is", () => {
    const previewed = shape({ entries: [{ logicalId: "Role", action: "update", replacement: "false" }] });
    const replaced = shape({ unknownInputs: [], entries: [{ logicalId: "Role", action: "update", replacement: "true" }] });
    expect(planShapeCovers(previewed, replaced)).toBe("svc now replaces Role, which the first plan did not show");
    for (const r of ["true", "false"] as const) {
      const fresh = shape({ unknownInputs: [], entries: [{ logicalId: "Role", action: "update", replacement: r }] });
      expect(planShapeCovers(shape(), fresh)).toBeUndefined();
    }
  });

  test("a changed known input is not covered, an unknown one filled is", () => {
    const was = shape({ knownInputs: { "net.cidr": "10.0.0.0/16" } });
    expect(planShapeCovers(was, shape({ unknownInputs: [], knownInputs: { "net.cidr": "10.1.0.0/16" } }))).toBe(
      "svc now reads net.cidr as a different value than the first plan",
    );
    expect(planShapeCovers(was, shape({ unknownInputs: [], knownInputs: { "net.cidr": "10.0.0.0/16", "vpc.id": "vpc-1" } }))).toBeUndefined();
  });

  test("an input still unknown is not covered", () => {
    expect(planShapeCovers(shape(), shape())).toBe("svc still reads vpc.id, which is not known yet");
  });
});

describe("coveredRound", () => {
  const doc = { members: [], entries: [] } as unknown as ChangeSetDocument;
  const side = (component: string, unknownInputs?: string[], shapes?: Record<string, PlanShape>) => ({
    doc,
    members: [{ member: "svc", component, ...(unknownInputs ? { unknownInputs } : {}) }],
    ...(shapes ? { shapes } : {}),
  });

  test("covered: binds the first approval's digest and names the inputs filled in", () => {
    const r = coveredRound({
      approved: side("svc", ["vpc.id"], { svc: shape() }),
      approvedDigest: "sha256:aaa",
      fresh: side("svc", undefined, { svc: shape({ unknownInputs: [] }) }),
    });
    expect(r).toEqual({ covered: true, digest: "sha256:aaa", filledInputs: ["vpc.id"] });
  });

  test("a component the first plan did not preview is not covered", () => {
    const r = coveredRound({ approved: side("svc", ["vpc.id"]), approvedDigest: "sha256:aaa", fresh: side("other") });
    expect(r).toEqual({ covered: false, reason: "other was not in the first plan" });
  });

  test("a member that was a hole with no preview shape is not covered, even with its unknown input filled in (#4422)", () => {
    // The approved side has no shape for svc and no entries: the reviewer never saw what it would do.
    const fresh = { svc: shape({ unknownInputs: [], entries: [{ logicalId: "Fn", action: "create" }] }) };
    const r = coveredRound({ approved: side("svc", ["vpc.id"]), approvedDigest: "sha256:aaa", fresh: side("svc", undefined, fresh) });
    expect(r).toEqual({ covered: false, reason: "svc now plans to create Fn, which the first plan did not" });
  });

  test("a known input that moved is not covered", () => {
    const r = coveredRound({
      approved: side("svc", ["vpc.id"]),
      approvedDigest: "sha256:aaa",
      fresh: side("svc"),
      changedKnown: { svc: ["net.cidr", "vpc.id"] },
    });
    expect(r).toEqual({ covered: false, reason: "svc reads net.cidr, which the first plan read as another value" });
  });
});

describe("property-level shapes (ported from plan-shape, #4419)", () => {
  const entry = (over: Partial<PlanShapeEntry> = {}): PlanShapeEntry => ({
    logicalId: "Eni",
    action: "update",
    replacement: "false",
    type: "T",
    properties: ["A", "B"],
    unknown: ["B"],
    ...over,
  });
  const sh = (...entries: PlanShapeEntry[]): PlanShape => ({ member: "m", unknownInputs: ["p"], entries });
  const fresh = (...entries: PlanShapeEntry[]): PlanShape => ({ member: "m", unknownInputs: [], entries });

  test("digests the same for the same shape in another order", () => {
    const a = sh(entry({ logicalId: "a" }), entry({ logicalId: "b", properties: ["Z", "Y"] }));
    const b = sh(entry({ logicalId: "b", properties: ["Y", "Z"] }), entry({ logicalId: "a" }));
    expect(planShapeDigest(a)).toBe(planShapeDigest(b));
    expect(normalizePlanShape(b).entries.map((e) => e.logicalId)).toEqual(["a", "b"]);
    expect(planShapeDigest(a)).not.toBe(planShapeDigest(sh(entry({ logicalId: "a" }))));
  });

  test("accepts an identical change and one narrowed where an unknown input drives it", () => {
    expect(planShapeDifferences(sh(entry()), fresh(entry()))).toEqual([]);
    expect(planShapeDifferences(sh(entry()), fresh(entry({ properties: ["A"] })))).toEqual([]);
    expect(planShapeDifferences(sh(entry({ replacement: "true" })), fresh(entry({ replacement: "false" })))).toEqual([]);
    expect(planShapeDifferences(sh(entry({ properties: ["B"] })), fresh())).toEqual([]);
  });

  test("refuses an added resource, an added property, another action, more replacement", () => {
    expect(planShapeDifferences(sh(entry()), fresh(entry(), entry({ logicalId: "n" })))).toHaveLength(1);
    expect(planShapeCovers(sh(entry()), fresh(entry({ properties: ["A", "B", "C"] })))).toContain("also changes C");
    expect(planShapeCovers(sh(entry()), fresh(entry({ action: "delete" })))).toContain("where the first plan showed update");
    expect(planShapeCovers(sh(entry()), fresh(entry({ replacement: "true" })))).toContain("now replaces Eni");
    expect(planShapeCovers(sh(entry()), fresh(entry({ type: "U" })))).toContain("as U, where the first plan showed T");
  });

  test("refuses a change that vanishes or weakens with no unknown input behind it", () => {
    expect(planShapeDifferences(sh(entry({ unknown: [] })), fresh())).toHaveLength(1);
    expect(planShapeDifferences(sh(entry({ unknown: [], replacement: "true" })), fresh(entry({ unknown: [], replacement: "false" })))).toHaveLength(1);
    expect(planShapeCovers(sh(entry()), fresh(entry({ properties: ["B"] })))).toContain("no longer changes A");
  });

  test("a previewed entry without property detail may drop out, as before", () => {
    expect(planShapeDifferences({ member: "m", unknownInputs: [], entries: [{ logicalId: "x", action: "create" }] }, fresh())).toEqual([]);
  });

  test("an entry with property detail is compared even when its action is no-op", () => {
    const imp = entry({ logicalId: "I", action: "no-op" });
    expect(planShapeCovers(sh(), fresh(imp))).toContain("now plans to no-op I");
    expect(planShapeCovers(sh(imp), fresh(imp))).toBeUndefined();
  });

  test("the refusal names the differences and marks the plan as moved", () => {
    const err = new PlanShapeMovedError("m", ["m now plans to create Eni, which the first plan did not"]);
    expect(err.planMoved).toBe(true);
    expect(err.message).toContain("Eni, which the first plan did not");
  });

  test("a round is not covered when a property level difference shows in the shapes a lexicon supplied", () => {
    const doc = { members: [], entries: [] } as unknown as ChangeSetDocument;
    const side = (shape: PlanShape, unknownInputs?: string[]) => ({ doc, members: [{ member: "m", component: "c", ...(unknownInputs ? { unknownInputs } : {}) }], shapes: { m: shape } });
    const r = coveredRound({ approved: side(sh(entry()), ["up.id"]), approvedDigest: "d", fresh: side(fresh(entry({ properties: ["A", "C"] }))) });
    expect(r).toEqual({ covered: false, reason: "m now also changes C on Eni" });
  });
});
