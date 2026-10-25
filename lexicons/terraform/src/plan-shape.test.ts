/**
 * `terraformPlanShape` (#4436), against the recorded `show -json` plans of
 * terraform, tofu and choudoufu in `__fixtures__/change-set/` (see
 * change-set.test.ts for how they were recorded).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { planShapeCovers, planShapeDigest, type PlanShapeEntry } from "@intentius/chant/components/covered-round";
import { terraformPlanShape } from "./plan-shape";

const DIR = join(import.meta.dirname, "__fixtures__", "change-set");
const read = (name: string): unknown => JSON.parse(readFileSync(join(DIR, name), "utf-8"));

const T = "terraform_data";

/** The fixture plan: a no-op, an update, an update of a sensitive value, a delete, a replace, two creates under a module. */
const FIXTURE_ENTRIES: PlanShapeEntry[] = [
  { logicalId: "module.app.terraform_data.instance[0]", action: "create", type: T, properties: ["id", "input", "output"], unknown: ["id", "output"] },
  { logicalId: "module.app.terraform_data.instance[1]", action: "create", type: T, properties: ["id", "input", "output"], unknown: ["id", "output"] },
  { logicalId: "terraform_data.config", action: "update", replacement: "false", type: T, properties: ["input", "output"], unknown: ["output"] },
  { logicalId: "terraform_data.old", action: "delete", type: T, properties: [], unknown: [] },
  { logicalId: "terraform_data.secret", action: "update", replacement: "false", type: T, properties: ["input", "output"], unknown: ["output"] },
  { logicalId: "terraform_data.worker", action: "replace", replacement: "true", type: T, properties: ["id", "output", "triggers_replace"], unknown: ["id", "output"] },
];

describe("terraformPlanShape, on real plans", () => {
  test.each(["terraform", "tofu", "choudoufu"] as const)("%s: one entry per change, none for the no-op", (planner) => {
    expect(terraformPlanShape(read(`${planner}.plan.json`), "estate")).toEqual({ member: "estate", entries: FIXTURE_ENTRIES, unknownInputs: [] });
  });

  test("a table of the actions, replacement and attributes the fixture gives", () => {
    const shape = terraformPlanShape(read("terraform.plan.json"), "estate");
    expect(shape.entries.map((e) => [e.logicalId, e.action, e.replacement, e.properties, e.unknown])).toEqual(
      FIXTURE_ENTRIES.map((e) => [e.logicalId, e.action, e.replacement, e.properties, e.unknown]),
    );
    // terraform_data.keep is a no-op, so it has no entry.
    expect(shape.entries.some((e) => e.logicalId === "terraform_data.keep")).toBe(false);
  });

  test("the choudoufu set plan's embedded plan gives a shape too", () => {
    const doc = read("choudoufu-set-plan.json") as { roots: Array<{ plan?: unknown }> };
    expect(terraformPlanShape(doc.roots[0]!.plan, "estates/e01")).toEqual({
      member: "estates/e01",
      entries: [{ logicalId: "terraform_data.x", action: "create", properties: [], unknown: [] }],
      unknownInputs: [],
    });
  });

  test("a forget has an entry with no properties", () => {
    const shape = terraformPlanShape(read("terraform.import-forget.plan.json"), "estate");
    expect(shape.entries.find((e) => e.logicalId === "terraform_data.a")).toMatchObject({ action: "forget", properties: [], unknown: [] });
  });

  test("the digest of the same plan JSON is equal across two runs", () => {
    const one = planShapeDigest(terraformPlanShape(read("terraform.plan.json"), "estate"));
    const two = planShapeDigest(terraformPlanShape(read("terraform.plan.json"), "estate"));
    expect(one).toBe(two);
    expect(planShapeDigest(terraformPlanShape(read("tofu.plan.json"), "estate"))).toBe(one);
  });

  test("a shape is covered by itself, and not by a plan that adds a resource", () => {
    const first = terraformPlanShape(read("terraform.plan.json"), "estate");
    expect(planShapeCovers(first, terraformPlanShape(read("terraform.plan.json"), "estate"))).toBeUndefined();
    const plan = read("terraform.plan.json") as { resource_changes: unknown[] };
    const more = { ...plan, resource_changes: [...plan.resource_changes, { address: "terraform_data.extra", type: T, change: { actions: ["create"], before: null, after: { input: "x" }, after_unknown: {} } }] };
    expect(planShapeCovers(first, terraformPlanShape(more, "estate"))).toContain("terraform_data.extra");
  });

  test("unknown and known inputs are the caller's, and enter the digest", () => {
    const plan = read("terraform.plan.json");
    const shape = terraformPlanShape(plan, "app", { unknownInputs: ["a.id"], knownInputs: { "net.cidr": "10.0.0.0/16" } });
    expect(shape.unknownInputs).toEqual(["a.id"]);
    expect(shape.knownInputs).toEqual({ "net.cidr": "10.0.0.0/16" });
    expect(planShapeDigest(shape)).not.toBe(planShapeDigest(terraformPlanShape(plan, "app")));
  });
});

/** A plan with one update whose `replace_paths` and `after_unknown` are as given. */
function updatePlan(change: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
  return { resource_changes: [{ address: "aws_instance.web", type: "aws_instance", ...extra, change: { actions: ["update"], ...change } }] };
}

describe("terraformPlanShape replacement", () => {
  test("an update with a replace_paths entry replaces", () => {
    const plan = updatePlan({ before: { ami: "a" }, after: { ami: "b" }, after_unknown: {}, replace_paths: [["ami"]] });
    expect(terraformPlanShape(plan, "m").entries[0]).toMatchObject({ action: "update", replacement: "true", type: "aws_instance", properties: ["ami"] });
  });

  test("an update whose replaced path is unknown after apply is conditional", () => {
    const plan = updatePlan({ before: { ami: "a" }, after: {}, after_unknown: { ami: true }, replace_paths: [["ami"]] });
    expect(terraformPlanShape(plan, "m").entries[0]).toMatchObject({ replacement: "conditional", properties: ["ami"], unknown: ["ami"] });
  });

  test("a nested replaced path is unknown when its own leaf is", () => {
    const plan = updatePlan({ before: { tags: { env: "a" } }, after: { tags: {} }, after_unknown: { tags: { env: true } }, replace_paths: [["tags", "env"]] });
    expect(terraformPlanShape(plan, "m").entries[0]!.replacement).toBe("conditional");
  });

  test("one known replaced path is enough to replace", () => {
    const plan = updatePlan({
      before: { ami: "a", zone: "x" },
      after: { zone: "y" },
      after_unknown: { ami: true },
      replace_paths: [["ami"], ["zone"]],
    });
    expect(terraformPlanShape(plan, "m").entries[0]!.replacement).toBe("true");
  });

  test("an update with no replace_paths replaces nothing", () => {
    const plan = updatePlan({ before: { ami: "a" }, after: { ami: "b" }, after_unknown: {} });
    expect(terraformPlanShape(plan, "m").entries[0]!.replacement).toBe("false");
  });

  test("a delete and create pair with no replace_paths replaces", () => {
    const plan = { resource_changes: [{ address: "x.y", type: "x", change: { actions: ["create", "delete"], before: { a: 1 }, after: { a: 2 }, after_unknown: {} } }] };
    expect(terraformPlanShape(plan, "m").entries[0]).toMatchObject({ action: "replace", replacement: "true" });
  });
});

describe("terraformPlanShape, edge cases", () => {
  test("a deposed object's logical id carries its key", () => {
    const plan = updatePlan({ before: { a: 1 }, after: null, actions: ["delete"] }, { deposed: "0123abcd" });
    const [entry] = terraformPlanShape(plan, "m").entries;
    expect(entry).toMatchObject({ logicalId: "aws_instance.web#0123abcd", action: "delete" });
  });

  test("read and no-op entries are left out", () => {
    const plan = {
      resource_changes: [
        { address: "data.x.a", type: "x", change: { actions: ["read"] } },
        { address: "x.b", type: "x", change: { actions: ["no-op"], before: {}, after: {} } },
      ],
    };
    expect(terraformPlanShape(plan, "m").entries).toEqual([]);
  });

  test("anything that is not a plan has no entries", () => {
    expect(terraformPlanShape(undefined, "m")).toEqual({ member: "m", entries: [], unknownInputs: [] });
    expect(terraformPlanShape({}, "m").entries).toEqual([]);
  });

  test("sensitive values never enter the shape", () => {
    const shape = terraformPlanShape(read("terraform.plan.json"), "estate");
    expect(JSON.stringify(shape)).not.toContain("s3cr3t");
  });
});
