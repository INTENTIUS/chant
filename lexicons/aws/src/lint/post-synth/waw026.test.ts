import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw026, checkSqsEncryption } from "./waw026";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW026: SQS Queue Not Encrypted", () => {
  test("check metadata", () => {
    expect(waw026.id).toBe("WAW026");
    expect(waw026.description).toContain("encrypted");
  });

  test("flags queue without encryption", () => {
    const ctx = makeCtx({
      Resources: {
        MyQueue: {
          Type: "AWS::SQS::Queue",
          Properties: { QueueName: "my-queue" },
        },
      },
    });
    const diags = checkSqsEncryption(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW026");
  });

  test("no diagnostic with SqsManagedSseEnabled", () => {
    const ctx = makeCtx({
      Resources: {
        MyQueue: {
          Type: "AWS::SQS::Queue",
          Properties: { SqsManagedSseEnabled: true },
        },
      },
    });
    const diags = checkSqsEncryption(ctx);
    expect(diags).toHaveLength(0);
  });

  test("no diagnostic with KmsMasterKeyId", () => {
    const ctx = makeCtx({
      Resources: {
        MyQueue: {
          Type: "AWS::SQS::Queue",
          Properties: { KmsMasterKeyId: "alias/my-key" },
        },
      },
    });
    const diags = checkSqsEncryption(ctx);
    expect(diags).toHaveLength(0);
  });
});
