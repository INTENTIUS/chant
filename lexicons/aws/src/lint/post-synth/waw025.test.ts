import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw025, checkSnsEncryption } from "./waw025";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW025: SNS Topic Not Encrypted", () => {
  test("check metadata", () => {
    expect(waw025.id).toBe("WAW025");
    expect(waw025.description).toContain("encrypted");
  });

  test("flags topic without KmsMasterKeyId", () => {
    const ctx = makeCtx({
      Resources: {
        MyTopic: {
          Type: "AWS::SNS::Topic",
          Properties: { TopicName: "my-topic" },
        },
      },
    });
    const diags = checkSnsEncryption(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW025");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic when KmsMasterKeyId is set", () => {
    const ctx = makeCtx({
      Resources: {
        MyTopic: {
          Type: "AWS::SNS::Topic",
          Properties: { KmsMasterKeyId: "alias/my-key" },
        },
      },
    });
    const diags = checkSnsEncryption(ctx);
    expect(diags).toHaveLength(0);
  });
});
