import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SBOM_FORMAT,
  SBOM_MEDIA_TYPES,
  SbomGeneratorNotImplementedError,
  defaultSbomGenerator,
  notImplementedSbomGenerator,
} from "./sbom-generator";
import { lockfileSbomGenerator } from "./lockfile-sbom-generator";
import { createMockSbomGenerator } from "./__tests__/mock-sbom-generator";

describe("SBOM document media types (#606 — format-agnostic storage)", () => {
  it("declares both SPDX and CycloneDX media types — no format is hardcoded as the only one", () => {
    expect(SBOM_MEDIA_TYPES.spdx).toBe("application/spdx+json");
    expect(SBOM_MEDIA_TYPES.cyclonedx).toBe("application/vnd.cyclonedx+json");
  });

  it("defaults to SPDX (BuildKit's native attestation format) per the epic's article-validated refinement", () => {
    expect(DEFAULT_SBOM_FORMAT).toBe("spdx");
  });
});

describe("notImplementedSbomGenerator (#606) — still exported, no longer the default", () => {
  it("every method throws SbomGeneratorNotImplementedError, naming the method", async () => {
    await expect(notImplementedSbomGenerator.forImage({ imagePath: "x", digest: "sha256:1" })).rejects.toBeInstanceOf(
      SbomGeneratorNotImplementedError,
    );
    await expect(notImplementedSbomGenerator.forJar({ jarPath: "x", digest: "sha256:1" })).rejects.toThrow(
      /forJar/,
    );
    await expect(notImplementedSbomGenerator.forZip({ zipPath: "x", digest: "sha256:1" })).rejects.toThrow(
      /forZip/,
    );
    await expect(notImplementedSbomGenerator.forDir({ path: "x" })).rejects.toThrow(/forDir/);
  });
});

describe("defaultSbomGenerator (#630 — hermetic by default)", () => {
  it("returns the same lockfileSbomGenerator instance every call, never shelling out at import/call time", () => {
    expect(defaultSbomGenerator()).toBe(lockfileSbomGenerator);
    expect(defaultSbomGenerator()).toBe(defaultSbomGenerator());
  });

  it("forImage still throws SbomGeneratorNotImplementedError — no hermetic backend can see an image's base layers", async () => {
    await expect(defaultSbomGenerator().forImage({ imagePath: "x", digest: "sha256:1" })).rejects.toBeInstanceOf(
      SbomGeneratorNotImplementedError,
    );
  });

  it("forDir generates a real SBOM tool-free from a package-lock.json on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-sbom-default-"));
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        packages: { "": { name: "fixture" }, "node_modules/left-pad": { version: "1.3.0" } },
      }),
    );

    const doc = await defaultSbomGenerator().forDir({ path: dir });
    expect(doc.packageCount).toBe(1);
    expect(doc.generator).toBe("chant-lockfile-sbom/package-lock.json");
    expect(JSON.parse(doc.bytes)).toBeTruthy();
  });
});

describe("MockSbomGenerator (test double)", () => {
  it("produces a format-agnostic document whose mediaType always matches the requested/default format", async () => {
    const mock = createMockSbomGenerator();
    const spdxDoc = await mock.generator.forImage({ imagePath: "a.tar", digest: "sha256:1" });
    expect(spdxDoc.format).toBe("spdx");
    expect(spdxDoc.mediaType).toBe(SBOM_MEDIA_TYPES.spdx);

    const cyclonedxDoc = await mock.generator.forJar({ jarPath: "a.jar", digest: "sha256:2", format: "cyclonedx" });
    expect(cyclonedxDoc.format).toBe("cyclonedx");
    expect(cyclonedxDoc.mediaType).toBe(SBOM_MEDIA_TYPES.cyclonedx);
  });

  it("records every call for assertion, keyed by artifact-type method", async () => {
    const mock = createMockSbomGenerator();
    await mock.generator.forImage({ imagePath: "a.tar", digest: "sha256:1" });
    await mock.generator.forZip({ zipPath: "b.zip", digest: "sha256:2" });
    expect(mock.calls.map((c) => c.method)).toEqual(["forImage", "forZip"]);
  });

  it("fail option surfaces a rejected promise from every method", async () => {
    const mock = createMockSbomGenerator({ fail: true });
    await expect(mock.generator.forImage({ imagePath: "a.tar", digest: "sha256:1" })).rejects.toThrow(
      /sbom generation failed/,
    );
  });
});
