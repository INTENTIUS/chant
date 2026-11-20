/**
 * `facts.ownership` from choudoufu on every declared node of a live root, and
 * the same words from a plunge member (chant #5333).
 *
 * `chant graph --live` reads with `--owned`, so a live root's graph draws only
 * what this estate's markers bind. choudoufu's `live-graph` also describes a
 * pending create and the objects others hold; those facts ride on
 * `ObservationResult.engineFacts`, and the overlay puts them on the declared
 * nodes. Each test here builds what `chant graph --live --overlay` builds and
 * composes it the way `chant workspace graph` does.
 *
 * Fixtures, none produced by a run:
 *
 * - `__fixtures__/live-module-keyed/`, the #4513 root, whose live-graph.json
 *   has every ownership word (bound, pending, unowned, foreign).
 * - `__fixtures__/live-plunge-twin/`, the estate of the pulumi lexicon's
 *   `testdata/plunge-graph/` declared as a choudoufu live root: two buckets
 *   bound and a bucket policy pending.
 *
 * Nothing here runs choudoufu or plunge: the activities are injected.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import { DRIFT_OWNERSHIP_VERDICTS, driftVerdictOfEngineOwnership, engineOwnershipOfDrift } from "@intentius/chant/drift-record";
import { buildGraphIr, buildLiveGraphIr, carryEngineFacts, overlayGraphs, sourceOverlayGraphs, withInstanceNodes, type GraphIR } from "@intentius/chant/graph-ir";
import { normalizeObservation } from "@intentius/chant/observation";
import { composeWorkspaceGraph, type ComposedMember } from "@intentius/chant/workspace/compose-graph";
import { readPulumiMember } from "@intentius/chant-lexicon-pulumi/workspace-member";
import { describeResources, engineFactsBeside, readEngineGraph, type TerraformReadDeps } from "./describe-resources";
import { choudoufuLivePlanDriftRecords } from "./drift-record";
import { renderTerraformRoots } from "./hcl/roots";

const FIXTURES = join(import.meta.dirname, "__fixtures__");
const PLUNGE_MEMBER = join(import.meta.dirname, "..", "..", "pulumi", "src", "testdata", "plunge-graph");
const json = (...path: string[]): unknown => JSON.parse(readFileSync(join(FIXTURES, ...path), "utf-8"));

const never = ((args: { root: string }) => {
  throw new Error(`unexpected activity for root "${args.root}"`);
}) as never;

/** One live root's fixture: its directory under __fixtures__, and the estate its live-plan names. */
interface LiveRoot {
  fixture: string;
  estate: string;
}

const MODULE_KEYED: LiveRoot = { fixture: "live-module-keyed", estate: "module-keyed-estate" };
const TWIN: LiveRoot = { fixture: "live-plunge-twin", estate: "app-dev" };

async function declared(root: LiveRoot): Promise<Map<string, Declarable>> {
  const { entities } = await renderTerraformRoots({ projectRoot: join(FIXTURES, root.fixture), roots: { estate: { dir: "./root" } }, binary: "choudoufu" });
  return entities;
}

/** `describeResources` over the root, as `chant graph --live` asks: owned only. */
async function observe(root: LiveRoot, entities: Map<string, Declarable>) {
  const deps: TerraformReadDeps = {
    init: never,
    show: never,
    liveLs: never,
    livePlan: (async () => ({ json: json(root.fixture, "live-plan.json"), dir: join(FIXTURES, root.fixture, "root"), estate: root.estate })) as unknown as TerraformReadDeps["livePlan"],
    liveGraph: (async () => ({ supported: true as const, json: json(root.fixture, "live-graph.json"), dir: join(FIXTURES, root.fixture, "root") })) as NonNullable<TerraformReadDeps["liveGraph"]>,
  };
  const scoped = new Map([...entities].map(([k, e]) => [k, { entityType: e.entityType, props: (e as Declarable & { props: Record<string, unknown> }).props }]));
  return normalizeObservation(
    await describeResources({ environment: "prod", buildOutput: "", entityNames: [...scoped.keys()].sort(), entities: scoped, owned: true }, deps),
  );
}

/** What `chant graph --live --overlay` prints for the root: the overlay, then the engine's facts on the declared nodes. */
async function overlaid(root: LiveRoot, anchor: "source" | "live" = "source"): Promise<GraphIR> {
  const entities = await declared(root);
  const observed = await observe(root, entities);
  const live = buildLiveGraphIr([{ lexicon: "terraform", resources: observed.resources }]);
  const canvas = withInstanceNodes(buildGraphIr(entities), entities);
  const opts = { unobserved: observed.unobserved };
  const ir = anchor === "source" ? sourceOverlayGraphs(canvas, live, opts) : overlayGraphs(live, canvas, opts);
  return { ...ir, nodes: carryEngineFacts(ir.nodes, observed.engineFacts) };
}

const member = (name: string): ComposedMember => ({ name, dir: name, kind: name === "app" ? "pulumi" : "choudoufu", status: "composed", reason: null, chant: "0.124.103", irVersion: 1, live: true });

const ownershipById = (nodes: readonly { id: string; facts?: { ownership?: string } }[]) =>
  Object.fromEntries(nodes.filter((n) => n.facts?.ownership).map((n) => [n.id, n.facts!.ownership]));

describe("a choudoufu live root's declared nodes carry its facts.ownership (#5333)", () => {
  it("--owned leaves pending, unowned and foreign off the live graph, and engineFacts keeps them by node id", async () => {
    const observed = await observe(MODULE_KEYED, await declared(MODULE_KEYED));
    expect(Object.keys(observed.resources)).toEqual(["estate/module.app/aws_cloudwatch_log_group.logs", "estate/module.app/aws_eip.pool"]);
    expect(observed.unobserved["estate/module.edge/aws_cloudwatch_log_group.front"]).toMatchObject({ reason: "filtered" });
    expect(observed.engineFacts).toEqual({
      "estate/module.app[1]/aws_cloudwatch_log_group.logs": { ownership: "pending" },
      'estate/module.edge["east"]/aws_cloudwatch_log_group.front': { ownership: "unowned", cloudIds: [{ kind: "import-id", value: "/module-keyed-estate/edge-east" }] },
      'estate/module.edge["west"]/aws_cloudwatch_log_group.front': {
        ownership: "foreign",
        markers: { owner: "other-estate", encoding: "escaped", source: "live" },
        cloudIds: [{ kind: "import-id", value: "/module-keyed-estate/edge-west" }],
      },
    });
  });

  it("the workspace graph's nodes have every word the engine printed, in the graph's enum", async () => {
    const graph = composeWorkspaceGraph({ name: "w", root: "." }, [{ member: member("estate"), ir: await overlaid(MODULE_KEYED) }]);
    expect(ownershipById(graph.nodes)).toEqual({
      "estate/estate/module.app[0]/aws_cloudwatch_log_group.logs": "bound",
      "estate/estate/module.app[0]/aws_eip.pool[0]": "bound",
      "estate/estate/module.app[0]/aws_eip.pool[1]": "bound",
      "estate/estate/module.app[1]/aws_cloudwatch_log_group.logs": "pending",
      "estate/estate/module.app[1]/aws_eip.pool[0]": "bound",
      "estate/estate/module.app[1]/aws_eip.pool[1]": "bound",
      'estate/estate/module.edge["east"]/aws_cloudwatch_log_group.front': "unowned",
      'estate/estate/module.edge["west"]/aws_cloudwatch_log_group.front': "foreign",
    });
    // The paint is the overlay's, unchanged by the facts.
    const paint = Object.fromEntries(graph.nodes.map((n) => [n.id, n.attrs._status]));
    expect(paint["estate/estate/module.app[1]/aws_cloudwatch_log_group.logs"]).toBe("accent");
    expect(paint['estate/estate/module.edge["west"]/aws_cloudwatch_log_group.front']).toBe("neutral");
  });

  it("the live-anchored overlay carries the same words", async () => {
    const source = ownershipById((await overlaid(MODULE_KEYED, "source")).nodes);
    const live = ownershipById((await overlaid(MODULE_KEYED, "live")).nodes);
    expect(live).toEqual(source);
  });

  it("engineFactsBeside skips every node the live graph draws", () => {
    const read = readEngineGraph("estate", json(TWIN.fixture, "live-graph.json"));
    const bucket = { type: "aws_s3_bucket", verdict: "present" } as never;
    expect(engineFactsBeside({ "estate/aws_s3_bucket.assets": bucket, "estate/aws_s3_bucket.media": bucket }, [read])).toEqual({
      "estate/aws_s3_bucket_policy.assets_policy": { ownership: "pending" },
    });
    expect(Object.keys(engineFactsBeside({}, [read])).sort()).toEqual([
      "estate/aws_s3_bucket.assets",
      "estate/aws_s3_bucket.media",
      "estate/aws_s3_bucket_policy.assets_policy",
    ]);
  });
});

describe("a choudoufu root and a plunge stack give the same facts.ownership (#5333)", () => {
  /** A node's resource name: the URN's last segment, or the block's name, `-` read as `_`. */
  const nameOf = (id: string) => (id.includes("::") ? id.slice(id.lastIndexOf("::") + 2) : id.slice(id.lastIndexOf(".") + 1)).replaceAll("-", "_");

  it("one workspace graph, both members, the same word per resource", async () => {
    const { entities, warnings } = readPulumiMember({ member: { dir: PLUNGE_MEMBER, label: "app" } });
    expect(warnings).toEqual([]);
    const graph = composeWorkspaceGraph({ name: "w", root: "." }, [
      { member: member("estate"), ir: await overlaid(TWIN) },
      { member: member("app"), ir: buildGraphIr(entities) },
    ]);
    const byMember = (m: string) =>
      Object.fromEntries(graph.nodes.filter((n) => n.member === m && n.facts?.ownership).map((n) => [nameOf(n.id), n.facts!.ownership]));
    expect(byMember("estate")).toEqual({ assets: "bound", media: "bound", assets_policy: "pending" });
    expect(byMember("app")).toEqual(byMember("estate"));
  });
});

describe("the drift verdict and the graph enum, on one live-plan (#5333)", () => {
  for (const root of [MODULE_KEYED, TWIN]) {
    it(`${root.fixture}: each drift record's verdict maps to the word live-graph printed for its address`, () => {
      const graph = json(root.fixture, "live-graph.json") as { nodes: { id: string; facts?: { ownership?: string } }[] };
      const printed = Object.fromEntries(graph.nodes.filter((n) => n.facts?.ownership).map((n) => [n.id, n.facts!.ownership]));
      const records = choudoufuLivePlanDriftRecords({ member: "estate", observedAt: "2026-11-19T00:00:00Z", livePlan: json(root.fixture, "live-plan.json") });
      const mapped = Object.fromEntries(records.map((r) => [r.address, engineOwnershipOfDrift(r)]));
      expect(mapped).toEqual(printed);
      // Drift records keep their own field and words.
      for (const r of records) if (r.ownership) expect(DRIFT_OWNERSHIP_VERDICTS).toContain(r.ownership.verdict);
      // And each word reads back as the verdict, but pending, which is a status.
      for (const r of records) {
        const word = engineOwnershipOfDrift(r)!;
        expect(driftVerdictOfEngineOwnership(word)).toBe(r.ownership?.verdict);
      }
    });
  }
});
