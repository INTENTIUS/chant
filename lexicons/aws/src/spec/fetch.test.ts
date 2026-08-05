import { describe, test, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fetchSchemaZip, loadPinnedSchemas, pinnedArchivePath } from "./fetch";
import { specContentDigest, AWS_SPEC_PIN } from "./pin";

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

// #1511 — the committed pin archive is the deterministic source: matching
// content loads without a network fetch, a mismatched archive refuses loudly,
// and an absent one falls back to the live path.
describe("loadPinnedSchemas (#1511)", () => {
  const schemaA = Buffer.from(JSON.stringify({ typeName: "AWS::Test::A", properties: {} }));
  const schemaB = Buffer.from(JSON.stringify({ typeName: "AWS::Test::B", properties: {} }));

  async function makeArchive(dir: string): Promise<{ path: string; digest: string }> {
    const { zipSync } = await import("fflate");
    const zip = Buffer.from(zipSync({ "aws-test-a.json": schemaA, "aws-test-b.json": schemaB }));
    const digest = specContentDigest(
      new Map([
        ["AWS::Test::A", schemaA],
        ["AWS::Test::B", schemaB],
      ]),
    );
    const path = join(dir, `${digest.replace(/^sha256:/, "").slice(0, 12)}.zip`);
    writeFileSync(path, zip);
    return { path, digest };
  }

  test("an archive whose content digests to the pin loads, no network involved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-pin-archive-"));
    try {
      const { path, digest } = await makeArchive(dir);
      const pin = { digest, resources: 2, accepted: "2026-08-05" };
      const schemas = await loadPinnedSchemas({ pin, path });
      expect(schemas).toBeDefined();
      expect([...schemas!.keys()].sort()).toEqual(["AWS::Test::A", "AWS::Test::B"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an archive that does not digest to the pin throws, naming both digests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-pin-archive-"));
    try {
      const { path } = await makeArchive(dir);
      const pin = { digest: "sha256:" + "0".repeat(64), resources: 2, accepted: "2026-08-05" };
      await expect(loadPinnedSchemas({ pin, path })).rejects.toThrow(/extracts to sha256:.*declares sha256:0{8}/s);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no committed archive: undefined, so the caller falls back to the live fetch", async () => {
    const pin = { digest: "sha256:" + "1".repeat(64), resources: 2, accepted: "2026-08-05" };
    const schemas = await loadPinnedSchemas({ pin, path: join(tmpdir(), "chant-no-such-archive.zip") });
    expect(schemas).toBeUndefined();
  });

  test("the committed archive at the real path matches the real pin", async () => {
    // The repo invariant the whole fix rests on: spec-archive/<digest12>.zip
    // and AWS_SPEC_PIN move together. Skipped only where the archive is not
    // present (an npm install; the tarball excludes it).
    const path = pinnedArchivePath();
    if (!existsSync(path)) return;
    const schemas = await loadPinnedSchemas();
    expect(schemas).toBeDefined();
    expect(schemas!.size).toBe(AWS_SPEC_PIN.resources);
  });
});
