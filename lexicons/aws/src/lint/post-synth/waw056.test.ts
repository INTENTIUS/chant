import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw056, checkScpDeniesNothing } from "./waw056";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

function scp(content: unknown) {
  return {
    Type: "AWS::Organizations::Policy",
    Properties: { Name: "guard", Type: "SERVICE_CONTROL_POLICY", Content: content, TargetIds: ["r-1"] },
  };
}

describe("WAW056: SCP guardrail denies nothing", () => {
  test("check metadata", () => {
    expect(waw056.id).toBe("WAW056");
    expect(waw056.description).toContain("Deny");
  });

  test("flags an SCP whose statements are all Allow", () => {
    const ctx = makeCtx({
      Resources: {
        Guard: scp({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }] }),
      },
    });
    const diags = checkScpDeniesNothing(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW056");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("Guard");
  });

  test("flags an SCP with an empty Statement array", () => {
    const ctx = makeCtx({ Resources: { Guard: scp({ Version: "2012-10-17", Statement: [] }) } });
    expect(checkScpDeniesNothing(ctx)).toHaveLength(1);
  });

  test("no diagnostic when a Deny statement is present", () => {
    const ctx = makeCtx({
      Resources: {
        Guard: scp({
          Version: "2012-10-17",
          Statement: [{ Effect: "Deny", Action: "organizations:LeaveOrganization", Resource: "*" }],
        }),
      },
    });
    expect(checkScpDeniesNothing(ctx)).toHaveLength(0);
  });

  test("parses string Content and accepts a single Statement object", () => {
    const denied = makeCtx({
      Resources: {
        Guard: scp(JSON.stringify({ Statement: { Effect: "Deny", Action: "s3:*", Resource: "*" } })),
      },
    });
    expect(checkScpDeniesNothing(denied)).toHaveLength(0);

    const allowOnly = makeCtx({
      Resources: { Guard: scp(JSON.stringify({ Statement: [{ Effect: "Allow", Action: "*" }] })) },
    });
    expect(checkScpDeniesNothing(allowOnly)).toHaveLength(1);
  });

  test("skips intrinsic Content and non-SCP policy types", () => {
    const ctx = makeCtx({
      Resources: {
        Intrinsic: scp({ Ref: "PolicyDoc" }),
        TagPolicy: {
          Type: "AWS::Organizations::Policy",
          Properties: { Name: "tags", Type: "TAG_POLICY", Content: { Statement: [] } },
        },
      },
    });
    expect(checkScpDeniesNothing(ctx)).toHaveLength(0);
  });
});
