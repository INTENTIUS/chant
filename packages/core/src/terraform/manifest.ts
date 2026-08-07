/**
 * The carve state manifest (#998) — what makes emit → bridge → apply compose.
 *
 * `carve emit` persists the boundary report and adoption selector next to the
 * emitted source as `<target>.carve.json`. The later steps read it back from
 * their output dir, so `carve bridge` and `carve apply` no longer need the
 * target re-specified by hand, and each step records what it did for the next.
 * Plain JSON on disk — reviewable, diffable, nothing proprietary.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { CarveReport } from "./carve";
import type { OwnershipMarker } from "../ownership";

export const CARVE_MANIFEST_SUFFIX = ".carve.json";

export interface CarveManifest {
  version: 1;
  /** Terraform address of the carved resource, e.g. `aws_s3_bucket.assets`. */
  target: string;
  /** Terraform resource type, when known. */
  tfType?: string;
  /** Absolute path of the Terraform estate the carve came from. */
  from: string;
  /** Absolute path of the tfstate used for adoption (offline path). */
  statePath?: string;
  /** Boundary classification persisted when the manifest was written. */
  boundary: CarveReport;
  /** Recorded by `carve emit`. */
  emit?: {
    source: "tfstate" | "live";
    /** Emitted chant source file path(s). */
    files: string[];
    at: string;
  };
  /** Recorded by `carve bridge`. */
  bridge?: {
    written: string[];
    appliedInPlace: boolean;
    at: string;
  };
  /** Recorded by `carve apply`. */
  apply?: {
    marker: OwnershipMarker;
    ownershipTags: Record<string, string>;
    /** Emitted files the marker was stamped into (`--write-source`). */
    stampedFiles?: string[];
    at: string;
  };
}

/** Filesystem-safe slug for a Terraform address (shared file-naming convention). */
export function carveSlug(target: string): string {
  return target.replace(/[^A-Za-z0-9_]+/g, "-");
}

/** Where the manifest for `target` lives inside an output dir. */
export function carveManifestPath(outDir: string, target: string): string {
  return join(outDir, `${carveSlug(target)}${CARVE_MANIFEST_SUFFIX}`);
}

/** Write (or overwrite) a manifest into the output dir. Returns the path. */
export function writeCarveManifest(outDir: string, manifest: CarveManifest): string {
  mkdirSync(outDir, { recursive: true });
  const path = carveManifestPath(outDir, manifest.target);
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
  return path;
}

/** Read a manifest, or null when absent/unreadable/not a v1 manifest. */
export function readCarveManifest(path: string): CarveManifest | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as CarveManifest;
    if (parsed?.version !== 1) return null;
    if (typeof parsed.target !== "string" || typeof parsed.boundary !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** All carve manifest paths in an output dir. */
export function listCarveManifests(outDir: string): string[] {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir)
    .filter((f) => f.endsWith(CARVE_MANIFEST_SUFFIX))
    .map((f) => join(outDir, f))
    .sort();
}

export interface ResolvedManifest {
  manifest?: CarveManifest;
  path?: string;
  error?: string;
}

/**
 * Resolve the manifest a later carve step composes with. With a selected
 * target, that target's manifest (absent is fine — the step just runs
 * standalone). Without one, the single manifest in the output dir; none or
 * several is an error naming what is (or is not) there.
 */
export function resolveCarveManifest(outDir: string, select?: string): ResolvedManifest {
  if (select) {
    const path = carveManifestPath(outDir, select);
    const manifest = readCarveManifest(path);
    return manifest ? { manifest, path } : {};
  }

  const paths = listCarveManifests(outDir);
  if (paths.length === 0) {
    return { error: `No carve manifest in ${outDir} — run \`chant carve emit\` first, or pass --select <tf-address>.` };
  }
  const manifests = paths
    .map((path) => ({ path, manifest: readCarveManifest(path) }))
    .filter((m): m is { path: string; manifest: CarveManifest } => m.manifest !== null);
  if (manifests.length === 0) {
    return { error: `No readable carve manifest in ${outDir} — pass --select <tf-address>.` };
  }
  if (manifests.length > 1) {
    const targets = manifests.map((m) => m.manifest.target).join(", ");
    return { error: `Several carves in ${outDir} (${targets}) — pass --select <tf-address> to pick one.` };
  }
  return { manifest: manifests[0].manifest, path: manifests[0].path };
}

/** Read-modify-write a section of an existing manifest. No-op when absent. */
export function updateCarveManifest(
  outDir: string,
  target: string,
  patch: Partial<Pick<CarveManifest, "boundary" | "emit" | "bridge" | "apply">>,
): string | undefined {
  const path = carveManifestPath(outDir, target);
  const manifest = readCarveManifest(path);
  if (!manifest) return undefined;
  Object.assign(manifest, patch);
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
  return path;
}
