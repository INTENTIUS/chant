/**
 * Engine facts from `choudoufu live-graph -json -from-plan=<file>` on a live
 * root (chant #4528, designed on #4520 section 4 and ruled there).
 *
 * Two documents are read here, neither produced by a run:
 *
 * - chant #4527's schema fixture,
 *   `packages/core/src/graph-schema/fixtures/choudoufu.engine-graph.json`,
 *   the shape choudoufu#2285's own tests decode against. It carries every
 *   fact field and two `grain: "block"` edges, one out of an instance under
 *   an expanded module call.
 * - `__fixtures__/live-module-keyed/live-graph.json`, written by hand for the
 *   #4513 fixture root to what choudoufu#2285 prints for it from the
 *   `live-plan.json` beside it, read on choudoufu
 *   `origin/integration/consolidation-graph` (3b40fc5683),
 *   internal/live/livegraph/: one node per block with its `sourceLoc`
 *   (`collect`); instance nodes for the literal `count = 2` call and the
 *   block's own `count = 2`, and for the `for_each = toset(...)` call only
 *   through the plan's rows, since a function call is not a literal
 *   (`literalKeys`, `nodeForAddr`); facts by `planFacts` (`marker` binds
 *   carry `markers.EscapeAddress`, a `derived` bind is `ownedBy: "name"`,
 *   ABSENT is `pending`, an unowned row with `tofu_estate` is `foreign`);
 *   no `observedAt`, because the plan document has no `observed_at`; no
 *   engine version, as on a dev build; continuation keys
 *   `tofu-address-2..4`; and no edges, because no block in that root reads
 *   another.
 *
 * Nothing here runs choudoufu: the activities are injected.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeObservation } from "@intentius/chant/observation";
import type { Declarable } from "@intentius/chant/declarable";
import { buildLiveGraphIr } from "@intentius/chant/graph-ir";
import { ENGINE_FACTS_FLOOR } from "@intentius/chant/engine-facts";
import { NEXT_RELEASE } from "@intentius/chant/release-floors";
import {
  describeResources,
  readEngineGraph,
  TERRAFORM_LIVE_PLAN_DIR_ENV,
  withEngineFacts,
  type TerraformReadDeps,
} from "./describe-resources";
import { renderTerraformRoots } from "./hcl/roots";
import {
  choudoufuLiveGraphCommand,
  classifyLiveGraphFailure,
  MIN_CHOUDOUFU_GRAPH_VERSION,
  MIN_CHOUDOUFU_VERSION,
  isOlderVersion,
} from "./op/activities/terraform";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(here, "..", "..", "..", "packages", "core", "src", "graph-schema");
const SCHEMA = JSON.parse(readFileSync(join(SCHEMA_DIR, "graph.schema.json"), "utf-8")) as { $id: string };
const CORE_FIXTURE: unknown = JSON.parse(readFileSync(join(SCHEMA_DIR, "fixtures", "choudoufu.engine-graph.json"), "utf-8"));
const FIXTURE = join(here, "__fixtures__", "live-module-keyed");
const ROOT_DIR = join(FIXTURE, "root");
const LIVE_PLAN: unknown = JSON.parse(readFileSync(join(FIXTURE, "live-plan.json"), "utf-8"));
const LIVE_GRAPH: unknown = JSON.parse(readFileSync(join(FIXTURE, "live-graph.json"), "utf-8"));
const ESTATE = "module-keyed-estate";

// Core's own ajv (v8, draft 2020-12), which the schema test uses; the copy at
// the workspace root is another major. Loaded through core's package so the
// two tests validate with the same build.
interface Validate {
  (doc: unknown): boolean;
  errors?: unknown;
}
interface Ajv {
  addSchema(schema: unknown): void;
  getSchema(ref: string): Validate | undefined;
}
const Ajv2020 = (createRequire(join(SCHEMA_DIR, "..", "..", "package.json"))("ajv/dist/2020") as { default: new (opts: object) => Ajv }).default;
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(SCHEMA);
const validEngineGraph = ajv.getSchema(`${SCHEMA.$id}#/$defs/EngineGraphDocument`)!;

type Entities = Map<string, { entityType: string; props: Record<string, unknown> }>;

async function render(): Promise<Entities> {
  const { entities: declarables } = await renderTerraformRoots({
    projectRoot: FIXTURE,
    roots: { estate: { dir: "./root" } },
    binary: "choudoufu",
  });
  const entities: Entities = new Map();
  for (const [key, entity] of declarables) {
    entities.set(key, { entityType: entity.entityType, props: (entity as Declarable & { props: Record<string, unknown> }).props });
  }
  return entities;
}

function options(entities: Entities) {
  return { environment: "prod", buildOutput: "", entityNames: [...entities.keys()].sort(), entities };
}

const never = ((args: { root: string }) => {
  throw new Error(`unexpected activity for root "${args.root}"`);
}) as never;

type LiveGraph = NonNullable<TerraformReadDeps["liveGraph"]>;
type LiveGraphCall = Parameters<LiveGraph>[0] & { document: unknown };

/** `live-plan -json` answers from the fixture; `live-graph` answers with `graph`, recording what it was handed. */
function deps(graph?: (call: LiveGraphCall) => Awaited<ReturnType<LiveGraph>>, calls: LiveGraphCall[] = []): TerraformReadDeps {
  return {
    init: never,
    show: never,
    liveLs: never,
    livePlan: (async () => ({ json: LIVE_PLAN, dir: ROOT_DIR, estate: ESTATE })) as unknown as TerraformReadDeps["livePlan"],
    ...(graph
      ? {
          liveGraph: (async (args: Parameters<LiveGraph>[0]) => {
            // The file is read while it exists: a scratch copy is removed after the call.
            const call = { ...args, document: JSON.parse(readFileSync(args.fromPlan, "utf-8")) as unknown };
            calls.push(call);
            return graph(call);
          }) as LiveGraph,
        }
      : {}),
  };
}

const answers = (json: unknown) => () => ({ supported: true as const, json, dir: ROOT_DIR });

const saved = process.env[TERRAFORM_LIVE_PLAN_DIR_ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[TERRAFORM_LIVE_PLAN_DIR_ENV];
  else process.env[TERRAFORM_LIVE_PLAN_DIR_ENV] = saved;
});

describe("the engine graph documents (#4528)", () => {
  it("both validate against chant #4527's schema", () => {
    expect(validEngineGraph(CORE_FIXTURE), JSON.stringify(validEngineGraph.errors)).toBe(true);
    expect(validEngineGraph(LIVE_GRAPH), JSON.stringify(validEngineGraph.errors)).toBe(true);
  });
});

describe("readEngineGraph over #4527's schema fixture", () => {
  const read = readEngineGraph("web", CORE_FIXTURE);

  it("puts each block node's facts on its entity key", () => {
    expect([...read.blocks.keys()].sort()).toEqual(["web/aws_s3_bucket.logs", "web/aws_sns_topic.alerts", "web/aws_sqs_queue.jobs"]);
    expect(read.blocks.get("web/aws_s3_bucket.logs")).toEqual({
      ownership: "bound",
      ownedBy: "record",
      cloudIds: [
        { kind: "import-id", value: "web-logs" },
        { kind: "arn", value: "arn:aws:s3:::web-logs" },
      ],
      recordVersions: {
        kept: true,
        versions: [
          { id: "3sL4kqtJlcpXroDTDmJ.rmSpXd3dIbrHY", writtenAt: "2026-10-26T11:58:02Z", current: true, deleted: false },
          { id: "2bE8x0l1BqzDmoPTmD7M7bGqFrsTFTQS", writtenAt: "2026-10-20T09:14:40Z", current: false, deleted: false },
        ],
      },
      observedAt: "2026-10-26T12:00:00Z",
    });
    expect(read.blocks.get("web/aws_sqs_queue.jobs")).toEqual({
      ownership: "foreign",
      markers: { owner: "billing", encoding: "escaped", source: "live" },
      observedAt: "2026-10-26T12:00:00Z",
    });
    expect(read.blocks.get("web/aws_sns_topic.alerts")).toEqual({ ownership: "pending", observedAt: "2026-10-26T12:00:00Z" });
  });

  it("puts an instance node's facts under its block's entity key, by instance address", () => {
    expect([...read.instances.keys()]).toEqual(["web/module.app/aws_eip.pool"]);
    expect(read.instances.get("web/module.app/aws_eip.pool")!.get("module.app[0].aws_eip.pool[1]")).toEqual({
      ownership: "bound",
      ownedBy: "marker",
      markers: { owner: "web", address: "module.app:0.aws_eip.pool:1", encoding: "escaped", source: "live" },
      cloudIds: [{ kind: "import-id", value: "eipalloc-0abc" }],
      observedAt: "2026-10-26T12:00:00Z",
    });
  });

  it("maps block edges to live graph ids and keeps their grain", () => {
    expect(read.edges).toEqual([
      { from: "web/module.app[0]/aws_eip.pool[1]", to: "web/module.app/aws_instance.web", kind: "ref", viaAttr: "dependencies", grain: "block" },
      { from: "web/module.app/aws_instance.web", to: "web/aws_s3_bucket.logs", kind: "ref", viaAttr: "dependencies", grain: "block" },
    ]);
  });

  it("refuses a document that is not an engine graph", () => {
    expect(() => readEngineGraph("web", { version: 1, nodes: [], edges: [] })).toThrow(/not an engine graph document/);
    expect(() => readEngineGraph("web", "nope")).toThrow(/not an engine graph document/);
  });

  it("carries the facts and edges onto the live graph", () => {
    const resources = withEngineFacts(
      {
        "web/aws_s3_bucket.logs": { type: "Terraform::Resource", status: "bound", physicalId: "web-logs", ownership: "owned" },
        "web/module.app/aws_instance.web": { type: "Terraform::Resource", status: "bound", ownership: "owned" },
        "web/module.app/aws_eip.pool": {
          type: "Terraform::Resource",
          status: "bound",
          ownership: "owned",
          instances: [
            { key: "[1]", scope: "module.app[0]", address: "module.app[0].aws_eip.pool[1]", verdict: "present", ownership: "owned", physicalId: "eipalloc-0abc" },
          ],
        },
      },
      read,
    );
    const ir = buildLiveGraphIr([{ lexicon: "terraform", resources, edges: read.edges }]);
    const node = (id: string) => ir.nodes.find((n) => n.id === id);
    expect(node("web/aws_s3_bucket.logs")!.facts!.ownedBy).toBe("record");
    expect(node("web/module.app[0]/aws_eip.pool[1]")!.facts!.markers!.source).toBe("live");
    // The block node of an expanded block has no facts of its own; its instance does.
    expect(node("web/module.app/aws_eip.pool")!.facts).toBeUndefined();
    // Both endpoints of each were observed, so buildLiveGraphIr keeps both (its sort is localeCompare's).
    expect(ir.edges.map((e) => `${e.from} -> ${e.to} (${e.grain})`).sort()).toEqual([
      "web/module.app/aws_instance.web -> web/aws_s3_bucket.logs (block)",
      "web/module.app[0]/aws_eip.pool[1] -> web/module.app/aws_instance.web (block)",
    ]);
    // ownership keeps its own meaning beside the facts.
    expect(node("web/aws_s3_bucket.logs")!.ownership).toBe("owned");
  });
});

describe("describeResources reads live-graph after live-plan on the module-keyed root (#4528, #4513)", () => {
  it("hands live-graph the same live-plan document, in a scratch file when no directory was asked for", async () => {
    delete process.env[TERRAFORM_LIVE_PLAN_DIR_ENV];
    const calls: LiveGraphCall[] = [];
    await describeResources(options(await render()), deps(answers(LIVE_GRAPH), calls));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ root: "estate", estate: ESTATE });
    expect(calls[0]!.document).toEqual(LIVE_PLAN);
    expect(calls[0]!.fromPlan.startsWith(tmpdir())).toBe(true);
    expect(calls[0]!.fromPlan.endsWith("estate.live-plan.json")).toBe(true);
  });

  it("hands it the <root>.live-plan.json under CHANT_TERRAFORM_LIVE_PLAN_DIR when that is set", async () => {
    const out = mkdtempSync(join(tmpdir(), "chant-4528-plan-dir-"));
    try {
      process.env[TERRAFORM_LIVE_PLAN_DIR_ENV] = out;
      const calls: LiveGraphCall[] = [];
      await describeResources(options(await render()), deps(answers(LIVE_GRAPH), calls));
      expect(calls.map((c) => c.fromPlan)).toEqual([join(out, "estate.live-plan.json")]);
      expect(calls[0]!.document).toEqual(LIVE_PLAN);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("sets each module-keyed instance's facts, by marker, by name, pending, unowned and foreign", async () => {
    const { resources } = normalizeObservation(await describeResources(options(await render()), deps(answers(LIVE_GRAPH))));
    const pool = resources["estate/module.app/aws_eip.pool"]!;
    expect(pool.facts).toBeUndefined();
    expect(pool.instances!.map((i) => [i.address, i.facts?.ownership, i.facts?.ownedBy, i.facts?.markers?.address, i.facts?.cloudIds?.[0]?.value])).toEqual([
      ["module.app[0].aws_eip.pool[0]", "bound", "marker", "module.app:0.aws_eip.pool:0", "eipalloc-0a41c7d2e9b3f5061"],
      ["module.app[0].aws_eip.pool[1]", "bound", "marker", "module.app:0.aws_eip.pool:1", "eipalloc-0b52d8e3fac4061f2"],
      ["module.app[1].aws_eip.pool[0]", "bound", "marker", "module.app:1.aws_eip.pool:0", "eipalloc-0c63e9f40bd5172a3"],
      ["module.app[1].aws_eip.pool[1]", "bound", "marker", "module.app:1.aws_eip.pool:1", "eipalloc-0d74fa051ce6283b4"],
    ]);
    expect(pool.instances![0]!.facts!.markers).toEqual({ owner: ESTATE, address: "module.app:0.aws_eip.pool:0", encoding: "escaped", source: "live" });

    const logs = resources["estate/module.app/aws_cloudwatch_log_group.logs"]!;
    expect(logs.instances!.map((i) => [i.address, i.verdict, i.facts])).toEqual([
      ["module.app[0].aws_cloudwatch_log_group.logs", "present", { ownership: "bound", ownedBy: "name", cloudIds: [{ kind: "import-id", value: `/${ESTATE}/app-0` }] }],
      ["module.app[1].aws_cloudwatch_log_group.logs", "absent", { ownership: "pending" }],
    ]);

    const front = resources["estate/module.edge/aws_cloudwatch_log_group.front"]!;
    expect(front.instances!.map((i) => i.facts)).toEqual([
      { ownership: "unowned", cloudIds: [{ kind: "import-id", value: `/${ESTATE}/edge-east` }] },
      { ownership: "foreign", markers: { owner: "other-estate", encoding: "escaped", source: "live" }, cloudIds: [{ kind: "import-id", value: `/${ESTATE}/edge-west` }] },
    ]);

    // The verdicts are the live-plan read's, unchanged.
    expect(pool).toMatchObject({ status: "bound", ownership: "owned", marker: { stack: ESTATE } });
    expect(front).toMatchObject({ status: "unowned", ownership: "foreign" });
  });

  it("draws the facts on the instance nodes the declared graph lists", async () => {
    const { resources } = normalizeObservation(await describeResources(options(await render()), deps(answers(LIVE_GRAPH))));
    const ir = buildLiveGraphIr([{ lexicon: "terraform", resources }]);
    const facts = new Map(ir.nodes.filter((n) => n.facts).map((n) => [n.id, n.facts!.ownership]));
    expect(Object.fromEntries(facts)).toEqual({
      "estate/module.app[0]/aws_cloudwatch_log_group.logs": "bound",
      "estate/module.app[0]/aws_eip.pool[0]": "bound",
      "estate/module.app[0]/aws_eip.pool[1]": "bound",
      "estate/module.app[1]/aws_eip.pool[0]": "bound",
      "estate/module.app[1]/aws_eip.pool[1]": "bound",
      'estate/module.edge["east"]/aws_cloudwatch_log_group.front': "unowned",
      'estate/module.edge["west"]/aws_cloudwatch_log_group.front': "foreign",
    });
  });

  it("puts a block edge on the observation's edges, mapped to the live graph's ids", async () => {
    // live-graph prints no edge for this root, since no block reads another.
    // This one is added by the test, out of an instance under the expanded
    // call into a block, the shape #4527's fixture carries.
    const doc = structuredClone(LIVE_GRAPH) as { edges: unknown[] };
    doc.edges.push({
      from: "module.app[0].aws_eip.pool[1]",
      to: "module.app.aws_cloudwatch_log_group.logs",
      kind: "ref",
      viaAttr: "depends_on",
      grain: "block",
    });
    const raw = await describeResources(options(await render()), deps(answers(doc)));
    const observed = normalizeObservation(raw);
    expect(observed.edges).toEqual([
      { from: "estate/module.app[0]/aws_eip.pool[1]", to: "estate/module.app/aws_cloudwatch_log_group.logs", kind: "ref", viaAttr: "depends_on", grain: "block" },
    ]);
    const ir = buildLiveGraphIr([{ lexicon: "terraform", resources: observed.resources, edges: observed.edges }]);
    expect(ir.edges).toEqual(observed.edges);
  });

  it("with no edges in the document, the observation carries none", async () => {
    const observed = normalizeObservation(await describeResources(options(await render()), deps(answers(LIVE_GRAPH))));
    expect(observed.edges).toBeUndefined();
    expect(observed.notes.some((n) => n.includes("live-graph"))).toBe(false);
  });
});

describe("an older choudoufu: no facts, one note, the rest unchanged (#4528)", () => {
  async function baseline() {
    return normalizeObservation(await describeResources(options(await render()), deps()));
  }

  function noFacts(resources: Record<string, { facts?: unknown; instances?: Array<{ facts?: unknown }> }>): boolean {
    return Object.values(resources).every((r) => r.facts === undefined && (r.instances ?? []).every((i) => i.facts === undefined));
  }

  it("a usage error leaves facts absent and adds exactly one note naming the floor", async () => {
    const before = await baseline();
    const after = normalizeObservation(
      await describeResources(
        options(await render()),
        deps(() => ({ supported: false, detail: 'OpenTofu has no command named "live-graph".', dir: ROOT_DIR })),
      ),
    );
    expect(noFacts(after.resources)).toBe(true);
    expect(after.resources).toEqual(before.resources);
    expect(after.unobserved).toEqual(before.unobserved);
    expect(after.queried).toEqual(before.queried);
    expect(after.sources).toEqual(before.sources);
    expect(after.edges).toBeUndefined();
    const added = after.notes.filter((n) => !before.notes.includes(n));
    expect(added).toHaveLength(1);
    expect(added[0]).toContain("terraform.roots.estate: engine facts are absent");
    expect(added[0]).toContain('OpenTofu has no command named "live-graph".');
    expect(added[0]).toContain(`v${MIN_CHOUDOUFU_GRAPH_VERSION}`);
  });

  it("any other live-graph failure degrades the same way, with its own note", async () => {
    const before = await baseline();
    const after = normalizeObservation(
      await describeResources(
        options(await render()),
        deps(() => {
          throw new Error("choudoufu live-graph failed in /x (exit 1)\nThe live plan is of another estate");
        }),
      ),
    );
    expect(after.resources).toEqual(before.resources);
    const added = after.notes.filter((n) => !before.notes.includes(n));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/engine facts are absent: `choudoufu live-graph -json -from-plan` failed \(choudoufu live-graph failed in \/x \(exit 1\)\)/);
  });

  it("a live-plan that failed runs no live-graph at all", async () => {
    const calls: LiveGraphCall[] = [];
    const failing: TerraformReadDeps = {
      ...deps(answers(LIVE_GRAPH), calls),
      livePlan: (async () => {
        throw new Error("choudoufu live-plan failed (exit 1)");
      }) as unknown as TerraformReadDeps["livePlan"],
    };
    const observed = normalizeObservation(await describeResources(options(await render()), failing));
    expect(calls).toEqual([]);
    expect(Object.keys(observed.unobserved).length).toBeGreaterThan(0);
  });

  it("classifies the usage errors older builds print", () => {
    expect(classifyLiveGraphFailure(1, 'OpenTofu has no command named "live-graph".\n\nTo see all of OpenTofu\'s top-level commands, run:\n  choudoufu -help\n')).toBe("unsupported");
    expect(classifyLiveGraphFailure(127, "Usage: choudoufu [global options] <subcommand> [args]")).toBe("unsupported");
    expect(classifyLiveGraphFailure(1, "flag provided but not defined: -from-plan")).toBe("unsupported");
    expect(classifyLiveGraphFailure(1, "Error: The live plan is of another estate")).toBe("failed");
    expect(classifyLiveGraphFailure(1, "Error: Cannot read the live plan")).toBe("failed");
  });

  it("builds the command with no DIR and no -history", () => {
    expect(choudoufuLiveGraphCommand({ binary: "choudoufu", fromPlan: "/tmp/out/estate.live-plan.json" })).toBe(
      "choudoufu live-graph -json -from-plan=/tmp/out/estate.live-plan.json",
    );
    expect(choudoufuLiveGraphCommand({ binary: "choudoufu", fromPlan: "/tmp/a b/x.json", estate: "web" })).toBe(
      "choudoufu live-graph -json -from-plan='/tmp/a b/x.json' -estate=web",
    );
  });
});

describe("the floors (#4528)", () => {
  it("the choudoufu floor is the release that ships live-graph, above the read floor", () => {
    expect(MIN_CHOUDOUFU_GRAPH_VERSION).toBe("0.32.0");
    expect(isOlderVersion(MIN_CHOUDOUFU_VERSION, MIN_CHOUDOUFU_GRAPH_VERSION)).toBe(true);
  });

  it("the chant floor for writing facts is the next release", () => {
    expect(ENGINE_FACTS_FLOOR).toBe(NEXT_RELEASE);
  });
});
