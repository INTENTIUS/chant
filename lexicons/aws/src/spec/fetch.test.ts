import { describe, test, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fetchSchemaZip, loadPinnedSchemas, pinAssetName, pinAssetUrl } from "./fetch";
import { specContentDigest } from "./pin";

describe("fetchSchemaZip", () => {
  test("exports fetchSchemaZip function", () => {
    expect(typeof fetchSchemaZip).toBe("function");
  });

  // Integration test - requires network, skip by default
  test.skip("fetches schema zip from AWS (integration)", async () => {
    const schemas = await fetchSchemaZip();

    // Should have many resource schemas
    expect(schemas.size).toBeGreaterThan(100);

    // Should contain common resource types
    expect(schemas.has("aws-s3-bucket.json")).toBe(true);
    expect(schemas.has("aws-lambda-function.json")).toBe(true);

    // Each schema should be valid JSON
    for (const [name, buffer] of schemas) {
      const text = new TextDecoder().decode(buffer);
      const parsed = JSON.parse(text);
      expect(parsed.typeName).toBeDefined();
    }
  });
});

// #1511 — the pinned release asset is the deterministic source: verified
// content loads (from local cache or the download), a digest mismatch refuses
// loudly wherever the bytes came from, and an unreachable asset falls back to
// the live path by returning undefined.
describe("loadPinnedSchemas (#1511)", () => {
  const schemaA = Buffer.from(JSON.stringify({ typeName: "AWS::Test::A", properties: {} }));
  const schemaB = Buffer.from(JSON.stringify({ typeName: "AWS::Test::B", properties: {} }));

  async function makeZip(): Promise<{ zip: Buffer; digest: string }> {
    const { zipSync } = await import("fflate");
    const zip = Buffer.from(zipSync({ "aws-test-a.json": schemaA, "aws-test-b.json": schemaB }));
    const digest = specContentDigest(
      new Map([
        ["AWS::Test::A", schemaA],
        ["AWS::Test::B", schemaB],
      ]),
    );
    return { zip, digest };
  }

  test("a downloaded asset that digests to the pin loads, and is cached only after verifying", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-spec-pin-"));
    try {
      const { zip, digest } = await makeZip();
      const pin = { digest, resources: 2, accepted: "2026-08-05" };
      let downloads = 0;
      const download = async () => (downloads++, zip);

      const first = await loadPinnedSchemas({ pin, cacheDir: dir, download });
      expect([...first!.keys()].sort()).toEqual(["AWS::Test::A", "AWS::Test::B"]);
      expect(downloads).toBe(1);

      // Second load: served from the verified local cache, no download.
      const second = await loadPinnedSchemas({ pin, cacheDir: dir, download });
      expect(second!.size).toBe(2);
      expect(downloads).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("content that does not digest to the pin throws, naming both digests — and is never cached", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-spec-pin-"));
    try {
      const { zip } = await makeZip();
      const pin = { digest: "sha256:" + "0".repeat(64), resources: 2, accepted: "2026-08-05" };
      let downloads = 0;
      const download = async () => (downloads++, zip);

      await expect(loadPinnedSchemas({ pin, cacheDir: dir, download })).rejects.toThrow(
        /extracts to sha256:.*declares sha256:0{8}/s,
      );
      // A second call downloads again: the bad copy must not have been cached.
      await expect(loadPinnedSchemas({ pin, cacheDir: dir, download })).rejects.toThrow();
      expect(downloads).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a corrupted local cache copy refuses the same way — cache is not more trusted than the network", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-spec-pin-"));
    try {
      const { zip, digest } = await makeZip();
      const pin = { digest, resources: 2, accepted: "2026-08-05" };
      mkdirSync(dir, { recursive: true });
      // A DIFFERENT zip planted at the pin's cache path.
      const { zipSync } = await import("fflate");
      const wrong = Buffer.from(zipSync({ "other.json": Buffer.from(JSON.stringify({ typeName: "AWS::Test::Other" })) }));
      writeFileSync(join(dir, pinAssetName(pin)), wrong);

      await expect(loadPinnedSchemas({ pin, cacheDir: dir, download: async () => zip })).rejects.toThrow(/extracts to/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unreachable asset: undefined, so the caller falls back to the live fetch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-spec-pin-"));
    try {
      const pin = { digest: "sha256:" + "1".repeat(64), resources: 2, accepted: "2026-08-05" };
      const schemas = await loadPinnedSchemas({ pin, cacheDir: dir, download: async () => undefined });
      expect(schemas).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the asset URL is public, content-addressed, and on the dedicated pin release", () => {
    const pin = { digest: "sha256:" + "ab".repeat(32), resources: 1, accepted: "2026-08-05" };
    expect(pinAssetUrl(pin)).toBe(
      "https://github.com/INTENTIUS/chant/releases/download/aws-spec-pin/abababababab.zip",
    );
  });
});
