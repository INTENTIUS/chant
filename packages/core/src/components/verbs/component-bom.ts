/**
 * Component-level BOM aggregation (#614, epic #551 follow-up to #613).
 *
 * A component may produce more than one leaf BOM: a software SBOM
 * (./sbom.ts's `generate-sbom`, over an image/jar/zip/dir) for its built
 * artifact, and/or an IaC config-BOM (./config-bom.ts's `extract-config-bom`)
 * for its synthesized template. Each leaf BOM already validates as its own
 * standalone SPDX/CycloneDX document (#613). This module composes every leaf
 * BOM a component's build archive carries into **one** component-level BOM —
 * a real assembly (CycloneDX `metadata.component` + nested `components` +
 * `compositions` + `dependencies`, or SPDX `documentDescribes`-equivalent
 * `CONTAINS`/`DEPENDS_ON` relationships), not a re-implementation of the
 * writer: `aggregateComponentBom` below reads each leaf BOM's own structural
 * inventory back out (it does not re-parse the leaf's serialized bytes) and
 * hands the result to ./bom-writer.ts's `writeBom`, which gained
 * `BomInput.subDocuments` support for exactly this purpose.
 *
 * **Why not just concatenate/parse the leaf documents' bytes.** The leaf BOM
 * bytes are the source of truth for each artifact independently, but this
 * module needs each leaf's package list as structured data to nest it
 * correctly in the assembly — reparsing SPDX/CycloneDX JSON back into
 * `BomPackage[]` would be a second, format-aware reader this codebase does
 * not otherwise need. Callers therefore pass each leaf's already-known
 * `BomPackage[]` (what `generate-sbom`/`extract-config-bom` built before
 * calling `writeBom` themselves) plus the archive entry it produced — see
 * `ComponentBomLeaf` below. A caller assembling a component's archive
 * end-to-end has both on hand already; nothing here re-derives them from
 * scratch.
 *
 * **Single-artifact = 1:1, multi-artifact = a real assembly.** A component
 * with exactly one leaf BOM produces a component BOM whose only "assembly"
 * is itself — see `aggregateComponentBom`'s single-leaf fast path, which
 * still runs through the same writer and produces a valid document, just
 * with an empty `subDocuments` composition (nothing to nest). A component
 * with two or more leaves gets `subDocuments` populated, the real multi-leaf
 * case #614 asks for.
 *
 * **Release-level rollup is out of scope here** (deferred per #614's note) —
 * this module aggregates *within* one component's archive, never across
 * components/releases.
 */

import type { BuildArchiveEntry, BuildArchiveManifest } from "./build-archive";
import { sbomEntries } from "./build-archive";
import { writeBom, type BomPackage, type BomSubDocument } from "./bom-writer";
import { DEFAULT_SBOM_FORMAT, type SbomDocument, type SbomFormat } from "./sbom-generator";

// ── inputs ───────────────────────────────────────────────────────────────────

/**
 * One leaf BOM a component produced, ready to fold into the component-level
 * aggregate. `entry` is the `sbom`-kind `BuildArchiveEntry` `generate-sbom`/
 * `extract-config-bom` already wrote into the manifest (carries `bomKind`,
 * `subjectDigest`, `packageCount`, `generator`); `packages` is the same
 * `BomPackage[]` that capability built before calling `writeBom` for its own
 * standalone document.
 */
export interface ComponentBomLeaf {
  /** The `sbom`-kind manifest entry this leaf corresponds to (see `findSbomForSubject`/`findConfigBomForSubject`, ./build-archive.ts). */
  entry: BuildArchiveEntry;
  /** The leaf's own enumerated packages/components/resources. */
  packages: BomPackage[];
}

export interface AggregateComponentBomInput {
  /** Component name — becomes the aggregate BOM's subject name. */
  component: string;
  /** The build archive manifest this component's leaves live in — used to derive a stable subject id from `manifestDigest` and to validate that every leaf's `entry` actually belongs to this manifest. */
  manifest: BuildArchiveManifest;
  /** Every leaf BOM to compose. Order is preserved in the resulting `subDocuments`/nested components. Must be non-empty — a component with no BOM to aggregate has nothing for this function to do (see module doc's "skips cleanly" convention elsewhere in this directory). */
  leaves: ComponentBomLeaf[];
  /** BOM format for the aggregate document. Defaults to `DEFAULT_SBOM_FORMAT` (SPDX), same precedence convention as every other BOM-producing capability in this directory. */
  format?: SbomFormat;
  /** Clock override for deterministic tests. */
  now?: () => Date;
}

export interface AggregateComponentBomOutput {
  /** The composed component-level BOM document. */
  bom: SbomDocument;
  /** Total package/component count across every leaf (the sum `chant components status` surfaces, see ../../lifecycle/build-ledger.ts). */
  totalPackageCount: number;
  /** How many leaf BOMs were composed — 1 for a single-artifact component (still a valid document, just with nothing to nest), 2+ for a real multi-artifact assembly. */
  leafCount: number;
}

/** Tool name recorded on the aggregate document — distinct from any individual leaf's own `generator` (e.g. "syft", "chant-config-bom-extractor"), since the aggregate is produced by this module, not by whichever tool generated a leaf. */
const COMPONENT_BOM_GENERATOR = "chant-component-bom-aggregator";

/**
 * Compose a component's leaf BOMs (a software SBOM and/or an IaC config-BOM,
 * per `input.leaves`) into one component-level BOM via ./bom-writer.ts's
 * assembly support (`BomInput.subDocuments`). Pure — no I/O, no manifest
 * mutation; the caller decides whether/where to write the result to disk
 * (mirroring `extract-config-bom`'s `outDir` convention) and whether to fold
 * it back into the archive as its own entry.
 *
 * Throws if `input.leaves` is empty — aggregation over zero leaves is a
 * caller bug (compose only when at least one BOM exists), not a case this
 * function silently no-ops on.
 */
export function aggregateComponentBom(input: AggregateComponentBomInput): AggregateComponentBomOutput {
  if (input.leaves.length === 0) {
    throw new Error(
      `aggregateComponentBom: component "${input.component}" has no leaf BOMs to aggregate — ` +
        `only call this once at least one generate-sbom/extract-config-bom leaf exists`,
    );
  }

  const format = input.format ?? DEFAULT_SBOM_FORMAT;
  const totalPackageCount = input.leaves.reduce((sum, l) => sum + l.packages.length, 0);

  // Single leaf: the component BOM *is* that leaf's BOM, structurally — no
  // sub-document nesting needed, its packages become the aggregate's own
  // flat package list directly (still a real, standalone valid document).
  if (input.leaves.length === 1) {
    const leaf = input.leaves[0]!;
    const doc = writeBom(
      format,
      {
        subjectName: input.component,
        subjectId: input.manifest.manifestDigest,
        packages: leaf.packages,
        generator: COMPONENT_BOM_GENERATOR,
      },
      input.now,
    );
    return {
      bom: { ...doc, packageCount: totalPackageCount, generator: COMPONENT_BOM_GENERATOR },
      totalPackageCount,
      leafCount: 1,
    };
  }

  // Multi-leaf: a real assembly — each leaf becomes its own nested
  // sub-document, keyed by which artifact digest it describes (its
  // `subjectDigest`) so the assembly is traceable back to a specific
  // BuildArchiveEntry, never flattened into one anonymous package list.
  const subDocuments: BomSubDocument[] = input.leaves.map((leaf) => ({
    subjectName: leafSubjectName(leaf),
    subjectId: leaf.entry.subjectDigest ?? leaf.entry.digest,
    packages: leaf.packages,
  }));

  const doc = writeBom(
    format,
    {
      subjectName: input.component,
      subjectId: input.manifest.manifestDigest,
      packages: [],
      generator: COMPONENT_BOM_GENERATOR,
      subDocuments,
    },
    input.now,
  );

  return {
    bom: { ...doc, packageCount: totalPackageCount, generator: COMPONENT_BOM_GENERATOR },
    totalPackageCount,
    leafCount: input.leaves.length,
  };
}

/** Human-readable sub-document name: the leaf kind plus the archive path of the BOM entry itself, so two leaves of the same `bomKind` (unlikely but not disallowed) remain distinguishable. */
function leafSubjectName(leaf: ComponentBomLeaf): string {
  const kind = leaf.entry.bomKind ?? "software";
  return `${kind}:${leaf.entry.path}`;
}

// ── convenience: build leaves straight from a manifest ──────────────────────

/**
 * Convenience for the common case: given a manifest that already carries
 * `sbom`-kind entries (written by `generate-sbom`/`extract-config-bom`) and
 * the `BomPackage[]` each one was built from (keyed by archive path, since
 * that's the one stable identifier a caller has for "which leaf is this"),
 * assemble the `ComponentBomLeaf[]` `aggregateComponentBom` expects. Kept
 * separate from `aggregateComponentBom` itself so a caller that already has
 * `ComponentBomLeaf[]` in hand (e.g. straight from the capabilities that just
 * ran) can skip this lookup entirely.
 */
export function componentBomLeavesFromManifest(
  manifest: BuildArchiveManifest,
  packagesByPath: Map<string, BomPackage[]>,
): ComponentBomLeaf[] {
  return sbomEntries(manifest)
    .filter((entry) => packagesByPath.has(entry.path))
    .map((entry) => ({ entry, packages: packagesByPath.get(entry.path)! }));
}
