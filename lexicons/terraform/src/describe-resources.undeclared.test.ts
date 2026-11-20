/**
 * A choudoufu live root's bound objects that no block declares, as live nodes
 * of `chant graph --live --overlay` (#5429).
 *
 * Fixture `__fixtures__/live-undeclared/`: `root/main.tf` is the monolith
 * estate behold#1240 read; `live-plan.json` is a recorded `live-plan -json`
 * for it, with one bound log group, `aws_cloudwatch_log_group.stray`, that no
 * block declares; `live-graph.json` is what a real choudoufu build
 * (v0.15.0-30) printed for `live-graph -json -from-plan=live-plan.json` in
 * that root, warning header removed; `live-ls.json` is the recorded listing,
 * which holds the stray log group with `declared: false`. Nothing here runs
 * choudoufu: the activities answer from those files.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import { buildGraphIr, buildLiveGraphIr, carryEngineFacts, sourceOverlayGraphs, withInstanceNodes, type GraphIR, type LiveObservation } from "@intentius/chant/graph-ir";
import { normalizeObservation, type NormalizedObservation } from "@intentius/chant/observation";
import { describeResources, TERRAFORM_LIVE_LISTING_ENV, type TerraformReadDeps } from "./describe-resources";
import { renderTerraformRoots } from "./hcl/roots";

const FIXTURES = join(import.meta.dirname, "__fixtures__");
const FIXTURE = "live-undeclared";
const ESTATE = "tlmig-sample-monolith";
const STRAY = "aws_cloudwatch_log_group.stray";
const STRAY_ID = `mono/${STRAY}`;
const json = (file: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES, FIXTURE, file), "utf-8"));

const never = ((args: { root: string }) => {
  throw new Error(`unexpected activity for root "${args.root}"`);
}) as never;

interface Docs {
  livePlan?: Record<string, unknown>;
  liveGraph?: Record<string, unknown>;
  liveLs?: Record<string, unknown>;
  /** No `live-graph` at all, as a choudoufu older than the command. */
  noGraph?: boolean;
}

/** The fixture's documents with the stray log group taken out, as a member that binds nothing undeclared reads. */
function withoutStray(): Required<Omit<Docs, "noGraph">> {
  const livePlan = json("live-plan.json");
  livePlan.bound = (livePlan.bound as Array<{ addr: string }>).filter((b) => b.addr !== STRAY);
  const liveGraph = json("live-graph.json");
  liveGraph.nodes = (liveGraph.nodes as Array<{ id: string }>).filter((n) => n.id !== STRAY);
  (liveGraph.meta as { engineGraph: { gaps?: unknown } }).engineGraph.gaps = [];
  const liveLs = json("live-ls.json");
  liveLs.items = (liveLs.items as Array<{ address?: string }>).filter((i) => i.address !== STRAY);
  return { livePlan, liveGraph, liveLs };
}

async function read(docs: Docs = {}): Promise<{ observed: NormalizedObservation; entities: Map<string, Declarable> }> {
  const { entities } = await renderTerraformRoots({ projectRoot: join(FIXTURES, FIXTURE), roots: { mono: { dir: "./root" } }, binary: "choudoufu" });
  const dir = join(FIXTURES, FIXTURE, "root");
  const deps: TerraformReadDeps = {
    init: never,
    show: never,
    liveLs: (async () => ({ json: docs.liveLs ?? json("live-ls.json"), dir, estate: ESTATE })) as unknown as TerraformReadDeps["liveLs"],
    livePlan: (async () => ({ json: docs.livePlan ?? json("live-plan.json"), dir, estate: ESTATE })) as unknown as TerraformReadDeps["livePlan"],
    ...(docs.noGraph
      ? {}
      : { liveGraph: (async () => ({ supported: true as const, json: docs.liveGraph ?? json("live-graph.json"), dir })) as NonNullable<TerraformReadDeps["liveGraph"]> }),
  };
  const scoped = new Map([...entities].map(([k, e]) => [k, { entityType: e.entityType, props: (e as Declarable & { props: Record<string, unknown> }).props }]));
  const observed = normalizeObservation(
    await describeResources({ environment: "prod", buildOutput: "", entityNames: [...scoped.keys()].sort(), entities: scoped, owned: true }, deps),
  );
  return { observed, entities };
}

/** `chant graph --live --overlay` over the root, as the graph handler builds it. */
async function overlaid(docs: Docs = {}): Promise<{ ir: GraphIR; observed: NormalizedObservation }> {
  const { observed, entities } = await read(docs);
  const observations: LiveObservation[] = [{ lexicon: "terraform", resources: observed.resources }];
  const undeclared: LiveObservation[] = observed.undeclared ? [{ lexicon: "terraform", resources: observed.undeclared }] : [];
  const live = buildLiveGraphIr([...observations, ...undeclared]);
  const canvas = withInstanceNodes(buildGraphIr(entities), entities);
  const ir = sourceOverlayGraphs(canvas, live, { unobserved: observed.unobserved });
  return { ir: { ...ir, nodes: carryEngineFacts(ir.nodes, observed.engineFacts) }, observed };
}

const NOT_IN_CONFIGURATION = {
  read: "graph",
  reason: "not-in-configuration",
  detail: "the live plan names an address no block of this configuration declares",
};

afterEach(() => {
  delete process.env[TERRAFORM_LIVE_LISTING_ENV];
});

describe("a bound object no block declares is a live node (#5429)", () => {
  it("with the listing: choudoufu's address and type, status orphan, and boundBy, listed and gaps under ownershipRows", async () => {
    process.env[TERRAFORM_LIVE_LISTING_ENV] = "1";
    const { ir } = await overlaid();
    const stray = ir.nodes.find((n) => n.id === STRAY_ID);
    expect(stray).toEqual({
      id: STRAY_ID,
      kind: "aws_cloudwatch_log_group",
      lexicon: "terraform",
      physicalId: "/tlmig-sample/stray",
      ownership: "owned",
      attrs: {
        address: STRAY,
        root: "mono",
        estate: ESTATE,
        resourceType: "aws_cloudwatch_log_group",
        status: "orphan",
        boundBy: "marker",
        listedBy: "tagging",
        _status: "warn",
        _ownership: "owned",
      },
      facts: {
        ownership: "bound",
        ownedBy: "marker",
        markers: { owner: ESTATE, address: STRAY, encoding: "escaped", source: "live" },
        cloudIds: [{ kind: "import-id", value: "/tlmig-sample/stray" }],
        ownershipRows: { boundBy: "marker", listed: true, gaps: [NOT_IN_CONFIGURATION] },
      },
    });
  });

  it("without the listing: the plan's and the graph's rows, and no listed", async () => {
    const { ir } = await overlaid();
    expect(ir.nodes.find((n) => n.id === STRAY_ID)?.facts?.ownershipRows).toEqual({ boundBy: "marker", gaps: [NOT_IN_CONFIGURATION] });
  });

  it("a choudoufu with no live-graph: the node still comes from live-plan, with its bound row", async () => {
    const { ir } = await overlaid({ noGraph: true });
    const stray = ir.nodes.find((n) => n.id === STRAY_ID)!;
    expect(stray.kind).toBe("aws_cloudwatch_log_group");
    expect(stray.attrs._status).toBe("warn");
    expect(stray.facts).toEqual({ ownershipRows: { boundBy: "marker" } });
  });

  it("an object only the listing names: its ARN, listed, and the listing's source", async () => {
    process.env[TERRAFORM_LIVE_LISTING_ENV] = "1";
    const { livePlan, liveGraph } = withoutStray();
    const { ir } = await overlaid({ livePlan, liveGraph });
    const stray = ir.nodes.find((n) => n.id === STRAY_ID)!;
    expect(stray).toMatchObject({
      kind: "aws_cloudwatch_log_group",
      physicalId: "arn:aws:logs:us-east-1:000000000000:log-group:/tlmig-sample/stray",
      ownership: "owned",
      attrs: { address: STRAY, status: "orphan", listedBy: "tagging", _status: "warn", _ownership: "owned" },
      facts: { ownershipRows: { listed: true } },
    });
  });

  it("stays out of the read's resources and engine facts, so the diff and the change set see what they saw", async () => {
    process.env[TERRAFORM_LIVE_LISTING_ENV] = "1";
    const { observed } = await read();
    expect(Object.keys(observed.undeclared ?? {})).toEqual([STRAY_ID]);
    expect(observed.resources).not.toHaveProperty(STRAY_ID);
    expect(observed.engineFacts ?? {}).not.toHaveProperty(STRAY_ID);
    expect(observed.unobserved).not.toHaveProperty(STRAY_ID);
    const without = await read(withoutStray());
    expect(observed.resources).toEqual(without.observed.resources);
  });
});

describe("a member with no undeclared objects reads as today (#5429)", () => {
  it("no undeclared map, and the overlay is the graph of the read's resources alone", async () => {
    process.env[TERRAFORM_LIVE_LISTING_ENV] = "1";
    const docs = withoutStray();
    const { observed, ir } = await overlaid(docs);
    expect(observed.undeclared).toBeUndefined();
    const { entities } = await read(docs);
    const live = buildLiveGraphIr([{ lexicon: "terraform", resources: observed.resources }]);
    const canvas = withInstanceNodes(buildGraphIr(entities), entities);
    const before = sourceOverlayGraphs(canvas, live, { unobserved: observed.unobserved });
    expect(ir).toEqual({ ...before, nodes: carryEngineFacts(before.nodes, observed.engineFacts) });
    expect(ir.nodes.some((n) => n.attrs._status === "warn")).toBe(false);
  });
});
