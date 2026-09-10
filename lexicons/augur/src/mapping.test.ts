/**
 * The coverage table's own invariants (#2357).
 *
 * The table is data, so most of what can go wrong with it is a shape problem:
 * a type in both halves, a kind outside the closed set, a declared-unmapped row
 * whose reason says nothing. Each of those turns the table from a statement
 * into a shrug, and none of them is visible by reading `mapping.ts` top to
 * bottom once it has more than a screenful of rows.
 */

import { describe, expect, it } from "vitest";
import {
  byCodeUnit,
  DECLARED_UNMAPPED,
  ENGINE_KINDS,
  ENGINE_KINDS_BY_ENTITY_TYPE,
  augurCoverageTable,
  coverageFor,
  isEngineKind,
  unmappedDetail,
} from "./mapping";
import { PROFILE_TYPE } from "./resources";

describe("the coverage table", () => {
  it("puts no entity type in both halves", () => {
    // A type that is mapped and declared unmapped at once has two answers, and
    // `coverageFor` would silently prefer the first.
    const both = Object.keys(ENGINE_KINDS_BY_ENTITY_TYPE).filter((t) =>
      Object.prototype.hasOwnProperty.call(DECLARED_UNMAPPED, t),
    );
    expect(both).toEqual([]);
  });

  it("maps every row to a kind from the closed set", () => {
    for (const [type, mapping] of Object.entries(ENGINE_KINDS_BY_ENTITY_TYPE)) {
      expect(isEngineKind(mapping.kind), `${type} has kind ${mapping.kind}`).toBe(true);
      expect(["aws", "kubernetes"], `${type} has provider ${mapping.provider}`).toContain(mapping.provider);
    }
  });

  it("gives every declared-unmapped row a reason that says something", () => {
    // "not supported" is not a reason. A row here is a decision somebody made,
    // and the sentence is what a reader of a report gets instead of a figure.
    for (const [type, reason] of Object.entries(DECLARED_UNMAPPED)) {
      expect(reason.trim().length, `${type} states no reason`).toBeGreaterThan(20);
      expect(reason.trim().toLowerCase(), `${type}'s reason says nothing`).not.toMatch(
        /^(n\/a|none|unsupported|not supported|tbd|-)\.?$/,
      );
    }
  });

  it("declares this lexicon's own resource unmapped", () => {
    // A profile is the question. Sending it would ask an engine to price the
    // asking, and the example's build produces two of them.
    expect(coverageFor(PROFILE_TYPE).status).toBe("declared-unmapped");
  });

  it("is total: every type resolves to exactly one of three states", () => {
    const seen = new Set<string>();
    for (const type of [
      ...Object.keys(ENGINE_KINDS_BY_ENTITY_TYPE),
      ...Object.keys(DECLARED_UNMAPPED),
      "Acme::Widget::Thing",
      "",
    ]) {
      const verdict = coverageFor(type);
      expect(["mapped", "declared-unmapped", "unknown-type"]).toContain(verdict.status);
      seen.add(verdict.status);
    }
    expect([...seen].sort()).toEqual(["declared-unmapped", "mapped", "unknown-type"]);
  });

  it("is not fooled by a prototype key", () => {
    // `ENGINE_KINDS_BY_ENTITY_TYPE["constructor"]` is a function on a bare
    // object literal, and a truthiness check on it would report a type nobody
    // declared as mapped to a kind that does not exist.
    expect(coverageFor("constructor").status).toBe("unknown-type");
    expect(coverageFor("toString").status).toBe("unknown-type");
    expect(coverageFor("__proto__").status).toBe("unknown-type");
  });

  it("names the kind in the detail, both ways round", () => {
    const role = unmappedDetail("AWS::IAM::Role", coverageFor("AWS::IAM::Role"));
    expect(role).toContain("AWS::IAM::Role");
    expect(role).toContain("declared unmapped by the augur coverage table");

    const unknown = unmappedDetail("Acme::Widget::Thing", coverageFor("Acme::Widget::Thing"));
    expect(unknown).toContain("Acme::Widget::Thing");
    expect(unknown).toContain("neither mapped to an engine kind nor declared unmapped");
    // The difference between the two is the whole reason the second table
    // exists: one is a decision, the other is a gap in this file.
    expect(unknown).not.toEqual(role);
  });

  it("renders both halves as one sorted table", () => {
    const rows = augurCoverageTable();
    expect(rows.length).toBe(
      Object.keys(ENGINE_KINDS_BY_ENTITY_TYPE).length + Object.keys(DECLARED_UNMAPPED).length,
    );
    const types = rows.map((r) => r.entityType);
    expect(types).toEqual([...types].sort(byCodeUnit));
    expect(rows.filter((r) => r.kind === "—").length).toBe(Object.keys(DECLARED_UNMAPPED).length);
  });

  it("keeps the kind witness and the exported list in step", () => {
    expect(ENGINE_KINDS.length).toBe(new Set(ENGINE_KINDS).size);
    for (const kind of ENGINE_KINDS) expect(isEngineKind(kind)).toBe(true);
    expect(isEngineKind("compute-ish")).toBe(false);
    expect(isEngineKind(undefined)).toBe(false);
  });
});
