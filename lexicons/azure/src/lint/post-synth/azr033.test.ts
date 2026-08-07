import { describe, expect, test } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr033 } from "./azr033";

function makeCtx(template: object) {
  return createPostSynthContext({ azure: template });
}

const SCHEMA = "https://schema.management.azure.com/schemas/2019-08-01/tenantDeploymentTemplate.json#";

function tenantPolicy(block: boolean) {
  return {
    $schema: SCHEMA,
    contentVersion: "1.0.0.0",
    resources: [
      {
        type: "Microsoft.Subscription/policies",
        apiVersion: "2021-10-01",
        name: "default",
        properties: { blockSubscriptionsLeavingTenant: block },
      },
    ],
  };
}

describe("AZR033: subscriptions may leave the tenant", () => {
  test("flags blockSubscriptionsLeavingTenant: false", () => {
    const diags = azr033.check(makeCtx(tenantPolicy(false)));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR033");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("default");
  });

  test("no diagnostic when the leave-block is on", () => {
    expect(azr033.check(makeCtx(tenantPolicy(true)))).toHaveLength(0);
  });

  test("ignores other resource types", () => {
    const ctx = makeCtx({
      $schema: SCHEMA,
      contentVersion: "1.0.0.0",
      resources: [
        { type: "Microsoft.Management/managementGroups", apiVersion: "2023-04-01", name: "Security", properties: {} },
      ],
    });
    expect(azr033.check(ctx)).toHaveLength(0);
  });
});
