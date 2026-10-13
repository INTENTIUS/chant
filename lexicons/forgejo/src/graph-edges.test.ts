import { describe, expect, it } from "vitest";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import { forgejoPlugin } from "./plugin";

function entity(entityType: string, props: Record<string, unknown>): Declarable {
  return { [DECLARABLE_MARKER]: true, lexicon: "github", entityType, kind: "resource", props } as unknown as Declarable;
}

// Forgejo workflows are github entities, so the github lexicon resolves their
// edges (#3910). This checks the forgejo plugin hands them over, every kind
// and the dangling case included; github's own tests cover each rule.
describe("forgejo graphEdges (#3910)", () => {
  it("reports needs, calls, triggers and dangling references for a forgejo project", () => {
    const build = entity("GitHub::Actions::Job", {});
    const test = entity("GitHub::Actions::Job", { needs: ["build", "lint"] });
    const call = entity("GitHub::Actions::Job", { uses: "./.forgejo/workflows/shared.yml" });
    const entities = new Map<string, Declarable>([
      ["ci", entity("GitHub::Actions::Workflow", { name: "CI", jobs: { build, test, call } })],
      ["shared", entity("GitHub::Actions::Workflow", { name: "Shared", on: { workflow_run: { workflows: ["CI"] } }, jobs: { s: entity("GitHub::Actions::Job", {}) } })],
      ["build", build],
      ["test", test],
      ["call", call],
    ]);
    const report = forgejoPlugin.graphEdges!(entities)!;
    expect(report.references).toEqual([
      { from: "test", to: "build", kind: "needs", viaAttr: "needs" },
      { from: "test", to: "lint", kind: "needs", viaAttr: "needs", dangling: true },
      { from: "call", to: "shared", kind: "calls", viaAttr: "uses", crossPipeline: true },
      { from: "shared", to: "ci", kind: "triggers", viaAttr: "workflow_run", crossPipeline: true },
    ]);
    expect(report.pipelines).toEqual({ ci: ["ci", "build", "test", "call"], shared: ["shared"] });
  });
});
