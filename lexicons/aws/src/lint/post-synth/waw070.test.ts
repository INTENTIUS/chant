import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw070, checkDanglingRefs } from "./waw070";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW070: Ref or Fn::GetAtt names something the template doesn't declare", () => {
  test("check metadata", () => {
    expect(waw070.id).toBe("WAW070");
  });

  test("Fn::GetAtt to a resource not in the template → error", () => {
    const diags = checkDanglingRefs(makeCtx({
      Resources: {
        Record: { Type: "AWS::Route53::RecordSet", Properties: { ResourceRecords: [{ "Fn::GetAtt": ["app", "id"] }] } },
      },
    }));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain('Fn::GetAtt "app"');
    expect(diags[0].entity).toBe("Record");
  });

  test("Ref to something undeclared in an output → error", () => {
    const diags = checkDanglingRefs(makeCtx({
      Resources: { Bucket: { Type: "AWS::S3::Bucket" } },
      Outputs: { Name: { Value: { Ref: "Missing" } } },
    }));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('Output "Name" has Ref "Missing"');
  });

  test("resources, parameters, pseudo-parameters and the string GetAtt form are fine", () => {
    const diags = checkDanglingRefs(makeCtx({
      Parameters: { AppFqdn: { Type: "String" } },
      Resources: {
        Bucket: { Type: "AWS::S3::Bucket" },
        Record: {
          Type: "AWS::Route53::RecordSet",
          Properties: {
            ResourceRecords: [{ Ref: "AppFqdn" }],
            Comment: { "Fn::Join": ["", [{ Ref: "AWS::Region" }, { "Fn::GetAtt": "Bucket.Arn" }, { Ref: "Bucket" }]] },
          },
        },
      },
    }));
    expect(diags).toEqual([]);
  });

  test("Fn::GetAtt to a parameter → error", () => {
    const diags = checkDanglingRefs(makeCtx({
      Parameters: { P: { Type: "String" } },
      Resources: { R: { Type: "AWS::SNS::Topic", Properties: { TopicName: { "Fn::GetAtt": ["P", "X"] } } } },
    }));
    expect(diags).toHaveLength(1);
  });
});
