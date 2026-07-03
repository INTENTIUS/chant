/**
 * Per-artifact reproducibility + provenance record (#614, epic #551 follow-up
 * to #613's BOM-doc model). Attaches to a `BuildArchiveEntry`
 * (./build-archive.ts) alongside the BOM entries #613 already added, so every
 * artifact in a build archive carries not just "what's in it" (the BOM) but
 * also "can this be reproduced, and from what source."
 *
 * **Honesty over convenience.** A single blanket "reproducible: true/false"
 * bit on a *component* would misrepresent a component that builds more than
 * one artifact type — a synthesized IaC template and a container image are
 * not equally reproducible, and collapsing them into one flag would either
 * overstate the image's reproducibility or understate the template's. This
 * module therefore records `basis` **per artifact entry**, never per
 * component:
 *
 *  - `"deterministic-synthesis"` — chant's own synthesis produced this
 *    artifact from declarative input (a `template`-kind entry, see
 *    ../../build.ts). Re-running `chant build` against the same source
 *    reproduces byte-identical output — the same content-addressing property
 *    ./build-archive.ts's `contentDigest`/`manifestDigest` already rely on.
 *    Verification is exactly "re-synth and compare digests," expressed here
 *    as `verifyBy: "re-synth"`.
 *  - `"best-effort"` — an `image`/`asset` entry built by an external tool
 *    (`docker build`, a JVM/zip packager). Nothing here observes whether the
 *    underlying build was actually bit-for-bit reproducible (timestamps,
 *    build-arg ordering, and base-image drift are common, unglamorous causes
 *    of non-determinism that chant does not control) — `"best-effort"` is
 *    the honest default absent a real reproducible-build attestation. A
 *    future SLSA/reproducible-build-flagged backend can upgrade this to a
 *    stronger basis; nothing here forecloses that, it just refuses to claim
 *    it today.
 *
 * **Provenance** is the companion source -> output link: which source
 * ref/commit produced this artifact's digest. Recorded per artifact for the
 * same reason `basis` is — two artifacts from one component build may trace
 * to different source trees (e.g. an image built from `services/search/` vs
 * a template synthesized from `infra/search.component.ts`), so the link
 * belongs on the entry, not hoisted to the component.
 */

// ── reproducibility ─────────────────────────────────────────────────────────

/**
 * How an artifact's reproducibility is established. Deliberately two values,
 * not a spectrum: chant either produced the artifact itself via deterministic
 * synthesis (verifiable by re-running `chant build`), or it didn't (an
 * external build tool produced it, and no attestation proves determinism).
 * Adding a third value (e.g. a real SLSA-attested "reproducible-build") is a
 * later, additive change — widening `basis` never requires touching every
 * existing artifact's recorded value, since `"best-effort"` remains true of
 * anything not upgraded.
 */
export type ReproducibilityBasis = "deterministic-synthesis" | "best-effort";

/** How a claimed `basis` can actually be checked. Optional — a `"best-effort"` entry commonly has no verification path at all. */
export type VerificationMethod = "re-synth";

/** The reproducibility record for one build-archive entry (#614). */
export interface ArtifactReproducibility {
  /** Honest, per-artifact basis for the claim — never inferred from a sibling artifact's basis. */
  basis: ReproducibilityBasis;
  /** How to verify the claim, when there is one. `"re-synth"` applies only to `"deterministic-synthesis"` entries — re-run `chant build` and compare the resulting digest. */
  verifyBy?: VerificationMethod;
}

/**
 * Default reproducibility basis for a given `BuildArchiveEntryKind`, absent
 * an explicit override. A `template` entry is chant's own synthesized IaC
 * output — deterministic by construction (the same synthesis run over the
 * same source produces the same bytes, per ./build-archive.ts's module doc).
 * `image`/`asset` entries are produced by an external build tool chant only
 * orchestrates (`docker build`, a JVM/zip packager) — best-effort absent a
 * real reproducible-build attestation. `sbom` entries describe another
 * artifact rather than being one themselves, so they carry no
 * reproducibility claim of their own (`undefined`) — see
 * `../build-archive.ts`'s `BuildArchiveEntry.reproducibility` doc.
 */
export function defaultReproducibility(
  kind: "image" | "template" | "asset" | "sbom",
): ArtifactReproducibility | undefined {
  switch (kind) {
    case "template":
      return { basis: "deterministic-synthesis", verifyBy: "re-synth" };
    case "image":
    case "asset":
      return { basis: "best-effort" };
    case "sbom":
      return undefined;
  }
}

// ── provenance ───────────────────────────────────────────────────────────────

/** One source -> output link: the source ref/commit that produced a given artifact digest. */
export interface ProvenanceLink {
  /** Source ref/commit the artifact was built or synthesized from (e.g. a git sha, or `"<sha>:<path>"` when a monorepo subpath matters). */
  sourceRef: string;
  /** The artifact digest this provenance describes — the same `BuildArchiveEntry.digest` it is attached to, repeated here so a `ProvenanceLink` remains meaningful if ever extracted/serialized apart from its entry. */
  artifactDigest: string;
}
