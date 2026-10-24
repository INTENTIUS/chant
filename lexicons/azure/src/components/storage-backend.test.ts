import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityRegistry } from "@intentius/chant/components/capability";
import { registerCapabilityPlugins } from "@intentius/chant/components/capability-plugin-loader";
import { starterCapabilityPlugin } from "@intentius/chant/components/starter-plugin";
import { createPublishArtifactCapability } from "@intentius/chant/components/verbs/publish-artifact";
import { createMockProcessRunner } from "@intentius/chant/components/verbs/__tests__/mock-process-runner";
import { awsCapabilityPlugin } from "@intentius/chant-lexicon-aws/components";
import { gcpCapabilityPlugin, createGcsStorageBackend } from "@intentius/chant-lexicon-gcp/components";
import { azureCapabilityPlugin } from "./capability-plugin";
import { createAzureBlobStorageBackend } from "./blob-backend";

describe("Azure Blob storage backend (#4408)", () => {
  it("matches blob hosts only", () => {
    const b = createAzureBlobStorageBackend(createMockProcessRunner().runner);
    expect(b.matches("https://acct.blob.core.windows.net/c/a.jar")).toBe(true);
    expect(b.matches("s3://bucket/a.jar")).toBe(false);
  });

  it("uploads with az storage blob upload", async () => {
    const mock = createMockProcessRunner();
    await createAzureBlobStorageBackend(mock.runner).upload({ from: "/tmp/a.jar", to: "https://acct.blob.core.windows.net/cont/jars/a.jar" });
    expect(mock.calls.map((c) => c.command)).toEqual([
      "az storage blob upload --account-name 'acct' --container-name 'cont' --name 'jars/a.jar' --file '/tmp/a.jar' --overwrite --auth-mode login",
    ]);
  });

  it("refuses a URI that is not a blob", async () => {
    await expect(createAzureBlobStorageBackend(createMockProcessRunner().runner).upload({ from: "/a", to: "https://example.com/x" })).rejects.toThrow(/not a blob URI/);
  });
});

describe("a project declaring aws plus azure plus gcp (#4408)", () => {
  it("registers one publish-artifact and exposes three storage backends", () => {
    const registry = registerCapabilityPlugins(new CapabilityRegistry(), [
      starterCapabilityPlugin,
      awsCapabilityPlugin,
      azureCapabilityPlugin,
      gcpCapabilityPlugin,
    ]);
    expect(registry.has("publish-artifact")).toBe(true);
    const plugins = [awsCapabilityPlugin, azureCapabilityPlugin, gcpCapabilityPlugin];
    expect(plugins.flatMap((p) => p.storageBackends?.() ?? []).map((b) => b.name).sort()).toEqual(["azure-blob", "gcs", "s3"]);
    for (const p of plugins) expect(p.capabilities().map((c) => c.kind)).not.toContain("publish-artifact");
  });

  it("routes by destination URI to the right mocked backend", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-pa-"));
    const file = join(dir, "a.jar");
    writeFileSync(file, "J");
    const az = createMockProcessRunner();
    const gc = createMockProcessRunner();
    const cap = createPublishArtifactCapability({
      backends: [createAzureBlobStorageBackend(az.runner), createGcsStorageBackend(gc.runner)],
    });
    const ctx = { env: "dev", component: "c" } as never;
    await cap.run(ctx, { from: file, to: "gs://bk/a.jar" });
    await cap.run(ctx, { from: file, to: "https://acct.blob.core.windows.net/c/a.jar" });
    expect(gc.calls.map((c) => c.command)).toEqual([`gcloud storage cp '${file}' 'gs://bk/a.jar'`]);
    expect(az.calls).toHaveLength(1);
  });
});
