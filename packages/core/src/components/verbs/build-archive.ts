/**
 * BuildArchive format — the self-contained bundle `docker-build` (and the
 * other build-family verbs) write into (#564, epic #551 "4. Build archive +
 * deferred publish"). See docs/components/build-archive.mdx.
 *
 * A build archive holds four kinds of contents, enumerated by one manifest:
 *  - `image` — an image tarball in OCI layout (as `docker save` produces),
 *    content-addressed by its digest.
 *  - `template` — a synthesized deploy template (e.g. a CloudFormation
 *    document) referenced by `cfn-deploy`'s `archive:<name>` convention
 *    (see ../verbs/apply.ts's `CfnDeployInput.template`). Per #613, a
 *    `template` entry is a first-class artifact with its own content
 *    digest — peer to `image`/`asset` — so it can itself be the
 *    `subjectDigest` a `sbom`-kind entry (specifically a config-BOM,
 *    `bomKind: "config"`) is attached to.
 *  - `asset` — any other published artifact (a jar, a zip) the `publish`
 *    family's non-image backends (`publish-artifact`) promote.
 *  - `sbom` — a Bill of Materials attached to another entry's digest (#606,
 *    #613, epic #551 follow-up to #564/#568), written by either the
 *    `generate-sbom` capability (./sbom.ts, a **software** BOM over an
 *    image/jar/zip/dir) or the `extract-config-bom` capability
 *    (./config-bom.ts, a **config-BOM** over a synthesized IaC template's
 *    declared resources/nested stacks/external references). `bomKind`
 *    distinguishes the two without introducing a separate entry kind — both
 *    are content-addressed, digest-linked BOM documents, and every existing
 *    `sbom`-kind consumer (`findSbomForSubject`, the build ledger) keeps
 *    working unmodified for either kind. The archive is the **universal
 *    home** for both: an image's SBOM may also be projected as an OCI
 *    referrer at publish time (a registry-side convenience for `oras
 *    discover`/`cosign tree`), but the archive-carried copy is what makes
 *    non-image artifacts (a jar in S3, a zip, a template) and registry-less
 *    deploys (`load-image-on-host`) work identically — no registry required
 *    to read a build's BOM back.
 *
 * The manifest is itself content-addressed (`manifestDigest`, a stable hash
 * over its entries) so two builds of the same inputs produce the same
 * archive identity, and so a promoted digest can be traced back to exactly
 * the manifest that produced it. Nothing here shells out or touches a real
 * filesystem/docker daemon — manifest assembly is pure data, which is what
 * lets `docker-build` (./build.ts) and `publish-image`/`load-image-on-host`
 * (./publish.ts) build and promote an archive entirely through the injectable
 * `CloudExecutor`, exercised in tests via `MockCloudExecutor` with no real
 * disk/docker/AWS involved. The same is true of `generate-sbom` (./sbom.ts)
 * and the injectable `SbomGenerator` (./sbom-generator.ts).
 *
 * Per #614, every `image`/`template`/`asset` entry also carries an honest,
 * per-artifact `reproducibility` record and an optional `provenance`
 * source->output link (see ./reproducibility.ts) — never a single blanket
 * flag hoisted to the component, since a component that builds more than one
 * artifact type (an image plus a synthesized template, say) has a different
 * true answer for each.
 */

// ── manifest entries ──────────────────────────────────────────────────────

import type { ArtifactReproducibility, ProvenanceLink } from "./reproducibility";
import { defaultReproducibility } from "./reproducibility";

export type BuildArchiveEntryKind = "image" | "template" | "asset" | "sbom";

/** One content-addressed item inside a build archive. */
export interface BuildArchiveEntry {
  /** What this entry is — an OCI-layout image tarball, a synthesized template, a non-image asset (jar/zip), or an SBOM. */
  kind: BuildArchiveEntryKind;
  /** Path of this entry inside the archive (what `cfn-deploy`'s `archive:<path>` and `publish-image`/`publish-artifact`'s `from` reference). */
  path: string;
  /** Content-addressed digest of this entry's bytes (`sha256:...`). Identity for promote-by-digest. */
  digest: string;
  /** Declared media type, mirroring the OCI conventions the epic references (`oras discover`/`cosign tree` attach to the same digest). Defaults are assigned per `kind` by `addArchiveEntry` when omitted. For a `kind: "sbom"` entry this is the SBOM's own media type (`application/spdx+json` or `application/vnd.cyclonedx+json`) — never hardcoded, always read from the `SbomDocument` that produced the entry (./sbom-generator.ts). */
  mediaType?: string;
  /**
   * For a `kind: "sbom"` entry only: the digest of the artifact this SBOM
   * describes (an `image`/`asset` entry's `digest` elsewhere in the same
   * manifest) — the OCI "referrer subject" relationship, recorded uniformly
   * here regardless of whether the backend that produced it was a BuildKit
   * attestation or a `syft` scan (#606: "the backend owns HOW it attaches
   * ... the archive manifest records it uniformly"). Absent for non-SBOM
   * entries.
   */
  subjectDigest?: string;
  /** For a `kind: "sbom"` entry only: number of packages/components the SBOM enumerates, when known — surfaced by `chant components status` without parsing the SBOM bytes. */
  packageCount?: number;
  /** For a `kind: "sbom"` entry only: which tool produced it (e.g. "syft", "buildkit") — surfaced alongside format/package count so status reports SBOM *source*. */
  generator?: string;
  /**
   * For a `kind: "sbom"` entry only: whether this is a **software** BOM
   * (over an image/jar/zip/dir's declared dependencies, ./sbom.ts) or a
   * **config-BOM** (over a synthesized IaC template's declared resources +
   * nested stacks + external references, ./config-bom.ts) (#613). Defaults
   * to `"software"` when omitted, so every pre-#613 `sbom` entry (and every
   * caller that never set this field) is unambiguously the software kind —
   * this default must never change without a manifest version bump.
   */
  bomKind?: "software" | "config";
  /**
   * For an `image`/`template`/`asset` entry: the honest, per-artifact
   * reproducibility basis (#614, see ./reproducibility.ts). Assigned a
   * kind-appropriate default by `addArchiveEntry` when omitted — see
   * `defaultReproducibility` — so every entry that can meaningfully carry a
   * reproducibility claim gets one without every call site having to compute
   * it. Absent for `sbom` entries, which describe another artifact rather
   * than being one themselves.
   */
  reproducibility?: ArtifactReproducibility;
  /**
   * For an `image`/`template`/`asset` entry: the source ref/commit that
   * produced this artifact's digest (#614). Optional — a caller that hasn't
   * threaded through a source ref (e.g. a test fixture, or a build run
   * outside a git checkout) simply omits it rather than fabricating one.
   */
  provenance?: ProvenanceLink;
}

/** The manifest of contents for one build archive — the "self-contained format" #564 asks for. */
export interface BuildArchiveManifest {
  /** Manifest schema version, so a future incompatible shape can be detected before being misread. */
  version: 1;
  /** Component this archive was built for. */
  component: string;
  /** ISO-8601 timestamp this manifest was assembled. */
  createdAt: string;
  /** Every image/template/asset this archive carries. */
  contents: BuildArchiveEntry[];
  /**
   * Content-addressed digest of this manifest's own entries (`sha256:...`),
   * stable across rebuilds of byte-identical inputs and independent of
   * `createdAt` — so identical inputs produce the same archive identity even
   * when built at different times, and a changed digest here always means
   * changed contents, not merely a re-run.
   */
  manifestDigest: string;
}

/**
 * Fallback media type per entry `kind`, used only when a caller omits
 * `mediaType` on `addArchiveEntry`. `sbom` has no single default here by
 * design — SPDX and CycloneDX are both first-class (#606) and the actual
 * media type always comes from the `SbomDocument` the `generate-sbom`
 * capability produced (./sbom-generator.ts); this fallback exists only so a
 * malformed/omitted call doesn't produce an entry with no media type at all.
 */
const DEFAULT_MEDIA_TYPES: Record<BuildArchiveEntryKind, string> = {
  image: "application/vnd.oci.image.layout.v1.tar",
  template: "application/json",
  asset: "application/octet-stream",
  sbom: "application/spdx+json",
};

/**
 * Deterministic content digest over arbitrary string content. Same shape as
 * the FNV-ish fake digest `MockCloudExecutor` uses, so tests can assert on it
 * without a real `sha256` implementation. Exported so callers that need to
 * digest content that never goes through the `CloudExecutor` (e.g. a
 * synthesized template's serialized bytes, see ./build.ts's
 * `addArchiveTemplate`) share this one algorithm rather than each defining
 * their own. Production `image`/`asset` entries instead carry the real
 * digest their producing capability already computed (e.g. `docker-build`'s
 * `executor.docker.build` digest).
 */
export function contentDigest(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (Math.imul(hash, 31) + input.charCodeAt(i)) | 0;
  }
  const hex = Math.abs(hash).toString(16).padStart(8, "0");
  return `sha256:${hex.repeat(8).slice(0, 64)}`;
}

/** Compute the aggregate `manifestDigest` over a set of entries — sorted by path so entry order never changes the digest, only content does. */
export function computeManifestDigest(contents: BuildArchiveEntry[]): string {
  const sorted = [...contents].sort((a, b) => a.path.localeCompare(b.path));
  const canonical = sorted.map((e) => `${e.kind}:${e.path}:${e.digest}`).join("\n");
  return contentDigest(canonical);
}

/** Start a new, empty manifest for `component`. Entries are added with `addArchiveEntry`. */
export function createBuildArchiveManifest(component: string, opts?: { now?: () => Date }): BuildArchiveManifest {
  const createdAt = (opts?.now ?? (() => new Date()))().toISOString();
  return { version: 1, component, createdAt, contents: [], manifestDigest: computeManifestDigest([]) };
}

/**
 * Add (or replace, by `path`) one entry and return a new manifest with
 * `manifestDigest` recomputed. Pure/immutable so callers (and tests) can hold
 * onto a manifest snapshot before/after a step without aliasing surprises.
 *
 * Assigns a kind-appropriate default `reproducibility` (#614,
 * `defaultReproducibility`) when the caller omits one — `template` entries
 * default to `deterministic-synthesis`, `image`/`asset` entries default to
 * `best-effort`, and `sbom` entries get none. An explicit `entry.reproducibility`
 * (e.g. a future reproducible-build-attested image) always wins over the
 * default. `reproducibility`/`provenance` are never part of
 * `computeManifestDigest`'s input — they describe the artifact, they are not
 * content the artifact's identity depends on, so recording/correcting them
 * later never perturbs `manifestDigest`.
 */
export function addArchiveEntry(
  manifest: BuildArchiveManifest,
  entry: BuildArchiveEntry,
): BuildArchiveManifest {
  const reproducibility =
    entry.reproducibility ??
    (entry.kind === "image" || entry.kind === "template" || entry.kind === "asset" || entry.kind === "sbom"
      ? defaultReproducibility(entry.kind)
      : undefined);
  const resolved: BuildArchiveEntry = {
    mediaType: DEFAULT_MEDIA_TYPES[entry.kind],
    ...entry,
    ...(reproducibility ? { reproducibility } : {}),
  };
  const contents = [...manifest.contents.filter((e) => e.path !== resolved.path), resolved];
  return { ...manifest, contents, manifestDigest: computeManifestDigest(contents) };
}

/** Look up one entry by archive-relative path (the same path form `cfn-deploy`'s `archive:<path>` and `publish-image`'s `from` use). */
export function findArchiveEntry(
  manifest: BuildArchiveManifest,
  path: string,
): BuildArchiveEntry | undefined {
  return manifest.contents.find((e) => e.path === path);
}

/**
 * Strip the `archive:` prefix chant's step wiring uses
 * (e.g. `cfn-deploy`'s `template: "archive:search.template.json"`) down to
 * the manifest-relative path. Returns the input unchanged when it carries no
 * such prefix (a plain filesystem path outside the archive).
 */
export function archiveRelativePath(ref: string): string {
  return ref.startsWith("archive:") ? ref.slice("archive:".length) : ref;
}

/** All `image`-kind entries in a manifest — what a publish backend has to choose from when `from` is ambiguous/omitted. */
export function imageEntries(manifest: BuildArchiveManifest): BuildArchiveEntry[] {
  return manifest.contents.filter((e) => e.kind === "image");
}

/** All `sbom`-kind entries in a manifest, regardless of which artifact they describe (#606). */
export function sbomEntries(manifest: BuildArchiveManifest): BuildArchiveEntry[] {
  return manifest.contents.filter((e) => e.kind === "sbom");
}

/**
 * Find the archive-carried SBOM entry attached to a given artifact digest
 * (an `image`/`asset` entry's `digest` elsewhere in the same manifest). This
 * is the archive-native lookup ../../lifecycle/build-ledger.ts's
 * `buildLedgerEntries` uses to surface "SBOM by digest" without any registry
 * or `oras`/network access — the archive is the universal home for the SBOM
 * regardless of artifact type (#606).
 */
export function findSbomForSubject(
  manifest: BuildArchiveManifest,
  subjectDigest: string,
): BuildArchiveEntry | undefined {
  return manifest.contents.find((e) => e.kind === "sbom" && e.subjectDigest === subjectDigest);
}

/**
 * Find the archive-carried **config-BOM** entry (`bomKind: "config"`)
 * attached to a given template digest — the config-BOM analogue of
 * `findSbomForSubject` (#613). A `template` entry's digest is computed the
 * same way an `image`/`asset` entry's is (`contentDigest` over its bytes,
 * see `addArchiveTemplate` in ./build.ts), so config-only/infra components
 * with no software artifact still resolve a BOM by digest through the same
 * lookup shape as every other artifact kind.
 */
export function findConfigBomForSubject(
  manifest: BuildArchiveManifest,
  subjectDigest: string,
): BuildArchiveEntry | undefined {
  return manifest.contents.find(
    (e) => e.kind === "sbom" && e.bomKind === "config" && e.subjectDigest === subjectDigest,
  );
}

/** All `template`-kind entries in a manifest — every synthesized IaC document the archive carries, each a first-class artifact with its own content digest (#613). */
export function templateEntries(manifest: BuildArchiveManifest): BuildArchiveEntry[] {
  return manifest.contents.filter((e) => e.kind === "template");
}

/** All `asset`-kind entries in a manifest (non-image published artifacts — a jar, a zip). */
export function assetEntries(manifest: BuildArchiveManifest): BuildArchiveEntry[] {
  return manifest.contents.filter((e) => e.kind === "asset");
}

/**
 * Every artifact entry in a manifest — `image`, `template`, and `asset`
 * kinds, excluding `sbom` entries (which describe an artifact rather than
 * being one) — the set #614's per-artifact reproducibility surface iterates
 * over. Order is manifest insertion order; callers that need a stable order
 * for display/JSON output sort by `path` themselves (mirroring
 * `computeManifestDigest`'s own path-sort convention).
 */
export function artifactEntries(manifest: BuildArchiveManifest): BuildArchiveEntry[] {
  return manifest.contents.filter((e) => e.kind !== "sbom");
}
