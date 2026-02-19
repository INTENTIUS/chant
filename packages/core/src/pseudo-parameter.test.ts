import { describe, expect, test } from "bun:test";
import { PseudoParameter, createPseudoParameters } from "./pseudo-parameter";
import { INTRINSIC_MARKER } from "./intrinsic";

describe("PseudoParameter", () => {
  test("toJSON returns Ref object", () => {
    const p = new PseudoParameter("AWS::StackName");
    expect(p.toJSON()).toEqual({ Ref: "AWS::StackName" });
  });

  test("toString returns interpolation syntax", () => {
    const p = new PseudoParameter("AWS::Region");
    expect(p.toString()).toBe("${AWS::Region}");
  });

  test("has INTRINSIC_MARKER", () => {
    const p = new PseudoParameter("AWS::AccountId");
    expect(p[INTRINSIC_MARKER]).toBe(true);
  });
});

describe("createPseudoParameters", () => {
  test("creates typed namespace from name map", () => {
    const params = createPseudoParameters({
      Region: "AWS::Region",
      StackName: "AWS::StackName",
    });

    expect(params.Region).toBeInstanceOf(PseudoParameter);
    expect(params.StackName).toBeInstanceOf(PseudoParameter);
    expect(params.Region.toJSON()).toEqual({ Ref: "AWS::Region" });
    expect(params.StackName.toJSON()).toEqual({ Ref: "AWS::StackName" });
  });

  test("works with empty map", () => {
    const params = createPseudoParameters({});
    expect(Object.keys(params)).toHaveLength(0);
  });
});
