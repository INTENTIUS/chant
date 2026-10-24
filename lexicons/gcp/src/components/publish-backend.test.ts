import { describe, expect, it } from "vitest";
import { createMockProcessRunner } from "@intentius/chant/components/verbs/__tests__/mock-process-runner";
import { createArtifactRegistryBackend } from "./artifact-registry-backend";
import { gcpCapabilityPlugin } from "./capability-plugin";

describe("Artifact Registry backend (#3143)", () => {
  it("matches Artifact Registry and gcr hosts only", () => {
    const b = createArtifactRegistryBackend(createMockProcessRunner().runner);
    expect(b.matches("us-central1-docker.pkg.dev")).toBe(true);
    expect(b.matches("gcr.io")).toBe(true);
    expect(b.matches("eu.gcr.io")).toBe(true);
    expect(b.matches("x.azurecr.io")).toBe(false);
  });

  it("logs in with gcloud auth configure-docker", async () => {
    const mock = createMockProcessRunner();
    await createArtifactRegistryBackend(mock.runner).login("us-central1-docker.pkg.dev");
    expect(mock.calls.map((c) => c.command)).toEqual(["gcloud auth configure-docker 'us-central1-docker.pkg.dev' --quiet"]);
  });

  it("refuses a host that is not Artifact Registry", async () => {
    await expect(createArtifactRegistryBackend(createMockProcessRunner().runner).login("example.com")).rejects.toThrow(/not an Artifact Registry host/);
  });

  it("the plugin contributes the backend and not the verb", () => {
    expect(gcpCapabilityPlugin.registryBackends?.().map((b) => b.name)).toEqual(["artifact-registry"]);
    expect(gcpCapabilityPlugin.capabilities().map((c) => c.kind)).toEqual(["gcp-apply", "wait-for-operation", "wait-cloud-run-ready"]);
  });
});
