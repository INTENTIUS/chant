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
import { ENGINE_OWNERSHIP_FLOOR, ENGINE_OWNERSHIP_ROWS_FLOOR, UNDECLARED_LIVE_NODES_FLOOR, engineOwnershipRowsOf, mergeOwnershipRows, withOwnershipRows } from "./engine-facts";
import { buildLiveGraphIr, carryEngineFacts, type IRNode } from "./graph-ir";
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

describe("facts.ownershipRows (#5402)", () => {
  it("keeps only the declared fields and shapes, and nothing when none is left", () => {
    expect(
      engineOwnershipRowsOf({
        boundBy: "derived",
        identityValues: { name: "/x", n: 3 },
        omission: { reason: "ABSENT", detail: "not created" },
        adopt: { owner: "e", address: "a.b", matched: [{ attribute: "bucket", value: "b" }, { value: "no attribute" }], extra: 1 },
        gaps: [{ read: "listing", reason: "record", detail: "d" }, { read: "elsewhere", reason: "r" }, { read: "graph" }],
        listed: true,
        other: "dropped",
      }),
    ).toEqual({
      boundBy: "derived",
      identityValues: { name: "/x" },
      omission: { reason: "ABSENT", detail: "not created" },
      adopt: { owner: "e", address: "a.b", matched: [{ attribute: "bucket", value: "b" }] },
      gaps: [{ read: "listing", reason: "record", detail: "d" }],
      listed: true,
    });
    expect(engineOwnershipRowsOf({ omission: { detail: "no reason" }, adopt: {}, gaps: [] })).toBeUndefined();
    expect(engineOwnershipRowsOf("bound")).toBeUndefined();
  });

  it("merges two sets for one node, later fields winning and gaps kept once each", () => {
    const g = { read: "graph" as const, reason: "r", detail: "d" };
    expect(mergeOwnershipRows({ boundBy: "marker", gaps: [g] }, { listed: true, gaps: [g, { read: "listing", reason: "record", detail: "" }] })).toEqual({
      boundBy: "marker",
      listed: true,
      gaps: [g, { read: "listing", reason: "record", detail: "" }],
    });
    expect(mergeOwnershipRows(undefined, undefined)).toBeUndefined();
  });

  it("withOwnershipRows adds the rows beside the word, and leaves facts alone with none", () => {
    const facts = { ownership: "pending" as const };
    expect(withOwnershipRows(facts, undefined)).toBe(facts);
    expect(withOwnershipRows(undefined, undefined)).toBeUndefined();
    expect(withOwnershipRows(facts, { omission: { reason: "ABSENT", detail: "" } })).toEqual({ ownership: "pending", ownershipRows: { omission: { reason: "ABSENT", detail: "" } } });
  });

  it("the schema declares the field on EngineFacts, and the floor is the next release", () => {
    const facts = (SCHEMA.$defs as unknown as Record<string, { properties: Record<string, unknown> }>).EngineFacts.properties;
    expect(facts.ownershipRows).toMatchObject({ $ref: "#/$defs/EngineOwnershipRows" });
    expect(ENGINE_OWNERSHIP_ROWS_FLOOR).toBe(NEXT_RELEASE);
  });
});

describe("undeclared live objects on an observation (#5429)", () => {
  it("normalizes, merges per node with present winning, and becomes live nodes only where a caller adds them", () => {
    const stray = { type: "aws_cloudwatch_log_group", status: "orphan", ownership: "owned" as const, physicalId: "/s", attributes: { address: "aws_cloudwatch_log_group.stray" } };
    const a = normalizeObservation({ ...observation({}), undeclared: { "r/stray": stray, "r/x": stray } });
    const b = normalizeObservation(observation({ "r/x": { type: "t", status: "bound" } }));
    expect(a.undeclared).toEqual({ "r/stray": stray, "r/x": stray });
    const merged = mergeObservations([a, b]);
    expect(merged.undeclared).toEqual({ "r/stray": stray });
    expect(merged.resources).not.toHaveProperty("r/stray");
    expect(normalizeObservation(observation({})).undeclared).toBeUndefined();

    const ir = buildLiveGraphIr([{ lexicon: "terraform", resources: merged.resources }, { lexicon: "terraform", resources: merged.undeclared! }]);
    expect(ir.nodes.find((n) => n.id === "r/stray")).toEqual({ id: "r/stray", kind: "aws_cloudwatch_log_group", lexicon: "terraform", physicalId: "/s", ownership: "owned", attrs: { address: "aws_cloudwatch_log_group.stray" } });
  });

  it("the floor is the next release", () => {
    expect(UNDECLARED_LIVE_NODES_FLOOR).toBe(NEXT_RELEASE);
  });
});
