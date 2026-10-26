/**
 * Placeholder previews of a root whose `vars` read outputs not known yet
 * (#4463): a stand-in per type, the cases with no preview, and what the
 * stand-ins drive in the plan JSON.
 */

import { describe, expect, test } from "vitest";
import { markPlaceholderDriven, placeholderVars, TERRAFORM_UNKNOWN_MARK, terraformPlaceholder, waitingHole } from "./placeholder-preview";

describe("terraformPlaceholder: a stand-in typed from the variable block (#4463)", () => {
  test("string", () => {
    expect(terraformPlaceholder("string")).toBe(TERRAFORM_UNKNOWN_MARK);
  });

  test("number", () => {
    expect(terraformPlaceholder("number")).toBe(0);
  });

  test("bool", () => {
    expect(terraformPlaceholder("bool")).toBe(false);
  });

  test("list", () => {
    expect(terraformPlaceholder("list(string)")).toEqual([]);
    expect(terraformPlaceholder("list(object({ id = string }))")).toEqual([]);
    expect(terraformPlaceholder("set(string)")).toEqual([]);
  });

  test("map", () => {
    expect(terraformPlaceholder("map(string)")).toEqual({});
    expect(terraformPlaceholder("map(number)")).toEqual({});
  });

  test("an object gets a stand-in per attribute, optional ones by their inner type", () => {
    expect(terraformPlaceholder("object({ id = string, port = number, public = optional(bool, true) })")).toEqual({
      id: TERRAFORM_UNKNOWN_MARK,
      port: 0,
      public: false,
    });
    expect(terraformPlaceholder("object({\n  id   = string\n  tags = map(string)\n})")).toEqual({ id: TERRAFORM_UNKNOWN_MARK, tags: {} });
  });

  test("a tuple gets a stand-in per element", () => {
    expect(terraformPlaceholder("tuple([string, number])")).toEqual([TERRAFORM_UNKNOWN_MARK, 0]);
  });

  test("no type, any, or a type in the old interpolated form reads as its type", () => {
    expect(terraformPlaceholder(undefined)).toBe(TERRAFORM_UNKNOWN_MARK);
    expect(terraformPlaceholder("any")).toBe(TERRAFORM_UNKNOWN_MARK);
    expect(terraformPlaceholder("${number}")).toBe(0);
  });
});

describe("placeholderVars (#4463)", () => {
  const declared = new Map([
    ["vpc_id", { type: "string" }],
    ["size", { type: "number" }],
    ["name", { type: "string" }],
  ]);

  test("fills each variable that holds nothing with its typed stand-in, and keeps the rest", () => {
    expect(placeholderVars({ vpc_id: undefined, size: undefined, name: "app" }, declared)).toEqual({
      placeholders: ["size", "vpc_id"],
      vars: { vpc_id: TERRAFORM_UNKNOWN_MARK, size: 0, name: "app" },
    });
  });

  test("says why when no preview can be made", () => {
    expect(placeholderVars({ name: "app" }, declared)).toBe("no variable of the step holds the unknown read");
    expect(placeholderVars({ subnet: undefined }, declared)).toMatch(/declares no variable "subnet"/);
    expect(placeholderVars({ name: { id: undefined } }, declared)).toMatch(/inside var\.name/);
  });
});

describe("markPlaceholderDriven (#4463)", () => {
  const plan = {
    configuration: {
      root_module: {
        resources: [
          {
            address: "aws_subnet.a",
            mode: "managed",
            type: "aws_subnet",
            name: "a",
            expressions: { vpc_id: { references: ["var.vpc_id"] }, cidr_block: { constant_value: "10.0.1.0/24" } },
          },
        ],
        module_calls: {
          net: {
            expressions: { parent: { references: ["var.vpc_id"] } },
            module: {
              resources: [{ address: "aws_route_table.rt", mode: "managed", type: "aws_route_table", name: "rt", expressions: { vpc_id: { references: ["var.parent"] } } }],
            },
          },
        },
        outputs: { subnet_vpc: { expression: { references: ["var.vpc_id"] } }, cidr: { expression: { constant_value: "10.0.1.0/24" } } },
      },
    },
    resource_changes: [
      {
        address: "aws_subnet.a",
        mode: "managed",
        type: "aws_subnet",
        name: "a",
        change: { actions: ["create"], before: null, after: { vpc_id: TERRAFORM_UNKNOWN_MARK, cidr_block: "10.0.1.0/24" }, after_unknown: { id: true } },
      },
      {
        address: "module.net.aws_route_table.rt",
        module_address: "module.net",
        mode: "managed",
        type: "aws_route_table",
        name: "rt",
        change: { actions: ["create"], before: null, after: { vpc_id: TERRAFORM_UNKNOWN_MARK }, after_unknown: {} },
      },
    ],
    planned_values: { outputs: { subnet_vpc: { value: TERRAFORM_UNKNOWN_MARK }, cidr: { value: "10.0.1.0/24" } } },
    output_changes: { subnet_vpc: { actions: ["create"], after: TERRAFORM_UNKNOWN_MARK, after_unknown: false }, cidr: { actions: ["create"], after: "10.0.1.0/24", after_unknown: false } },
  };

  test("marks what the stand-ins drive unknown, through module inputs and outputs, and leaves the rest", () => {
    const marked = markPlaceholderDriven(plan, ["vpc_id"]);
    if (!("plan" in marked)) throw new Error(marked.refused);
    const out = marked.plan as typeof plan;
    expect(out.resource_changes[0]!.change).toEqual({ actions: ["create"], before: null, after: { cidr_block: "10.0.1.0/24" }, after_unknown: { id: true, vpc_id: true } });
    expect(out.resource_changes[1]!.change.after_unknown).toEqual({ vpc_id: true });
    expect(out.output_changes.subnet_vpc).toEqual({ actions: ["create"], after_unknown: true });
    expect(out.output_changes.cidr.after).toBe("10.0.1.0/24");
    expect(out.planned_values.outputs).toEqual({ cidr: { value: "10.0.1.0/24" } });
    // The input is left as it was.
    expect(plan.resource_changes[0]!.change.after.vpc_id).toBe(TERRAFORM_UNKNOWN_MARK);
  });

  test("refuses a count or for_each that reads a stand-in", () => {
    const counted = structuredClone(plan) as Record<string, any>;
    counted.configuration.root_module.resources[0].count_expression = { references: ["var.vpc_id"] };
    expect(markPlaceholderDriven(counted, ["vpc_id"])).toEqual({
      refused: "the count or for_each of aws_subnet.a reads a stand-in, so the preview cannot say how many instances there are",
    });
  });
});

test("the hole a root keeps says why there is no preview (#4463)", () => {
  expect(waitingHole("app", ["net"])).toEqual({ address: "app", type: "terraform_root", reason: "inputs from net; planned again once they apply" });
  expect(waitingHole("app", ["net"], "the plan with stand-in values failed: x").reason).toBe(
    "inputs from net; planned again once they apply; no preview: the plan with stand-in values failed: x",
  );
});
