/**
 * Module-keyed addresses through describe-resources.ts, from documents
 * (chant #4513).
 *
 * #4488 gave live instances under an expanded module call a `scope`, and its
 * core test (packages/core/src/graph-ir-live.test.ts) feeds that metadata in
 * by hand. This file reads it out of a live-plan document and a state
 * document whose every address is module-keyed (`module.app[0].aws_eip.pool[1]`,
 * `module.edge["east"]...`), then checks that the live graph's instance ids
 * are the ones the declared graph lists.
 *
 * The declared side is real: `src/__fixtures__/live-module-keyed/root/`,
 * rendered as `buildRoots()` renders it, with an `estate.chdf.hcl` sidecar
 * that makes the root live under `binary: "choudoufu"`.
 *
 * The two documents were built by hand. No binary was run, so these are not
 * recordings like `live-plan-depth/`. Where each part comes from, all read
 * on choudoufu `origin/integration/consolidation-graph` (b47315e7c):
 *
 * - `live-plan.json`'s keys and their order: `LivePlanDocument`,
 *   `LivePlanBound`, `LiveOmission` and `LiveUnowned` in
 *   internal/command/views/live_plan.go. The addresses are
 *   `addrs.AbsResourceInstance.String()`, which `liveBoundReport`,
 *   `liveOmissions` and `liveUnownedReport` in internal/command/live_plan.go
 *   write as `addr`.
 * - `source`: `derived` for the log group, whose name is its identity;
 *   `marker` for the EIPs, whose allocation id EC2 assigns
 *   (`liveBoundReport`'s switch, the same split as the recorded
 *   `live-plan-depth/live-plan.json`).
 * - `adopt_tofu_address`: `markers.EscapeAddress`
 *   (internal/live/markers/markers.go) and the escaping table in
 *   live/MARKERS.md, `module.subnets["a"].aws_subnet.this` ->
 *   `module.subnets:a.aws_subnet.this`.
 * - The omission `detail` strings: the ABSENT template in
 *   internal/live/projection/build.go, the no-marker UNOWNED template and
 *   `anotherEstateDetail` in internal/live/projection/ownership.go. The
 *   paired "Live resource outside this estate" diagnostics, and
 *   `upstream_version`, follow the recorded v0.30.0 document in
 *   `live-plan-depth/`. `choudoufu_version` is empty, which the struct
 *   documents as a development build, because no release produced this
 *   document.
 * - That a module call's count or for_each reaches a child's identity
 *   through a variable: `TestModuleCallCountVar` and `TestModuleCallForEachVar`
 *   in internal/live/identity/moduleforeachvar_test.go.
 * - `show-state.json`: `jsonstate.Module` and `jsonstate.Resource` in
 *   internal/command/jsonstate/state.go. A child module's `address` is
 *   `addrs.ModuleInstance.String()` (`module.app[0]`, `marshalModules`), and
 *   a resource's address carries the module prefix, as the recorded
 *   `src/__fixtures__/show-state.json` does for an unkeyed call.
 * - The EIP allocation ids and the account id in the ARNs are made up.
 *
 * Nothing here runs choudoufu or tofu: the activities are injected.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeObservation } from "@intentius/chant/observation";
import type { Declarable } from "@intentius/chant/declarable";
import { buildGraphIr, buildLiveGraphIr, overlayGraphs, withInstanceNodes } from "@intentius/chant/graph-ir";
import { describeResources, indexLivePlan, indexStateResources, type TerraformReadDeps } from "./describe-resources";
import { renderTerraformRoots } from "./hcl/roots";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const FIXTURE = join(fixtures, "live-module-keyed");
const ROOT_DIR = join(FIXTURE, "root");
const LIVE_PLAN: unknown = JSON.parse(readFileSync(join(FIXTURE, "live-plan.json"), "utf-8"));
const STATE: unknown = JSON.parse(readFileSync(join(FIXTURE, "show-state.json"), "utf-8"));
const ESTATE = "module-keyed-estate";

type Entities = Map<string, { entityType: string; props: Record<string, unknown> }>;

/** The fixture root rendered under `binary`: `"choudoufu"` makes it live, `"tofu"` stock. */
async function render(binary: "choudoufu" | "tofu"): Promise<{ declarables: Map<string, Declarable>; entities: Entities }> {
  const { entities: declarables } = await renderTerraformRoots({
    projectRoot: FIXTURE,
    roots: { estate: { dir: "./root" } },
    binary,
  });
  const entities: Entities = new Map();
  for (const [key, entity] of declarables) {
    entities.set(key, { entityType: entity.entityType, props: (entity as Declarable & { props: Record<string, unknown> }).props });
  }
  return { declarables, entities };
}

function options(entities: Entities) {
  return { environment: "prod", buildOutput: "", entityNames: [...entities.keys()].sort(), entities };
}

const never = ((args: { root: string }) => {
  throw new Error(`unexpected activity for root "${args.root}"`);
}) as never;

/** The live root's activities: `live-plan -json` answers, nothing else may run. */
function liveDeps(): TerraformReadDeps {
  return {
    init: never,
    show: never,
    liveLs: never,
    livePlan: (async () => ({ json: LIVE_PLAN, dir: ROOT_DIR, estate: ESTATE })) as unknown as TerraformReadDeps["livePlan"],
  };
}

/** The stock root's activities: `init`, then `show -json` over the state document. */
function stateDeps(): TerraformReadDeps {
  return {
    init: (async () => ({ dir: ROOT_DIR })) as TerraformReadDeps["init"],
    show: (async () => ({ source: "state" as const, json: STATE, text: "", dir: ROOT_DIR, adds: 0, changes: 0, destroys: 0 })) as TerraformReadDeps["show"],
    livePlan: never,
    liveLs: never,
  };
}

const POOL = [
  "module.app[0].aws_eip.pool[0]",
  "module.app[0].aws_eip.pool[1]",
  "module.app[1].aws_eip.pool[0]",
  "module.app[1].aws_eip.pool[1]",
];
const EAST = 'module.edge["east"].aws_cloudwatch_log_group.front';
const WEST = 'module.edge["west"].aws_cloudwatch_log_group.front';

describe("the module-keyed fixture root (#4513)", () => {
  it("declares each block once, under its unkeyed module call, and live", async () => {
    const { entities } = await render("choudoufu");
    for (const key of [
      "estate/module.app",
      "estate/module.edge",
      "estate/module.app/aws_eip.pool",
      "estate/module.app/aws_cloudwatch_log_group.logs",
      "estate/module.edge/aws_cloudwatch_log_group.front",
    ]) {
      expect(entities.has(key), key).toBe(true);
      expect(entities.get(key)!.props.mode, key).toBe("live");
      expect(entities.get(key)!.props.estate, key).toBe(ESTATE);
    }
    expect([...entities.keys()].some((k) => k.includes("["))).toBe(false);
  });

  it("indexes the live-plan document by module-keyed instance address", () => {
    const index = indexLivePlan(LIVE_PLAN);
    expect(index.estate).toBe(ESTATE);
    expect([...index.bound.keys()].sort()).toEqual(["module.app[0].aws_cloudwatch_log_group.logs", ...POOL]);
    expect(index.omissions.get("module.app[1].aws_cloudwatch_log_group.logs")!.reason).toBe("ABSENT");
    expect(index.unowned.get(EAST)).toMatchObject({ adoptEstate: ESTATE, adoptAddress: "module.edge:east.aws_cloudwatch_log_group.front" });
    expect(index.unowned.get(WEST)).toMatchObject({ heldBy: "other-estate" });
  });

  it("indexes the state document's keyed child modules and their rows", () => {
    const index = indexStateResources(STATE);
    expect([...index.modules].sort()).toEqual(["module.app[0]", "module.app[1]", 'module.edge["east"]', 'module.edge["west"]']);
    expect(index.rows.get("module.app[1].aws_eip.pool[0]")).toMatchObject({ type: "aws_eip", id: "eipalloc-0c63e9f40bd5172a3" });
    // The module prefix is already on each row, so none gets a second one.
    expect([...index.rows.keys()].filter((k) => k.startsWith("module.app[0].module.app"))).toEqual([]);
  });
});

describe("describeResources over a module-keyed live-plan document (#4513)", () => {
  it("rolls a block expanded under an expanded call up to owned, with key and scope per instance", async () => {
    const { entities } = await render("choudoufu");
    const { resources, queried } = normalizeObservation(await describeResources(options(entities), liveDeps()));
    const pool = resources["estate/module.app/aws_eip.pool"]!;
    expect(queried["estate/module.app/aws_eip.pool"]).toBe(
      `choudoufu live-plan -json (root "estate", estate "${ESTATE}", address "module.app.aws_eip.pool")`,
    );
    expect(pool).toMatchObject({
      type: "Terraform::Resource",
      status: "bound",
      ownership: "owned",
      physicalId: "module.app.aws_eip.pool",
      marker: { stack: ESTATE },
    });
    expect(pool.attributes).toMatchObject({ address: "module.app.aws_eip.pool", root: "estate", estate: ESTATE, boundBy: "marker", resourceType: "aws_eip" });
    expect(pool.attributes!.instances).toEqual(POOL);
    expect(pool.instances).toEqual([
      { key: "[0]", scope: "module.app[0]", address: POOL[0], verdict: "present", ownership: "owned", status: "bound", physicalId: "eipalloc-0a41c7d2e9b3f5061" },
      { key: "[1]", scope: "module.app[0]", address: POOL[1], verdict: "present", ownership: "owned", status: "bound", physicalId: "eipalloc-0b52d8e3fac4061f2" },
      { key: "[0]", scope: "module.app[1]", address: POOL[2], verdict: "present", ownership: "owned", status: "bound", physicalId: "eipalloc-0c63e9f40bd5172a3" },
      { key: "[1]", scope: "module.app[1]", address: POOL[3], verdict: "present", ownership: "owned", status: "bound", physicalId: "eipalloc-0d74fa051ce6283b4" },
    ]);
  });

  it("gives a block only the call expands a scope and no key, and keeps an absent instance", async () => {
    const { entities } = await render("choudoufu");
    const { resources } = normalizeObservation(await describeResources(options(entities), liveDeps()));
    const logs = resources["estate/module.app/aws_cloudwatch_log_group.logs"]!;
    // One instance bound by derivation, the other ABSENT: owned, with the one
    // bound identity, and no marker, because a derived bind read no tag.
    expect(logs).toMatchObject({ status: "bound", ownership: "owned", physicalId: `/${ESTATE}/app-0` });
    expect(logs.marker).toBeUndefined();
    expect(logs.attributes).toMatchObject({ boundBy: "derived" });
    expect(logs.instances).toEqual([
      {
        scope: "module.app[0]",
        address: "module.app[0].aws_cloudwatch_log_group.logs",
        verdict: "present",
        ownership: "owned",
        status: "bound",
        physicalId: `/${ESTATE}/app-0`,
      },
      { scope: "module.app[1]", address: "module.app[1].aws_cloudwatch_log_group.logs", verdict: "absent" },
    ]);
  });

  it("reads a for_each call's string keys, foreign over adoptable", async () => {
    const { entities } = await render("choudoufu");
    const { resources } = normalizeObservation(await describeResources(options(entities), liveDeps()));
    const front = resources["estate/module.edge/aws_cloudwatch_log_group.front"]!;
    expect(front).toMatchObject({ status: "unowned", ownership: "foreign", physicalId: `/${ESTATE}/edge-west` });
    expect(front.attributes).toMatchObject({ heldBy: "other-estate", instances: [EAST, WEST] });
    expect(front.instances).toEqual([
      { scope: 'module.edge["east"]', address: EAST, verdict: "present", ownership: "unknown", status: "adoptable", physicalId: `/${ESTATE}/edge-east` },
      { scope: 'module.edge["west"]', address: WEST, verdict: "present", ownership: "foreign", status: "unowned", physicalId: `/${ESTATE}/edge-west` },
    ]);
  });

  it("finds a keyed module call's members by its unkeyed address", async () => {
    const { entities } = await render("choudoufu");
    const { resources } = normalizeObservation(await describeResources(options(entities), liveDeps()));
    expect(resources["estate/module.app"]).toMatchObject({ type: "Terraform::Module", status: "module", ownership: "unknown" });
    expect(resources["estate/module.app"]!.attributes!.instances).toEqual([
      "module.app[0].aws_cloudwatch_log_group.logs",
      ...POOL.slice(0, 2),
      "module.app[1].aws_cloudwatch_log_group.logs",
      ...POOL.slice(2),
    ]);
    expect(resources["estate/module.edge"]!.attributes!.instances).toEqual([EAST, WEST]);
  });

  it("puts every live instance on a node the declared graph lists", async () => {
    const { declarables, entities } = await render("choudoufu");
    const { resources } = normalizeObservation(await describeResources(options(entities), liveDeps()));
    const live = buildLiveGraphIr([{ lexicon: "terraform", resources }]);
    const declared = withInstanceNodes(buildGraphIr(declarables), declarables);
    const declaredIds = new Set(declared.nodes.map((n) => n.id));

    const liveInstances = live.nodes.filter((n) => n.instanceOf).map((n) => n.id).sort();
    expect(liveInstances).toEqual([
      "estate/module.app[0]/aws_cloudwatch_log_group.logs",
      "estate/module.app[0]/aws_eip.pool[0]",
      "estate/module.app[0]/aws_eip.pool[1]",
      "estate/module.app[1]/aws_eip.pool[0]",
      "estate/module.app[1]/aws_eip.pool[1]",
      'estate/module.edge["east"]/aws_cloudwatch_log_group.front',
      'estate/module.edge["west"]/aws_cloudwatch_log_group.front',
    ]);
    for (const id of liveInstances) expect(declaredIds.has(id), id).toBe(true);

    // The absent instance draws no live node, so the overlay leaves the
    // declared one unmatched while its bound sibling matches.
    const status = new Map(overlayGraphs(live, declared).nodes.map((n) => [n.id, n.attrs._status]));
    expect(status.get("estate/module.app[0]/aws_cloudwatch_log_group.logs")).toBe("good");
    expect(status.get("estate/module.app[1]/aws_cloudwatch_log_group.logs")).toBe("accent");
  });
});

describe("describeResources over a module-keyed state document (#4513)", () => {
  it("reads each block's rows under keyed child modules as its instances", async () => {
    const { entities } = await render("tofu");
    const { resources, queried } = normalizeObservation(await describeResources(options(entities), stateDeps()));
    expect(queried["estate/module.app/aws_eip.pool"]).toBe('terraform show -json (root "estate", address "module.app.aws_eip.pool")');
    const pool = resources["estate/module.app/aws_eip.pool"]!;
    expect(pool).toMatchObject({ status: "managed", ownership: "owned", physicalId: "module.app.aws_eip.pool" });
    expect(pool.attributes!.instances).toEqual(POOL);
    expect(pool.instances!.map((i) => [i.key, i.scope, i.physicalId])).toEqual([
      ["[0]", "module.app[0]", "eipalloc-0a41c7d2e9b3f5061"],
      ["[1]", "module.app[0]", "eipalloc-0b52d8e3fac4061f2"],
      ["[0]", "module.app[1]", "eipalloc-0c63e9f40bd5172a3"],
      ["[1]", "module.app[1]", "eipalloc-0d74fa051ce6283b4"],
    ]);

    const front = resources["estate/module.edge/aws_cloudwatch_log_group.front"]!;
    expect(front.instances!.map((i) => [i.key, i.scope])).toEqual([
      [undefined, 'module.edge["east"]'],
      [undefined, 'module.edge["west"]'],
    ]);
  });

  it("reports a keyed module call present from its child_modules entries", async () => {
    // A keyed call's child_modules[] entries are `module.app[0]`, never
    // `module.app`, and neither its rows nor they start with `module.app.`,
    // so a prefix test on the unkeyed address read the call as absent.
    const { entities } = await render("tofu");
    const { resources } = normalizeObservation(await describeResources(options(entities), stateDeps()));
    expect(resources["estate/module.app"]).toMatchObject({ type: "Terraform::Module", status: "module", physicalId: "module.app" });
    expect(resources["estate/module.edge"]).toMatchObject({ type: "Terraform::Module", status: "module", physicalId: "module.edge" });
  });
});
