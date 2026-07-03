/**
 * Build ledger — the "what's been built" half of build & deploy observability
 * (#568, epic #551 "Build & deploy observability" / "4. Build archive +
 * deferred publish").
 *
 * The `BuildArchive` manifest (../components/verbs/build-archive.ts) is
 * itself the build ledger: it is content-addressed by digest and enumerates
 * every image/template/asset a build produced. What #568 adds on top is
 * discovery of an image's **referrers** — the SBOM, SLSA provenance, and
 * signature attached to the same digest by tooling like `oras discover
 * <digest>` / `cosign tree` (epic #551's phrasing).
 *
 * This module only *surfaces and consumes* referrers — it does not generate
 * SBOM/provenance/signatures. Generation belongs to #564's follow-up (the
 * epic explicitly scopes signing/SLSA generation there, not here). The
 * `ReferrerLookup` interface is injectable for exactly the reason
 * `CloudExecutor` is injectable elsewhere in ../components/verbs: no test and
 * no default implementation shells out to a real `oras`/`cosign`/registry
 * call. A real implementation (backed by `oras`/`cosign` or a registry API)
 * can be wired in later behind this same interface without changing any
 * caller.
 */

import type { BuildArchiveManifest } from "../components/verbs/build-archive";
import { imageEntries } from "../components/verbs/build-archive";

/** The kind of referrer artifact attached to an image digest (mirrors the OCI referrers API / `oras discover` output). */
export type ReferrerKind = "sbom" | "provenance" | "signature";

/** One referrer attached to an image digest. */
export interface Referrer {
  kind: ReferrerKind;
  /** Media type of the referrer artifact itself (e.g. `application/vnd.cyclonedx+json`, `application/vnd.in-toto+json`). */
  mediaType: string;
  /** Content-addressed digest of the referrer artifact (`sha256:...`) — distinct from the subject digest it refers to. */
  digest: string;
  /** Where to fetch the referrer's content, when known (a registry blob ref, a file path, ...). Opaque to this module. */
  location?: string;
}

/**
 * Injectable lookup for an image digest's referrers — the seam a real
 * `oras`/`cosign`/registry-API implementation plugs into. Defaults to
 * `NoopReferrerLookup` (below) so build ledger queries degrade to "no
 * referrers known" rather than requiring network/registry access, matching
 * how ../components/verbs/cloud-executor.ts's real implementations are
 * optional and mockable.
 */
export interface ReferrerLookup {
  /** List every referrer attached to `digest`, or `[]` if none / lookup unsupported. */
  discover(digest: string): Promise<Referrer[]>;
}

/** Default `ReferrerLookup`: reports no referrers. A real registry/`oras`-backed implementation is out of scope here (belongs with #564's signing follow-up) — this keeps build-ledger queries safe to run with no cloud/network access. */
export const noopReferrerLookup: ReferrerLookup = {
  async discover() {
    return [];
  },
};

/** One build-ledger entry: an archive's image entry plus whatever referrers are attached to its digest. */
export interface BuildLedgerEntry {
  /** Component the archive was built for. */
  component: string;
  /** Archive-relative path of the image entry (see `BuildArchiveEntry.path`). */
  path: string;
  /** Content-addressed digest of the image (`sha256:...`) — the join key with the release ledger. */
  digest: string;
  /** When the archive manifest was assembled. */
  createdAt: string;
  /** The manifest's own aggregate digest — traces a promoted image digest back to the exact manifest that produced it. */
  manifestDigest: string;
  /** SBOM/provenance/signature referrers attached to this image's digest, if any were discoverable. */
  referrers: Referrer[];
}

/**
 * Build the ledger view for one archive manifest: every `image`-kind entry,
 * each paired with its OCI referrers via `lookup`. "What's built" becomes
 * "what's built, from which commit, by what, when" once a release record
 * (./release-ledger.ts) is joined onto this by `digest` — this function only
 * produces the build side of that join.
 */
export async function buildLedgerEntries(
  manifest: BuildArchiveManifest,
  lookup: ReferrerLookup = noopReferrerLookup,
): Promise<BuildLedgerEntry[]> {
  const images = imageEntries(manifest);
  const entries: BuildLedgerEntry[] = [];
  for (const image of images) {
    const referrers = await lookup.discover(image.digest);
    entries.push({
      component: manifest.component,
      path: image.path,
      digest: image.digest,
      createdAt: manifest.createdAt,
      manifestDigest: manifest.manifestDigest,
      referrers,
    });
  }
  return entries;
}

/** Find the referrer of a given kind for a digest, if any (a convenience for "does this build have a signature/SBOM/provenance"). */
export function findReferrer(referrers: Referrer[], kind: ReferrerKind): Referrer | undefined {
  return referrers.find((r) => r.kind === kind);
}
