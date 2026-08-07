import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw057, checkScpUnattached } from "./waw057";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

const DENY = { Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: "*", Resource: "*" }] };

function scp(targetIds?: unknown) {
  return {
    Type: "AWS::Organizations::Policy",
    Properties: {
      Name: "guard",
      Type: "SERVICE_CONTROL_POLICY",
      Content: DENY,
      ...(targetIds !== undefined ? { TargetIds: targetIds } : {}),
    },
  };
}

describe("WAW057: SCP guardrail attached to no targets", () => {
  test("check metadata", () => {
    expect(waw057.id).toBe("WAW057");
    expect(waw057.description).toContain("targets");
  });

  test("flags an SCP with no TargetIds", () => {
    const ctx = makeCtx({ Resources: { Guard: scp() } });
    const diags = checkScpUnattached(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW057");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("Guard");
  });

  test("flags an SCP with an empty TargetIds array", () => {
    const ctx = makeCtx({ Resources: { Guard: scp([]) } });
    expect(checkScpUnattached(ctx)).toHaveLength(1);
  });

  test("no diagnostic when TargetIds has entries (including intrinsics)", () => {
    const ctx = makeCtx({
      Resources: {
        Root: scp(["r-1"]),
        ByRef: scp([{ "Fn::GetAtt": ["Org", "RootId"] }]),
      },
    });
    expect(checkScpUnattached(ctx)).toHaveLength(0);
  });

  test("skips intrinsic TargetIds and non-SCP policy types", () => {
    const ctx = makeCtx({
      Resources: {
        Intrinsic: scp({ Ref: "Targets" }),
        TagPolicy: {
          Type: "AWS::Organizations::Policy",
          Properties: { Name: "tags", Type: "TAG_POLICY", Content: DENY },
        },
      },
    });
    expect(checkScpUnattached(ctx)).toHaveLength(0);
  });
});
