/**
 * BuildArchive format — the self-contained bundle `docker-build` (and the
 * other build-family verbs) write into (#564, epic #551 "4. Build archive +
 * deferred publish"). See docs/components/build-archive.mdx.
 *
 * A build archive holds three kinds of contents, enumerated by one manifest:
 *  - `image` — an image tarball in OCI layout (as `docker save` produces),
 *    content-addressed by its digest.
 *  - `template` — a synthesized deploy template (e.g. a CloudFormation
 *    document) referenced by `cfn-deploy`'s `archive:<name>` convention
 *    (see ../verbs/apply.ts's `CfnDeployInput.template`).
 *  - `asset` — any other published artifact (a jar, a zip) the `publish`
 *    family's non-image backends (`publish-artifact`) promote.
 *
 * The manifest is itself content-addressed (`manifestDigest`, a stable hash
 * over its entries) so two builds of the same inputs produce the same
 * archive identity, and so a promoted digest can be traced back to exactly
 * the manifest that produced it. Nothing here shells out or touches a real
 * filesystem/docker daemon — manifest assembly is pure data, which is what
 * lets `docker-build` (./build.ts) and `publish-image`/`load-image-on-host`
 * (./publish.ts) build and promote an archive entirely through the injectable
 * `CloudExecutor`, exercised in tests via `MockCloudExecutor` with no real
 * disk/docker/AWS involved.
 */

// ── manifest entries ──────────────────────────────────────────────────────

export type BuildArchiveEntryKind = "image" | "template" | "asset";

/** One content-addressed item inside a build archive. */
export interface BuildArchiveEntry {
  /** What this entry is — an OCI-layout image tarball, a synthesized template, or a non-image asset (jar/zip). */
  kind: BuildArchiveEntryKind;
  /** Path of this entry inside the archive (what `cfn-deploy`'s `archive:<path>` and `publish-image`/`publish-artifact`'s `from` reference). */
  path: string;
  /** Content-addressed digest of this entry's bytes (`sha256:...`). Identity for promote-by-digest. */
  digest: string;
  /** Declared media type, mirroring the OCI conventions the epic references (`oras discover`/`cosign tree` attach to the same digest). Defaults are assigned per `kind` by `addArchiveEntry` when omitted. */
  mediaType?: string;
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

const DEFAULT_MEDIA_TYPES: Record<BuildArchiveEntryKind, string> = {
  image: "application/vnd.oci.image.layout.v1.tar",
  template: "application/json",
  asset: "application/octet-stream",
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
 */
export function addArchiveEntry(
  manifest: BuildArchiveManifest,
  entry: BuildArchiveEntry,
): BuildArchiveManifest {
  const resolved: BuildArchiveEntry = { mediaType: DEFAULT_MEDIA_TYPES[entry.kind], ...entry };
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
