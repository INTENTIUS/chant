import { describe, test, expect } from "vitest";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import { applyLexiconGraphEdges, buildGraphIr } from "@intentius/chant/graph-ir";
import { gitlabGraphEdges } from "./graph-edges";
import { gitlabPlugin } from "./plugin";

function entity(entityType: string, props: Record<string, unknown>, kind: "resource" | "property" = "resource"): Declarable {
  return { [DECLARABLE_MARKER]: true, lexicon: "gitlab", entityType, kind, props } as unknown as Declarable;
}
const job = (props: Record<string, unknown> = {}) => entity("GitLab::CI::Job", props);
const pipeline = (props: Record<string, unknown>) => entity("GitLab::CI::Pipeline", props);
const need = (props: Record<string, unknown>) => entity("GitLab::CI::Need", props, "property");
const trigger = (props: Record<string, unknown>) => entity("GitLab::CI::Trigger", props, "property");
const include = (props: Record<string, unknown>) => entity("GitLab::CI::Include", props, "property");

/** Run the hook and merge it the way `chant graph` does. */
function graph(entities: Map<string, Declarable>) {
  const report = gitlabGraphEdges(entities);
  return applyLexiconGraphEdges(buildGraphIr(entities), report ? [report] : []);
}

describe("gitlabGraphEdges (#3910)", () => {
  test("the plugin exposes the hook", () => {
    expect(gitlabPlugin.graphEdges).toBeTypeOf("function");
  });

  test("needs: a name, { job } and the Job object itself all resolve to the job", () => {
    const build = job({ stage: "build" });
    const ir = graph(new Map<string, Declarable>([
      ["build", build],
      ["lintCode", job({ stage: "build" })],
      ["unitTest", job({ stage: "test", needs: ["build", need({ job: "lint-code", artifacts: false })] })],
      ["deploy", job({ stage: "deploy", needs: [build] })],
    ]));
    expect(ir.edges).toEqual([
      { from: "deploy", to: "build", kind: "needs", viaAttr: "needs" },
      { from: "unitTest", to: "build", kind: "needs", viaAttr: "needs" },
      { from: "unitTest", to: "lintCode", kind: "needs", viaAttr: "needs" },
    ]);
    expect(ir.groups.byPipeline).toEqual({ ".gitlab-ci.yml": ["build", "deploy", "lintCode", "unitTest"] });
  });

  test("a job without needs: waits for the stage before its own", () => {
    const ir = graph(new Map<string, Declarable>([
      ["build", job({ stage: "build" })],
      ["test", job({ stage: "test" })],
      ["deploy", job({ stage: "deploy" })],
    ]));
    expect(ir.edges).toEqual([
      { from: "deploy", to: "test", kind: "needs", viaAttr: "stage" },
      { from: "test", to: "build", kind: "needs", viaAttr: "stage" },
    ]);
  });

  test("stage order looks further back past a job that starts early with needs:", () => {
    const ir = graph(new Map<string, Declarable>([
      ["compile", job({ stage: "build" })],
      ["quick", job({ stage: "test", needs: [] })],
      ["deploy", job({ stage: "deploy" })],
    ]));
    expect(ir.edges).toEqual([
      { from: "deploy", to: "compile", kind: "needs", viaAttr: "stage" },
      { from: "deploy", to: "quick", kind: "needs", viaAttr: "stage" },
    ]);
  });

  test("a Pipeline's stages: list sets the order, and a job with no stage is in test", () => {
    const ir = graph(new Map<string, Declarable>([
      ["pipeline", pipeline({ stages: ["test", "package"] })],
      ["pack", job({ stage: "package" })],
      ["check", job({})],
    ]));
    expect(ir.edges).toEqual([{ from: "pack", to: "check", kind: "needs", viaAttr: "stage" }]);
  });

  test("extends: the job it inherits from", () => {
    const ir = graph(new Map<string, Declarable>([
      ["baseJob", job({ stage: "build" })],
      ["build", job({ stage: "build", extends: "base-job" })],
    ]));
    expect(ir.edges).toEqual([{ from: "build", to: "baseJob", kind: "extends", viaAttr: "extends" }]);
  });

  test("trigger: and include: name pipelines this project does not generate, so they dangle", () => {
    const ir = graph(new Map<string, Declarable>([
      ["pipeline", pipeline({ include: [include({ local: "ci/templates.yml" }), "https://example.com/ci.yml", include({ project: "group/shared", ref: "main", file: "ci.yml" })] })],
      ["child", job({ stage: "build", trigger: trigger({ include: "child/.gitlab-ci.yml", strategy: "depend" }) })],
      ["downstream", job({ stage: "build", trigger: "group/downstream" })],
      ["multi", job({ stage: "build", trigger: trigger({ project: "group/other", branch: "main" }) })],
    ]));
    expect(ir.edges).toEqual([]);
    expect(ir.dangling).toEqual([
      { from: "child", kind: "triggers", path: "trigger.include", value: "child/.gitlab-ci.yml", crossPipeline: true },
      { from: "downstream", kind: "triggers", path: "trigger", value: "group/downstream", crossPipeline: true },
      { from: "multi", kind: "triggers", path: "trigger.project", value: "group/other@main", crossPipeline: true },
      { from: "pipeline", kind: "includes", path: "include", value: "ci/templates.yml", crossPipeline: true },
      { from: "pipeline", kind: "includes", path: "include", value: "group/shared@main:ci.yml", crossPipeline: true },
      { from: "pipeline", kind: "includes", path: "include", value: "https://example.com/ci.yml", crossPipeline: true },
    ]);
  });

  test("dangling: cross-project and parent-pipeline needs, unknown job, hidden template", () => {
    const ir = graph(new Map<string, Declarable>([
      ["deploy", job({
        stage: "deploy",
        needs: [need({ project: "group/lib", job: "package", ref: "main", artifacts: true }), need({ pipeline: "$PARENT_PIPELINE_ID", job: "gen" }), "compile"],
        extends: [".deploy-template"],
      })],
    ]));
    expect(ir.edges).toEqual([]);
    expect(ir.dangling).toEqual([
      { from: "deploy", kind: "extends", path: "extends", value: ".deploy-template" },
      { from: "deploy", kind: "needs", path: "needs.pipeline", value: "$PARENT_PIPELINE_ID:gen", crossPipeline: true },
      { from: "deploy", kind: "needs", path: "needs.project", value: "group/lib@main:package", crossPipeline: true },
      { from: "deploy", kind: "needs", path: "needs", value: "compile" },
    ]);
  });

  test("a project with no jobs or pipeline reports nothing", () => {
    expect(gitlabGraphEdges(new Map())).toBeUndefined();
  });
});
