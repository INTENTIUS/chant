import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw027, checkDynamoDbPitr } from "./waw027";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW027: DynamoDB Missing PITR", () => {
  test("check metadata", () => {
    expect(waw027.id).toBe("WAW027");
    expect(waw027.description).toContain("point-in-time");
  });

  test("flags table without PITR", () => {
    const ctx = makeCtx({
      Resources: {
        MyTable: {
          Type: "AWS::DynamoDB::Table",
          Properties: {
            TableName: "my-table",
            KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
            AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
          },
        },
      },
    });
    const diags = checkDynamoDbPitr(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW027");
    expect(diags[0].severity).toBe("info");
  });

  test("no diagnostic when PITR is enabled", () => {
    const ctx = makeCtx({
      Resources: {
        MyTable: {
          Type: "AWS::DynamoDB::Table",
          Properties: {
            PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
          },
        },
      },
    });
    const diags = checkDynamoDbPitr(ctx);
    expect(diags).toHaveLength(0);
  });

  test("flags when PITR spec present but not enabled", () => {
    const ctx = makeCtx({
      Resources: {
        MyTable: {
          Type: "AWS::DynamoDB::Table",
          Properties: {
            PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
          },
        },
      },
    });
    const diags = checkDynamoDbPitr(ctx);
    expect(diags).toHaveLength(1);
  });
});
