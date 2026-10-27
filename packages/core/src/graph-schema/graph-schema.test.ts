// The graph JSON Schema set and its fixtures (#4527): generated from the
// TypeScript types, checked in, and in sync. Engines (choudoufu#2285,
// plunge#40) validate their output against the same files.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { GRAPH_SCHEMA_FIXTURES, GRAPH_SCHEMA_FIXTURE_DEFS } from "./fixtures";
import { GRAPH_SCHEMA_FIXTURE_DIR, GRAPH_SCHEMA_ID, GRAPH_SCHEMA_PATH, generateGraphSchema, staleGraphSchemaFiles } from "./generate";
import { validateIndexDocument, type IndexDocument } from "../lifecycle/index-document";
import { adoptionFileProblemsAgainst, type AdoptionFile } from "../lifecycle/adoption-file";
import { GRAPH_IR_VERSION } from "../graph-ir";

const schema = JSON.parse(readFileSync(GRAPH_SCHEMA_PATH, "utf-8")) as { $id: string; $defs: Record<string, unknown> };
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema);
const validator = (def: string) => ajv.getSchema(`${GRAPH_SCHEMA_ID}#/$defs/${def}`)!;
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(GRAPH_SCHEMA_FIXTURE_DIR, `${name}.json`), "utf-8")) as Record<string, unknown>;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe("graph schema sync (#4527)", () => {
  it("the checked-in schema and fixtures match the TypeScript types (npm run generate:graph-schema if this fails)", () => {
    const stale = staleGraphSchemaFiles().map((p) => relative(GRAPH_SCHEMA_FIXTURE_DIR, p));
    expect(stale).toEqual([]);
  });

  it("covers the three documents in one set, with the engine facts and edge grain", () => {
    const generated = generateGraphSchema() as { $defs: Record<string, unknown> };
    for (const def of ["EngineGraphDocument", "IndexDocument", "AdoptionFile", "AdoptionSelection", "AdoptionIndexRef", "GraphIR", "IRNode", "IREdge", "EngineFacts", "EngineGraphMeta", "EdgeGrain"]) {
      expect(Object.keys(generated.$defs)).toContain(def);
    }
  });

  it("keeps GraphIR at version 1", () => {
    expect(GRAPH_IR_VERSION).toBe(1);
    const doc = (schema.$defs.EngineGraphDocument as { properties: { version: unknown } }).properties.version;
    expect(doc).toEqual({ const: 1 });
  });
});

describe("graph schema fixtures (#4527)", () => {
  for (const [name, def] of Object.entries(GRAPH_SCHEMA_FIXTURE_DEFS)) {
    it(`${name}.json validates as ${def}`, () => {
      const validate = validator(def);
      const ok = validate(fixture(name));
      expect(validate.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
    });
  }

  it("the index fixture's stamp agrees with itself", () => {
    expect(() => validateIndexDocument(GRAPH_SCHEMA_FIXTURES.index as IndexDocument)).not.toThrow();
  });

  it("the adoption fixture names the index fixture's version, digest and node (#4536)", () => {
    expect(adoptionFileProblemsAgainst(fixture("adopt") as unknown as AdoptionFile, fixture("index") as unknown as IndexDocument)).toEqual([]);
  });

  it("each engine fixture names its engine and carries facts and grain", () => {
    for (const [name, engine, grains] of [
      ["choudoufu.engine-graph", "choudoufu", ["block"]],
      ["plunge.engine-graph", "plunge", ["instance", "property"]],
    ] as const) {
      const doc = fixture(name) as { meta: { engineGraph: { engine: { name: string } } }; nodes: Array<{ facts?: unknown }>; edges: Array<{ grain?: string }> };
      expect(doc.meta.engineGraph.engine.name).toBe(engine);
      expect(doc.nodes.some((n) => n.facts !== undefined)).toBe(true);
      expect([...new Set(doc.edges.map((e) => e.grain))].sort()).toEqual(grains);
    }
  });

  it("plunge's markers come from the record and its ownership stops at bound or pending (#4520 Q5)", () => {
    const doc = fixture("plunge.engine-graph") as { nodes: Array<{ facts?: { ownership?: string; markers?: { source: string } } }> };
    for (const n of doc.nodes) {
      if (n.facts?.markers) expect(n.facts.markers.source).toBe("record");
      if (n.facts?.ownership) expect(["bound", "pending"]).toContain(n.facts.ownership);
    }
  });
});

describe("graph schema refusals (#4527)", () => {
  const engine = validator("EngineGraphDocument");
  const base = () => clone(fixture("choudoufu.engine-graph")) as {
    version: unknown;
    meta: Record<string, unknown> & { engineGraph: Record<string, unknown> };
    nodes: Array<Record<string, unknown> & { facts?: Record<string, unknown> }>;
    edges: Array<Record<string, unknown>>;
  };

  it("refuses a misspelled facts field", () => {
    const doc = base();
    doc.nodes[0]!.facts = { ...doc.nodes[0]!.facts, ownedby: "marker" };
    expect(engine(doc)).toBe(false);
  });

  it("refuses an ownership value outside bound, unowned, pending and foreign", () => {
    const doc = base();
    doc.nodes[0]!.facts = { ...doc.nodes[0]!.facts, ownership: "owned" };
    expect(engine(doc)).toBe(false);
  });

  it("refuses a grain outside block, instance and property", () => {
    const doc = base();
    doc.edges[0]!.grain = "module";
    expect(engine(doc)).toBe(false);
  });

  it("refuses markers without encoding and source", () => {
    const doc = base();
    doc.nodes[0]!.facts = { markers: { owner: "web" } };
    expect(engine(doc)).toBe(false);
  });

  it("refuses a document with no meta.engineGraph, or at another version", () => {
    const noMeta = base();
    delete (noMeta.meta as { engineGraph?: unknown }).engineGraph;
    expect(engine(noMeta)).toBe(false);
    const v2 = base();
    v2.version = 2;
    expect(engine(v2)).toBe(false);
  });

  it("lets other keys sit in meta beside engineGraph (meta is an open bag)", () => {
    const doc = base();
    doc.meta._behaviour = { engine: "x" };
    expect(engine(doc)).toBe(true);
  });

  it("refuses an adoption file at another version, with no select, or with a misspelled field (#4536)", () => {
    const adopt = validator("AdoptionFile");
    const base = () => clone(fixture("adopt")) as Record<string, unknown> & { select: Array<Record<string, unknown>> };
    expect(adopt(base())).toBe(true);
    const v2 = base();
    v2.adopt = "v2";
    expect(adopt(v2)).toBe(false);
    const noSelect = base();
    delete (noSelect as { select?: unknown }).select;
    expect(adopt(noSelect)).toBe(false);
    const typo = base();
    typo.select[0]!.address = "aws_s3_bucket.x";
    expect(adopt(typo)).toBe(false);
    const noType = base();
    delete noType.select[0]!.type;
    expect(adopt(noType)).toBe(true);
  });

  it("refuses an index coverage verdict outside listed and the unobserved reasons", () => {
    const index = validator("IndexDocument");
    const doc = clone(fixture("index")) as { coverage: Array<Record<string, unknown>> };
    doc.coverage[0]!.verdict = "missing";
    expect(index(doc)).toBe(false);
  });
});
