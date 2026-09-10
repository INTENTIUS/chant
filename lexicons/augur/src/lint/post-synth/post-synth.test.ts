import { describe, expect, it } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { aug101 } from "./aug101";
import { AUGUR_PROFILES_VERSION, type SerializedProfile } from "../../serializer";

function ctx(profiles: SerializedProfile[]): PostSynthContext {
  return {
    outputs: new Map([["augur", `${JSON.stringify({ augur: AUGUR_PROFILES_VERSION, profiles }, null, 2)}\n`]]),
  } as unknown as PostSynthContext;
}

describe("AUG101 — two profiles asking the same question", () => {
  it("reports two profiles at the same level", () => {
    const found = aug101.check(
      ctx([
        { name: "steady", traffic: "100 rps, p50" },
        { name: "alsoSteady", traffic: "100 rps, p50" },
      ]),
    );
    expect(found).toHaveLength(1);
    expect(found[0].checkId).toBe("AUG101");
    expect(found[0].severity).toBe("error");
    expect(found[0].message).toContain("steady, alsoSteady");
  });

  it("treats two levels that differ only in whitespace or case as one", () => {
    // chant parses the level nowhere, and an engine reading "100 rps" and
    // "100  rps" as two different questions is an engine nobody has.
    const found = aug101.check(
      ctx([
        { name: "a", traffic: "100 rps, p50" },
        { name: "b", traffic: "100  RPS,  p50" },
      ]),
    );
    expect(found).toHaveLength(1);
  });

  it("says nothing about two genuinely different levels", () => {
    expect(
      aug101.check(
        ctx([
          { name: "steady", traffic: "100 rps, p50" },
          { name: "peak", traffic: "1000 rps, p99" },
        ]),
      ),
    ).toEqual([]);
  });

  it("says nothing about one profile, or none", () => {
    expect(aug101.check(ctx([{ name: "only", traffic: "100 rps, p50" }]))).toEqual([]);
    expect(aug101.check(ctx([]))).toEqual([]);
  });

  it("skips a profile with no level, which AUG001 already reports", () => {
    // Two empty levels are not two identical questions; they are two
    // declarations that ask nothing, and the lint rule names that better.
    expect(
      aug101.check(
        ctx([
          { name: "a", traffic: "" },
          { name: "b", traffic: "  " },
        ]),
      ),
    ).toEqual([]);
  });

  it("leaves another lexicon's output alone", () => {
    const foreign = {
      outputs: new Map([["aws", JSON.stringify({ Resources: { Bucket: { Type: "AWS::S3::Bucket" } } })]]),
    } as unknown as PostSynthContext;
    expect(aug101.check(foreign)).toEqual([]);
  });
});
