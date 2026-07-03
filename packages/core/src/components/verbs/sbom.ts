/**
 * `generate-sbom` capability (#606, epic #551 follow-up to #564's build
 * archive / #568's build ledger — closes the "produce" side #568 explicitly
 * deferred).
 *
 * One capability, artifact-type-keyed via the injectable `SbomGenerator`
 * (./sbom-generator.ts — mirrors ./cloud-executor.ts's `CloudExecutor`
 * pattern), so a build-producing component of *any* artifact type — image,
 * JAR, zip/Lambda package, or a bare source directory for a config-only
 * producer — generates its SBOM through the same verb. Never docker-only:
 * dispatch is on `input.artifactType`, not on which build capability
 * produced the artifact.
 *
 * Writes the result into the build-archive manifest as an `sbom`-kind entry
 * (../verbs/build-archive.ts), content-addressed and linked to its subject
 * artifact's digest via `subjectDigest` — the **universal home** for the
 * SBOM regardless of artifact type or registry availability. Registering the
 * SBOM as an OCI referrer for image artifacts at publish time is a separate,
 * later concern (the publish step/registry tooling's job, see
 * ../../lifecycle/build-ledger.ts's `ReferrerLookup` for the consume side);
 * this capability only ever writes the archive-carried copy, so it works
 * unconditionally — including the registry-less `load-image-on-host` path.
 *
 * Config-only / infra components have no built artifact and simply never
 * compose this step into their `deploy`/`build` phase — "skips cleanly" is
 * structural (no step to run), not a special case this module needs to
 * detect. Opt-out is the same: a component that wants no SBOM omits the
 * `generate-sbom` step from its composition.
 */

import type { Capability } from "../capability";
import {
  addArchiveEntry,
  archiveRelativePath,
  contentDigest,
  createBuildArchiveManifest,
  type BuildArchiveManifest,
} from "./build-archive";
import {
  defaultSbomGenerator,
  DEFAULT_SBOM_FORMAT,
  type SbomArtifactType,
  type SbomDocument,
  type SbomFormat,
  type SbomGenerator,
} from "./sbom-generator";

// ── generate-sbom ────────────────────────────────────────────────────────────

export interface GenerateSbomInput {
  /** Which artifact type to generate an SBOM for — selects the `SbomGenerator` method dispatched to (image -> BuildKit/syft, jar -> syft/cyclonedx-maven, zip -> syft, dir -> syft/cdxgen). */
  artifactType: SbomArtifactType;
  /** Archive-relative (or local, for `dir`) path to the artifact being scanned — the archive entry's `path` for `image`/`jar`/`zip`, or a source directory for `dir`. An `archive:`-prefixed reference is accepted and stripped, matching `publish-image`'s `from` convention. */
  path: string;
  /** Digest of the artifact this SBOM describes (the `image`/`asset` archive entry's `digest`) — omitted for `dir` scans that precede any build (no artifact digest exists yet), in which case the SBOM entry's `subjectDigest` is left unset. */
  digest?: string;
  /** SBOM format to request. Defaults to `chant.config.ts`'s `sbom.format`, then `DEFAULT_SBOM_FORMAT` (SPDX) when neither this input nor project config says otherwise — see ./sbom-generator.ts. */
  format?: SbomFormat;
  /** Where the SBOM document is written inside the build archive (e.g. `"search.sbom.json"`). Defaults to `<path>.sbom.json`. */
  into?: string;
  /** Manifest to extend with this SBOM's entry, rather than starting a fresh one — the same accumulation convention `docker-build`'s `manifest` input uses (./build.ts), so a component's whole build phase (image + SBOM, or JAR + SBOM) shares one manifest. */
  manifest?: BuildArchiveManifest;
}

export interface GenerateSbomOutput {
  /** The generated SBOM document (format, media type, bytes, package count, generator) — see ./sbom-generator.ts. */
  sbom: SbomDocument;
  /** Where the SBOM was written inside the build archive. */
  archivePath: string;
  /** Content-addressed digest of the SBOM document's own bytes. */
  digest: string;
  /** The build archive's manifest, now including this SBOM's entry alongside whatever `input.manifest` already held. */
  manifest: BuildArchiveManifest;
}

/** Default archive path for a generated SBOM when `into` is omitted: `<artifact path>.sbom.json`. */
function defaultSbomPath(artifactPath: string): string {
  return `${archiveRelativePath(artifactPath)}.sbom.json`;
}

/**
 * Dispatch one `SbomGenerator` call by `artifactType` — the only place this
 * capability branches on artifact type, matching how `selectPublishBackend`
 * (./publish.ts) is the only place the publish family branches on backend
 * kind. Never a component/cloud name, always an artifact shape.
 */
async function generate(
  generator: SbomGenerator,
  input: GenerateSbomInput,
  artifactPath: string,
): Promise<SbomDocument> {
  switch (input.artifactType) {
    case "image":
      return generator.forImage({ imagePath: artifactPath, digest: input.digest ?? "", format: input.format });
    case "jar":
      return generator.forJar({ jarPath: artifactPath, digest: input.digest ?? "", format: input.format });
    case "zip":
      return generator.forZip({ zipPath: artifactPath, digest: input.digest ?? "", format: input.format });
    case "dir":
      return generator.forDir({ path: artifactPath, format: input.format });
  }
}

/**
 * Generate an SBOM for a build-producing component's artifact (image, JAR,
 * zip, or source directory) via the artifact-type-keyed `SbomGenerator`, and
 * fold the result into the build-archive manifest as an `sbom`-kind entry
 * linked to the subject artifact's digest. Format defaults to
 * `DEFAULT_SBOM_FORMAT` (SPDX) when neither `input.format` nor the injected
 * generator overrides it — see ./sbom-generator.ts's module doc for the
 * full default-resolution story. `chant.config.ts`'s `sbom.format` (see
 * ../../config.ts's `ChantConfig.sbom` and `resolveSbomFormat`) is resolved
 * by the caller/orchestrator into `input.format` before this capability
 * runs, the same way env config is resolved before any other capability's
 * `run` (this module never imports ../../config.ts directly, matching how
 * no other verb module does either).
 *
 * No rollback: an already-generated SBOM sitting in the archive (or, later,
 * projected as a registry referrer) is immutable, content-addressed
 * evidence — nothing to compensate, the same opt-out `docker-build` and
 * `publish-image` already take for their own no-mutable-remote-state reason.
 */
export function createGenerateSbomCapability(
  generator: SbomGenerator = defaultSbomGenerator(),
): Capability<GenerateSbomInput, GenerateSbomOutput> {
  return {
    kind: "generate-sbom",
    async run(ctx, input) {
      const artifactPath = archiveRelativePath(input.path);
      const format = input.format ?? DEFAULT_SBOM_FORMAT;
      const sbom = await generate(generator, { ...input, format }, artifactPath);

      const into = input.into ?? defaultSbomPath(input.path);
      const digest = contentDigest(sbom.bytes);
      const base = input.manifest ?? createBuildArchiveManifest(ctx.component);
      const manifest = addArchiveEntry(base, {
        kind: "sbom",
        path: into,
        digest,
        mediaType: sbom.mediaType,
        subjectDigest: input.digest,
        packageCount: sbom.packageCount,
        generator: sbom.generator,
      });

      return { sbom, archivePath: into, digest, manifest };
    },
  };
}

/** Default `generate-sbom` capability, backed by the process-wide default `SbomGenerator` (throws until a real backend is injected — see ./sbom-generator.ts's `notImplementedSbomGenerator`). */
export const generateSbom: Capability<GenerateSbomInput, GenerateSbomOutput> = createGenerateSbomCapability();
