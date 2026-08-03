import { describe, it, expect } from "vitest";
import { regionOf, unqualifiedKey } from "./identity";

describe("regionOf", () => {
  it("reads the region a lexicon stamped", () => {
    expect(regionOf({ attributes: { region: "us-west-1" } })).toBe("us-west-1");
  });

  it("treats a missing, empty or non-string region as none", () => {
    expect(regionOf({})).toBeUndefined();
    expect(regionOf({ attributes: {} })).toBeUndefined();
    expect(regionOf({ attributes: { region: "" } })).toBeUndefined();
    expect(regionOf({ attributes: { region: 1 } })).toBeUndefined();
  });
});

describe("unqualifiedKey", () => {
  it("carries the region when there is one", () => {
    expect(unqualifiedKey("sg-1", { attributes: { region: "us-east-1" } })).toBe("us-east-1::sg-1");
  });

  it("leaves an id with no region bare", () => {
    expect(unqualifiedKey("arn:aws:iam::1:policy/p", {})).toBe("arn:aws:iam::1:policy/p");
  });

  it("is idempotent, so a second pass does not double-qualify", () => {
    const meta = { attributes: { region: "us-east-1" } };
    expect(unqualifiedKey(unqualifiedKey("sg-1", meta), meta)).toBe("us-east-1::sg-1");
  });

  it("qualifies an id that already carries a DIFFERENT region", () => {
    // Not a case the readers produce, but the guard is a prefix test and it
    // should not silently accept `us-west-1::sg-1` as already being in
    // us-east-1.
    expect(unqualifiedKey("us-west-1::sg-1", { attributes: { region: "us-east-1" } })).toBe(
      "us-east-1::us-west-1::sg-1",
    );
  });
});
