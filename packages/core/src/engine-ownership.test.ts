/**
 * The drift verdict and the graph's ownership enum (#5333): one mapping in
 * ./drift-record.ts, and engine facts about what a live read did not return
 * as present, carried onto the overlay's nodes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DRIFT_OWNERSHIP_VERDICTS,
  DRIFT_VERDICT_ENGINE_OWNERSHIP,
  driftRecord,
  driftVerdictOfEngineOwnership,
  engineOwnershipOfDrift,
  type DriftRecord,
} from "./drift-record";
import { ENGINE_OWNERSHIP_FLOOR } from "./engine-facts";
import { carryEngineFacts, type IRNode } from "./graph-ir";
import { mergeObservations, normalizeObservation, observation } from "./observation";
import { NEXT_RELEASE } from "./release-floors";

const SCHEMA = JSON.parse(readFileSync(join(import.meta.dirname, "graph-schema", "graph.schema.json"), "utf-8")) as {
  $defs: { EngineFacts: { properties: { ownership: { enum: string[] } } } };
};
const ENUM = SCHEMA.$defs.EngineFacts.properties.ownership.enum;

const record = (over: Partial<DriftRecord>): DriftRecord =>
  driftRecord({ member: "m", engine: "choudoufu", address: "a.b", node: null, observedAt: "2026-11-19T00:00:00Z", read: "ownership", status: "in-sync", evidence: { tool: "choudoufu" }, ...over });

describe("DRIFT_VERDICT_ENGINE_OWNERSHIP (#5333)", () => {
  it("maps every verdict, onto the schema's enum only, and no two verdicts onto one word", () => {
    expect(Object.keys(DRIFT_VERDICT_ENGINE_OWNERSHIP).sort()).toEqual([...DRIFT_OWNERSHIP_VERDICTS].sort());
    const words = Object.values(DRIFT_VERDICT_ENGINE_OWNERSHIP).filter((w): w is NonNullable<typeof w> => w !== null);
    for (const w of words) expect(ENUM).toContain(w);
    expect(new Set(words).size).toBe(words.length);
    expect(DRIFT_VERDICT_ENGINE_OWNERSHIP).toEqual({ owned: "bound", foreign: "foreign", adoptable: "unowned", unknown: null });
  });

  it("engineOwnershipOfDrift reads the verdict, and pending from the status", () => {
    expect(engineOwnershipOfDrift(record({ ownership: { verdict: "owned", by: "marker" } }))).toBe("bound");
    expect(engineOwnershipOfDrift(record({ status: "unclaimed", ownership: { verdict: "adoptable" } }))).toBe("unowned");
    expect(engineOwnershipOfDrift(record({ status: "undeclared", ownership: { verdict: "foreign", ownedBy: "other" } }))).toBe("foreign");
    expect(engineOwnershipOfDrift(record({ status: "undeclared", ownership: { verdict: "unknown" } }))).toBeUndefined();
    expect(engineOwnershipOfDrift(record({ status: "pending" }))).toBe("pending");
    expect(engineOwnershipOfDrift(record({ status: "not-observed", unobserved: { reason: "read-failed" } }))).toBeUndefined();
  });

  it("driftVerdictOfEngineOwnership is its inverse, and pending has no verdict", () => {
    for (const word of ENUM) {
      const verdict = driftVerdictOfEngineOwnership(word as never);
      if (word === "pending") expect(verdict).toBeUndefined();
      else expect(DRIFT_VERDICT_ENGINE_OWNERSHIP[verdict!]).toBe(word);
    }
  });

  it("the floor is the next release", () => {
    expect(ENGINE_OWNERSHIP_FLOOR).toBe(NEXT_RELEASE);
  });
});

describe("engineFacts on an observation (#5333)", () => {
  it("normalizes, and merges per node with present winning", () => {
    const a = normalizeObservation({ ...observation({}), engineFacts: { "r/x": { ownership: "pending" } } });
    const b = normalizeObservation({ ...observation({ "r/x": { type: "t", status: "bound" } }), engineFacts: { "r/y": { ownership: "foreign" } } });
    expect(a.engineFacts).toEqual({ "r/x": { ownership: "pending" } });
    expect(mergeObservations([a, b]).engineFacts).toEqual({ "r/y": { ownership: "foreign" } });
    expect(normalizeObservation(observation({})).engineFacts).toBeUndefined();
  });

  it("carryEngineFacts sets facts by id, and a node with facts keeps its own", () => {
    const nodes: IRNode[] = [
      { id: "x", kind: "t", lexicon: "terraform", attrs: { _status: "accent" } },
      { id: "y", kind: "t", lexicon: "terraform", attrs: {}, facts: { ownership: "bound" } },
      { id: "z", kind: "t", lexicon: "terraform", attrs: {} },
    ];
    const out = carryEngineFacts(nodes, { x: { ownership: "pending" }, y: { ownership: "foreign" } });
    expect(out.map((n) => [n.id, n.facts?.ownership, n.attrs._status])).toEqual([
      ["x", "pending", "accent"],
      ["y", "bound", undefined],
      ["z", undefined, undefined],
    ]);
    expect(carryEngineFacts(nodes, undefined)).toBe(nodes);
  });
});
