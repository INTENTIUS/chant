import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw055, checkLogsRetention } from "./waw055";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW055: CloudWatch Logs Retention Not Set", () => {
  test("check metadata", () => {
    expect(waw055.id).toBe("WAW055");
    expect(waw055.description).toContain("retention");
  });

  test("flags a log group with no RetentionInDays", () => {
    const ctx = makeCtx({
      Resources: { MyLogs: { Type: "AWS::Logs::LogGroup", Properties: { LogGroupName: "/app/logs" } } },
    });
    const diags = checkLogsRetention(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW055");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic when RetentionInDays is set", () => {
    const ctx = makeCtx({
      Resources: { MyLogs: { Type: "AWS::Logs::LogGroup", Properties: { RetentionInDays: 90 } } },
    });
    expect(checkLogsRetention(ctx)).toHaveLength(0);
  });

  test("skips intrinsic RetentionInDays values", () => {
    const ctx = makeCtx({
      Resources: { MyLogs: { Type: "AWS::Logs::LogGroup", Properties: { RetentionInDays: { Ref: "RetentionParam" } } } },
    });
    expect(checkLogsRetention(ctx)).toHaveLength(0);
  });

  test("no diagnostic for non-LogGroup resources", () => {
    const ctx = makeCtx({ Resources: { MyBucket: { Type: "AWS::S3::Bucket", Properties: {} } } });
    expect(checkLogsRetention(ctx)).toHaveLength(0);
  });
});
