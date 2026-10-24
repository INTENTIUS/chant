import { describe, expect, it } from "vitest";
import { CapabilityRegistry } from "@intentius/chant/components/capability";
import { registerCapabilityPlugins } from "@intentius/chant/components/capability-plugin-loader";
import { starterCapabilityPlugin } from "@intentius/chant/components/starter-plugin";
import { createMockProcessRunner } from "@intentius/chant/components/verbs/__tests__/mock-process-runner";
import { awsCapabilityPlugin } from "@intentius/chant-lexicon-aws/components";
import { gcpCapabilityPlugin } from "@intentius/chant-lexicon-gcp/components";
import { azureCapabilityPlugin } from "./capability-plugin";
import { createAcrRegistryBackend } from "./acr-backend";

describe("ACR registry backend (#3142)", () => {
  it("matches azurecr hosts only", () => {
    const b = createAcrRegistryBackend(createMockProcessRunner().runner);
    expect(b.matches("myreg.azurecr.io")).toBe(true);
    expect(b.matches("123.dkr.ecr.us-east-1.amazonaws.com")).toBe(false);
  });

  it("logs in with az acr login by registry name", async () => {
    const mock = createMockProcessRunner();
    await createAcrRegistryBackend(mock.runner).login("myreg.azurecr.io");
    expect(mock.calls.map((c) => c.command)).toEqual(["az acr login --name 'myreg'"]);
  });

  it("refuses a host that is not an ACR", async () => {
    await expect(createAcrRegistryBackend(createMockProcessRunner().runner).login("example.com")).rejects.toThrow(/not an Azure Container Registry/);
  });
});

describe("a project declaring aws plus azure plus gcp (#3142, #3143)", () => {
  it("loads without a duplicate-verb error and keeps one publish-image", () => {
    const registry = registerCapabilityPlugins(new CapabilityRegistry(), [
      starterCapabilityPlugin,
      awsCapabilityPlugin,
      azureCapabilityPlugin,
      gcpCapabilityPlugin,
    ]);
    expect(registry.has("publish-image")).toBe(true);
    expect(registry.has("arm-deploy")).toBe(true);
    expect(registry.has("gcp-apply")).toBe(true);
    expect(registry.has("cfn-deploy")).toBe(true);
    const backends = [awsCapabilityPlugin, azureCapabilityPlugin, gcpCapabilityPlugin].flatMap((p) => p.registryBackends?.() ?? []);
    expect(backends.map((b) => b.name).sort()).toEqual(["acr", "artifact-registry", "ecr"]);
  });

  it("no lexicon registers publish-image itself", () => {
    for (const p of [awsCapabilityPlugin, azureCapabilityPlugin, gcpCapabilityPlugin]) {
      expect(p.capabilities().map((c) => c.kind)).not.toContain("publish-image");
    }
  });
});
