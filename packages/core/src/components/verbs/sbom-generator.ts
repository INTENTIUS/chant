/**
 * SBOM document type + the injectable, artifact-type-keyed `SbomGenerator`
 * boundary (#606, epic #551 "Build & deploy observability" follow-up to
 * #564/#568). Mirrors ./cloud-executor.ts's `CloudExecutor` pattern: a real
 * backend may shell out to `syft`/`docker buildx --sbom`/`cyclonedx-maven`,
 * but no test and no default import ever does — every backend here is
 * injected, and tests construct a `MockSbomGenerator`
 * (./__tests__/mock-sbom-generator.ts) instead.
 *
 * **Format-agnostic by construction.** An SBOM is stored as an opaque typed
 * doc: `{ format, mediaType, bytes }`. Nothing downstream (the build-archive
 * manifest, the build ledger, `chant components status`) branches on
 * `format` — every consumer keys off `mediaType`, the same convention
 * `BuildArchiveEntry.mediaType` already uses for image/template/asset
 * entries (./build-archive.ts). SPDX (`application/spdx+json`) and
 * CycloneDX (`application/vnd.cyclonedx+json`) are both first-class; neither
 * is hardcoded as *the* format anywhere in this module or its consumers.
 *
 * **Default format:** SPDX, matching the epic's refinement from the
 * devops-cloud.news SBOM article — BuildKit natively emits SPDX attestations
 * for images, so the image/BuildKit backend defaults to SPDX; the `syft`
 * backend can emit either and defaults to SPDX here too, for one predictable
 * default across artifact types. Override via `chant.config.ts`'s
 * `sbom.format` (see ../../config.ts) and/or a component's own `build.sbom`
 * (see ../component.ts's `BuildSpec`). Documented in
 * docs/components/build-archive.mdx.
 *
 * **Artifact-type-keyed generation.** "Generate an SBOM" has a different
 * real implementation per artifact type — an image asks BuildKit or scans
 * the built image with `syft`; a JAR is scanned with `syft` or
 * `cyclonedx-maven`; a zip/Lambda package is scanned with `syft`; a bare
 * source directory is scanned with `syft`/`cdxgen`. `SbomGenerator` is one
 * interface with one method per artifact type — analogous to
 * `PublishImageBackend` being one interface satisfied by two backends
 * (./publish.ts) — so the *capability* (./sbom.ts) stays artifact-type
 * agnostic and simply calls the method matching the archive entry it was
 * handed.
 */

// `lockfileSbomGenerator` (#630's hermetic default, below) lives in
// ./lockfile-sbom-generator.ts, which itself imports `DEFAULT_SBOM_FORMAT`/
// `SbomGeneratorNotImplementedError` from *this* module — a deliberate
// circular import. Safe here because the only use of `lockfileSbomGenerator`
// in this file is inside `defaultSbomGenerator()`'s function body (evaluated
// lazily, on first call), never at this module's own top-level/import time,
// so it doesn't matter which module's evaluation finishes first.
import { lockfileSbomGenerator } from "./lockfile-sbom-generator";

// ── the SBOM document ────────────────────────────────────────────────────────

/** The two SBOM standards this module supports. Never hardcode one — consumers key off `mediaType`. */
export type SbomFormat = "spdx" | "cyclonedx";

/** Canonical media type per format, mirroring `BuildArchiveEntry.mediaType`'s convention (./build-archive.ts). */
export const SBOM_MEDIA_TYPES: Record<SbomFormat, string> = {
  spdx: "application/spdx+json",
  cyclonedx: "application/vnd.cyclonedx+json",
};

/** Project-wide default SBOM format when neither `chant.config.ts`'s `sbom.format` nor a component's `build.sbom.format` says otherwise. Documented in docs/components/build-archive.mdx. */
export const DEFAULT_SBOM_FORMAT: SbomFormat = "spdx";

/**
 * The artifact types an `SbomGenerator` backend can be asked to scan —
 * mirrors the build-family's artifact shapes (`docker-build` -> `image`,
 * `jvm-build` -> `jar`, `zip-package` -> `zip`, a bare source tree -> `dir`),
 * never a component/cloud name.
 */
export type SbomArtifactType = "image" | "jar" | "zip" | "dir";

/**
 * An SBOM as an opaque typed document: format, its media type (what every
 * consumer actually keys off), and the serialized bytes. Never inspected or
 * re-parsed by chant itself — chant's job is to generate, store, and surface
 * it, not to interpret SBOM content (that is the scan-result/VEX policy-gate
 * fast-follow, out of scope here — see #606's "out of scope" section).
 */
export interface SbomDocument {
  /** Which standard this document is. Informational — consumers should key off `mediaType`, not this field, for anything that dispatches on the wire format. */
  format: SbomFormat;
  /** The document's IANA/OCI media type (`application/spdx+json` or `application/vnd.cyclonedx+json`). This is the format-agnostic key every consumer (build-archive manifest, build ledger, `chant components status`) actually reads. */
  mediaType: string;
  /** Serialized SBOM content (the actual SPDX/CycloneDX JSON document, as bytes/string). */
  bytes: string;
  /** Number of packages/components the SBOM enumerates, when the generator reports it — surfaced by `chant components status` without parsing `bytes`. */
  packageCount?: number;
  /** Which tool produced this document (e.g. "syft", "buildkit", "cyclonedx-maven") — surfaced alongside format/package count so `chant components status` can report SBOM *source*, not just presence. */
  generator: string;
}

// ── per-artifact-type generator inputs ───────────────────────────────────────

export interface GenerateImageSbomInput {
  /** Archive-relative or local path to the image tarball (OCI layout, as `docker save` produces — see ./build.ts's `DockerBuildOutput.archivePath`). */
  imagePath: string;
  /** Image digest the SBOM is being generated for (the join key with the build-archive manifest / build ledger). */
  digest: string;
  format?: SbomFormat;
}

export interface GenerateJarSbomInput {
  /** Path to the built jar (see ./build.ts's `JvmBuildOutput.archivePath`). */
  jarPath: string;
  digest: string;
  format?: SbomFormat;
}

export interface GenerateZipSbomInput {
  /** Path to the built zip/Lambda package (see ./build.ts's `ZipPackageOutput.archivePath`). */
  zipPath: string;
  digest: string;
  format?: SbomFormat;
}

export interface GenerateDirSbomInput {
  /** Source directory to scan (a config-only/producer component with no packaged artifact, or a pre-build source scan). */
  path: string;
  format?: SbomFormat;
}

/**
 * Injectable, artifact-type-keyed SBOM generation boundary — the SBOM-side
 * analogue of `CloudExecutor` (./cloud-executor.ts). A real implementation
 * shells out (BuildKit `docker buildx build --sbom=true`/`syft <target>
 * -o spdx-json`/`cyclonedx-maven`/`cdxgen`); every method here is injected so
 * tests substitute `MockSbomGenerator`
 * (./__tests__/mock-sbom-generator.ts) and never invoke a real tool or the
 * network.
 */
export interface SbomGenerator {
  /** Generate (or attest) an SBOM for a built container image. A real implementation may prefer BuildKit's native `--sbom` attestation (defaults to SPDX, per the epic's refinement) or fall back to a `syft` scan of the saved tarball. */
  forImage(input: GenerateImageSbomInput): Promise<SbomDocument>;
  /** Generate an SBOM for a built JVM jar (`syft`/`cyclonedx-maven`). */
  forJar(input: GenerateJarSbomInput): Promise<SbomDocument>;
  /** Generate an SBOM for a built zip/Lambda deployment package (`syft` on the archive). */
  forZip(input: GenerateZipSbomInput): Promise<SbomDocument>;
  /** Generate an SBOM for a bare source directory (`syft`/`cdxgen`). */
  forDir(input: GenerateDirSbomInput): Promise<SbomDocument>;
}

/**
 * Thrown by `NotImplementedSbomGenerator` — the "no real backend wired yet"
 * signal, matching `CapabilityNotImplementedError`'s role for verb stubs
 * (../capability.ts). Kept distinct from a generic `Error` so callers (and
 * tests) can assert on it specifically.
 */
export class SbomGeneratorNotImplementedError extends Error {
  constructor(public readonly method: string) {
    super(
      `SbomGenerator.${method} has no real implementation configured — inject a real generator ` +
        `(shelling out to syft/buildx/cyclonedx-maven/cdxgen) or use a mock in tests`,
    );
    this.name = "SbomGeneratorNotImplementedError";
  }
}

/**
 * All-throwing `SbomGenerator`: every method throws
 * `SbomGeneratorNotImplementedError`. No longer the process-wide default (see
 * `defaultSbomGenerator` below, #630) — kept exported for callers that
 * deliberately want the loud, no-backend-at-all behavior (e.g. a test
 * asserting on the thrown error itself, or a caller that wants to force
 * "nothing is wired" rather than silently getting the hermetic backend).
 */
export const notImplementedSbomGenerator: SbomGenerator = {
  async forImage(): Promise<SbomDocument> {
    throw new SbomGeneratorNotImplementedError("forImage");
  },
  async forJar(): Promise<SbomDocument> {
    throw new SbomGeneratorNotImplementedError("forJar");
  },
  async forZip(): Promise<SbomDocument> {
    throw new SbomGeneratorNotImplementedError("forZip");
  },
  async forDir(): Promise<SbomDocument> {
    throw new SbomGeneratorNotImplementedError("forDir");
  },
};

/** Lazily-constructed process-wide default, mirroring ./cloud-executor.ts's `defaultCloudExecutor`. */
let defaultGenerator: SbomGenerator | undefined;

/**
 * The default `SbomGenerator` the `generate-sbom` capability falls back to
 * when none is supplied.
 *
 * **Hermetic by default (#630).** This is `./lockfile-sbom-generator.ts`'s
 * `lockfileSbomGenerator` — `forDir`/`forZip`/`forJar` parse a
 * `package-lock.json`/`pom.xml` already on disk (no `syft`, no network, no
 * external tool) and emit a real SPDX/CycloneDX document. That means a
 * newcomer composing `generate-sbom` over a source directory, a zip/Lambda
 * package, or a JAR gets a working SBOM the moment they `chant run
 * --components`, with nothing to install first — the whole point of #630's
 * "runnable proof" bar. `forImage` still throws
 * `SbomGeneratorNotImplementedError`: no hermetic backend can see an image's
 * base layers, so an image SBOM still needs the real deep-scan tool backend
 * (`syft`/`docker buildx --sbom`/`cyclonedx-maven`/`cdxgen`, #610) — a
 * documented, deliberate gap, not an oversight. This was previously
 * `notImplementedSbomGenerator` (every method throwing); switching the
 * default is intentional per #630 — the prior "loud failure by default"
 * traded newcomer runnability for a default nobody exercised without opting
 * in, which #613 already built a hermetic backend to fix but never wired up.
 * A project that truly wants the old all-throwing behavior can construct
 * `createGenerateSbomCapability(notImplementedSbomGenerator)` explicitly.
 */
export function defaultSbomGenerator(): SbomGenerator {
  if (!defaultGenerator) defaultGenerator = lockfileSbomGenerator;
  return defaultGenerator;
}
