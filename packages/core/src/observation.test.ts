/**
 * The observation contract itself (#1089) — the normalizer, the envelope
 * discriminant, and the multi-stack merge.
 */
import { describe, test, expect } from "vitest";
import {
  UNOBSERVED_REASONS,
  formatUnobserved,
  isObservationResult,
  isUnobservedReason,
  mergeObservations,
  normalizeObservation,
  observation,
  unobservedAll,
  unobservedReasonText,
} from "./observation";
import type { ResourceMetadata } from "./lexicon";

const meta = (over: Partial<ResourceMetadata> = {}): ResourceMetadata => ({
  type: "Fake::Resource",
  status: "OK",
  ...over,
});

describe("normalizeObservation", () => {
  test("a bare map means 'I looked at everything'", () => {
    expect(normalizeObservation({ a: meta() })).toEqual({ resources: { a: meta() }, unobserved: {} });
  });

  test("the envelope carries both halves", () => {
    const value = observation({ a: meta() }, { b: { reason: "read-failed" } });
    expect(normalizeObservation(value)).toEqual({
      resources: { a: meta() },
      unobserved: { b: { reason: "read-failed" } },
    });
  });

  test("undefined normalizes to two empty maps", () => {
    expect(normalizeObservation(undefined)).toEqual({ resources: {}, unobserved: {} });
  });

  test("an entity literally named `observation` cannot be mistaken for the envelope", () => {
    const bare = { observation: meta({ type: "Odd::Name" }) };
    expect(isObservationResult(bare)).toBe(false);
    expect(normalizeObservation(bare).resources.observation.type).toBe("Odd::Name");
  });

  test("the envelope omits an empty unobserved map", () => {
    expect(observation({ a: meta() }, {})).toEqual({ observation: "v1", resources: { a: meta() } });
  });
});

describe("unobservedAll", () => {
  test("marks every named entity with one reason, carrying declared types", () => {
    const entities = new Map([["a", { entityType: "AWS::S3::Bucket" }]]);
    expect(unobservedAll(["a", "b"], "no-credentials", "token expired", entities)).toEqual({
      a: { reason: "no-credentials", type: "AWS::S3::Bucket", detail: "token expired" },
      b: { reason: "no-credentials", detail: "token expired" },
    });
  });
});

describe("mergeObservations (multi-stack)", () => {
  test("present beats not-observed beats absent", () => {
    const merged = mergeObservations([
      { resources: {}, unobserved: { a: { reason: "read-failed" }, b: { reason: "no-binding" } } },
      { resources: { a: meta() }, unobserved: {} },
    ]);
    expect(Object.keys(merged.resources)).toEqual(["a"]);
    expect(Object.keys(merged.unobserved)).toEqual(["b"]);
  });

  test("an entity nobody looked for in any stack stays absent", () => {
    const merged = mergeObservations([
      { resources: { a: meta() }, unobserved: {} },
      { resources: { b: meta() }, unobserved: {} },
    ]);
    expect(merged.unobserved).toEqual({});
  });
});

describe("reason totality", () => {
  test("every reason has human text and passes the guard", () => {
    for (const reason of UNOBSERVED_REASONS) {
      expect(isUnobservedReason(reason)).toBe(true);
      expect(unobservedReasonText(reason).length).toBeGreaterThan(0);
    }
    expect(isUnobservedReason("made-up")).toBe(false);
  });

  test("formatUnobserved names the entity, the type and the detail", () => {
    expect(
      formatUnobserved("widget", { type: "K8s::X::Widget", reason: "unsupported-kind", detail: "no mapping" }),
    ).toBe("widget (K8s::X::Widget) — no reader for this resource kind: no mapping");
  });
});
