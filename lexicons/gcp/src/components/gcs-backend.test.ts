import { describe, expect, it } from "vitest";
import { createMockProcessRunner } from "@intentius/chant/components/verbs/__tests__/mock-process-runner";
import { createGcsStorageBackend } from "./gcs-backend";

describe("GCS storage backend (#4408)", () => {
  it("matches gs:// only", () => {
    const b = createGcsStorageBackend(createMockProcessRunner().runner);
    expect(b.matches("gs://b/k")).toBe(true);
    expect(b.matches("s3://b/k")).toBe(false);
  });

  it("uploads with gcloud storage cp", async () => {
    const mock = createMockProcessRunner();
    await createGcsStorageBackend(mock.runner).upload({ from: "/tmp/a.zip", to: "gs://bk/z/a.zip" });
    expect(mock.calls.map((c) => c.command)).toEqual(["gcloud storage cp '/tmp/a.zip' 'gs://bk/z/a.zip'"]);
  });

  it("refuses a non-gs destination", async () => {
    await expect(createGcsStorageBackend(createMockProcessRunner().runner).upload({ from: "/a", to: "s3://b/k" })).rejects.toThrow(/not an object URI/);
  });
});
