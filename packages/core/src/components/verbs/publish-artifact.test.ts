import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  createPublishArtifactCapability,
  selectStorageBackend,
  type ArtifactStorageBackend,
} from "./publish-artifact";

function fake(name: string, prefix: string) {
  const uploads: Array<{ from: string; to: string }> = [];
  const backend: ArtifactStorageBackend = {
    name,
    matches: (uri) => uri.startsWith(prefix),
    upload: async (args) => void uploads.push(args),
  };
  return { backend, uploads };
}

describe("selectStorageBackend (#4408)", () => {
  const s3 = fake("s3", "s3://").backend;
  const gcs = fake("gcs", "gs://").backend;
  it("prefers a named backend, then the matching one, then the only one", () => {
    expect(selectStorageBackend([s3, gcs], "s3://b/k", "gcs")).toBe(gcs);
    expect(selectStorageBackend([s3, gcs], "gs://b/k")).toBe(gcs);
    expect(selectStorageBackend([s3], "weird://x")).toBe(s3);
  });
  it("refuses an unknown name, an ambiguous match and an undecidable pick", () => {
    expect(() => selectStorageBackend([s3], "s3://b/k", "nope")).toThrow(/no storage backend "nope"/);
    expect(() => selectStorageBackend([s3, fake("s3b", "s3://").backend], "s3://b/k")).toThrow(/matches several/);
    expect(() => selectStorageBackend([s3, gcs], "weird://x")).toThrow(/cannot tell/);
  });
});

describe("publish-artifact (core)", () => {
  it("uploads through the backend the environment names and returns uri + digest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-pa-core-"));
    const file = join(dir, "app.jar");
    writeFileSync(file, "JAR");
    const a = fake("s3", "s3://");
    const b = fake("gcs", "gs://");
    const cap = createPublishArtifactCapability({ backends: [a.backend, b.backend] });
    const out = await cap.run({ env: "dev", component: "c", vars: { publish: { backend: "gcs" } } } as never, { from: file, to: "gs://bk/jars/" });
    expect(out).toEqual({ uri: "gs://bk/jars/app.jar", digest: `sha256:${createHash("sha256").update("JAR").digest("hex")}` });
    expect(b.uploads).toEqual([{ from: file, to: "gs://bk/jars/app.jar" }]);
    expect(a.uploads).toEqual([]);
  });

  it("withStorageBackends rebinds the verb", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-pa-core-"));
    const file = join(dir, "x.zip");
    writeFileSync(file, "Z");
    const a = fake("s3", "s3://");
    const cap = createPublishArtifactCapability().withStorageBackends([a.backend]) as ReturnType<typeof createPublishArtifactCapability>;
    await cap.run({ env: "dev", component: "c" } as never, { from: file, to: "s3://b/x.zip" });
    expect(a.uploads).toHaveLength(1);
  });
});
