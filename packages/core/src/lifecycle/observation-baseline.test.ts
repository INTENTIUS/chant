import { describe, test, expect } from "vitest";
import {
  acceptDeviations,
  acceptedDeviation,
  baselineForLexicon,
  countAccepted,
  emptyBaseline,
  isObservationBaseline,
  parseBaseline,
  serializeBaseline,
} from "./observation-baseline";

describe("the baseline document", () => {
  test("round-trips through serialize/parse", () => {
    const b = acceptDeviations(emptyBaseline("prod"), "aws", [
      { entity: "Assets", type: "AWS::S3::Bucket", path: "Tags[0].Value", value: "platform", note: "org policy" },
    ], { now: "2026-07-27T00:00:00.000Z" });
    const parsed = parseBaseline(serializeBaseline(b));
    expect(parsed).toEqual(b);
  });

  test("serializes with sorted keys and a trailing newline, so the commit diff reads cleanly", () => {
    const json = serializeBaseline(emptyBaseline("prod"));
    expect(json.endsWith("\n")).toBe(true);
    expect(JSON.parse(json)).toEqual({ baseline: "v1", environment: "prod", lexicons: {} });
  });

  test("refuses to read anything that is not a versioned baseline", () => {
    expect(parseBaseline(null)).toBeNull();
    expect(parseBaseline("")).toBeNull();
    expect(parseBaseline("{ not json")).toBeNull();
    expect(parseBaseline('{"baseline":"v2","lexicons":{}}')).toBeNull();
    expect(parseBaseline('{"lexicons":{}}')).toBeNull();
    expect(isObservationBaseline({ baseline: "v1", lexicons: {} })).toBe(true);
  });
});

describe("acceptDeviations", () => {
  const now = "2026-07-27T00:00:00.000Z";

  test("records a deviation bound to the value that was accepted", () => {
    const b = acceptDeviations(emptyBaseline("prod"), "aws", [
      { entity: "Role", type: "AWS::IAM::Role", path: "MaxSessionDuration", value: 7200 },
    ], { now });
    expect(baselineForLexicon(b, "aws")).toEqual({
      Role: {
        type: "AWS::IAM::Role",
        accepted: [{ path: "MaxSessionDuration", value: 7200, recordedAt: now }],
      },
    });
    expect(b.updated).toBe(now);
  });

  test("does not mutate the input", () => {
    const before = emptyBaseline("prod");
    acceptDeviations(before, "aws", [{ entity: "R", path: "A", value: 1 }], { now });
    expect(before.lexicons).toEqual({});
  });

  test("re-accepting the same path replaces the entry rather than appending a second", () => {
    let b = acceptDeviations(emptyBaseline("prod"), "aws", [{ entity: "R", path: "A", value: 1 }], { now });
    b = acceptDeviations(b, "aws", [{ entity: "R", path: "A", value: 2 }], { now });
    expect(baselineForLexicon(b, "aws").R.accepted).toEqual([{ path: "A", value: 2, recordedAt: now }]);
  });

  test("keeps deviations from other entities and other lexicons", () => {
    let b = acceptDeviations(emptyBaseline("prod"), "aws", [{ entity: "R1", path: "A", value: 1 }], { now });
    b = acceptDeviations(b, "aws", [{ entity: "R2", path: "B", value: 2 }], { now });
    b = acceptDeviations(b, "k8s", [{ entity: "D", path: "spec.replicas", value: 3 }], { now });
    expect(Object.keys(baselineForLexicon(b, "aws")).sort()).toEqual(["R1", "R2"]);
    expect(countAccepted(b)).toBe(3);
  });

  test("accepted paths sort, so the committed file is stable across runs", () => {
    const b = acceptDeviations(emptyBaseline("prod"), "aws", [
      { entity: "R", path: "Z", value: 1 },
      { entity: "R", path: "A", value: 2 },
    ], { now });
    expect(baselineForLexicon(b, "aws").R.accepted.map((a) => a.path)).toEqual(["A", "Z"]);
  });

  test("an empty accept list is a no-op", () => {
    const b = emptyBaseline("prod");
    expect(acceptDeviations(b, "aws", [])).toBe(b);
  });

  test("lookup is by entity and path", () => {
    const b = acceptDeviations(emptyBaseline("prod"), "aws", [{ entity: "R", path: "A", value: 1 }], { now });
    const lex = baselineForLexicon(b, "aws");
    expect(acceptedDeviation(lex, "R", "A")?.value).toBe(1);
    expect(acceptedDeviation(lex, "R", "B")).toBeUndefined();
    expect(acceptedDeviation(lex, "Other", "A")).toBeUndefined();
  });

  test("a missing baseline reads as nothing accepted", () => {
    expect(baselineForLexicon(null, "aws")).toEqual({});
    expect(countAccepted(null)).toBe(0);
  });
});
