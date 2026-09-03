import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw069, checkUndeclaredConditions } from "./waw069";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW069: Template references an undeclared condition", () => {
  test("check metadata", () => {
    expect(waw069.id).toBe("WAW069");
    expect(waw069.description).toContain("condition");
  });

  test("resource Condition key referencing an undeclared condition → error", () => {
    const ctx = makeCtx({
      Resources: {
        Rule: { Type: "AWS::Logs::LogGroup", Condition: "DoCutover", Properties: { RetentionInDays: 7 } },
      },
    });
    const diags = checkUndeclaredConditions(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW069");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("DoCutover");
    expect(diags[0].entity).toBe("Rule");
  });

  test("Fn::If nested in properties referencing an undeclared condition → error", () => {
    const ctx = makeCtx({
      Resources: {
        Rule: {
          Type: "AWS::Logs::LogGroup",
          Properties: { LogGroupName: { "Fn::If": ["DoCutover", "/on", "/off"] } },
        },
      },
    });
    const diags = checkUndeclaredConditions(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Fn::If");
  });

  test("output Condition key and Condition reference inside Conditions → error", () => {
    const ctx = makeCtx({
      Conditions: { NoCutover: { "Fn::Not": [{ Condition: "DoCutover" }] } },
      Resources: { Rule: { Type: "AWS::Logs::LogGroup", Properties: {} } },
      Outputs: { RuleName: { Condition: "AlsoMissing", Value: { Ref: "Rule" } } },
    });
    const diags = checkUndeclaredConditions(ctx);
    expect(diags).toHaveLength(2);
    const names = diags.map((d) => d.message);
    expect(names.some((m) => m.includes('"DoCutover"'))).toBe(true);
    expect(names.some((m) => m.includes('"AlsoMissing"'))).toBe(true);
  });

  test("declared conditions are quiet", () => {
    const ctx = makeCtx({
      Conditions: {
        DoCutover: { "Fn::Equals": [{ Ref: "Cutover" }, "true"] },
        NoCutover: { "Fn::Not": [{ Condition: "DoCutover" }] },
      },
      Resources: {
        Rule: {
          Type: "AWS::Logs::LogGroup",
          Condition: "DoCutover",
          Properties: { LogGroupName: { "Fn::If": ["DoCutover", "/on", "/off"] } },
        },
      },
      Outputs: { RuleName: { Condition: "DoCutover", Value: { Ref: "Rule" } } },
    });
    expect(checkUndeclaredConditions(ctx)).toHaveLength(0);
  });

  test("an IAM policy Condition block is not a condition reference", () => {
    const ctx = makeCtx({
      Resources: {
        Role: {
          Type: "AWS::IAM::Role",
          Properties: {
            AssumeRolePolicyDocument: {
              Statement: [
                {
                  Effect: "Allow",
                  Condition: { StringEquals: { "aws:SourceAccount": "123456789012" } },
                },
              ],
            },
          },
        },
      },
    });
    expect(checkUndeclaredConditions(ctx)).toHaveLength(0);
  });
});
