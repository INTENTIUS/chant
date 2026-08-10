import { describe, expect, test } from "vitest";
import { expandComposite } from "@intentius/chant";
import { GovernanceFoundation, LocationRestriction, OrganizationAuditConfig } from "./landing-zone";

/** Helper to extract props from a Declarable member. */
function p(member: unknown): Record<string, any> {
  return (member as any).props;
}

describe("GovernanceFoundation", () => {
  test("declares the foundation folders and baseline org policies", () => {
    const lz = GovernanceFoundation({ orgId: "123456789012" });
    expect(Object.keys(lz.members)).toEqual([
      "folderSecurity",
      "folderInfrastructure",
      "folderSandbox",
      "folderWorkloads",
      "policyDisableSaKeyCreation",
      "policySkipDefaultNetwork",
    ]);
  });

  test("folders hang off the organization; policies bind their constraints at the root", () => {
    const lz = GovernanceFoundation({ orgId: "123456789012" });
    expect(p(lz.folderSecurity).displayName).toBe("Security");
    expect(p(lz.folderSecurity).organizationRef).toEqual({ external: "123456789012" });
    expect(p(lz.policyDisableSaKeyCreation).resourceID).toBe("iam.disableServiceAccountKeyCreation");
    expect(p(lz.policyDisableSaKeyCreation).organizationRef).toEqual({ external: "123456789012" });
    expect(p(lz.policyDisableSaKeyCreation).spec.rules).toEqual([{ enforce: "TRUE" }]);
    expect(p(lz.policySkipDefaultNetwork).resourceID).toBe("compute.skipDefaultNetworkCreation");
  });

  test("orgId accepts both the bare number and the organizations/ prefix", () => {
    const prefixed = GovernanceFoundation({ orgId: "organizations/123456789012" });
    expect(p(prefixed.folderSandbox).organizationRef).toEqual({ external: "123456789012" });
  });

  test("namespace flows to every member", () => {
    const lz = GovernanceFoundation({ orgId: "123456789012", namespace: "governance" });
    expect(p(lz.folderWorkloads).metadata.namespace).toBe("governance");
    expect(p(lz.policySkipDefaultNetwork).metadata.namespace).toBe("governance");
  });

  test("expandComposite produces prefixed logical names", () => {
    const expanded = expandComposite("lz", GovernanceFoundation({ orgId: "123456789012" }));
    expect([...expanded.keys()]).toContain("lzFolderSecurity");
    expect([...expanded.keys()]).toContain("lzPolicyDisableSaKeyCreation");
    expect(expanded.size).toBe(6);
  });

  test("LocationRestriction and OrganizationAuditConfig carry the optional guardrails", () => {
    const lr = LocationRestriction({ orgId: "123456789012", locations: ["in:eu-locations"] });
    expect(p(lr.policyResourceLocations).resourceID).toBe("gcp.resourceLocations");
    expect(JSON.stringify(p(lr.policyResourceLocations).spec.rules)).toContain("in:eu-locations");

    const ac = OrganizationAuditConfig({ orgId: "organizations/123456789012" });
    expect(p(ac.auditConfig)).toMatchObject({
      resourceRef: { kind: "Organization", external: "organizations/123456789012" },
      service: "allServices",
    });
    expect(p(ac.auditConfig).auditLogConfigs).toEqual([
      { logType: "ADMIN_READ" },
      { logType: "DATA_READ" },
      { logType: "DATA_WRITE" },
    ]);
  });
});
