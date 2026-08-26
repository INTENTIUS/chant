import { describe, test, expect } from "vitest";
import {
  Scenario,
  snapshot,
  isScenario,
  collectScenarios,
  SCENARIO_MARKER,
  SCENARIO_ENTITY_TYPE,
} from "./scenario";
import { DECLARABLE_MARKER, type Declarable } from "../declarable";
import { partitionByLexicon } from "../build";

describe("snapshot()", () => {
  test("classifies a slash-containing string as a file", () => {
    expect(snapshot("fixtures/prod-baseline.json")).toEqual({ kind: "file", path: "fixtures/prod-baseline.json" });
  });

  test("classifies a .json-suffixed string as a file even without a slash", () => {
    expect(snapshot("baseline.json")).toEqual({ kind: "file", path: "baseline.json" });
  });

  test("classifies a bare token as an environment name", () => {
    expect(snapshot("prod")).toEqual({ kind: "env", env: "prod" });
  });

  test("rejects an empty string", () => {
    expect(() => snapshot("")).toThrow(/non-empty/);
  });
});

describe("Scenario()", () => {
  test("builds a Declarable-shaped, marked declaration", () => {
    const s = Scenario("plan-neutral refactor", {
      given: snapshot("fixtures/prod-baseline.json"),
      expect: { noop: true },
    });
    expect(s[DECLARABLE_MARKER]).toBe(true);
    expect(s[SCENARIO_MARKER]).toBe(true);
    expect(s.entityType).toBe(SCENARIO_ENTITY_TYPE);
    expect(s.lexicon).toBe("chant");
    expect(s.name).toBe("plan-neutral refactor");
    expect(s.given).toEqual({ kind: "file", path: "fixtures/prod-baseline.json" });
    expect(s.expect).toEqual({ noop: true });
  });

  test("isScenario recognizes it and rejects ordinary declarables", () => {
    const s = Scenario("s", { given: snapshot("prod"), expect: { noop: true } });
    expect(isScenario(s)).toBe(true);
    expect(isScenario({})).toBe(false);
    expect(isScenario(null)).toBe(false);
    const other: Declarable = { [DECLARABLE_MARKER]: true, lexicon: "aws", entityType: "AWS::S3::Bucket" };
    expect(isScenario(other)).toBe(false);
  });

  test("declared fields are locked but the object stays extensible", () => {
    const s = Scenario("s", { given: snapshot("prod"), expect: { noop: true } });
    expect(() => {
      (s as { name: string }).name = "renamed";
    }).toThrow();
    // Discovery stamps its own symbol-keyed metadata — the object must accept it.
    const extra = Symbol("chant.discovery.logical-name");
    expect(() => {
      (s as unknown as Record<symbol, unknown>)[extra] = "s";
    }).not.toThrow();
  });

  test("nested given/expect structures are frozen", () => {
    const s = Scenario("s", {
      given: snapshot("fixtures/x.json"),
      expect: { deletes: [{ name: "legacy", ownership: "owned" }] },
    });
    expect(Object.isFrozen(s.given)).toBe(true);
    expect(Object.isFrozen(s.expect)).toBe(true);
    expect(Object.isFrozen(s.expect.deletes)).toBe(true);
    expect(Object.isFrozen(s.expect.deletes![0])).toBe(true);
  });

  test("rejects an empty name", () => {
    expect(() => Scenario("", { given: snapshot("prod"), expect: { noop: true } })).toThrow(/non-empty/);
  });

  test("rejects a missing given", () => {
    // @ts-expect-error deliberately omitting given
    expect(() => Scenario("s", { expect: { noop: true } })).toThrow(/given/);
  });

  test("rejects an empty expect", () => {
    expect(() => Scenario("s", { given: snapshot("prod"), expect: {} })).toThrow(/at least one clause/);
  });

  test("rejects an unknown expect clause", () => {
    expect(() =>
      // @ts-expect-error deliberately passing an unrecognized clause
      Scenario("s", { given: snapshot("prod"), expect: { bogus: true } }),
    ).toThrow(/unknown `expect` clause/);
  });

  test("rejects noop: false (not a valid literal)", () => {
    expect(() =>
      // @ts-expect-error deliberately passing noop: false
      Scenario("s", { given: snapshot("prod"), expect: { noop: false } }),
    ).toThrow(/must be exactly `true`/);
  });

  test("rejects a negative count", () => {
    expect(() => Scenario("s", { given: snapshot("prod"), expect: { create: -1 } })).toThrow(/non-negative integer/);
  });

  test("rejects a non-integer count", () => {
    expect(() => Scenario("s", { given: snapshot("prod"), expect: { update: 1.5 } })).toThrow(/non-negative integer/);
  });

  test("accepts create/update/delete counts together", () => {
    const s = Scenario("s", { given: snapshot("prod"), expect: { create: 0, update: 1, delete: 2 } });
    expect(s.expect).toEqual({ create: 0, update: 1, delete: 2 });
  });

  test("rejects a deletes entry with a bad ownership value", () => {
    expect(() =>
      Scenario("s", {
        given: snapshot("prod"),
        // @ts-expect-error deliberately passing an invalid ownership
        expect: { deletes: [{ name: "legacy", ownership: "nope" }] },
      }),
    ).toThrow(/ownership/);
  });

  test("rejects a deletes entry with a missing name", () => {
    expect(() =>
      Scenario("s", {
        given: snapshot("prod"),
        // @ts-expect-error deliberately omitting name
        expect: { deletes: [{ ownership: "owned" }] },
      }),
    ).toThrow(/name/);
  });

  test("accepts unobserved: \"refuse\"", () => {
    const s = Scenario("s", { given: snapshot("prod"), expect: { unobserved: "refuse" } });
    expect(s.expect.unobserved).toBe("refuse");
  });

  test("accepts unobserved: { allow: [names] }", () => {
    const s = Scenario("s", { given: snapshot("prod"), expect: { unobserved: { allow: ["legacy-bucket"] } } });
    expect(s.expect.unobserved).toEqual({ allow: ["legacy-bucket"] });
  });

  test("rejects a malformed unobserved policy", () => {
    expect(() =>
      // @ts-expect-error deliberately passing a bad policy shape
      Scenario("s", { given: snapshot("prod"), expect: { unobserved: "nope" } }),
    ).toThrow(/unobserved/);
  });
});

describe("collectScenarios()", () => {
  test("extracts only scenario declarations, keyed by entity name", () => {
    const s1 = Scenario("s1", { given: snapshot("prod"), expect: { noop: true } });
    const s2 = Scenario("s2", { given: snapshot("staging"), expect: { create: 0 } });
    const other: Declarable = { [DECLARABLE_MARKER]: true, lexicon: "aws", entityType: "AWS::S3::Bucket" };
    const entities = new Map<string, Declarable>([
      ["scenarioOne", s1],
      ["scenarioTwo", s2],
      ["bucket", other],
    ]);
    const found = collectScenarios(entities);
    expect(found.size).toBe(2);
    expect(found.get("scenarioOne")).toBe(s1);
    expect(found.get("scenarioTwo")).toBe(s2);
  });
});

describe("serializer exclusion", () => {
  test("partitionByLexicon excludes scenarios from every lexicon partition", () => {
    const s = Scenario("s", { given: snapshot("prod"), expect: { noop: true } });
    const bucket: Declarable = {
      [DECLARABLE_MARKER]: true,
      lexicon: "aws",
      entityType: "AWS::S3::Bucket",
      kind: "resource",
    };
    const entities = new Map<string, Declarable>([
      ["myScenario", s],
      ["bucket", bucket],
    ]);
    const partitions = partitionByLexicon(entities);
    expect(partitions.has("chant")).toBe(false);
    for (const [, group] of partitions) {
      for (const [, entity] of group) {
        expect(isScenario(entity)).toBe(false);
      }
    }
    expect(partitions.get("aws")?.has("bucket")).toBe(true);
  });
});
