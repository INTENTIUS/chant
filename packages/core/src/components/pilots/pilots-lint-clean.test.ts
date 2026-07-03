/**
 * The real pilots must lint clean under the COMP* composition rules (#562,
 * epic #551's acceptance criteria: "Ensure the four real pilots lint CLEAN
 * (they are valid compositions)"). #561 added a fifth/sixth component (the
 * jar-lib producer / emr-job consumer pair) after this issue was filed;
 * included here too since it now lives alongside the original four as real,
 * non-stub composition.
 *
 * Pilots are authored as `*.pilot.ts` (see ../discover.ts's docstring: only
 * `*.component.ts` is the discovery convention `chant lint`/`chant build`
 * actually scan), so this test builds a `ComponentCheckContext` directly from
 * the imported `Component` values — the same objects `./pilots.test.ts`
 * schema-validates — rather than depending on file-suffix discovery, and runs
 * every COMP* check against it exactly as `../../lint/component-checks.ts`'s
 * `runComponentChecks` would over a real discovered project.
 */

import { describe, expect, it } from "vitest";
import type { ComponentCheckContext, ComponentCheckEntry } from "../../lint/component-checks";
import { loadComponentChecks } from "../../lint/rules/comp/index";
import { searchService } from "./alb-ecs.pilot";
import { ordersTable } from "./dynamodb.pilot";
import { neo4jCluster } from "./neo4j-fanout.pilot";
import { imageProcessor } from "./lambda.pilot";
import { jarLib, emrJob } from "./jar-emr.pilot";
import type { Component } from "../component";

const checks = loadComponentChecks();

function contextFor(components: Component[]): ComponentCheckContext {
  const map = new Map<string, ComponentCheckEntry>();
  for (const component of components) {
    map.set(component.name, { component, filePath: `${component.name}.pilot.ts` });
  }
  return { components: map };
}

/** Every check's diagnostics against one context, tagged with the producing check id. */
function runAll(ctx: ComponentCheckContext) {
  return checks.flatMap((check) => check.check(ctx));
}

describe("Real pilots lint clean under COMP* (#562 acceptance criteria)", () => {
  it("ALB/ECS, DynamoDB, and the jar-lib/emr-job pair produce zero COMP* diagnostics", () => {
    const ctx = contextFor([searchService, ordersTable, jarLib, emrJob]);
    const diagnostics = runAll(ctx);
    expect(diagnostics).toEqual([]);
  });

  it("the image-processor Lambda pilot (#558's fourth component) produces zero COMP* diagnostics", () => {
    const ctx = contextFor([imageProcessor]);
    expect(runAll(ctx)).toEqual([]);
  });

  it("the Neo4j fan-out pilot produces zero COMP* diagnostics other than the expected COMP004 (gate requires Temporal)", () => {
    // The Neo4j pilot's Node-1 approval gate is a deliberate design choice
    // (see neo4j-fanout.pilot.ts's own docstring and
    // ../driver.ts's DriverGateUnsupportedError / docs/components/
    // orchestration.mdx's "Temporal is optional" aside) — it is the one real
    // pilot that genuinely needs the durable backend, so COMP004 firing here
    // is the *correct*, expected signal, not a defect. A real project would
    // acknowledge it with `// chant-disable-next-line COMP004 -- <reason>`
    // once authored as an actual `*.component.ts` file (see
    // ../../lint/rules/comp/comp004-gate-needs-temporal.ts and the
    // comp004/pass fixture demonstrating that opt-out end to end).
    const ctx = contextFor([neo4jCluster]);
    const diagnostics = runAll(ctx);
    expect(diagnostics.every((d) => d.checkId === "COMP004")).toBe(true);
    expect(diagnostics.filter((d) => d.checkId === "COMP004")).toHaveLength(1);
  });

  it("all six real components together (the full pilot set) produce zero COMP* diagnostics except the one documented Neo4j gate", () => {
    const ctx = contextFor([searchService, ordersTable, neo4jCluster, imageProcessor, jarLib, emrJob]);
    const diagnostics = runAll(ctx);
    const unexpected = diagnostics.filter((d) => !(d.checkId === "COMP004" && d.component === "neo4j-cluster"));
    expect(unexpected).toEqual([]);
  });
});
