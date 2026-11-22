/**
 * A scanner for the scan before the stage (#5446) that runs no tool and
 * reaches no network: an image's SBOM is a fixed SPDX document listing the OS
 * packages it is given, and findings come from an advisory database file
 * matched offline (../../components/verbs/vuln-scan.ts, `scanWithDatabase`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SBOM_MEDIA_TYPES, type SbomDocument } from "../../components/verbs/sbom-generator";
import { scanWithDatabase, type AdvisoryDatabase } from "../../components/verbs/vuln-scan";
import type { ReleaseScanner } from "../publish-scan";

/** The advisory database the tests scan against: a critical left-pad 1.3.0 (npm), a critical openssl 3.0.11-1 and a low zlib (deb). */
export const SCAN_ADVISORIES = join(__dirname, "scan-advisories.json");

/** An SPDX document listing `purls`, as syft writes one for an image's layers. */
export function layerSpdx(name: string, purls: readonly string[]): string {
  return `${JSON.stringify(
    {
      spdxVersion: "SPDX-2.3",
      dataLicense: "CC0-1.0",
      SPDXID: "SPDXRef-DOCUMENT",
      name,
      documentNamespace: `https://example.test/${name}`,
      creationInfo: { created: "2026-11-01T00:00:00Z", creators: ["Tool: syft-fake"] },
      packages: purls.map((p, i) => ({ SPDXID: `SPDXRef-Package-${i}`, name: p.split("/").pop()!.split("@")[0], versionInfo: p.split("@")[1], externalRefs: [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: p }] })),
    },
    null,
    2,
  )}\n`;
}

/** A fake {@link ReleaseScanner}: `image` packages for every image, findings from `db`, every call recorded. */
export function fakeReleaseScanner(opts: { image?: readonly string[]; db?: string; missing?: string } = {}): ReleaseScanner & { calls: string[] } {
  const calls: string[] = [];
  const db = JSON.parse(readFileSync(opts.db ?? SCAN_ADVISORIES, "utf-8")) as AdvisoryDatabase;
  return {
    name: "fake-grype v0.0.1",
    calls,
    unavailable: () => opts.missing ?? null,
    async imageSbom(archive) {
      calls.push(`image ${archive}`);
      const bytes = layerSpdx("image", opts.image ?? ["pkg:deb/debian/openssl@3.0.11-1", "pkg:deb/debian/zlib@1.2.13"]);
      const doc: SbomDocument = { format: "spdx", mediaType: SBOM_MEDIA_TYPES.spdx, bytes, packageCount: (opts.image ?? [0, 0]).length, generator: "syft" };
      return doc;
    },
    async scan(sbom) {
      calls.push(`scan ${sbom.generator}`);
      return scanWithDatabase(sbom, db);
    },
  };
}
