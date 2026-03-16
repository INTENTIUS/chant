import { describe, it, expect } from "bun:test";
import { Azure, ResourceGroupName, ResourceGroupLocation, ResourceGroupId, SubscriptionId, TenantId, DeploymentName } from "./pseudo";

describe("Azure pseudo-parameters", () => {
  it("ResourceGroupName serializes to bracket expression", () => {
    expect(ResourceGroupName.toJSON()).toBe("[resourceGroup().name]");
  });

  it("ResourceGroupLocation serializes to bracket expression", () => {
    expect(ResourceGroupLocation.toJSON()).toBe("[resourceGroup().location]");
  });

  it("ResourceGroupId serializes to bracket expression", () => {
    expect(ResourceGroupId.toJSON()).toBe("[resourceGroup().id]");
  });

  it("SubscriptionId serializes to bracket expression", () => {
    expect(SubscriptionId.toJSON()).toBe("[subscription().subscriptionId]");
  });

  it("TenantId serializes to bracket expression", () => {
    expect(TenantId.toJSON()).toBe("[subscription().tenantId]");
  });

  it("DeploymentName serializes to bracket expression", () => {
    expect(DeploymentName.toJSON()).toBe("[deployment().name]");
  });

  it("Azure namespace contains all pseudo-parameters", () => {
    expect(Azure.ResourceGroupName).toBe(ResourceGroupName);
    expect(Azure.ResourceGroupLocation).toBe(ResourceGroupLocation);
    expect(Azure.ResourceGroupId).toBe(ResourceGroupId);
    expect(Azure.SubscriptionId).toBe(SubscriptionId);
    expect(Azure.TenantId).toBe(TenantId);
    expect(Azure.DeploymentName).toBe(DeploymentName);
  });

  it("toString returns display name", () => {
    expect(ResourceGroupName.toString()).toBe("Azure.ResourceGroupName");
    expect(SubscriptionId.toString()).toBe("Azure.SubscriptionId");
  });
});
