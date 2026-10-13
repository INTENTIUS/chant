import { describe, test, expect } from "vitest";
import { canonicalJson } from "../effect-receipt";
import { contentDigest } from "../content-digest";
import { computePlanDigest, isPlanDigest, describePlanDigest, samePlanDigest, PLAN_DIGEST_PREFIX } from "./plan-digest";

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

  test("it is a versioned jcs1-sha256 digest, in the shape isPlanDigest accepts", () => {
    const digest = computePlanDigest("terraform-plan", {});
    expect(digest).toMatch(/^jcs1-sha256:[0-9a-f]{64}$/);
    expect(digest.startsWith(PLAN_DIGEST_PREFIX)).toBe(true);
    expect(isPlanDigest(digest)).toBe(true);
  });

  test("it hashes the same bytes the bare sha256: digest of chant before #2547 did", () => {
    const subject = { b: [1, { y: 2, x: 1 }], a: "\u00e9" };
    const legacy = contentDigest(canonicalJson({ kind: "k", subject }));
    expect(computePlanDigest("k", subject)).toBe(`jcs1-${legacy}`);
  });
});

describe("the canonical form is RFC 8785", () => {
  test("it sorts keys by UTF-16 code unit, as RFC 8785 section 3.2.3 does", () => {
    // The RFC's own example: these keys in this order.
    const keys = ["\r", "1", "\u0080", "\u00f6", "\u20ac", "\ud83d\ude00", "\ufb33"];
    const reversed = [...keys].reverse();
    const value = Object.fromEntries(reversed.map((k) => [k, reversed.indexOf(k)]));
    // Written out by hand because Object.keys puts "1" first, whatever order a key was added in.
    expect(canonicalJson(value)).toBe(`{${keys.map((k) => `${JSON.stringify(k)}:${reversed.indexOf(k)}`).join(",")}}`);
  });

  test("it writes numbers as ECMAScript does, which is what RFC 8785 section 3.2.2 specifies", () => {
    expect(canonicalJson([1e21, 1e-7, 0.000001, -0, 4.5, 333333333.33333329])).toBe("[1e+21,1e-7,0.000001,0,4.5,333333333.3333333]");
  });
});

describe("samePlanDigest", () => {
  const hex = "a".repeat(64);
  test("a digest recorded under the bare prefix is the same plan as the jcs1 one", () => {
    expect(samePlanDigest(`sha256:${hex}`, `jcs1-sha256:${hex}`)).toBe(true);
    expect(samePlanDigest(`jcs1-sha256:${hex}`, `sha256:${hex}`)).toBe(true);
    expect(samePlanDigest(`sha256:${hex}`, `sha256:${hex}`)).toBe(true);
  });

  test("a different hash is a different plan, in either prefix", () => {
    expect(samePlanDigest(`sha256:${hex}`, `jcs1-sha256:${"b".repeat(64)}`)).toBe(false);
  });

  test("a value that is not a plan digest matches only itself", () => {
    expect(samePlanDigest("anything", "anything")).toBe(true);
    expect(samePlanDigest("anything", `sha256:${hex}`)).toBe(false);
    expect(samePlanDigest(undefined, `sha256:${hex}`)).toBe(false);
    expect(samePlanDigest(undefined, undefined)).toBe(true);
  });
});

describe("isPlanDigest", () => {
  test("accepts both prefixes, since gates recorded before #2547 carry the bare one", () => {
    expect(isPlanDigest(`sha256:${"a".repeat(64)}`)).toBe(true);
    expect(isPlanDigest(`jcs1-sha256:${"a".repeat(64)}`)).toBe(true);
  });

  test("refuses everything a copy-paste or a path could be", () => {
    expect(isPlanDigest("chant.tfplan")).toBe(false);
    expect(isPlanDigest(`sha256:${"a".repeat(63)}`)).toBe(false);
    expect(isPlanDigest("a".repeat(64))).toBe(false);
    expect(isPlanDigest(`sha256:${"A".repeat(64)}`)).toBe(false);
    expect(isPlanDigest(`jcs2-sha256:${"a".repeat(64)}`)).toBe(false);
    expect(isPlanDigest(`jcs1-sha256:${"a".repeat(63)}`)).toBe(false);
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
