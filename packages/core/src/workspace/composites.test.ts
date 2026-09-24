/**
 * The read contract for `chant workspace graph --composites` (#2662): the
 * schema is a valid draft 2020-12 document whose closed code lists match the
 * code, and real output validates against it, for a built workspace whose
 * members answer through a fake chant, for failures, for `--at`, and for each
 * reason the list can be empty. The reference workspace runs a real chant
 * (`read-contract.test.ts`).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { GraphIR, IRNode } from "../graph-ir";
import { cleanScratch, commitAll, contract, declaration, FAKE_FILE_GRAPH_CHANT, repo, validSchema } from "./__fixtures__/contract-repo";
import { MEMBER_RUN_REASON_CODES } from "./compose-graph";
import {
  COMPOSITES_CONTRACT_VERSION,
  COMPOSITES_ERROR_CODES,
  COMPOSITES_OUTPUT_SCHEMA_ID,
  COMPOSITES_REASON_CODES,
  COMPOSITES_RUNTIME_REASON_CODES,
  compositeInstances,
  joinComponents,
  workspaceComposites,
  type ComponentEntry,
  type CompositesDocument,
} from "./composites";
import { GRAPH_ERROR_CODES } from "./graph-cli";
import schema from "./composites.schema.json";

afterAll(cleanScratch);

const { expectValid } = contract(schema);

type Result = Exclude<CompositesDocument, { error: unknown }>;

function result(doc: CompositesDocument): Result {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

const composite = (id: string, kind: string, instance: string, lexicon = "aws"): IRNode => ({ id, kind: "Resource", lexicon, attrs: {}, compositeParent: kind, compositeInstance: instance });

const ir = (nodes: IRNode[], extra: Partial<GraphIR> = {}): string => `${JSON.stringify({ version: 1, nodes, edges: [], groups: {}, ...extra })}\n`;

const componentIr = (components: { name: string; composites?: string[]; archetype?: string }[]): string =>
  ir(
    components.map((c) => ({
      id: c.name,
      kind: "Component",
      lexicon: "chant",
      attrs: { wave: 1, liveNames: [c.name], ...(c.composites ? { composites: c.composites } : {}), ...(c.archetype ? { archetype: c.archetype } : {}) },
      sourceLoc: { file: `src/${c.name}.component.ts` },
    })),
    { groups: { byWave: { "wave-1": components.map((c) => c.name) } } },
  );

/** The built-in runtime every component has. */
const local = (name: string) => ({ name: "local", lexicon: null, default: true, command: `chant run --components ${name}` });

/**
 * app declares three instances and exports ImageUri; delivery links to it and
 * declares two components; jobs declares an instance and a component of its
 * own; docs is kind other.
 */
function fixture(): string {
  return repo({
    "chant.workspace.json": declaration([
      { name: "app", dir: "app", kind: "chant" },
      { name: "delivery", dir: "delivery", kind: "chant", links: [{ member: "app", output: "ImageUri" }] },
      { name: "jobs", dir: "jobs", kind: "chant" },
      { name: "docs", dir: "docs", kind: "other", because: "prose" },
    ]),
    "app/chant.config.ts": "export default {};\n",
    "app/ir.json": ir(
      [
        composite("backendRepo", "LoomBackend", "backend"),
        composite("backendService", "LoomBackend", "backend"),
        composite("siteBucket", "StaticSite", "site"),
        composite("cacheCluster", "CacheCluster", "cache"),
        { id: "Loose", kind: "Queue", lexicon: "aws", attrs: {} },
      ],
      { exports: [{ name: "ImageUri", node: "backendRepo", attr: "Uri" }] },
    ),
    "delivery/chant.config.ts": "export default {};\n",
    "delivery/ir.json": ir([]),
    "delivery/components.json": componentIr([
      { name: "loom-backend", archetype: "service" },
      { name: "edge", composites: ["StaticSite"], archetype: "infra" },
    ]),
    "jobs/chant.config.ts": "export default {};\n",
    "jobs/ir.json": ir([composite("queueTopic", "WorkQueue", "queue")]),
    "jobs/components.json": componentIr([{ name: "queue-runner", composites: ["WorkQueue", "CacheCluster"] }]),
    "docs/README.md": "",
    ".gitignore": "node_modules\n",
    "node_modules/.bin/chant": { text: FAKE_FILE_GRAPH_CHANT, mode: 0o755 },
  });
}

describe("composites output schema", () => {
  test("is a valid draft 2020-12 document with the published $id", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(validSchema(schema)).toBe(true);
    expect(schema.$id).toBe(COMPOSITES_OUTPUT_SCHEMA_ID);
    expect(COMPOSITES_CONTRACT_VERSION).toBe(1);
  });

  test("lists exactly the reason and error codes the code can return", () => {
    expect(schema.$defs.reason.properties.code.enum).toEqual([...COMPOSITES_REASON_CODES]);
    expect(schema.$defs.failure.properties.error.properties.code.enum).toEqual([...COMPOSITES_ERROR_CODES]);
    expect(COMPOSITES_ERROR_CODES).toEqual(GRAPH_ERROR_CODES);
    expect(schema.$defs.member.properties.reason.oneOf[1].properties!.code.enum).toEqual([...MEMBER_RUN_REASON_CODES]);
    expect(schema.$defs.member.properties.runtimeReasons.items.properties.code.enum).toEqual([...COMPOSITES_RUNTIME_REASON_CODES]);
  });
});

describe("the join", () => {
  const instances = compositeInstances({
    nodes: [
      { ...composite("a/xBucket", "LoomBackend", "a/x"), member: "a" },
      { ...composite("a/xRole", "OperatorRole", "a/x", "gcp"), member: "a" },
      { ...composite("a/billingTable", "Table", "a/billing"), member: "a" },
    ],
  });
  const component = (member: string, name: string, composites: string[] | null = null): ComponentEntry => ({ id: `${member}/${name}`, name, member, archetype: null, composites, file: null, runtimes: [] });

  test("an instance carries every kind and lexicon of its nodes", () => {
    expect(instances.map((i) => [i.id, i.instance, i.kinds, i.lexicons])).toEqual([
      ["a/billing", "billing", ["Table"], ["aws"]],
      ["a/x", "x", ["LoomBackend", "OperatorRole"], ["aws", "gcp"]],
    ]);
  });

  test("declared composites match exactly, and stop name matching for that component", () => {
    const rows = joinComponents(instances, [component("a", "loom-backend", ["Table"]), component("a", "other", ["LoomBackend"])], []);
    expect(rows.find((r) => r.id === "a/x")!.components).toEqual([{ component: "a/other", by: "composites", against: "kind", value: "LoomBackend", label: "exact", via: "member" }]);
    expect(rows.find((r) => r.id === "a/billing")!.components.map((m) => m.component)).toEqual(["a/loom-backend"]);
  });

  test("a component with no composites matches a kind by joinKey, then the instance's name", () => {
    const rows = joinComponents(instances, [component("a", "loom-backend"), component("a", "Billing"), component("a", "nothing")], []);
    expect(rows.find((r) => r.id === "a/x")!.components).toEqual([{ component: "a/loom-backend", by: "name", against: "kind", value: "LoomBackend", label: "folded", via: "member" }]);
    expect(rows.find((r) => r.id === "a/billing")!.components).toEqual([{ component: "a/Billing", by: "name", against: "instance", value: "billing", label: "folded", via: "member" }]);
  });

  test("across members, a resolved link from the component's member makes it via link", () => {
    const link = (status: "resolved" | "missing") => ({ consumer: "b", producer: "a", output: "O", kind: "output", origin: "declared" as const, label: "exact" as const, input: null, resolves: "source" as const, status, reason: null });
    const c = [component("b", "table-deployer", ["Table"])];
    expect(joinComponents(instances, c, [link("resolved")]).find((r) => r.id === "a/billing")!.components[0].via).toBe("link");
    expect(joinComponents(instances, c, [link("missing")]).find((r) => r.id === "a/billing")!.components[0].via).toBe("unlinked");
    expect(joinComponents(instances, c, []).find((r) => r.id === "a/x")!.components).toEqual([]);
  });
});

describe("chant workspace graph --composites on a built workspace", () => {
  test("lists each instance with the components that can deploy it, and an empty set for the gap", async () => {
    const { doc, failed } = await workspaceComposites({ cwd: fixture() });
    const g = result(doc);
    expectValid(g);
    expect(failed).toBe(false);
    expect(g.members.map((m) => [m.name, m.status, m.reason?.code ?? null])).toEqual([
      ["app", "read", null],
      ["delivery", "read", null],
      ["jobs", "read", null],
      ["docs", "skipped", "kind-not-run"],
    ]);
    expect(g.components).toEqual([
      { id: "delivery/edge", name: "edge", member: "delivery", archetype: "infra", composites: ["StaticSite"], file: "delivery/src/edge.component.ts", runtimes: [local("edge")] },
      { id: "delivery/loom-backend", name: "loom-backend", member: "delivery", archetype: "service", composites: null, file: "delivery/src/loom-backend.component.ts", runtimes: [local("loom-backend")] },
      { id: "jobs/queue-runner", name: "queue-runner", member: "jobs", archetype: null, composites: ["WorkQueue", "CacheCluster"], file: "jobs/src/queue-runner.component.ts", runtimes: [local("queue-runner")] },
    ]);
    const rows = Object.fromEntries(g.composites.map((c) => [c.id, c]));
    expect(Object.keys(rows)).toEqual(["app/backend", "app/cache", "app/site", "jobs/queue"]);
    expect(rows["app/backend"]).toMatchObject({ member: "app", instance: "backend", kinds: ["LoomBackend"], lexicons: ["aws"], nodes: ["app/backendRepo", "app/backendService"] });
    expect(rows["app/backend"].components).toEqual([{ component: "delivery/loom-backend", by: "name", against: "kind", value: "LoomBackend", label: "folded", via: "link" }]);
    expect(rows["app/site"].components).toEqual([{ component: "delivery/edge", by: "composites", against: "kind", value: "StaticSite", label: "exact", via: "link" }]);
    // jobs does not link to app: the match is data, marked as crossing no link.
    expect(rows["app/cache"].components).toEqual([{ component: "jobs/queue-runner", by: "composites", against: "kind", value: "CacheCluster", label: "exact", via: "unlinked" }]);
    expect(rows["jobs/queue"].components.map((m) => [m.component, m.via])).toEqual([["jobs/queue-runner", "member"]]);
    expect(g.reasons).toEqual([]);
    expect(g.summary).toEqual({ composites: 4, withComponent: 4, withoutComponent: 0, components: 3 });
  });

  test("an instance no component names is listed with an empty set", async () => {
    const root = fixture();
    writeFileSync(join(root, "jobs", "components.json"), componentIr([]));
    const g = result((await workspaceComposites({ cwd: root })).doc);
    expectValid(g);
    expect(g.composites.find((c) => c.id === "app/cache")!.components).toEqual([]);
    expect(g.composites.find((c) => c.id === "jobs/queue")!.components).toEqual([]);
    expect(g.summary).toMatchObject({ withComponent: 2, withoutComponent: 2 });
  });

  test("--at <rev> reads each member as it was at the revision", async () => {
    const root = fixture();
    const first = commitAll(root, "one");
    writeFileSync(join(root, "delivery", "components.json"), componentIr([]));
    const now = result((await workspaceComposites({ cwd: root })).doc);
    expect(now.components.map((c) => c.id)).toEqual(["jobs/queue-runner"]);
    const at = result((await workspaceComposites({ cwd: root, at: first })).doc);
    expectValid(at);
    expect(at.at).toBe(first);
    expect(at.components.map((c) => c.id)).toEqual(["delivery/edge", "delivery/loom-backend", "jobs/queue-runner"]);
  });

  test("a member whose component graph fails is listed as failed, and the rest still join", async () => {
    const root = fixture();
    writeFileSync(join(root, "jobs", "components.json"), "FAIL\n");
    const { doc, failed } = await workspaceComposites({ cwd: root });
    const g = result(doc);
    expectValid(g);
    expect(failed).toBe(true);
    expect(g.members.find((m) => m.name === "jobs")).toMatchObject({ status: "failed", reason: { code: "command-failed" } });
    expect(g.members.find((m) => m.name === "jobs")!.reason!.message).toContain("chant graph --components exited 1");
    expect(g.composites.find((c) => c.id === "jobs/queue")!.components).toEqual([]);
    expect(g.components.map((c) => c.id)).toEqual(["delivery/edge", "delivery/loom-backend"]);
  });
});

describe("why the list is empty", () => {
  test("a workspace with no chant member says so", async () => {
    const root = repo({ "chant.workspace.json": declaration([{ name: "docs", dir: "docs", kind: "other", because: "prose" }]), "docs/README.md": "" });
    const g = result((await workspaceComposites({ cwd: root })).doc);
    expectValid(g);
    expect(g.composites).toEqual([]);
    expect(g.reasons.map((r) => r.code)).toEqual(["composites-no-chant-member"]);
  });

  test("members with no composite and no component say both", async () => {
    const root = repo({
      "chant.workspace.json": declaration([{ name: "api", dir: "api", kind: "chant" }]),
      "api/chant.config.ts": "",
      "api/ir.json": ir([{ id: "Queue", kind: "Queue", lexicon: "aws", attrs: {} }]),
      ".gitignore": "node_modules\n",
      "node_modules/.bin/chant": { text: FAKE_FILE_GRAPH_CHANT, mode: 0o755 },
    });
    const g = result((await workspaceComposites({ cwd: root })).doc);
    expectValid(g);
    expect(g.reasons.map((r) => r.code)).toEqual(["composites-none-declared", "composites-no-component"]);
    expect(g.summary).toEqual({ composites: 0, withComponent: 0, withoutComponent: 0, components: 0 });
  });

  test("a declaration that can't be read is a failure document with a closed code", async () => {
    const { doc, failed } = await workspaceComposites({ cwd: repo({}) });
    expectValid(doc);
    expect(failed).toBe(true);
    expect("error" in doc && doc.error.code).toBe("declaration-missing");
  });
});

/** A lexicon module: a LexiconPlugin export, with `opRuntime` when `runtime` says what it hosts. */
function lexiconModule(name: string, runtime: "components" | "ops" | "none"): string {
  const opRuntime =
    runtime === "none"
      ? ""
      : `opRuntime: { name: ${JSON.stringify(name)}, start: async () => { throw new Error("stub"); }${runtime === "components" ? ", runComponents: async () => ({ success: true })" : ""} },`;
  return `const noop = async () => {};
export const plugin = { name: ${JSON.stringify(name)}, serializer: {}, generate: noop, validate: noop, coverage: noop, package: noop, ${opRuntime} };
`;
}

describe("the runtimes each component can deploy on (#2674)", () => {
  /** delivery configures four lexicons: one hosts component runs, one hosts only Op runs, one hosts nothing, one can't load. */
  function hosting(): string {
    const root = fixture();
    writeFileSync(
      join(root, "delivery", "chant.config.ts"),
      `export default {
  lexicons: [
    { name: "fleet", module: "./lexicons/fleet.ts" },
    { name: "oponly", module: "./lexicons/oponly.ts" },
    { name: "plain", module: "./lexicons/plain.ts" },
    { name: "gone", module: "./lexicons/gone.ts" },
  ],
};
`,
    );
    mkdirSync(join(root, "delivery", "lexicons"));
    writeFileSync(join(root, "delivery", "lexicons", "fleet.ts"), lexiconModule("fleet", "components"));
    writeFileSync(join(root, "delivery", "lexicons", "oponly.ts"), lexiconModule("oponly", "ops"));
    writeFileSync(join(root, "delivery", "lexicons", "plain.ts"), lexiconModule("plain", "none"));
    return root;
  }

  test("local is the default, and a configured lexicon whose opRuntime hosts component runs is listed with its --on line", async () => {
    const g = result((await workspaceComposites({ cwd: hosting() })).doc);
    expectValid(g);
    const edge = g.components.find((c) => c.id === "delivery/edge")!;
    expect(edge.runtimes).toEqual([
      { name: "local", lexicon: null, default: true, command: "chant run --components edge" },
      { name: "fleet", lexicon: "fleet", default: false, command: "chant run --components edge --on fleet" },
    ]);
    expect(g.components.find((c) => c.id === "delivery/loom-backend")!.runtimes.map((r) => r.command)).toEqual([
      "chant run --components loom-backend",
      "chant run --components loom-backend --on fleet",
    ]);
    // jobs configures no lexicon, so only local.
    expect(g.components.find((c) => c.id === "jobs/queue-runner")!.runtimes).toEqual([local("queue-runner")]);
    const delivery = g.members.find((m) => m.name === "delivery")!;
    expect(delivery.runtimeReasons.map((r) => r.code)).toEqual(["runtimes-lexicon-unreadable"]);
    expect(delivery.runtimeReasons[0].message).toContain('lexicon "gone"');
    expect(g.members.find((m) => m.name === "docs")!.runtimeReasons).toEqual([]);
  });

  test("a member whose config can't be read lists local only, with a reason", async () => {
    const root = fixture();
    writeFileSync(join(root, "jobs", "chant.config.ts"), 'throw new Error("no config here");\nexport default {};\n');
    const { doc, failed } = await workspaceComposites({ cwd: root, loadPlugin: async () => { throw new Error("not called"); } });
    const g = result(doc);
    expectValid(g);
    expect(failed).toBe(false);
    const jobs = g.members.find((m) => m.name === "jobs")!;
    expect(jobs.runtimeReasons).toEqual([{ code: "runtimes-config-unreadable", message: expect.stringContaining("no config here") }]);
    expect(g.components.find((c) => c.id === "jobs/queue-runner")!.runtimes).toEqual([local("queue-runner")]);
  });

  test("the plugin loader decides from opRuntime.runComponents alone", async () => {
    const root = fixture();
    writeFileSync(join(root, "jobs", "chant.config.ts"), 'export default { lexicons: ["hosted", "bare"] };\n');
    const g = result(
      (
        await workspaceComposites({
          cwd: root,
          loadPlugin: async (name) => (name === "hosted" ? { opRuntime: { runComponents: () => undefined } } : {}),
        })
      ).doc,
    );
    expectValid(g);
    expect(g.components.find((c) => c.id === "jobs/queue-runner")!.runtimes.map((r) => [r.name, r.lexicon, r.default])).toEqual([
      ["local", null, true],
      ["hosted", "hosted", false],
    ]);
  });
});
