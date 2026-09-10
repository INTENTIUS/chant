import { describe, test, expect } from "vitest";
import { computePlanDigest, isPlanDigest, describePlanDigest } from "./plan-digest";

describe("computePlanDigest", () => {
  test("the same change set digests the same, whatever order its keys arrived in", () => {
    const a = computePlanDigest("terraform-plan", { address: "aws_s3_bucket.a", actions: ["create"] });
    const b = computePlanDigest("terraform-plan", { actions: ["create"], address: "aws_s3_bucket.a" });
    expect(a).toBe(b);
  });

  test("a changed address changes it", () => {
    expect(computePlanDigest("terraform-plan", { address: "aws_s3_bucket.a" })).not.toBe(
      computePlanDigest("terraform-plan", { address: "aws_s3_bucket.b" }),
    );
  });

  // The kind is hashed alongside the subject so a gate bound to a terraform
  // plan cannot be satisfied by another kind of plan that happened to
  // serialize identically.
  test("two kinds of plan over identical data do not collide", () => {
    expect(computePlanDigest("terraform-plan", { x: 1 })).not.toBe(
      computePlanDigest("lifecycle-diff", { x: 1 }),
    );
  });

  test("it is a sha256 digest, in the shape isPlanDigest accepts", () => {
    const digest = computePlanDigest("terraform-plan", {});
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(isPlanDigest(digest)).toBe(true);
  });
});

describe("isPlanDigest", () => {
  test("refuses everything a copy-paste or a path could be", () => {
    expect(isPlanDigest("chant.tfplan")).toBe(false);
    expect(isPlanDigest(`sha256:${"a".repeat(63)}`)).toBe(false);
    expect(isPlanDigest("a".repeat(64))).toBe(false);
    expect(isPlanDigest(`sha256:${"A".repeat(64)}`)).toBe(false);
    expect(isPlanDigest(undefined)).toBe(false);
    expect(isPlanDigest(12)).toBe(false);
  });
});

describe("describePlanDigest", () => {
  test("an absent digest reads as the pre-#2300 record it is, never as undefined", () => {
    expect(describePlanDigest(undefined)).toBe("(none — recorded before plan-bound gates)");
    expect(describePlanDigest("sha256:abc")).toBe("sha256:abc");
  });
});
