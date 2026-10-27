/**
 * A plunge member's checked-in `engine-graph.json` (#4529): the facts and
 * the `property` edges it adds to the member graph, the `instance` grain on
 * the export's edges, and what a stock member gets (nothing new). The
 * document is chant#4527's plunge fixture, copied into
 * `testdata/plunge-graph/`. Nothing here runs plunge.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraphIr } from "@intentius/chant/graph-ir";
import { engineFactsOf, PULUMI_ENGINE_GRAPH_FILE, readPlungeEngineGraph } from "./engine-graph";
import { readPulumiMember } from "./workspace-member";

const testdata = join(import.meta.dirname, "testdata");
const dir = join(testdata, "plunge-graph");
const fixturePath = join(import.meta.dirname, "..", "..", "..", "packages", "core", "src", "graph-schema", "fixtures", "plunge.engine-graph.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as { nodes: { id: string; facts?: unknown }[] };
const factsOf = (urn: string) => fixture.nodes.find((n) => n.id === urn)!.facts;

const ASSETS = "app/aws:s3/bucketV2:BucketV2::assets";
const MEDIA = "app/gcp:storage/bucket:Bucket::media";
const POLICY = "app/aws:s3/bucketPolicy:BucketPolicy::assets-policy";

const scratch: string[] = [];
afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});
function copyOf(source: string): string {
  const d = mkdtempSync(join(tmpdir(), "chant-plunge-graph-"));
  scratch.push(d);
  cpSync(source, d, { recursive: true });
  return d;
}

describe("the fixture", () => {
  test("testdata/plunge-graph/engine-graph.json is chant#4527's plunge fixture, unchanged", () => {
    expect(readFileSync(join(dir, PULUMI_ENGINE_GRAPH_FILE), "utf-8")).toBe(readFileSync(fixturePath, "utf-8"));
  });
});

describe("readPlungeEngineGraph", () => {
  test("reads the fixture's nodes, edges and scope", () => {
    const read = readPlungeEngineGraph(fixture);
    if ("error" in read) throw new Error(read.error);
    expect(read.graph.scope).toEqual({ project: "app", stack: "dev" });
    expect(read.graph.engineVersion).toBe("3.272.0-plunge.1");
    expect(read.graph.nodes.map((n) => n.urn)).toEqual(fixture.nodes.map((n) => n.id));
    expect(read.graph.edges.map((e) => `${e.viaAttr}:${e.grain}`).sort()).toEqual(["bucket:property", "dependencies:instance", "provider:instance"]);
  });

  test("refuses a document that is not plunge's version 1, format 1 graph", () => {
    const doc = fixture as unknown as { version: number; meta: { engineGraph: { format: number; engine: { name: string } } } };
    expect(readPlungeEngineGraph({ ...doc, version: 2 })).toEqual({ error: expect.stringMatching(/version is 2/) });
    expect(readPlungeEngineGraph({ ...doc, meta: { engineGraph: { ...doc.meta.engineGraph, format: 2 } } })).toEqual({ error: expect.stringMatching(/format is 2/) });
    expect(readPlungeEngineGraph({ ...doc, meta: { engineGraph: { ...doc.meta.engineGraph, engine: { name: "choudoufu" } } } })).toEqual({ error: expect.stringMatching(/not plunge/) });
    expect(readPlungeEngineGraph({ version: 1, nodes: [] })).toEqual({ error: expect.stringMatching(/no meta.engineGraph/) });
    expect(readPlungeEngineGraph("x")).toEqual({ error: "it is not a JSON object" });
  });

  test("engineFactsOf keeps only the schema's fields and values", () => {
    expect(
      engineFactsOf({
        ownership: "mine",
        ownedBy: "record",
        markers: { owner: "app/dev", encoding: "plain", source: "guess" },
        cloudIds: [{ kind: "arn", value: "arn:aws:s3:::a" }, { kind: "secret", value: "x" }],
        outputs: { password: "hunter2" },
        observedAt: "2026-10-26T12:00:00Z",
      }),
    ).toEqual({ ownedBy: "record", cloudIds: [{ kind: "arn", value: "arn:aws:s3:::a" }], observedAt: "2026-10-26T12:00:00Z" });
    expect(engineFactsOf({ ownership: 3 })).toBeUndefined();
  });
});

describe("readPulumiMember with engine-graph.json (#4529)", () => {
  test("each node the export and the graph share gets the graph's facts, as plunge printed them", () => {
    const { entities, report, warnings } = readPulumiMember({ member: { dir, label: "app" } });
    expect(warnings).toEqual([]);
    expect([...entities.keys()].sort()).toEqual([ASSETS, POLICY, MEDIA].sort());
    const facts = (key: string) => (entities.get(key) as unknown as { facts?: unknown }).facts;
    expect(facts(ASSETS)).toEqual(factsOf("urn:pulumi:dev::app::aws:s3/bucketV2:BucketV2::assets"));
    expect(facts(MEDIA)).toEqual(factsOf("urn:pulumi:dev::app::gcp:storage/bucket:Bucket::media"));
    // The graph was taken mid-update; chant does not reconcile it with the export.
    expect((facts(POLICY) as { ownership?: string }).ownership).toBe("pending");
    // Not enumerable, so an older chant does not project it into attrs.
    expect(Object.keys(entities.get(ASSETS)!)).not.toContain("facts");
    expect(report.engineGraph).toEqual({ file: "engine-graph.json", read: true, stack: "dev", observedAt: "2026-10-26T12:00:00Z", facts: 3, propertyEdges: 1 });
  });

  test("the graph IR: facts on the nodes, property edges with grain property, export edges with grain instance", () => {
    const { entities } = readPulumiMember({ member: { dir, label: "app" } });
    const ir = buildGraphIr(entities);
    const node = ir.nodes.find((n) => n.id === ASSETS)!;
    expect(node.facts).toEqual(factsOf("urn:pulumi:dev::app::aws:s3/bucketV2:BucketV2::assets"));
    expect(node.attrs).toEqual({});
    expect(ir.edges.map((e) => [e.from, e.to, e.viaAttr, e.grain])).toEqual([
      [POLICY, ASSETS, "bucket", "property"],
      [POLICY, ASSETS, "dependencies", "instance"],
    ]);
    // The graph's provider edge has no node to land on.
    expect(JSON.stringify(ir)).not.toContain("pulumi:providers:aws");
  });

  test("an engine-graph.json that does not read leaves a warning, and the graph is the export's", () => {
    const broken = copyOf(dir);
    writeFileSync(join(broken, PULUMI_ENGINE_GRAPH_FILE), JSON.stringify({ version: 1, meta: { engineGraph: { format: 1, engine: { name: "choudoufu" } } }, nodes: [] }));
    const { entities, report, warnings } = readPulumiMember({ member: { dir: broken, label: "app" } });
    expect(warnings.join("\n")).toMatch(/engine-graph.json was not read: it was printed by "choudoufu", not plunge/);
    expect(report.engineGraph).toEqual({ file: "engine-graph.json", read: false, reason: 'it was printed by "choudoufu", not plunge' });
    expect([...entities.values()].every((e) => (e as unknown as { facts?: unknown }).facts === undefined)).toBe(true);
    writeFileSync(join(broken, PULUMI_ENGINE_GRAPH_FILE), "{");
    expect(readPulumiMember({ member: { dir: broken, label: "app" } }).report.engineGraph).toMatchObject({ read: false, reason: expect.stringMatching(/not readable JSON/) });
  });

  test("a member on plunge with no engine-graph.json reads as before, with grain instance on its edges", () => {
    const bare = copyOf(dir);
    rmSync(join(bare, PULUMI_ENGINE_GRAPH_FILE));
    const { entities, report } = readPulumiMember({ member: { dir: bare, label: "app" } });
    expect(report).toEqual({ export: "stack-export.json", objects: 3, exported: true });
    expect(buildGraphIr(entities).edges.map((e) => [e.viaAttr, e.grain])).toEqual([["dependencies", "instance"]]);
  });
});

describe("a stock member gets no facts (#4529)", () => {
  test("its engine-graph.json, if one is there, is not read", () => {
    for (const member of [{ dir, label: "app", engine: "pulumi" as const }, { dir: (() => {
      const d = copyOf(dir);
      writeFileSync(join(d, "Pulumi.yaml"), "name: app\nruntime: nodejs\n");
      return d;
    })(), label: "app" }]) {
      const { entities, report } = readPulumiMember({ member });
      expect(report.engineGraph).toBeUndefined();
      expect([...entities.values()].every((e) => (e as unknown as { facts?: unknown }).facts === undefined)).toBe(true);
      const ir = buildGraphIr(entities);
      expect(ir.nodes.every((n) => n.facts === undefined)).toBe(true);
      expect(ir.edges.map((e) => [e.viaAttr, e.grain])).toEqual([["dependencies", "instance"]]);
    }
  });
});
