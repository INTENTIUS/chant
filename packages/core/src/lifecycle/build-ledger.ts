/**
 * Build ledger — the "what's been built" half of build & deploy observability
 * (#568, epic #551 "Build & deploy observability" / "4. Build archive +
 * deferred publish"; SBOM consume/surface added in #606).
 *
 * The `BuildArchive` manifest (../components/verbs/build-archive.ts) is
 * itself the build ledger: it is content-addressed by digest and enumerates
 * every image/template/asset/sbom a build produced. What #568 adds on top is
 * discovery of an image's **referrers** — the SBOM, SLSA provenance, and
 * signature attached to the same digest by tooling like `oras discover
 * <digest>` / `cosign tree` (epic #551's phrasing).
 *
 * This module only *surfaces and consumes* SBOM/provenance/signature
 * evidence — generation is ../components/verbs/sbom.ts's `generate-sbom`
 * capability (#606; SLSA provenance + signing remain out of scope, noted as
 * fast-follow siblings). Two sources feed the same `sbom` summary below, and
 * a caller gets *both* without special-casing which one exists:
 *
 *  - **archive-carried** — an `sbom`-kind entry in the same
 *    `BuildArchiveManifest`, written directly by `generate-sbom`. This is
 *    the **universal home**: it works for every artifact type (image, jar,
 *    zip) and every publish backend, including the registry-less
 *    `load-image-on-host` path, with no registry/network access required to
 *    read it back.
 *  - **referrer-projected** — an OCI referrer of `kind: "sbom"` discovered
 *    via `ReferrerLookup`, the registry-side convenience for image
 *    artifacts (`oras discover <digest>`/`cosign tree`) that #568 already
 *    modeled. Not every artifact type has this projection (only images
 *    published to a registry do), and not every environment can query it
 *    (`ReferrerLookup` defaults to `noopReferrerLookup`, no network).
 *
 * `buildLedgerEntries` prefers the archive-carried copy when both exist
 * (same digest either way, since both trace back to the same
 * `generate-sbom` run — the archive is the source of truth; the referrer is
 * a projection of it) and falls back to the referrer when only that is
 * available (e.g. a manifest read that predates #606, or a third-party tool
 * attached an SBOM directly to the registry outside chant's own build). The
 * `ReferrerLookup` interface remains injectable for exactly the reason
 * `CloudExecutor` is injectable elsewhere in ../components/verbs: no test and
 * no default implementation shells out to a real `oras`/`cosign`/registry
 * call.
 *
 * **#614 additions.** Two more things get surfaced per manifest, both
 * derived from data the manifest already carries (no new generation, no
 * re-parsing of BOM bytes):
 *
 *  - Each `BuildLedgerEntry` (still one per image, matching this module's
 *    existing scope) now carries that image's own `reproducibility` — read
 *    straight off its `BuildArchiveEntry`, never inferred from a sibling
 *    artifact (see ../components/verbs/reproducibility.ts's module doc for
 *    why a blanket flag would misrepresent a multi-artifact component).
 *    `artifactReproducibilitySummary` below reports the same per-artifact
 *    honesty for *every* artifact entry in a manifest (image, template,
 *    asset alike) — the full per-artifact picture #614 asks for, not just
 *    the image-scoped slice `buildLedgerEntries` has always covered.
 *  - `componentBomSummary` reports the component-level BOM aggregation
 *    picture (../components/verbs/component-bom.ts): how many leaf BOMs
 *    (software SBOM + IaC config-BOM) the manifest carries, each one's
 *    `bomKind`/format/package count, and whether they'd compose into a
 *    single-artifact (1:1) or real multi-artifact assembly. This is a
 *    summary read off the manifest's existing `sbom`-kind entries — it does
 *    not regenerate or re-validate the aggregate document (that stays
 *    `aggregateComponentBom`'s job, given each leaf's `BomPackage[]`, which
 *    the manifest alone does not carry).
 */

import type { BuildArchiveManifest, BuildArchiveEntry } from "../components/verbs/build-archive";
import { findSbomForSubject, imageEntries, sbomEntries, artifactEntries } from "../components/verbs/build-archive";
import type { ArtifactReproducibility } from "../components/verbs/reproducibility";

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

/**
 * Where a build-ledger entry's `sbom` summary was read from — surfaced so
 * `chant components status` can report SBOM *source*, not just presence
 * (#606). "avoid drift": whichever source answers, it traces back to the
 * same `generate-sbom` run for a given digest, since promote-by-digest never
 * rebuilds — see docs/components/build-archive.mdx.
 */
export type SbomSource = "archive" | "referrer";

/**
 * The SBOM summary `chant components status` surfaces for one build-ledger
 * entry (#606): format, package count, and where it was read from — never
 * the raw SBOM bytes (chant's job is to generate/store/surface, not to
 * interpret SBOM content; that is the scan-result/VEX policy-gate
 * fast-follow, out of scope here).
 */
export interface SbomSummary {
  /** Media type of the SBOM document (`application/spdx+json` or `application/vnd.cyclonedx+json`) — the format-agnostic key, never a hardcoded format. */
  mediaType: string;
  /** Number of packages/components enumerated, when known. */
  packageCount?: number;
  /** Which tool produced it (e.g. "syft", "buildkit"), when known. */
  generator?: string;
  /** Whether this summary was read from the archive-carried entry or a registry-discovered OCI referrer. */
  source: SbomSource;
}

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
  /**
   * SBOM summary for this digest, read from whichever source is available —
   * the archive-carried `sbom`-kind manifest entry (preferred; works for
   * every artifact type and every publish backend, registry or not) or a
   * registry-discovered `sbom`-kind referrer (image artifacts only, when
   * `lookup` can reach a registry). `undefined` when neither source has one
   * — including when the component opted out of `generate-sbom` entirely.
   */
  sbom?: SbomSummary;
  /**
   * This image's own honest, per-artifact reproducibility record (#614) —
   * read from its `BuildArchiveEntry.reproducibility`. An `image` entry
   * defaults to `{ basis: "best-effort" }` (see
   * ../components/verbs/reproducibility.ts's `defaultReproducibility`)
   * absent a real reproducible-build attestation; never inferred from a
   * sibling `template`/`asset` entry's basis.
   */
  reproducibility?: ArtifactReproducibility;
}

/**
 * Build the ledger view for one archive manifest: every `image`-kind entry,
 * each paired with its OCI referrers via `lookup` and its SBOM summary (read
 * from the archive-carried entry first, the referrer projection otherwise —
 * see this module's doc comment). "What's built" becomes "what's built, from
 * which commit, by what, when" once a release record (./release-ledger.ts)
 * is joined onto this by `digest` — this function only produces the build
 * side of that join.
 */
export async function buildLedgerEntries(
  manifest: BuildArchiveManifest,
  lookup: ReferrerLookup = noopReferrerLookup,
): Promise<BuildLedgerEntry[]> {
  const images = imageEntries(manifest);
  const entries: BuildLedgerEntry[] = [];
  for (const image of images) {
    const referrers = await lookup.discover(image.digest);

    const archiveSbom = findSbomForSubject(manifest, image.digest);
    const referrerSbom = findReferrer(referrers, "sbom");
    const sbom: SbomSummary | undefined = archiveSbom
      ? {
          mediaType: archiveSbom.mediaType ?? "application/octet-stream",
          packageCount: archiveSbom.packageCount,
          generator: archiveSbom.generator,
          source: "archive",
        }
      : referrerSbom
        ? { mediaType: referrerSbom.mediaType, source: "referrer" }
        : undefined;

    entries.push({
      component: manifest.component,
      path: image.path,
      digest: image.digest,
      createdAt: manifest.createdAt,
      manifestDigest: manifest.manifestDigest,
      referrers,
      sbom,
      reproducibility: image.reproducibility,
    });
  }
  return entries;
}

/** Find the referrer of a given kind for a digest, if any (a convenience for "does this build have a signature/SBOM/provenance"). */
export function findReferrer(referrers: Referrer[], kind: ReferrerKind): Referrer | undefined {
  return referrers.find((r) => r.kind === kind);
}

// ── #614: per-artifact reproducibility + component BOM summary ─────────────

/** One artifact's reproducibility, named for display (`chant components status`) rather than just keyed by digest. */
export interface ArtifactReproducibilitySummary {
  /** Archive-relative path of the artifact (`BuildArchiveEntry.path`). */
  path: string;
  /** Which kind of artifact this is. */
  kind: BuildArchiveEntry["kind"];
  /** Content-addressed digest of the artifact. */
  digest: string;
  /** The artifact's own reproducibility record, when one is recorded (absent only for `sbom`-kind entries, which describe another artifact rather than being one). */
  reproducibility?: ArtifactReproducibility;
  /** Source ref/commit that produced this artifact, when recorded (#614's provenance link). */
  sourceRef?: string;
}

/**
 * Report every artifact entry's (`image`/`template`/`asset`) own
 * reproducibility + provenance, honestly per-artifact — the full picture
 * #614 asks for, wider than `buildLedgerEntries`'s image-only scope. Order
 * matches `artifactEntries`' manifest insertion order; sort by `path`
 * yourself for a stable display order (mirroring
 * `computeManifestDigest`'s own path-sort convention).
 */
export function artifactReproducibilitySummary(manifest: BuildArchiveManifest): ArtifactReproducibilitySummary[] {
  return artifactEntries(manifest).map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    digest: entry.digest,
    reproducibility: entry.reproducibility,
    sourceRef: entry.provenance?.sourceRef,
  }));
}

/** One leaf BOM in a component's aggregation picture — the summary form `componentBomSummary` reports, without regenerating or re-validating the aggregate document itself. */
export interface ComponentBomLeafSummary {
  /** Archive-relative path of the leaf BOM document. */
  path: string;
  /** Software SBOM or IaC config-BOM (#613's `bomKind`, defaulting to `"software"` the same way `BuildArchiveEntry.bomKind` does). */
  bomKind: "software" | "config";
  /** Digest of the artifact this leaf describes (`subjectDigest`), when recorded. */
  subjectDigest?: string;
  /** Media type of the leaf document (format-agnostic key, per #613's convention). */
  mediaType: string;
  /** Package/component count this leaf enumerates, when known. */
  packageCount?: number;
  /** Which tool produced this leaf, when known. */
  generator?: string;
}

/**
 * Summary of a component's BOM aggregation picture (#614,
 * ../components/verbs/component-bom.ts): every leaf BOM the manifest
 * carries, whether they compose 1:1 (a single-artifact component — the leaf
 * BOM *is* the component BOM, structurally) or as a real multi-artifact
 * assembly (2+ leaves), and the combined package count across every leaf.
 */
export interface ComponentBomSummary {
  /** Every leaf BOM (software SBOM + IaC config-BOM) the manifest carries. */
  leaves: ComponentBomLeafSummary[];
  /** Sum of every leaf's `packageCount` (0 for a leaf with an unknown count). */
  totalPackageCount: number;
  /** `false` when there are 0 or 1 leaves (nothing to assemble, or a 1:1 component BOM); `true` when there are 2+ leaves (a real multi-artifact assembly, per #614's "single-artifact = 1:1, multi-artifact = a real assembly"). */
  isAssembly: boolean;
}

/**
 * Build the component BOM summary for one manifest, straight from its
 * existing `sbom`-kind entries — no regeneration, no re-parsing of BOM
 * bytes. `undefined` when the manifest carries no BOM at all (a component
 * that composed neither `generate-sbom` nor `extract-config-bom` — skipping
 * is structural, matching every other BOM consumer's convention in this
 * codebase).
 */
export function componentBomSummary(manifest: BuildArchiveManifest): ComponentBomSummary | undefined {
  const boms = sbomEntries(manifest);
  if (boms.length === 0) return undefined;

  const leaves: ComponentBomLeafSummary[] = boms.map((entry) => ({
    path: entry.path,
    bomKind: entry.bomKind ?? "software",
    subjectDigest: entry.subjectDigest,
    mediaType: entry.mediaType ?? "application/octet-stream",
    packageCount: entry.packageCount,
    generator: entry.generator,
  }));
  const totalPackageCount = leaves.reduce((sum, l) => sum + (l.packageCount ?? 0), 0);

  return { leaves, totalPackageCount, isAssembly: leaves.length > 1 };
}
