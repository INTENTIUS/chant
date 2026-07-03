import { describe, expect, it } from "vitest";
import {
  DEFAULT_SBOM_FORMAT,
  SBOM_MEDIA_TYPES,
  SbomGeneratorNotImplementedError,
  defaultSbomGenerator,
  notImplementedSbomGenerator,
} from "./sbom-generator";
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

describe("notImplementedSbomGenerator / defaultSbomGenerator (#606)", () => {
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

  it("defaultSbomGenerator() returns the same not-implemented backend, never shelling out at import/call time", () => {
    expect(defaultSbomGenerator()).toBe(notImplementedSbomGenerator);
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
