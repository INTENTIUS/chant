import { describe, test, expect } from "bun:test";
import { nestedStack, isNestedStackInstance, NestedStackOutputRef, NESTED_STACK_MARKER } from "./nested-stack";
import { DECLARABLE_MARKER, isDeclarable } from "@intentius/chant/declarable";
import { CHILD_PROJECT_MARKER, isChildProject } from "@intentius/chant/child-project";
import { INTRINSIC_MARKER } from "@intentius/chant/intrinsic";

describe("nestedStack", () => {
  test("creates a nested stack with correct markers", () => {
    const stack = nestedStack("network", "/path/to/network");

    expect(isNestedStackInstance(stack)).toBe(true);
    expect(isChildProject(stack)).toBe(true);
    expect(isDeclarable(stack)).toBe(true);
    expect((stack as any)[NESTED_STACK_MARKER]).toBe(true);
    expect((stack as any)[CHILD_PROJECT_MARKER]).toBe(true);
    expect((stack as any)[DECLARABLE_MARKER]).toBe(true);
  });

  test("has correct metadata", () => {
    const stack = nestedStack("network", "/path/to/network");

    expect(stack.lexicon).toBe("aws");
    expect(stack.entityType).toBe("AWS::CloudFormation::Stack");
    expect(stack.kind).toBe("resource");
    expect(stack.logicalName).toBe("network");
    expect(stack.projectPath).toBe("/path/to/network");
  });

  test("outputs proxy returns NestedStackOutputRef", () => {
    const stack = nestedStack("network", "/path/to/network");

    const ref = stack.outputs.vpcId;
    expect(ref).toBeInstanceOf(NestedStackOutputRef);
    expect((ref as NestedStackOutputRef).stackName).toBe("network");
    expect((ref as NestedStackOutputRef).outputName).toBe("vpcId");
  });

  test("accepts options with parameters", () => {
    const stack = nestedStack("network", "/path/to/network", {
      parameters: { Environment: "prod" },
    });

    expect(stack.options).toEqual({ parameters: { Environment: "prod" } });
  });

  test("defaults options to empty object", () => {
    const stack = nestedStack("network", "/path/to/network");
    expect(stack.options).toEqual({});
  });
});

describe("NestedStackOutputRef", () => {
  test("stores stackName and outputName", () => {
    const ref = new NestedStackOutputRef("network", "vpcId");
    expect(ref.stackName).toBe("network");
    expect(ref.outputName).toBe("vpcId");
  });

  test("has INTRINSIC_MARKER", () => {
    const ref = new NestedStackOutputRef("network", "vpcId");
    expect((ref as any)[INTRINSIC_MARKER]).toBe(true);
  });

  test("serializes to Fn::GetAtt", () => {
    const ref = new NestedStackOutputRef("network", "vpcId");
    expect(ref.toJSON()).toEqual({
      "Fn::GetAtt": ["network", "Outputs.vpcId"],
    });
  });
});

describe("isNestedStackInstance", () => {
  test("returns true for nested stack", () => {
    const stack = nestedStack("test", "/path");
    expect(isNestedStackInstance(stack)).toBe(true);
  });

  test("returns false for plain object", () => {
    expect(isNestedStackInstance({})).toBe(false);
    expect(isNestedStackInstance(null)).toBe(false);
    expect(isNestedStackInstance("string")).toBe(false);
  });
});
