/**
 * Native JSON BOM writer (#613, epic #551 follow-up to #606). Pure
 * TypeScript, no external binaries (no `syft`/`buildx --sbom`/`cyclonedx-maven`/
 * `oras`/`cosign`), no network — every document below is assembled entirely
 * from in-memory data and `JSON.stringify`.
 *
 * This module is the shared serialization core both real `SbomGenerator`
 * backends in this directory build on: the software leaf
 * (./lockfile-sbom-generator.ts, lockfile/manifest-derived package lists) and
 * the IaC leaf (./config-bom.ts, synthesized-template-derived component
 * lists). Neither backend hand-rolls its own SPDX/CycloneDX shape — both
 * call `writeSpdx`/`writeCycloneDx` here so the two document standards have
 * exactly one writer each in the whole codebase.
 *
 * **Why hand-write the JSON instead of a library.** No SPDX/CycloneDX SDK is
 * a dependency of this package (matching ./cloud-executor.ts's stance on the
 * AWS SDK: shell out or hand-roll rather than add a heavy dependency for a
 * narrow need). Both standards' JSON forms are simple enough — a handful of
 * required top-level fields plus an array of package/component records — that
 * a ~100-line writer is more auditable than a dependency. Structural
 * correctness (required fields, enum values) is verified in
 * ./bom-writer.test.ts against each standard's own published JSON Schema
 * (vendored as devDep test fixtures, the same convention #553 used for the
 * Component contract schema — see ./__fixtures__/schemas/).
 *
 * **Format decisions, recorded for reviewers:**
 *  - SPDX **2.3** (not 2.2 or 3.0): 2.3 is what BuildKit's native `--sbom`
 *    attestation emits (referenced in ./sbom-generator.ts's module doc), so
 *    matching that version keeps a future BuildKit-backed `forImage` and this
 *    lockfile-backed backend speaking the same SPDX dialect. SPDX 3.0 is a
 *    substantially different (JSON-LD/RDF-shaped) model not yet the de facto
 *    tooling default as of this writing.
 *  - CycloneDX **1.5** (not 1.4 or 1.6): 1.5 is the version most broadly
 *    supported by consumer tooling (Dependency-Track, `cyclonedx-cli`) at
 *    time of writing and has a stable published JSON Schema; 1.6 adds fields
 *    this writer doesn't need yet.
 *  - `documentNamespace`/`serialNumber` are deterministic, derived from the
 *    subject's digest/path rather than a random UUID, so two BOM generations
 *    of byte-identical inputs produce byte-identical documents — the same
 *    content-addressing property ./build-archive.ts's `contentDigest`
 *    depends on for its "identical inputs -> identical manifest digest"
 *    guarantee (see ./sbom.test.ts's existing test of that property).
 */

import { SBOM_MEDIA_TYPES, type SbomFormat } from "./sbom-generator";

// ── shared package/component model ──────────────────────────────────────────

/**
 * One dependency/component the BOM enumerates — the standard-agnostic unit
 * both `writeSpdx` and `writeCycloneDx` project into their own per-format
 * package/component record shape. A generator backend (lockfile parser,
 * config-BOM template walker) builds a `BomPackage[]` once and hands it to
 * whichever writer the requested `format` selects.
 */
export interface BomPackage {
  /** Package/component name (npm package name, Maven artifactId, or — for a config-BOM — a resource's logical name/type). */
  name: string;
  /** Version string, when known. Omitted for resources with no version concept (e.g. a CFN resource). */
  version?: string;
  /** Package manager / ecosystem this entry came from (e.g. "npm", "maven"), surfaced in SPDX's `externalRefs`/CycloneDX's `purl` when derivable. */
  type?: "npm" | "maven" | "config" | "external-reference";
  /** Package URL (purl), when derivable — e.g. `pkg:npm/left-pad@1.3.0`. */
  purl?: string;
  /** SPDX download location, when known. Defaults to `"NOASSERTION"` per the SPDX spec's requirement that every package declare one. */
  downloadLocation?: string;
  /** Names of other `BomPackage.name` entries this one depends on — projected into SPDX's `relationships` (`DEPENDS_ON`) and CycloneDX's `dependencies`. */
  dependsOn?: string[];
}

/** Input to both writers: the subject the BOM describes plus its enumerated packages/components. */
export interface BomInput {
  /** Human-readable name for the BOM's subject (a package name, a template/stack name). */
  subjectName: string;
  /** Version of the subject itself, when known. */
  subjectVersion?: string;
  /** Stable identity for the subject, used to derive deterministic namespace/serial IDs — typically a digest or an archive-relative path. */
  subjectId: string;
  /** Every package/component the BOM enumerates. */
  packages: BomPackage[];
  /** Name of the tool that produced this document (surfaced in SPDX's `creationInfo.creators` / CycloneDX's `metadata.tools`). */
  generator: string;
}

/** Deterministic, dependency-free short hash used to derive stable SPDX document namespaces / CycloneDX serial numbers from `BomInput.subjectId`. Not a security hash — just stable and collision-unlikely enough for a namespace suffix. */
function stableId(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (Math.imul(hash, 31) + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

/** SPDX identifiers may only contain letters, digits, `.`, and `-` (SPDX-2.3 §2.2). */
function spdxSafeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9.-]/g, "-");
}

// ── SPDX-2.3 JSON ────────────────────────────────────────────────────────────

/**
 * Native SPDX-2.3 JSON writer. Emits the required top-level fields
 * (`spdxVersion`, `dataLicense`, `SPDXID`, `name`, `documentNamespace`,
 * `creationInfo`, `packages`) plus a `relationships` array recording the
 * document's `DESCRIBES` edge to the subject package and each package's
 * declared `DEPENDS_ON` edges — the "valid relationships section where
 * applicable" #613 calls for.
 */
export function writeSpdx(input: BomInput, now: () => Date = () => new Date()): string {
  const rootId = "SPDXRef-DOCUMENT";
  const subjectSpdxId = `SPDXRef-Package-${spdxSafeId(input.subjectName)}`;

  const packages = input.packages.map((pkg) => ({
    name: pkg.name,
    SPDXID: `SPDXRef-Package-${spdxSafeId(pkg.name)}`,
    versionInfo: pkg.version ?? "NOASSERTION",
    downloadLocation: pkg.downloadLocation ?? "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "NOASSERTION",
    copyrightText: "NOASSERTION",
    ...(pkg.purl
      ? {
          externalRefs: [
            { referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: pkg.purl },
          ],
        }
      : {}),
  }));

  const relationships: Array<{ spdxElementId: string; relationshipType: string; relatedSpdxElement: string }> = [
    { spdxElementId: rootId, relationshipType: "DESCRIBES", relatedSpdxElement: subjectSpdxId },
  ];
  for (const pkg of input.packages) {
    for (const dep of pkg.dependsOn ?? []) {
      relationships.push({
        spdxElementId: `SPDXRef-Package-${spdxSafeId(pkg.name)}`,
        relationshipType: "DEPENDS_ON",
        relatedSpdxElement: `SPDXRef-Package-${spdxSafeId(dep)}`,
      });
    }
  }

  const document = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: rootId,
    name: input.subjectName,
    documentNamespace: `https://chant.dev/spdxdocs/${spdxSafeId(input.subjectName)}-${stableId(input.subjectId)}`,
    creationInfo: {
      created: now().toISOString(),
      creators: [`Tool: ${input.generator}`],
    },
    packages: [
      {
        name: input.subjectName,
        SPDXID: subjectSpdxId,
        versionInfo: input.subjectVersion ?? "NOASSERTION",
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: "NOASSERTION",
        licenseDeclared: "NOASSERTION",
        copyrightText: "NOASSERTION",
      },
      ...packages,
    ],
    relationships,
  };

  return JSON.stringify(document, null, 2);
}

// ── CycloneDX-1.5 JSON ───────────────────────────────────────────────────────

/**
 * Native CycloneDX-1.5 JSON writer. Emits the required top-level fields
 * (`bomFormat`, `specVersion`, `serialNumber`, `version`, `metadata`,
 * `components`) plus a `dependencies` array recording the root subject's
 * direct dependencies and each component's own declared dependencies.
 */
export function writeCycloneDx(input: BomInput, now: () => Date = () => new Date()): string {
  const rootRef = `subject:${input.subjectName}`;

  const components = input.packages.map((pkg) => ({
    type: pkg.type === "config" ? "application" : "library",
    "bom-ref": pkg.name,
    name: pkg.name,
    ...(pkg.version ? { version: pkg.version } : {}),
    ...(pkg.purl ? { purl: pkg.purl } : {}),
  }));

  const dependencies = [
    { ref: rootRef, dependsOn: input.packages.map((p) => p.name) },
    ...input.packages
      .filter((p) => (p.dependsOn?.length ?? 0) > 0)
      .map((p) => ({ ref: p.name, dependsOn: p.dependsOn! })),
  ];

  const document = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${toUuidLike(stableId(input.subjectId) + stableId(input.subjectName))}`,
    version: 1,
    metadata: {
      timestamp: now().toISOString(),
      tools: [{ name: input.generator }],
      component: {
        type: "application",
        "bom-ref": rootRef,
        name: input.subjectName,
        ...(input.subjectVersion ? { version: input.subjectVersion } : {}),
      },
    },
    components,
    dependencies,
  };

  return JSON.stringify(document, null, 2);
}

/** Format an 8-hex-char stable id into a UUID-shaped (but not random/RFC-4122-compliant) string, since CycloneDX only requires `serialNumber` to match `urn:uuid:<uuid-form>` syntactically, not to be a real random UUID — determinism matters more here than entropy. */
function toUuidLike(seed: string): string {
  const padded = (seed + seed + seed + seed).slice(0, 32);
  return `${padded.slice(0, 8)}-${padded.slice(8, 12)}-4${padded.slice(13, 16)}-8${padded.slice(17, 20)}-${padded.slice(20, 32)}`;
}

// ── format dispatch ──────────────────────────────────────────────────────────

/** Serialize `input` in the requested `format` and wrap it as the project-wide `{ format, mediaType, bytes }` doc shape (./sbom-generator.ts's `SbomDocument`, minus `generator`/`packageCount` which the caller fills in). */
export function writeBom(
  format: SbomFormat,
  input: BomInput,
  now?: () => Date,
): { format: SbomFormat; mediaType: string; bytes: string } {
  const bytes = format === "spdx" ? writeSpdx(input, now) : writeCycloneDx(input, now);
  return { format, mediaType: SBOM_MEDIA_TYPES[format], bytes };
}
