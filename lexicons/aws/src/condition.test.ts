import { describe, test, expect } from "vitest";
import { Condition, isCondition, CONDITION_ENTITY_TYPE } from "./condition";
import { Equals, And, Or, Not, If, Ref } from "./intrinsics";
import { Parameter } from "./parameter";
import { awsSerializer } from "./serializer";
import { stackOutput } from "@intentius/chant/stack-output";
import { createResource } from "@intentius/chant/runtime";
import { resolveAttrRefs } from "@intentius/chant/discovery/resolve";
import type { Declarable } from "@intentius/chant/declarable";

const LogGroup = createResource("AWS::Logs::LogGroup", "aws", {});

function serialize(entities: Map<string, Declarable>): Record<string, any> {
  resolveAttrRefs(entities);
  return JSON.parse(awsSerializer.serialize(entities) as string);
}

describe("Condition declarable", () => {
  test("carries the aws lexicon and the condition entity type", () => {
    const cond = new Condition(Equals("a", "b"));
    expect(cond.lexicon).toBe("aws");
    expect(cond.entityType).toBe(CONDITION_ENTITY_TYPE);
    expect(isCondition(cond)).toBe(true);
    expect(isCondition(new Parameter("String"))).toBe(false);
    expect(isCondition("DoCutover")).toBe(false);
  });

  test("rejects a non-intrinsic expression", () => {
    expect(() => new Condition("true" as never)).toThrow(/condition intrinsic/);
  });
});

describe("condition intrinsics", () => {
  test("Equals resolves value intrinsics", () => {
    const param = new Parameter("String");
    const entities = new Map<string, Declarable>([["Cutover", param]]);
    resolveAttrRefs(entities);
    expect(JSON.parse(JSON.stringify(Equals(Ref(param), "true")))).toEqual({
      "Fn::Equals": [{ Ref: "Cutover" }, "true"],
    });
  });

  test("Not over a Condition declarable emits the Condition reference form", () => {
    const cond = new Condition(Equals("a", "b"));
    const entities = new Map<string, Declarable>([["DoCutover", cond]]);
    resolveAttrRefs(entities);
    expect(JSON.parse(JSON.stringify(Not(cond)))).toEqual({
      "Fn::Not": [{ Condition: "DoCutover" }],
    });
  });

  test("And/Or accept names, declarables, and nested intrinsics", () => {
    expect(JSON.parse(JSON.stringify(And("A", Equals("x", "y"))))).toEqual({
      "Fn::And": [{ Condition: "A" }, { "Fn::Equals": ["x", "y"] }],
    });
    expect(JSON.parse(JSON.stringify(Or("A", Not("B"))))).toEqual({
      "Fn::Or": [{ Condition: "A" }, { "Fn::Not": [{ Condition: "B" }] }],
    });
  });

  test("And/Or enforce CloudFormation's 2–10 operand bounds", () => {
    expect(() => And("A")).toThrow(/between 2 and 10/);
    expect(() => Or("A")).toThrow(/between 2 and 10/);
    const eleven = Array.from({ length: 11 }, (_, i) => `C${i}`);
    expect(() => And(...eleven)).toThrow(/between 2 and 10/);
  });

  test("If accepts the Condition declarable as the condition", () => {
    const cond = new Condition(Equals("a", "b"));
    const entities = new Map<string, Declarable>([["DoCutover", cond]]);
    resolveAttrRefs(entities);
    expect(JSON.parse(JSON.stringify(If(cond, "on", "off")))).toEqual({
      "Fn::If": ["DoCutover", "on", "off"],
    });
  });
});

describe("serializer Conditions section (#2068)", () => {
  test("Condition declarables are lifted into Conditions", () => {
    const param = new Parameter("String", { defaultValue: "false" });
    const doCutover = new Condition(Equals(Ref(param), "true"));
    const noCutover = new Condition(Not(doCutover));
    const template = serialize(
      new Map<string, Declarable>([
        ["Cutover", param],
        ["DoCutover", doCutover],
        ["NoCutover", noCutover],
      ]),
    );
    expect(template.Conditions).toEqual({
      DoCutover: { "Fn::Equals": [{ Ref: "Cutover" }, "true"] },
      NoCutover: { "Fn::Not": [{ Condition: "DoCutover" }] },
    });
    // Never emitted as a Resource
    expect(template.Resources).toEqual({});
  });

  test("resource-level Condition accepts the declarable as well as a string", () => {
    const doCutover = new Condition(Equals("a", "b"));
    const byRef = new LogGroup({ RetentionInDays: 7 }, { Condition: doCutover });
    const byName = new LogGroup({ RetentionInDays: 7 }, { Condition: "DoCutover" });
    const template = serialize(
      new Map<string, Declarable>([
        ["DoCutover", doCutover],
        ["ByRef", byRef],
        ["ByName", byName],
      ]),
    );
    expect(template.Resources.ByRef.Condition).toBe("DoCutover");
    expect(template.Resources.ByName.Condition).toBe("DoCutover");
  });

  test("stackOutput condition emits the output-level Condition key", () => {
    const doCutover = new Condition(Equals("a", "b"));
    const group = new LogGroup({ RetentionInDays: 7 }, { Condition: doCutover });
    const out = stackOutput(Ref(group), { condition: doCutover });
    const outByName = stackOutput(Ref(group), { condition: "DoCutover" });
    const template = serialize(
      new Map<string, Declarable>([
        ["DoCutover", doCutover],
        ["Rule", group],
        ["RuleName", out],
        ["RuleNameByName", outByName],
      ]),
    );
    expect(template.Outputs.RuleName).toEqual({ Value: { Ref: "Rule" }, Condition: "DoCutover" });
    expect(template.Outputs.RuleNameByName.Condition).toBe("DoCutover");
  });
});
