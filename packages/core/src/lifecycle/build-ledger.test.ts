import { describe, test, expect } from "vitest";
import {
  buildLedgerEntries,
  findReferrer,
  noopReferrerLookup,
  type Referrer,
  type ReferrerLookup,
} from "./build-ledger";
import {
  createBuildArchiveManifest,
  addArchiveEntry,
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
});
