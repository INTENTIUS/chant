import { describe, test, expect } from "vitest";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import { applyLexiconGraphEdges, buildGraphIr } from "@intentius/chant/graph-ir";
import { githubGraphEdges } from "./graph-edges";
import { githubPlugin } from "./plugin";

function entity(entityType: string, props: Record<string, unknown>, kind: "resource" | "property" = "resource"): Declarable {
  return { [DECLARABLE_MARKER]: true, lexicon: "github", entityType, kind, props } as unknown as Declarable;
}
const workflow = (props: Record<string, unknown> = {}) => entity("GitHub::Actions::Workflow", props);
const job = (props: Record<string, unknown> = {}) => entity("GitHub::Actions::Job", props);
const step = (props: Record<string, unknown>) => entity("GitHub::Actions::Step", props, "property");

/** Run the hook and merge it the way `chant graph` does. */
function graph(entities: Map<string, Declarable>) {
  const report = githubGraphEdges(entities);
  return applyLexiconGraphEdges(buildGraphIr(entities), report ? [report] : []);
}

/** The edges the hook added. A workflow holding an exported Job in `jobs:`
 * already had a `ref` edge to it from the core walk; that one is not ours. */
const ciEdges = (ir: ReturnType<typeof graph>) => ir.edges.filter((e) => e.kind !== "ref");

describe("githubGraphEdges (#3910)", () => {
  test("the plugin exposes the hook", () => {
    expect(githubPlugin.graphEdges).toBeTypeOf("function");
  });

  test("needs: job to job within the workflow, by kebab-cased key", () => {
    const ir = graph(new Map<string, Declarable>([
      ["ci", workflow({ name: "CI" })],
      ["build", job({})],
      ["unitTest", job({ needs: ["build"] })],
      ["deploy", job({ needs: "unit-test" })],
    ]));
    expect(ciEdges(ir)).toEqual([
      { from: "deploy", to: "unitTest", kind: "needs", viaAttr: "needs" },
      { from: "unitTest", to: "build", kind: "needs", viaAttr: "needs" },
    ]);
    expect(ir.groups.byPipeline).toEqual({ ci: ["build", "ci", "deploy", "unitTest"] });
    expect(ir.dangling).toBeUndefined();
  });

  test("needs resolves within the workflow that holds the job, not across workflows", () => {
    const build = job({});
    const release = job({ needs: ["build"] });
    const ir = graph(new Map<string, Declarable>([
      ["ci", workflow({ name: "CI", jobs: { build } })],
      ["publish", workflow({ name: "Publish", jobs: { release } })],
      ["build", build],
      ["release", release],
    ]));
    expect(ciEdges(ir)).toEqual([]);
    expect(ir.dangling).toEqual([{ from: "release", kind: "needs", path: "needs", value: "build" }]);
  });

  test("uses: ./.github/workflows/<file> calls the declared workflow written to that file", () => {
    const callReusable = job({ uses: "./.github/workflows/reusable-ci.yml" });
    const ir = graph(new Map<string, Declarable>([
      ["caller", workflow({ name: "Caller", jobs: { callReusable } })],
      ["reusableCi", workflow({ name: "Reusable", on: { workflow_call: {} }, jobs: { test: job({}) } })],
      ["callReusable", callReusable],
    ]));
    expect(ciEdges(ir)).toEqual([
      { from: "callReusable", to: "reusableCi", kind: "calls", viaAttr: "uses", crossPipeline: true },
    ]);
  });

  test("a .forgejo/workflows path resolves the same way", () => {
    const call = job({ uses: "./.forgejo/workflows/shared.yaml" });
    const ir = graph(new Map<string, Declarable>([
      ["main", workflow({ jobs: { call } })],
      ["shared", workflow({ jobs: { t: job({}) } })],
      ["call", call],
    ]));
    expect(ciEdges(ir).map((e) => [e.from, e.to, e.kind])).toEqual([["call", "shared", "calls"]]);
  });

  test("on.workflow_run.workflows: the triggered workflow points at the workflow named", () => {
    const ir = graph(new Map<string, Declarable>([
      ["ci", workflow({ name: "CI", jobs: { t: job({}) } })],
      ["deploy", workflow({ name: "Deploy", on: { workflowRun: { workflows: ["CI"], types: ["completed"] } }, jobs: { d: job({}) } })],
    ]));
    expect(ciEdges(ir)).toEqual([
      { from: "deploy", to: "ci", kind: "triggers", viaAttr: "workflow_run", crossPipeline: true },
    ]);
  });

  test("a step using a local composite action is reported, dangling: chant does not declare actions", () => {
    const ir = graph(new Map<string, Declarable>([
      ["ci", workflow({})],
      ["build", job({ steps: [step({ uses: "actions/checkout@v4" }), step({ uses: "./.github/actions/setup" })] })],
    ]));
    expect(ciEdges(ir)).toEqual([]);
    expect(ir.dangling).toEqual([{ from: "build", kind: "calls", path: "steps.uses", value: "./.github/actions/setup" }]);
  });

  test("dangling: unknown job, another repository's workflow, an undeclared workflow name", () => {
    const ir = graph(new Map<string, Declarable>([
      ["ci", workflow({ name: "CI", on: { workflow_run: { workflows: ["Nightly"] } } })],
      ["build", job({ needs: ["compile"] })],
      ["shared", job({ uses: "octo-org/infra/.github/workflows/deploy.yml@v1" })],
      ["local", job({ uses: "./.github/workflows/missing.yml" })],
    ]));
    expect(ciEdges(ir)).toEqual([]);
    expect(ir.dangling).toEqual([
      { from: "build", kind: "needs", path: "needs", value: "compile" },
      { from: "ci", kind: "triggers", path: "workflow_run", value: "Nightly", crossPipeline: true },
      { from: "local", kind: "calls", path: "uses", value: "./.github/workflows/missing.yml", crossPipeline: true },
      { from: "shared", kind: "calls", path: "uses", value: "octo-org/infra/.github/workflows/deploy.yml@v1", crossPipeline: true },
    ]);
  });

  test("standalone jobs follow the serializer: they run in the first workflow only", () => {
    const ir = graph(new Map<string, Declarable>([
      ["first", workflow({})],
      ["second", workflow({})],
      ["build", job({})],
    ]));
    expect(ir.groups.byPipeline).toEqual({ first: ["build", "first"], second: ["second"] });
  });

  test("a project with no workflows or jobs reports nothing", () => {
    expect(githubGraphEdges(new Map())).toBeUndefined();
  });
});
