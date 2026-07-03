import { describe, expect, it } from "vitest";
import { createGenerateSbomCapability } from "./sbom";
import { createMockSbomGenerator } from "./__tests__/mock-sbom-generator";
import { addArchiveTemplate } from "./build";
import { findArchiveEntry, findSbomForSubject } from "./build-archive";
import { DEFAULT_SBOM_FORMAT, SBOM_MEDIA_TYPES } from "./sbom-generator";

const ctx = { env: "dev", component: "search-service" };

describe("generate-sbom (#606)", () => {
  it("defaults to SPDX when no format is requested", async () => {
    expect(DEFAULT_SBOM_FORMAT).toBe("spdx");
    const mock = createMockSbomGenerator();
    const capability = createGenerateSbomCapability(mock.generator);

    const output = await capability.run(ctx, {
      artifactType: "image",
      path: "archive/search.tar",
      digest: "sha256:image1",
    });

    expect(output.sbom.format).toBe("spdx");
    expect(output.sbom.mediaType).toBe("application/spdx+json");
  });

  it("dispatches image artifacts to forImage (BuildKit/syft)", async () => {
    const mock = createMockSbomGenerator();
    const capability = createGenerateSbomCapability(mock.generator);

    await capability.run(ctx, { artifactType: "image", path: "archive/search.tar", digest: "sha256:image1" });

    expect(mock.calls.map((c) => c.method)).toEqual(["forImage"]);
    expect(mock.calls[0]!.args).toMatchObject({ imagePath: "archive/search.tar", digest: "sha256:image1" });
  });

  it("dispatches jar artifacts to forJar (syft/cyclonedx-maven)", async () => {
    const mock = createMockSbomGenerator();
    const capability = createGenerateSbomCapability(mock.generator);

    const output = await capability.run(ctx, {
      artifactType: "jar",
      path: "archive/lib.jar",
      digest: "sha256:jar1",
      format: "cyclonedx",
    });

    expect(mock.calls.map((c) => c.method)).toEqual(["forJar"]);
    expect(output.sbom.format).toBe("cyclonedx");
    expect(output.sbom.mediaType).toBe("application/vnd.cyclonedx+json");
  });

  it("dispatches zip artifacts to forZip (syft on the archive)", async () => {
    const mock = createMockSbomGenerator();
    const capability = createGenerateSbomCapability(mock.generator);

    await capability.run(ctx, { artifactType: "zip", path: "archive/fn.zip", digest: "sha256:zip1" });

    expect(mock.calls.map((c) => c.method)).toEqual(["forZip"]);
    expect(mock.calls[0]!.args).toMatchObject({ zipPath: "archive/fn.zip" });
  });

  it("dispatches dir artifacts to forDir (syft/cdxgen) — no artifact digest required", async () => {
    const mock = createMockSbomGenerator();
    const capability = createGenerateSbomCapability(mock.generator);

    const output = await capability.run(ctx, { artifactType: "dir", path: "src/" });

    expect(mock.calls.map((c) => c.method)).toEqual(["forDir"]);
    expect(mock.calls[0]!.args).toMatchObject({ path: "src/" });
    expect(output.manifest.contents[0]!.subjectDigest).toBeUndefined();
  });

  it("writes an sbom-kind entry into the build-archive manifest, linked to the subject digest", async () => {
    const mock = createMockSbomGenerator();
    const capability = createGenerateSbomCapability(mock.generator);

    const output = await capability.run(ctx, {
      artifactType: "image",
      path: "archive/search.tar",
      digest: "sha256:image1",
    });

    expect(output.manifest.component).toBe("search-service");
    const entry = findArchiveEntry(output.manifest, output.archivePath);
    expect(entry).toMatchObject({
      kind: "sbom",
      digest: output.digest,
      mediaType: SBOM_MEDIA_TYPES.spdx,
      subjectDigest: "sha256:image1",
    });
    expect(findSbomForSubject(output.manifest, "sha256:image1")).toBe(entry);
  });

  it("defaults the archive path to <artifact path>.sbom.json", async () => {
    const mock = createMockSbomGenerator();
    const capability = createGenerateSbomCapability(mock.generator);
    const output = await capability.run(ctx, {
      artifactType: "image",
      path: "archive/search.tar",
      digest: "sha256:image1",
    });
    expect(output.archivePath).toBe("archive/search.tar.sbom.json");
  });

  it("accepts an explicit `into` path", async () => {
    const mock = createMockSbomGenerator();
    const capability = createGenerateSbomCapability(mock.generator);
    const output = await capability.run(ctx, {
      artifactType: "image",
      path: "archive/search.tar",
      digest: "sha256:image1",
      into: "sbom/search.spdx.json",
    });
    expect(output.archivePath).toBe("sbom/search.spdx.json");
  });

  it("accepts an archive: wiring reference the same way publish-image's from does", async () => {
    const mock = createMockSbomGenerator();
    const capability = createGenerateSbomCapability(mock.generator);
    await capability.run(ctx, { artifactType: "image", path: "archive:search.tar", digest: "sha256:image1" });
    expect(mock.calls[0]!.args).toMatchObject({ imagePath: "search.tar" });
  });

  it("accumulates onto a manifest threaded through from a prior build/template step", async () => {
    const mock = createMockSbomGenerator();
    const capability = createGenerateSbomCapability(mock.generator);

    const { manifest: templateManifest } = addArchiveTemplate({
      path: "search.template.json",
      content: JSON.stringify({ Resources: {} }),
    });
    const output = await capability.run(ctx, {
      artifactType: "image",
      path: "archive/search.tar",
      digest: "sha256:image1",
      manifest: templateManifest,
    });

    expect(output.manifest.contents.map((e) => e.kind).sort()).toEqual(["sbom", "template"]);
  });

  it("surfaces package count and generator name from the SbomDocument onto the archive entry", async () => {
    const mock = createMockSbomGenerator({ packageCount: 42, generatorName: "syft-1.2.3" });
    const capability = createGenerateSbomCapability(mock.generator);
    const output = await capability.run(ctx, {
      artifactType: "image",
      path: "archive/search.tar",
      digest: "sha256:image1",
    });
    const entry = findArchiveEntry(output.manifest, output.archivePath)!;
    expect(entry.packageCount).toBe(42);
    expect(entry.generator).toBe("syft-1.2.3");
  });

  it("two generations from identical inputs produce the same manifest digest (content-addressed)", async () => {
    const mockA = createMockSbomGenerator();
    const mockB = createMockSbomGenerator();
    const outputA = await createGenerateSbomCapability(mockA.generator).run(ctx, {
      artifactType: "image",
      path: "archive/search.tar",
      digest: "sha256:image1",
    });
    const outputB = await createGenerateSbomCapability(mockB.generator).run(ctx, {
      artifactType: "image",
      path: "archive/search.tar",
      digest: "sha256:image1",
    });
    expect(outputA.digest).toBe(outputB.digest);
    expect(outputA.manifest.manifestDigest).toBe(outputB.manifest.manifestDigest);
  });

  it("surfaces a generation failure (e.g. scanner crash) as a rejected promise (never swallowed)", async () => {
    const mock = createMockSbomGenerator({ fail: true });
    const capability = createGenerateSbomCapability(mock.generator);
    await expect(
      capability.run(ctx, { artifactType: "image", path: "archive/search.tar", digest: "sha256:image1" }),
    ).rejects.toThrow(/sbom generation failed/);
  });

  it("declares no rollback — an already-generated, content-addressed SBOM is not itself something to undo", () => {
    const capability = createGenerateSbomCapability(createMockSbomGenerator().generator);
    expect(capability.rollback).toBeUndefined();
  });
});
