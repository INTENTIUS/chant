/**
 * The composed plan cut back into one plan per member (#4442), on recorded
 * `show -json` fixtures in `../__fixtures__/compose`: a composed plan of
 * three modules beside each root's plan alone on the same state, and a
 * composed plan where one member reads an output another creates.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { Composition, ComposedRead } from "../compose";
import { terraformChangeSetPart } from "../change-set";
import { terraformPlannedOutputs } from "../components/capability-plugin";
import { terraformPlanShape } from "../plan-shape";
import { slicePlan as reportSlicePlan } from "../report";
import { moduleChanges, stripChange, stripModule, topModule } from "./module-address";
import { composedMemberPlans, composedReads, planCounts, slicePlan, sliceText } from "./slice";

const FIX = join(import.meta.dirname, "..", "__fixtures__", "compose");
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIX, name), "utf-8"));

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A composition of `members` in that order, each its own module and root, reading as `reads` says. */
function composition(members: string[], reads: Record<string, ComposedRead[]> = {}, dirs: Record<string, string> = {}): Composition {
  return {
    candidates: [...members].sort(),
    members: [...members].sort(),
    order: members,
    max: 10,
    roots: new Map(members.map((m) => [m, m])),
    dirs: new Map(Object.entries(dirs)),
    modules: new Map(members.map((m) => [m, m])),
    reads: new Map(Object.entries(reads)),
    fallbacks: [],
  };
}

describe("one change-set part per member", () => {
  const composed = fixture("three-composed.plan.json");
  const c = composition(["net", "app", "edge"], { app: [{ via: "vars", upstream: "net", variable: "vpc_id", output: "vpc_id" }] });
  const plans = composedMemberPlans(c, composed);

  test.each(["net", "app", "edge"])("%s's part of the composed plan is the part its root planned alone gives", (m) => {
    const alone = fixture(`three-${m}.plan.json`);
    expect(plans[m]!.changeSet).toEqual(terraformChangeSetPart({ member: m, plan: alone }));
    expect(plans[m]!.planDigest).toBe(terraformChangeSetPart({ member: m, plan: alone }).member.planDigest);
    expect(plans[m]!.outputs).toEqual(terraformPlannedOutputs(alone));
    expect(plans[m]!.shape).toEqual(terraformPlanShape(alone, m));
  });

  test("a slice reads as the root alone: addresses, module addresses, outputs, values and configuration unprefixed", () => {
    const app = slicePlan(composed, "app") as any;
    const alone = fixture("three-app.plan.json") as any;
    expect(app.resource_changes).toEqual(alone.resource_changes);
    expect(app.output_changes).toEqual(alone.output_changes);
    expect(app.planned_values.root_module).toEqual(alone.planned_values.root_module);
    expect(app.planned_values.outputs).toEqual(alone.planned_values.outputs);
    expect(app.configuration.root_module).toEqual(alone.configuration.root_module);
    const net = slicePlan(composed, "net") as any;
    expect(net.prior_state.values.root_module).toEqual((fixture("three-net.plan.json") as any).prior_state.values.root_module);
    expect(net.relevant_attributes).toEqual([{ resource: "terraform_data.vpc", attribute: ["id"] }]);
    expect(net.checks).toBeUndefined();
    expect(net.variables).toBeUndefined();
  });

  test("the counts are each member's own, a no-op not counted", () => {
    expect(plans.net!.counts).toEqual({ add: 0, change: 1, destroy: 0, changes: 1, destroys: 0 });
    expect(plans.app!.counts).toEqual({ add: 2, change: 0, destroy: 0, changes: 2, destroys: 0 });
    expect(plans.edge!.counts).toEqual(planCounts(fixture("three-edge.plan.json")));
    expect(plans.edge!.counts.changes).toBe(0);
  });

  test("a known read is a read with nothing unknown, and the reader's shape lists no unknown inputs", () => {
    expect(plans.app!.reads).toEqual([{ upstream: "net", via: "vars", name: "vpc_id", outputs: ["vpc_id"], unknown: [] }]);
    expect(plans.app!.shape.unknownInputs).toEqual([]);
    expect(plans.net!.reads).toEqual([]);
  });
});

describe("an output one member creates and another reads", () => {
  const composed = fixture("unknown-composed.plan.json");

  test("is unknown in the upstream's planned outputs and in the reader's reads and shape", () => {
    const c = composition(["queue", "worker"], { worker: [{ via: "vars", upstream: "queue", variable: "queue_id", output: "queue_id" }] });
    const plans = composedMemberPlans(c, composed);
    expect(plans.queue!.outputs).toEqual({ known: { queue_name: "jobs" }, unknown: ["queue_id"] });
    expect(plans.worker!.reads).toEqual([{ upstream: "queue", via: "vars", name: "queue_id", outputs: ["queue_id"], unknown: ["queue_id"] }]);
    expect(plans.worker!.shape.unknownInputs).toEqual(["queue.queue_id"]);
    expect(plans.worker!.shape.entries).toEqual([expect.objectContaining({ logicalId: "terraform_data.consumer", action: "create", unknown: expect.arrayContaining(["input"]) })]);
  });

  test("a read of a known output of the same upstream is not unknown", () => {
    const c = composition(["queue", "worker"], { worker: [{ via: "vars", upstream: "queue", variable: "name", output: "queue_name" }] });
    expect(composedMemberPlans(c, composed).worker!.reads).toEqual([{ upstream: "queue", via: "vars", name: "name", outputs: ["queue_name"], unknown: [] }]);
  });

  test("a terraform_remote_state block names the outputs its root's files read; reading the whole object counts every output", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-compose-slice-"));
    made.push(dir);
    mkdirSync(join(dir, "worker"));
    mkdirSync(join(dir, "whole"));
    writeFileSync(join(dir, "worker", "main.tf"), 'data "terraform_remote_state" "q" {}\nresource "terraform_data" "consumer" { input = data.terraform_remote_state.q.outputs.queue_id }\n');
    writeFileSync(join(dir, "whole", "main.tf"), 'data "terraform_remote_state" "q" {}\nresource "terraform_data" "consumer" { input = data.terraform_remote_state.q.outputs }\n');
    const outputs = new Map([["queue", terraformPlannedOutputs(slicePlan(composed, "queue"))]]);
    const read: ComposedRead = { via: "remote-state", upstream: "queue", name: "q" };
    const reads = composedReads({ members: ["whole", "worker"], reads: new Map([["worker", [read]], ["whole", [read]]]), dirs: new Map([["worker", join(dir, "worker")], ["whole", join(dir, "whole")]]) }, outputs);
    expect(reads.get("worker")).toEqual([{ upstream: "queue", via: "remote-state", name: "q", outputs: ["queue_id"], unknown: ["queue_id"] }]);
    expect(reads.get("whole")).toEqual([{ upstream: "queue", via: "remote-state", name: "q", unknown: ["queue_id"] }]);
  });

  test("a remote state read the composed root rewrote to var.chant_read_<label> names the same outputs", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-compose-slice-"));
    made.push(dir);
    writeFileSync(join(dir, "main.tf"), 'resource "terraform_data" "consumer" { input = var.chant_read_q.outputs.queue_id }\n');
    writeFileSync(join(dir, "chant_compose.tf"), 'variable "chant_read_q" {\n  type = any\n}\n');
    const outputs = new Map([["queue", terraformPlannedOutputs(slicePlan(composed, "queue"))]]);
    const reads = composedReads({ members: ["worker"], reads: new Map([["worker", [{ via: "remote-state", upstream: "queue", name: "q" } as ComposedRead]]]), dirs: new Map([["worker", dir]]) }, outputs);
    expect(reads.get("worker")).toEqual([{ upstream: "queue", via: "remote-state", name: "q", outputs: ["queue_id"], unknown: ["queue_id"] }]);
  });
});

describe("one strip function for the report and the slicer", () => {
  test("a top module, with or without an index, is taken off; an address in no module is as it was", () => {
    expect(topModule("module.app.module.logs.terraform_data.group")).toBe("app");
    expect(stripModule("module.app.module.logs.terraform_data.group")).toBe("module.logs.terraform_data.group");
    expect(stripModule('module.net["a"].terraform_data.vpc')).toBe("terraform_data.vpc");
    expect(stripModule("module.net")).toBe("");
    expect(stripModule("terraform_data.vpc")).toBe("terraform_data.vpc");
    expect(stripChange({ address: "module.app.terraform_data.service", module_address: "module.app" })).toEqual({ address: "terraform_data.service" });
  });

  test("report.ts's slice and the composed slice give the same resource changes", () => {
    const composed = fixture("three-composed.plan.json") as any;
    for (const m of ["net", "app", "edge"]) {
      const fromReport = reportSlicePlan(composed, m).resource_changes;
      expect(fromReport).toEqual((slicePlan(composed, m) as any).resource_changes);
      expect(fromReport).toEqual(moduleChanges(composed.resource_changes, m));
    }
  });
});

describe("sliceText", () => {
  const text = [
    "Terraform used the selected providers to generate the following execution",
    "plan. Resource actions are indicated with the following symbols:",
    "  + create",
    "  ~ update in-place",
    "",
    "Terraform will perform the following actions:",
    "",
    "  # module.app.terraform_data.service will be created",
    '  + resource "terraform_data" "service" {',
    "      + id     = (known after apply)",
    "    }",
    "",
    "  # module.net.terraform_data.vpc will be updated in-place",
    '  ~ resource "terraform_data" "vpc" {',
    '        id     = "6f2b6c1e"',
    "    }",
    "",
    "Plan: 1 to add, 1 to change, 0 to destroy.",
    "",
    "Changes to Outputs:",
    "  + app__service_id = (known after apply)",
    "",
  ].join("\n");

  test("a member's resource blocks unprefixed, its counts and its outputs by their own names", () => {
    const s = sliceText(text, "app", { add: 1, change: 0, destroy: 0 });
    expect(s).toContain("  # terraform_data.service will be created");
    expect(s).not.toContain("terraform_data.vpc");
    expect(s).toContain("Plan: 1 to add, 0 to change, 0 to destroy.");
    expect(s).toContain("Changes to Outputs:\n  + service_id = (known after apply)");
  });

  test("a member with nothing in the text says it has no changes", () => {
    expect(sliceText(text, "edge", { add: 0, change: 0, destroy: 0 })).toContain("No changes. Its part of the composed run matches the configuration.");
  });
});
