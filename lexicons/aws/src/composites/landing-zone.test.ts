import { describe, expect, test } from "vitest";
import { expandComposite } from "@intentius/chant";
import { AttrRef } from "@intentius/chant/attrref";
import { GovernanceFoundation, OrganizationRoot, OrganizationTrail, RegionRestriction } from "./landing-zone";

describe("GovernanceFoundation (#791)", () => {
  test("declares the foundation OUs and baseline SCPs", () => {
    const lz = GovernanceFoundation({ parentRootId: "r-abc1" });
    expect(Object.keys(lz.members)).toEqual([
      "ouSecurity",
      "ouInfrastructure",
      "ouSandbox",
      "ouWorkloads",
      "scpDenyLeaveOrganization",
      "scpDenyAuditTamper",
    ]);
  });

  test("deny-leave-organization targets the root; deny-audit-tamper targets the Security OU", () => {
    const lz = GovernanceFoundation({ parentRootId: "r-abc1" });
    expect((lz.scpDenyLeaveOrganization as any).props.TargetIds).toEqual(["r-abc1"]);
    const tamperTargets = (lz.scpDenyAuditTamper as any).props.TargetIds;
    expect(tamperTargets).toHaveLength(1);
    expect(tamperTargets[0]).toBeInstanceOf(AttrRef);
  });

  test("brownfield and greenfield wire the same way", () => {
    const org = OrganizationRoot({});
    const green = GovernanceFoundation({ parentRootId: org.organization.RootId });
    expect((green.ouSecurity as any).props.ParentId).toBeInstanceOf(AttrRef);
    const brown = GovernanceFoundation({ parentRootId: "r-live" });
    expect((brown.ouSecurity as any).props.ParentId).toBe("r-live");
  });

  test("expandComposite produces prefixed logical names", () => {
    const expanded = expandComposite("lz", GovernanceFoundation({ parentRootId: "r-abc1" }));
    expect([...expanded.keys()]).toContain("lzOuSecurity");
    expect([...expanded.keys()]).toContain("lzScpDenyAuditTamper");
    expect(expanded.size).toBe(6);
  });

  test("RegionRestriction and OrganizationTrail carry the optional guardrails", () => {
    const rr = RegionRestriction({ regions: ["eu-west-1"], targetIds: ["r-abc1"] });
    const doc = (rr.scpRegionRestriction as any).props.Content;
    expect(JSON.stringify(doc)).toContain("eu-west-1");
    const trail = OrganizationTrail({ bucket: "acme-audit" });
    expect((trail.trail as any).props).toMatchObject({
      S3BucketName: "acme-audit",
      IsOrganizationTrail: true,
      IsLogging: true,
    });
  });
});
