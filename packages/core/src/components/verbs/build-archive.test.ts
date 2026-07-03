import { describe, expect, it } from "vitest";
import {
  addArchiveEntry,
  archiveRelativePath,
  artifactEntries,
  assetEntries,
  computeManifestDigest,
  createBuildArchiveManifest,
  findArchiveEntry,
  findSbomForSubject,
  imageEntries,
  sbomEntries,
} from "./build-archive";

describe("BuildArchive manifest (#564)", () => {
  it("starts empty and content-addressed", () => {
    const manifest = createBuildArchiveManifest("search-service");
    expect(manifest.version).toBe(1);
    expect(manifest.component).toBe("search-service");
    expect(manifest.contents).toEqual([]);
    expect(manifest.manifestDigest).toMatch(/^sha256:/);
  });

  it("adding an entry changes the manifest digest and records the entry", () => {
    const empty = createBuildArchiveManifest("search-service");
    const withImage = addArchiveEntry(empty, {
      kind: "image",
      path: "archive/search.tar",
      digest: "sha256:abc123",
    });

    expect(withImage.manifestDigest).not.toBe(empty.manifestDigest);
    expect(withImage.contents).toHaveLength(1);
    expect(findArchiveEntry(withImage, "archive/search.tar")).toMatchObject({
      kind: "image",
      digest: "sha256:abc123",
      mediaType: "application/vnd.oci.image.layout.v1.tar",
    });
  });

  it("is content-addressed: two manifests built from the same entries produce the same digest, regardless of createdAt or insertion order", () => {
    const a = addArchiveEntry(
      addArchiveEntry(createBuildArchiveManifest("svc", { now: () => new Date("2024-01-01") }), {
        kind: "image",
        path: "archive/x.tar",
        digest: "sha256:111",
      }),
      { kind: "template", path: "x.template.json", digest: "sha256:222" },
    );
    const b = addArchiveEntry(
      addArchiveEntry(createBuildArchiveManifest("svc", { now: () => new Date("2099-12-31") }), {
        kind: "template",
        path: "x.template.json",
        digest: "sha256:222",
      }),
      { kind: "image", path: "archive/x.tar", digest: "sha256:111" },
    );

    expect(a.manifestDigest).toBe(b.manifestDigest);
    expect(a.createdAt).not.toBe(b.createdAt);
  });

  it("changed content changes the digest", () => {
    const base = createBuildArchiveManifest("svc");
    const v1 = addArchiveEntry(base, { kind: "image", path: "archive/x.tar", digest: "sha256:111" });
    const v2 = addArchiveEntry(base, { kind: "image", path: "archive/x.tar", digest: "sha256:999" });
    expect(v1.manifestDigest).not.toBe(v2.manifestDigest);
  });

  it("replaces an entry at the same path rather than duplicating it", () => {
    const base = createBuildArchiveManifest("svc");
    const v1 = addArchiveEntry(base, { kind: "image", path: "archive/x.tar", digest: "sha256:111" });
    const v2 = addArchiveEntry(v1, { kind: "image", path: "archive/x.tar", digest: "sha256:222" });
    expect(v2.contents).toHaveLength(1);
    expect(v2.contents[0]!.digest).toBe("sha256:222");
  });

  it("is immutable: adding an entry never mutates the input manifest", () => {
    const base = createBuildArchiveManifest("svc");
    const before = JSON.stringify(base);
    addArchiveEntry(base, { kind: "asset", path: "lib.jar", digest: "sha256:333" });
    expect(JSON.stringify(base)).toBe(before);
  });

  it("computeManifestDigest matches what addArchiveEntry produces incrementally", () => {
    const entries = [
      { kind: "image" as const, path: "archive/x.tar", digest: "sha256:111" },
      { kind: "template" as const, path: "x.template.json", digest: "sha256:222" },
    ];
    let manifest = createBuildArchiveManifest("svc");
    for (const entry of entries) manifest = addArchiveEntry(manifest, entry);
    expect(manifest.manifestDigest).toBe(computeManifestDigest(manifest.contents));
  });

  it("imageEntries filters to image-kind entries only", () => {
    let manifest = createBuildArchiveManifest("svc");
    manifest = addArchiveEntry(manifest, { kind: "image", path: "archive/a.tar", digest: "sha256:1" });
    manifest = addArchiveEntry(manifest, { kind: "template", path: "a.template.json", digest: "sha256:2" });
    manifest = addArchiveEntry(manifest, { kind: "asset", path: "a.jar", digest: "sha256:3" });
    expect(imageEntries(manifest).map((e) => e.path)).toEqual(["archive/a.tar"]);
  });

  it("archiveRelativePath strips the archive: wiring prefix and passes plain paths through unchanged", () => {
    expect(archiveRelativePath("archive:search.template.json")).toBe("search.template.json");
    expect(archiveRelativePath("archive/search.tar")).toBe("archive/search.tar");
  });

  describe("sbom entries (#606)", () => {
    it("sbomEntries filters to sbom-kind entries only", () => {
      let manifest = createBuildArchiveManifest("svc");
      manifest = addArchiveEntry(manifest, { kind: "image", path: "archive/a.tar", digest: "sha256:1" });
      manifest = addArchiveEntry(manifest, {
        kind: "sbom",
        path: "archive/a.tar.sbom.json",
        digest: "sha256:sbom1",
        mediaType: "application/spdx+json",
        subjectDigest: "sha256:1",
      });
      expect(sbomEntries(manifest).map((e) => e.path)).toEqual(["archive/a.tar.sbom.json"]);
    });

    it("findSbomForSubject finds the sbom entry attached to a given subject digest", () => {
      let manifest = createBuildArchiveManifest("svc");
      manifest = addArchiveEntry(manifest, { kind: "image", path: "archive/a.tar", digest: "sha256:1" });
      manifest = addArchiveEntry(manifest, {
        kind: "sbom",
        path: "archive/a.tar.sbom.json",
        digest: "sha256:sbom1",
        mediaType: "application/vnd.cyclonedx+json",
        subjectDigest: "sha256:1",
      });
      expect(findSbomForSubject(manifest, "sha256:1")).toMatchObject({
        path: "archive/a.tar.sbom.json",
        mediaType: "application/vnd.cyclonedx+json",
      });
      expect(findSbomForSubject(manifest, "sha256:nonexistent")).toBeUndefined();
    });

    it("sbom entry mediaType is never hardcoded to one format — carries whatever the generator produced", () => {
      let manifest = createBuildArchiveManifest("svc");
      manifest = addArchiveEntry(manifest, {
        kind: "sbom",
        path: "a.sbom.json",
        digest: "sha256:s1",
        mediaType: "application/spdx+json",
        subjectDigest: "sha256:1",
      });
      manifest = addArchiveEntry(manifest, {
        kind: "sbom",
        path: "b.sbom.json",
        digest: "sha256:s2",
        mediaType: "application/vnd.cyclonedx+json",
        subjectDigest: "sha256:2",
      });
      const mediaTypes = sbomEntries(manifest).map((e) => e.mediaType).sort();
      expect(mediaTypes).toEqual(["application/spdx+json", "application/vnd.cyclonedx+json"]);
    });
  });

  describe("per-artifact reproducibility (#614)", () => {
    it("a template entry defaults to deterministic-synthesis when the caller supplies none", () => {
      let manifest = createBuildArchiveManifest("svc");
      manifest = addArchiveEntry(manifest, { kind: "template", path: "x.template.json", digest: "sha256:1" });
      expect(findArchiveEntry(manifest, "x.template.json")!.reproducibility).toEqual({
        basis: "deterministic-synthesis",
        verifyBy: "re-synth",
      });
    });

    it("an image entry defaults to best-effort", () => {
      let manifest = createBuildArchiveManifest("svc");
      manifest = addArchiveEntry(manifest, { kind: "image", path: "a.tar", digest: "sha256:1" });
      expect(findArchiveEntry(manifest, "a.tar")!.reproducibility).toEqual({ basis: "best-effort" });
    });

    it("an asset entry defaults to best-effort", () => {
      let manifest = createBuildArchiveManifest("svc");
      manifest = addArchiveEntry(manifest, { kind: "asset", path: "lib.jar", digest: "sha256:1" });
      expect(findArchiveEntry(manifest, "lib.jar")!.reproducibility).toEqual({ basis: "best-effort" });
    });

    it("an sbom entry gets no reproducibility default — it describes another artifact, not one itself", () => {
      let manifest = createBuildArchiveManifest("svc");
      manifest = addArchiveEntry(manifest, {
        kind: "sbom",
        path: "a.sbom.json",
        digest: "sha256:1",
        subjectDigest: "sha256:img",
      });
      expect(findArchiveEntry(manifest, "a.sbom.json")!.reproducibility).toBeUndefined();
    });

    it("an explicit reproducibility always overrides the kind-appropriate default", () => {
      let manifest = createBuildArchiveManifest("svc");
      manifest = addArchiveEntry(manifest, {
        kind: "image",
        path: "a.tar",
        digest: "sha256:1",
        reproducibility: { basis: "deterministic-synthesis", verifyBy: "re-synth" },
      });
      expect(findArchiveEntry(manifest, "a.tar")!.reproducibility).toEqual({
        basis: "deterministic-synthesis",
        verifyBy: "re-synth",
      });
    });

    it("reproducibility is honest per artifact — a template and an image in the same manifest carry different bases", () => {
      let manifest = createBuildArchiveManifest("svc");
      manifest = addArchiveEntry(manifest, { kind: "image", path: "a.tar", digest: "sha256:1" });
      manifest = addArchiveEntry(manifest, { kind: "template", path: "a.template.json", digest: "sha256:2" });
      expect(findArchiveEntry(manifest, "a.tar")!.reproducibility!.basis).toBe("best-effort");
      expect(findArchiveEntry(manifest, "a.template.json")!.reproducibility!.basis).toBe("deterministic-synthesis");
    });

    it("reproducibility/provenance never perturb manifestDigest — recording them later doesn't change archive identity", () => {
      const base = createBuildArchiveManifest("svc");
      const withDefault = addArchiveEntry(base, { kind: "image", path: "a.tar", digest: "sha256:1" });
      const withExplicit = addArchiveEntry(base, {
        kind: "image",
        path: "a.tar",
        digest: "sha256:1",
        reproducibility: { basis: "deterministic-synthesis", verifyBy: "re-synth" },
        provenance: { sourceRef: "abc123", artifactDigest: "sha256:1" },
      });
      expect(withDefault.manifestDigest).toBe(withExplicit.manifestDigest);
    });
  });

  describe("artifact accessors (#614)", () => {
    it("assetEntries filters to asset-kind entries only", () => {
      let manifest = createBuildArchiveManifest("svc");
      manifest = addArchiveEntry(manifest, { kind: "image", path: "a.tar", digest: "sha256:1" });
      manifest = addArchiveEntry(manifest, { kind: "asset", path: "lib.jar", digest: "sha256:2" });
      expect(assetEntries(manifest).map((e) => e.path)).toEqual(["lib.jar"]);
    });

    it("artifactEntries returns image/template/asset entries but excludes sbom entries", () => {
      let manifest = createBuildArchiveManifest("svc");
      manifest = addArchiveEntry(manifest, { kind: "image", path: "a.tar", digest: "sha256:1" });
      manifest = addArchiveEntry(manifest, { kind: "template", path: "a.template.json", digest: "sha256:2" });
      manifest = addArchiveEntry(manifest, { kind: "asset", path: "lib.jar", digest: "sha256:3" });
      manifest = addArchiveEntry(manifest, {
        kind: "sbom",
        path: "a.tar.sbom.json",
        digest: "sha256:4",
        subjectDigest: "sha256:1",
      });
      expect(artifactEntries(manifest).map((e) => e.path).sort()).toEqual(["a.tar", "a.template.json", "lib.jar"]);
    });
  });
});
