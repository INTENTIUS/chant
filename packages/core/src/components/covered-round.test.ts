import { describe, expect, test } from "vitest";
import { coveredRound, planShapeCovers, type PlanShape } from "./covered-round";
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
