import { describe, test, expect } from "vitest";
import {
  buildLedgerEntries,
  findReferrer,
  noopReferrerLookup,
  artifactReproducibilitySummary,
  componentBomSummary,
  type Referrer,
  type ReferrerLookup,
} from "./build-ledger";
import {
  createBuildArchiveManifest,
  addArchiveEntry,
  findSbomForSubject,
} from "../components/verbs/build-archive";

describe("build-ledger", () => {
  describe("buildLedgerEntries", () => {
    test("returns one entry per image-kind manifest entry", async () => {
      let manifest = createBuildArchiveManifest("search-service", { now: () => new Date("2026-01-01T00:00:00.000Z") });
      manifest = addArchiveEntry(manifest, { kind: "image", path: "image.tar", digest: "sha256:image1" });
      manifest = addArchiveEntry(manifest, { kind: "template", path: "search.template.json", digest: "sha256:tmpl1" });

      const entries = await buildLedgerEntries(manifest);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        component: "search-service",
        path: "image.tar",
        digest: "sha256:image1",
        manifestDigest: manifest.manifestDigest,
      });
    });

    test("noop lookup (default) attaches no referrers", async () => {
      let manifest = createBuildArchiveManifest("svc");
      manifest = addArchiveEntry(manifest, { kind: "image", path: "image.tar", digest: "sha256:image1" });
      const entries = await buildLedgerEntries(manifest);
      expect(entries[0].referrers).toEqual([]);
    });

    test("injected lookup attaches referrers keyed by digest", async () => {
      let manifest = createBuildArchiveManifest("svc");
      manifest = addArchiveEntry(manifest, { kind: "image", path: "image.tar", digest: "sha256:image1" });

      const sbom: Referrer = { kind: "sbom", mediaType: "application/vnd.cyclonedx+json", digest: "sha256:sbom1" };
      const provenance: Referrer = { kind: "provenance", mediaType: "application/vnd.in-toto+json", digest: "sha256:prov1" };
      const lookup: ReferrerLookup = {
        async discover(digest) {
          if (digest !== "sha256:image1") return [];
          return [sbom, provenance];
        },
      };

      const entries = await buildLedgerEntries(manifest, lookup);
      expect(entries[0].referrers).toEqual([sbom, provenance]);
    });

    test("multiple image entries each get their own referrer lookup", async () => {
      let manifest = createBuildArchiveManifest("multi-image");
      manifest = addArchiveEntry(manifest, { kind: "image", path: "a.tar", digest: "sha256:a" });
      manifest = addArchiveEntry(manifest, { kind: "image", path: "b.tar", digest: "sha256:b" });

      const lookup: ReferrerLookup = {
        async discover(digest) {
          return [{ kind: "signature", mediaType: "application/vnd.dev.cosign.simplesigning.v1+json", digest: `${digest}-sig` }];
        },
      };

      const entries = await buildLedgerEntries(manifest, lookup);
      expect(entries.map((e) => e.path).sort()).toEqual(["a.tar", "b.tar"]);
      const byDigest = new Map(entries.map((e) => [e.digest, e]));
      expect(byDigest.get("sha256:a")?.referrers[0].digest).toBe("sha256:a-sig");
      expect(byDigest.get("sha256:b")?.referrers[0].digest).toBe("sha256:b-sig");
    });

    test("no image entries -> no build ledger entries", async () => {
      let manifest = createBuildArchiveManifest("infra-only");
      manifest = addArchiveEntry(manifest, { kind: "template", path: "t.json", digest: "sha256:t" });
      const entries = await buildLedgerEntries(manifest);
      expect(entries).toEqual([]);
    });
  });

  describe("findReferrer", () => {
    test("finds a referrer by kind", () => {
      const referrers: Referrer[] = [
        { kind: "sbom", mediaType: "x", digest: "sha256:1" },
        { kind: "signature", mediaType: "y", digest: "sha256:2" },
      ];
      expect(findReferrer(referrers, "signature")?.digest).toBe("sha256:2");
      expect(findReferrer(referrers, "provenance")).toBeUndefined();
    });
  });

  describe("noopReferrerLookup", () => {
    test("always returns an empty list", async () => {
      expect(await noopReferrerLookup.discover("sha256:anything")).toEqual([]);
    });
  });

  describe("sbom summary (#606) — archive-carried vs referrer-projected", () => {
    test("no sbom entry and no sbom referrer -> sbom is undefined (component opted out / no SBOM generated)", async () => {
      let manifest = createBuildArchiveManifest("svc");
      manifest = addArchiveEntry(manifest, { kind: "image", path: "image.tar", digest: "sha256:image1" });
      const entries = await buildLedgerEntries(manifest);
      expect(entries[0].sbom).toBeUndefined();
    });

    test("archive-carried sbom entry is surfaced with format/package count/generator, source 'archive'", async () => {
      let manifest = createBuildArchiveManifest("svc");
      manifest = addArchiveEntry(manifest, { kind: "image", path: "image.tar", digest: "sha256:image1" });
      manifest = addArchiveEntry(manifest, {
        kind: "sbom",
        path: "image.tar.sbom.json",
        digest: "sha256:sbomdoc",
        mediaType: "application/spdx+json",
        subjectDigest: "sha256:image1",
        packageCount: 17,
        generator: "syft",
      });

      const entries = await buildLedgerEntries(manifest);
      expect(entries[0].sbom).toEqual({
        mediaType: "application/spdx+json",
        packageCount: 17,
        generator: "syft",
        source: "archive",
      });
    });

    test("referrer-projected sbom is surfaced when no archive-carried entry exists, source 'referrer'", async () => {
      let manifest = createBuildArchiveManifest("svc");
      manifest = addArchiveEntry(manifest, { kind: "image", path: "image.tar", digest: "sha256:image1" });

      const lookup: ReferrerLookup = {
        async discover(digest) {
          if (digest !== "sha256:image1") return [];
          return [{ kind: "sbom", mediaType: "application/vnd.cyclonedx+json", digest: "sha256:sbomref" }];
        },
      };

      const entries = await buildLedgerEntries(manifest, lookup);
      expect(entries[0].sbom).toEqual({
        mediaType: "application/vnd.cyclonedx+json",
        source: "referrer",
      });
    });

    test("archive-carried sbom is preferred over a referrer-projected one when both exist", async () => {
      let manifest = createBuildArchiveManifest("svc");
      manifest = addArchiveEntry(manifest, { kind: "image", path: "image.tar", digest: "sha256:image1" });
      manifest = addArchiveEntry(manifest, {
        kind: "sbom",
        path: "image.tar.sbom.json",
        digest: "sha256:sbomdoc",
        mediaType: "application/spdx+json",
        subjectDigest: "sha256:image1",
        packageCount: 9,
        generator: "buildkit",
      });

      const lookup: ReferrerLookup = {
        async discover() {
          return [{ kind: "sbom", mediaType: "application/vnd.cyclonedx+json", digest: "sha256:sbomref" }];
        },
      };

      const entries = await buildLedgerEntries(manifest, lookup);
      expect(entries[0].sbom).toEqual({
        mediaType: "application/spdx+json",
        packageCount: 9,
        generator: "buildkit",
        source: "archive",
      });
    });

    test("format-agnostic: CycloneDX archive-carried sbom is surfaced the same way SPDX is", async () => {
      let manifest = createBuildArchiveManifest("svc");
      manifest = addArchiveEntry(manifest, { kind: "image", path: "image.tar", digest: "sha256:image1" });
      manifest = addArchiveEntry(manifest, {
        kind: "sbom",
        path: "image.tar.sbom.json",
        digest: "sha256:sbomdoc",
        mediaType: "application/vnd.cyclonedx+json",
        subjectDigest: "sha256:image1",
        packageCount: 5,
        generator: "syft",
      });

      const entries = await buildLedgerEntries(manifest);
      expect(entries[0].sbom?.mediaType).toBe("application/vnd.cyclonedx+json");
    });

    test("non-image artifact (jar/zip, no image entry) still carries its sbom in the manifest, findable independent of buildLedgerEntries (which is image-scoped)", async () => {
      let manifest = createBuildArchiveManifest("jar-lib");
      manifest = addArchiveEntry(manifest, { kind: "asset", path: "lib.jar", digest: "sha256:jar1" });
      manifest = addArchiveEntry(manifest, {
        kind: "sbom",
        path: "lib.jar.sbom.json",
        digest: "sha256:sbomdoc",
        mediaType: "application/spdx+json",
        subjectDigest: "sha256:jar1",
      });

      // buildLedgerEntries only enumerates image-kind entries (the build
      // ledger's historical scope, #568) — a jar's SBOM is still readable
      // straight from the archive via findSbomForSubject, the same
      // artifact-type-agnostic accessor ./build-ledger.ts uses internally.
      const entries = await buildLedgerEntries(manifest);
      expect(entries).toEqual([]);
      expect(findSbomForSubject(manifest, "sha256:jar1")).toMatchObject({ mediaType: "application/spdx+json" });
    });

    test("image entries surface their own reproducibility record (#614)", async () => {
      let manifest = createBuildArchiveManifest("svc");
      manifest = addArchiveEntry(manifest, { kind: "image", path: "image.tar", digest: "sha256:image1" });
      const entries = await buildLedgerEntries(manifest);
      expect(entries[0].reproducibility).toEqual({ basis: "best-effort" });
    });
  });

  describe("artifactReproducibilitySummary (#614)", () => {
    test("reports every image/template/asset entry's own reproducibility, honestly per artifact type", () => {
      let manifest = createBuildArchiveManifest("search-service");
      manifest = addArchiveEntry(manifest, { kind: "image", path: "image.tar", digest: "sha256:img1" });
      manifest = addArchiveEntry(manifest, { kind: "template", path: "search.template.json", digest: "sha256:tmpl1" });
      manifest = addArchiveEntry(manifest, { kind: "asset", path: "lib.jar", digest: "sha256:jar1" });

      const summary = artifactReproducibilitySummary(manifest);
      const byPath = new Map(summary.map((s) => [s.path, s]));
      expect(byPath.get("image.tar")?.reproducibility).toEqual({ basis: "best-effort" });
      expect(byPath.get("search.template.json")?.reproducibility).toEqual({
        basis: "deterministic-synthesis",
        verifyBy: "re-synth",
      });
      expect(byPath.get("lib.jar")?.reproducibility).toEqual({ basis: "best-effort" });
    });

    test("excludes sbom-kind entries — they describe another artifact, they aren't one themselves", () => {
      let manifest = createBuildArchiveManifest("svc");
      manifest = addArchiveEntry(manifest, { kind: "image", path: "image.tar", digest: "sha256:img1" });
      manifest = addArchiveEntry(manifest, {
        kind: "sbom",
        path: "image.tar.sbom.json",
        digest: "sha256:sbom1",
        subjectDigest: "sha256:img1",
      });
      const summary = artifactReproducibilitySummary(manifest);
      expect(summary.map((s) => s.path)).toEqual(["image.tar"]);
    });

    test("surfaces the recorded provenance sourceRef when present", () => {
      let manifest = createBuildArchiveManifest("svc");
      manifest = addArchiveEntry(manifest, {
        kind: "template",
        path: "t.json",
        digest: "sha256:t1",
        provenance: { sourceRef: "abc123", artifactDigest: "sha256:t1" },
      });
      const summary = artifactReproducibilitySummary(manifest);
      expect(summary[0]!.sourceRef).toBe("abc123");
    });

    test("no artifact entries -> empty summary", () => {
      const manifest = createBuildArchiveManifest("empty");
      expect(artifactReproducibilitySummary(manifest)).toEqual([]);
    });
  });

  describe("componentBomSummary (#614)", () => {
    test("undefined when the manifest carries no BOM at all", () => {
      let manifest = createBuildArchiveManifest("svc");
      manifest = addArchiveEntry(manifest, { kind: "image", path: "image.tar", digest: "sha256:img1" });
      expect(componentBomSummary(manifest)).toBeUndefined();
    });

    test("single leaf: isAssembly is false — a 1:1 component BOM", () => {
      let manifest = createBuildArchiveManifest("infra-only");
      manifest = addArchiveEntry(manifest, { kind: "template", path: "t.json", digest: "sha256:t1" });
      manifest = addArchiveEntry(manifest, {
        kind: "sbom",
        bomKind: "config",
        path: "t.json.config-bom.json",
        digest: "sha256:sbom1",
        subjectDigest: "sha256:t1",
        mediaType: "application/spdx+json",
        packageCount: 3,
        generator: "chant-config-bom-extractor",
      });

      const summary = componentBomSummary(manifest);
      expect(summary?.isAssembly).toBe(false);
      expect(summary?.leaves).toHaveLength(1);
      expect(summary?.leaves[0]).toEqual({
        path: "t.json.config-bom.json",
        bomKind: "config",
        subjectDigest: "sha256:t1",
        mediaType: "application/spdx+json",
        packageCount: 3,
        generator: "chant-config-bom-extractor",
      });
      expect(summary?.totalPackageCount).toBe(3);
    });

    test("multi leaf (software SBOM + config-BOM): isAssembly is true, totalPackageCount sums both leaves", () => {
      let manifest = createBuildArchiveManifest("search-service");
      manifest = addArchiveEntry(manifest, { kind: "image", path: "image.tar", digest: "sha256:img1" });
      manifest = addArchiveEntry(manifest, { kind: "template", path: "search.template.json", digest: "sha256:tmpl1" });
      manifest = addArchiveEntry(manifest, {
        kind: "sbom",
        bomKind: "software",
        path: "image.tar.sbom.json",
        digest: "sha256:sbomsoft",
        subjectDigest: "sha256:img1",
        mediaType: "application/spdx+json",
        packageCount: 17,
        generator: "syft",
      });
      manifest = addArchiveEntry(manifest, {
        kind: "sbom",
        bomKind: "config",
        path: "search.template.json.config-bom.json",
        digest: "sha256:sbomconfig",
        subjectDigest: "sha256:tmpl1",
        mediaType: "application/spdx+json",
        packageCount: 5,
        generator: "chant-config-bom-extractor",
      });

      const summary = componentBomSummary(manifest);
      expect(summary?.isAssembly).toBe(true);
      expect(summary?.leaves).toHaveLength(2);
      expect(summary?.totalPackageCount).toBe(22);
      expect(summary?.leaves.map((l) => l.bomKind).sort()).toEqual(["config", "software"]);
    });

    test("bomKind defaults to 'software' when a leaf entry omits it, matching BuildArchiveEntry's own default", () => {
      let manifest = createBuildArchiveManifest("svc");
      manifest = addArchiveEntry(manifest, {
        kind: "sbom",
        path: "a.sbom.json",
        digest: "sha256:s1",
        subjectDigest: "sha256:img1",
      });
      const summary = componentBomSummary(manifest);
      expect(summary?.leaves[0]?.bomKind).toBe("software");
    });
  });
});
