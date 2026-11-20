/**
 * Per-instance ownership rows under `facts.ownershipRows` (#5402), for a
 * choudoufu live root and a plunge member, in one workspace graph.
 *
 * `facts.ownership` stays one word per node (#5333). Beside it, each node
 * carries the rows its engine printed for it: choudoufu `live-plan`'s
 * `bound[].source`, `identity_values`, omission and adoption, `live-ls`'s
 * `gaps[]` and whether it lists the object (with
 * `CHANT_TERRAFORM_LIVE_LISTING=1`), and either engine's
 * `meta.engineGraph.gaps`.
 *
 * Fixtures, none produced by a run: `__fixtures__/live-module-keyed/` (every
 * ownership word), `__fixtures__/live-plunge-twin/` and the pulumi lexicon's
 * `testdata/plunge-graph/`. Documents a test changes are copied in memory.
 * Nothing here runs choudoufu or plunge: the activities are injected.
 */

import { mkdtempSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import type { EngineFacts } from "@intentius/chant/engine-facts";
import { buildGraphIr, buildLiveGraphIr, carryEngineFacts, sourceOverlayGraphs, withInstanceNodes, type GraphIR } from "@intentius/chant/graph-ir";
import { normalizeObservation } from "@intentius/chant/observation";
import { composeWorkspaceGraph, type ComposedMember } from "@intentius/chant/workspace/compose-graph";
import { readPulumiMember } from "@intentius/chant-lexicon-pulumi/workspace-member";
import { readPlungeEngineGraph } from "@intentius/chant-lexicon-pulumi/engine-graph";
import { describeResources, indexLivePlan, ownershipRowsByAddress, readEngineGraph, TERRAFORM_LIVE_LISTING_ENV, type TerraformReadDeps } from "./describe-resources";
import { renderTerraformRoots } from "./hcl/roots";

const FIXTURES = join(import.meta.dirname, "__fixtures__");
const PLUNGE_MEMBER = join(import.meta.dirname, "..", "..", "pulumi", "src", "testdata", "plunge-graph");
const json = (...path: string[]): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES, ...path), "utf-8"));

const never = ((args: { root: string }) => {
  throw new Error(`unexpected activity for root "${args.root}"`);
}) as never;

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

interface Docs {
  livePlan?: Record<string, unknown>;
  liveGraph?: Record<string, unknown>;
  liveLs?: Record<string, unknown>;
}

/** `chant graph --live --overlay` over the root, as the #5333 test builds it, with the documents a test swaps in. */
async function overlaid(root: LiveRoot, docs: Docs = {}, calls: string[] = []): Promise<GraphIR> {
  const entities = await declared(root);
  const deps: TerraformReadDeps = {
    init: never,
    show: never,
    liveLs: (async (args: { compare?: boolean }) => {
      calls.push(`live-ls${args.compare ? " ." : ""}`);
      if (!docs.liveLs) throw new Error("live-ls: no listing in this test");
      return { json: docs.liveLs, dir: join(FIXTURES, root.fixture, "root"), estate: root.estate };
    }) as unknown as TerraformReadDeps["liveLs"],
    livePlan: (async () => ({ json: docs.livePlan ?? json(root.fixture, "live-plan.json"), dir: join(FIXTURES, root.fixture, "root"), estate: root.estate })) as unknown as TerraformReadDeps["livePlan"],
    liveGraph: (async () => ({ supported: true as const, json: docs.liveGraph ?? json(root.fixture, "live-graph.json"), dir: join(FIXTURES, root.fixture, "root") })) as NonNullable<TerraformReadDeps["liveGraph"]>,
  };
  const scoped = new Map([...entities].map(([k, e]) => [k, { entityType: e.entityType, props: (e as Declarable & { props: Record<string, unknown> }).props }]));
  const observed = normalizeObservation(
    await describeResources({ environment: "prod", buildOutput: "", entityNames: [...scoped.keys()].sort(), entities: scoped, owned: true }, deps),
  );
  const live = buildLiveGraphIr([{ lexicon: "terraform", resources: observed.resources }]);
  const canvas = withInstanceNodes(buildGraphIr(entities), entities);
  const ir = sourceOverlayGraphs(canvas, live, { unobserved: observed.unobserved });
  return { ...ir, nodes: carryEngineFacts(ir.nodes, observed.engineFacts) };
}

const member = (name: string): ComposedMember => ({ name, dir: name, kind: name === "app" ? "pulumi" : "choudoufu", status: "composed", reason: null, chant: "0.124.103", irVersion: 1, live: true });

const factsById = (nodes: readonly { id: string; facts?: EngineFacts }[]) =>
  Object.fromEntries(nodes.filter((n) => n.facts).map((n) => [n.id, n.facts!]));
const rowsById = (nodes: readonly { id: string; facts?: EngineFacts }[]) =>
  Object.fromEntries(nodes.filter((n) => n.facts?.ownershipRows).map((n) => [n.id, n.facts!.ownershipRows]));

afterEach(() => {
  delete process.env[TERRAFORM_LIVE_LISTING_ENV];
});

describe("a choudoufu live root's nodes carry live-plan's rows per instance (#5402)", () => {
  it("each instance of the workspace graph carries its own rows beside its word", async () => {
    const graph = composeWorkspaceGraph({ name: "w", root: "." }, [{ member: member("estate"), ir: await overlaid(MODULE_KEYED) }]);
    const facts = factsById(graph.nodes);
    const at = (id: string) => facts[`estate/estate/${id}`];

    // bound by name: how it bound, and the values that identify it.
    expect(at("module.app[0]/aws_cloudwatch_log_group.logs")).toMatchObject({
      ownership: "bound",
      ownershipRows: { boundBy: "derived", identityValues: { name: "/module-keyed-estate/app-0" } },
    });
    // bound by marker, on another instance of the same block: its own row.
    expect(at("module.app[0]/aws_eip.pool[1]")!.ownershipRows).toEqual({ boundBy: "marker" });
    // pending: the omission, with choudoufu's code and sentence.
    expect(at("module.app[1]/aws_cloudwatch_log_group.logs")!.ownershipRows).toEqual({
      omission: { reason: "ABSENT", detail: expect.stringContaining("has not been created yet") },
    });
    // unowned: the marker values that adopt it, and the omission beside them.
    expect(at('module.edge["east"]/aws_cloudwatch_log_group.front')).toMatchObject({
      ownership: "unowned",
      ownershipRows: {
        adopt: { owner: "module-keyed-estate", address: "module.edge:east.aws_cloudwatch_log_group.front" },
        omission: { reason: "UNOWNED" },
      },
    });
    // foreign: no adoption; who holds it stays facts.markers.owner.
    const west = at('module.edge["west"]/aws_cloudwatch_log_group.front')!;
    expect(west.ownership).toBe("foreign");
    expect(west.markers?.owner).toBe("other-estate");
    expect(west.ownershipRows).toEqual({ omission: { reason: "UNOWNED", detail: expect.stringContaining("belongs to another estate") } });
  });

  it("an adoptable[] content match carries its matched arguments and choudoufu's composed command", async () => {
    const livePlan = json(TWIN.fixture, "live-plan.json");
    livePlan.omissions = [{ addr: "aws_s3_bucket_policy.assets_policy", reason: "NEEDS_DISCOVERY", detail: "no identity of its own" }];
    livePlan.adoptable = [
      {
        addr: "aws_s3_bucket_policy.assets_policy",
        type: "aws_s3_bucket_policy",
        identity: "assets-4f1c2e9",
        adopt_tofu_estate: "app-dev",
        adopt_tofu_address: "aws_s3_bucket_policy.assets_policy",
        adopt_command: "choudoufu live-adopt aws_s3_bucket_policy.assets_policy",
        matched: [{ attribute: "bucket", value: "assets-4f1c2e9" }],
      },
    ];
    const rows = ownershipRowsByAddress(indexLivePlan(livePlan));
    expect(rows.get("aws_s3_bucket_policy.assets_policy")).toEqual({
      omission: { reason: "NEEDS_DISCOVERY", detail: "no identity of its own" },
      adopt: {
        owner: "app-dev",
        address: "aws_s3_bucket_policy.assets_policy",
        command: "choudoufu live-adopt aws_s3_bucket_policy.assets_policy",
        matched: [{ attribute: "bucket", value: "assets-4f1c2e9" }],
      },
    });
  });

  it("live-graph's meta.engineGraph.gaps ride as gaps read graph", async () => {
    const liveGraph = json(TWIN.fixture, "live-graph.json");
    (liveGraph.meta as { engineGraph: Record<string, unknown> }).engineGraph.gaps = [
      { address: "aws_s3_bucket.media", reason: "references-unread", detail: "the block's body is not native syntax" },
    ];
    const graph = composeWorkspaceGraph({ name: "w", root: "." }, [{ member: member("estate"), ir: await overlaid(TWIN, { liveGraph }) }]);
    expect(rowsById(graph.nodes)["estate/estate/aws_s3_bucket.media"]).toEqual({
      boundBy: "marker",
      gaps: [{ read: "graph", reason: "references-unread", detail: "the block's body is not native syntax" }],
    });
  });
});

describe("the live-ls listing's rows, on request (#5402)", () => {
  const listing = {
    estate: "module-keyed-estate",
    consistent: false,
    stabilized: true,
    attempts: 1,
    schemas: "provider",
    items: [
      { id: "eipalloc-0a41c7d2e9b3f5061", type: "aws_eip", address: "module.app[0].aws_eip.pool[0]", declared: true, source: "tagging", tags: {} },
    ],
    gaps: [{ address: "module.app[0].aws_cloudwatch_log_group.logs", type: "aws_cloudwatch_log_group", rung: "declaration-carried", detail: "bound by the name it declares" }],
  };

  it("runs no listing unless asked", async () => {
    const calls: string[] = [];
    const ir = await overlaid(MODULE_KEYED, { liveLs: listing }, calls);
    expect(calls).toEqual([]);
    for (const rows of Object.values(rowsById(ir.nodes))) {
      expect(rows).not.toHaveProperty("listed");
      expect(rows).not.toHaveProperty("gaps");
    }
  });

  it("with CHANT_TERRAFORM_LIVE_LISTING=1, carries its gaps read listing and whether it lists each bound object", async () => {
    process.env[TERRAFORM_LIVE_LISTING_ENV] = "1";
    const calls: string[] = [];
    const graph = composeWorkspaceGraph({ name: "w", root: "." }, [{ member: member("estate"), ir: await overlaid(MODULE_KEYED, { liveLs: listing }, calls) }]);
    expect(calls).toEqual(["live-ls ."]);
    const rows = rowsById(graph.nodes);
    expect(rows["estate/estate/module.app[0]/aws_cloudwatch_log_group.logs"]).toEqual({
      boundBy: "derived",
      identityValues: { name: "/module-keyed-estate/app-0" },
      listed: false,
      gaps: [{ read: "listing", reason: "declaration-carried", detail: "bound by the name it declares" }],
    });
    expect(rows["estate/estate/module.app[0]/aws_eip.pool[0]"]).toEqual({ boundBy: "marker", listed: true });
    expect(rows["estate/estate/module.app[0]/aws_eip.pool[1]"]).toEqual({ boundBy: "marker", listed: false });
    // An omission has no listed: the listing answers for bound objects.
    expect(rows["estate/estate/module.app[1]/aws_cloudwatch_log_group.logs"]).not.toHaveProperty("listed");
  });

  it("a listing that fails leaves live-plan's rows", async () => {
    process.env[TERRAFORM_LIVE_LISTING_ENV] = "1";
    const ir = await overlaid(MODULE_KEYED, {});
    expect(rowsById(ir.nodes)["estate/module.app[0]/aws_eip.pool[0]"]).toEqual({ boundBy: "marker" });
  });
});

describe("a member with no rows reads as before (#5402)", () => {
  it("live-plan and live-graph with no rows: the facts are #5333's, with no ownershipRows", () => {
    const document = json(MODULE_KEYED.fixture, "live-graph.json");
    const before = readEngineGraph("estate", document);
    const none = readEngineGraph("estate", document, ownershipRowsByAddress(indexLivePlan({ estate: "module-keyed-estate", bound: null, omissions: null, unowned: null })));
    expect(none.blocks).toEqual(before.blocks);
    expect(none.instances).toEqual(before.instances);
    for (const byAddress of none.instances.values()) for (const f of byAddress.values()) expect(f).not.toHaveProperty("ownershipRows");
  });

  it("a plunge member whose engine graph has no gaps: no node carries ownershipRows", () => {
    const { entities, warnings } = readPulumiMember({ member: { dir: PLUNGE_MEMBER, label: "app" } });
    expect(warnings).toEqual([]);
    expect(Object.keys(rowsById(buildGraphIr(entities).nodes))).toEqual([]);
  });
});

describe("a plunge member carries the same field (#5402)", () => {
  const plunge = (): Record<string, unknown> => JSON.parse(readFileSync(join(PLUNGE_MEMBER, "engine-graph.json"), "utf-8"));
  const MEDIA = "urn:pulumi:dev::app::gcp:storage/bucket:Bucket::media";

  it("meta.engineGraph.gaps for a URN rides on its node as gaps read graph, and rows plunge prints are kept", () => {
    const doc = plunge();
    (doc.meta as { engineGraph: Record<string, unknown> }).engineGraph.gaps = [
      { address: MEDIA, reason: "history-not-kept", detail: "the store replaces records in place" },
      { address: "urn:pulumi:dev::app::aws:s3/bucketV2:BucketV2::gone", reason: "no-state", detail: "the record holds no state and no pending create" },
    ];
    const nodes = doc.nodes as Array<{ id: string; facts?: Record<string, unknown> }>;
    const assets = nodes.find((n) => n.id.endsWith("::assets"))!;
    assets.facts = { ...assets.facts, ownershipRows: { adopt: { owner: "app/dev", address: "aws:s3/bucketV2:BucketV2::assets" }, unknownRow: true } };

    const read = readPlungeEngineGraph(doc);
    if ("error" in read) throw new Error(read.error);
    const byUrn = Object.fromEntries(read.graph.nodes.map((n) => [n.urn, n.facts?.ownershipRows]));
    expect(byUrn[MEDIA]).toEqual({ gaps: [{ read: "graph", reason: "history-not-kept", detail: "the store replaces records in place" }] });
    expect(byUrn[assets.id]).toEqual({ adopt: { owner: "app/dev", address: "aws:s3/bucketV2:BucketV2::assets" } });
    expect(read.graph.gaps).toBe(2);
  });

  it("one workspace graph: the choudoufu root and the plunge member put their rows in the one field", async () => {
    const doc = plunge();
    (doc.meta as { engineGraph: Record<string, unknown> }).engineGraph.gaps = [{ address: MEDIA, reason: "history-not-kept", detail: "the store replaces records in place" }];
    const dir = mkdtempSync(join(tmpdir(), "chant-5402-plunge-"));
    cpSync(PLUNGE_MEMBER, dir, { recursive: true });
    writeFileSync(join(dir, "engine-graph.json"), JSON.stringify(doc));
    const { entities } = readPulumiMember({ member: { dir, label: "app" } });

    const graph = composeWorkspaceGraph({ name: "w", root: "." }, [
      { member: member("estate"), ir: await overlaid(TWIN) },
      { member: member("app"), ir: buildGraphIr(entities) },
    ]);
    const rows = Object.fromEntries(graph.nodes.filter((n) => n.facts?.ownershipRows).map((n) => [`${n.member}:${n.id.slice(n.id.search(/[^/:]+$/))}`, n.facts!.ownershipRows]));
    expect(rows).toEqual({
      "estate:aws_s3_bucket.assets": { boundBy: "marker" },
      "estate:aws_s3_bucket.media": { boundBy: "marker" },
      "estate:aws_s3_bucket_policy.assets_policy": { omission: { reason: "ABSENT", detail: expect.any(String) } },
      "app:media": { gaps: [{ read: "graph", reason: "history-not-kept", detail: "the store replaces records in place" }] },
    });
  });
});
