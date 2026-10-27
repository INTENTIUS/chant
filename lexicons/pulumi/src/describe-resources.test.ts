/**
 * `describeResources` for a Pulumi member (#4529): one `plunge graph --json
 * --stack <stack>` for a member on plunge, read from chant#4527's plunge
 * fixture document, and nothing at all for a stock member. The runner is a
 * fake; no plunge binary runs here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildLiveGraphIr } from "@intentius/chant/graph-ir";
import { isObservationResult, normalizeObservation } from "@intentius/chant/observation";
import { describePulumiResources, PLUNGE_GRAPH_SOURCE } from "./describe-resources";
import type { PulumiRunner } from "./run";

const testdata = join(import.meta.dirname, "testdata");
const dir = join(testdata, "plunge-graph");
const fixturePath = join(import.meta.dirname, "..", "..", "..", "packages", "core", "src", "graph-schema", "fixtures", "plunge.engine-graph.json");
const fixtureText = readFileSync(fixturePath, "utf-8");
const fixture = JSON.parse(fixtureText) as { nodes: { id: string; facts?: unknown }[] };

function fake(answer: (args: string[]) => string | Error): { run: PulumiRunner; calls: { args: string[]; cwd: string }[] } {
  const calls: { args: string[]; cwd: string }[] = [];
  const run: PulumiRunner = async (args, opts) => {
    calls.push({ args, cwd: opts.cwd });
    const out = answer(args);
    if (out instanceof Error) throw out;
    return { stdout: out };
  };
  return { run, calls };
}

const entities = new Map([
  ["app/aws:s3/bucketV2:BucketV2::assets", { entityType: "aws:s3/bucketV2:BucketV2", props: {} }],
  ["app/gcp:storage/bucket:Bucket::media", { entityType: "gcp:storage/bucket:Bucket", props: {} }],
  ["app/aws:s3/bucketPolicy:BucketPolicy::assets-policy", { entityType: "aws:s3/bucketPolicy:BucketPolicy", props: {} }],
]);
const factsOf = (urn: string) => fixture.nodes.find((n) => n.id === urn)!.facts;

describe("describeResources for a member on plunge (#4529)", () => {
  test("runs plunge graph --json --stack <stack> once and maps each URN with pulumiNodeKey", async () => {
    const { run, calls } = fake(() => fixtureText);
    const result = await describePulumiResources({ entities }, { member: { dir, label: "app" }, plunge: run });
    expect(calls).toEqual([{ args: ["graph", "--json", "--stack", "dev"], cwd: dir }]);
    const obs = normalizeObservation(result);
    // The provider has no node; every other node of the document is a resource.
    expect(Object.keys(obs.resources).sort()).toEqual([...entities.keys()].sort());
    expect(obs.unobserved).toEqual({});
    expect(obs.sources["app/aws:s3/bucketV2:BucketV2::assets"]).toBe(PLUNGE_GRAPH_SOURCE);
    expect(obs.queried["app/aws:s3/bucketV2:BucketV2::assets"]).toBe("urn:pulumi:dev::app::aws:s3/bucketV2:BucketV2::assets");
  });

  test("each resource carries plunge's physicalId and facts, and no verdict", async () => {
    const { run } = fake(() => fixtureText);
    const { resources } = normalizeObservation(await describePulumiResources({ entities }, { member: { dir, label: "app" }, plunge: run }));
    const assets = resources["app/aws:s3/bucketV2:BucketV2::assets"];
    expect(assets).toEqual({
      type: "aws:s3/bucketV2:BucketV2",
      physicalId: "assets-4f1c2e9",
      status: "bound",
      ownership: "unknown",
      facts: factsOf("urn:pulumi:dev::app::aws:s3/bucketV2:BucketV2::assets"),
    });
    expect(assets.facts?.markers).toEqual({ owner: "app/dev", address: "aws:s3/bucketV2:BucketV2::assets", encoding: "plain", source: "record" });
    expect(resources["app/gcp:storage/bucket:Bucket::media"].facts?.markers?.encoding).toBe("digest");
    expect(resources["app/aws:s3/bucketPolicy:BucketPolicy::assets-policy"]).toMatchObject({ status: "pending", ownership: "unknown" });
    for (const r of Object.values(resources)) {
      expect(r.ownership).toBe("unknown");
      expect(r.marker).toBeUndefined();
    }
  });

  test("buildLiveGraphIr puts the facts on the live node", async () => {
    const { run } = fake(() => fixtureText);
    const { resources } = normalizeObservation(await describePulumiResources({ entities }, { member: { dir, label: "app" }, plunge: run }));
    const ir = buildLiveGraphIr([{ lexicon: "pulumi", resources }]);
    const node = ir.nodes.find((n) => n.id === "app/aws:s3/bucketV2:BucketV2::assets")!;
    expect(node.facts).toEqual(factsOf("urn:pulumi:dev::app::aws:s3/bucketV2:BucketV2::assets"));
    expect(node.ownership).toBeUndefined();
  });

  test("with owned asked, a note says ownership stays unknown", async () => {
    const { run } = fake(() => fixtureText);
    const result = await describePulumiResources({ entities, owned: true }, { member: { dir, label: "app" }, plunge: run });
    expect(normalizeObservation(result).notes.join("\n")).toMatch(/ownership stays unknown.*source: record/);
  });

  test("a failed run leaves every entity not-observed, never absent", async () => {
    const old = fake(() => Object.assign(new Error("Command failed"), { stderr: 'error: unknown command "graph" for "plunge"' }));
    const obs = normalizeObservation(await describePulumiResources({ entities }, { member: { dir, label: "app" }, plunge: old.run }));
    expect(obs.resources).toEqual({});
    expect(Object.keys(obs.unobserved).sort()).toEqual([...entities.keys()].sort());
    expect(Object.values(obs.unobserved).every((u) => u.reason === "read-failed" && /plunge#40/.test(u.detail ?? ""))).toBe(true);

    const other = fake(() => JSON.stringify({ version: 1, meta: { engineGraph: { format: 1, engine: { name: "choudoufu" } } }, nodes: [], edges: [] }));
    const wrong = normalizeObservation(await describePulumiResources({ entities }, { member: { dir, label: "app" }, plunge: other.run }));
    expect(Object.values(wrong.unobserved).every((u) => u.reason === "read-failed" && /not plunge/.test(u.detail ?? ""))).toBe(true);
  });
});

describe("describeResources for a stock member (#4529)", () => {
  test("runs nothing and leaves every entity not-observed", async () => {
    const plunge = fake(() => fixtureText);
    for (const member of [{ dir: join(testdata, "pulumi-preview"), label: "app" }, { dir, label: "app", engine: "pulumi" as const }]) {
      const result = await describePulumiResources({ entities }, { member, plunge: plunge.run });
      expect(isObservationResult(result)).toBe(true);
      const obs = normalizeObservation(result);
      expect(obs.resources).toEqual({});
      expect(Object.values(obs.unobserved).every((u) => u.reason === "no-binding" && /stock pulumi/.test(u.detail ?? ""))).toBe(true);
    }
    expect(plunge.calls).toEqual([]);
  });
});
