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
import { isAbsolute, join, relative, resolve } from "path";
import type { CarveReport } from "./carve";
import type { OwnershipMarker } from "../ownership";

export const CARVE_MANIFEST_SUFFIX = ".carve.json";

/**
 * Version 2 (#2039): `emit.files`, `bridge.written`, `bridge.patch` and
 * `apply.stampedFiles` are recorded relative to the manifest's own directory,
 * so the manifest stays true when the tree is copied, moved, or checked out
 * elsewhere. Version-1 manifests recorded them absolute; readers resolve
 * either through `resolveManifestFilePath`.
 */
export const CARVE_MANIFEST_VERSION = 2;

export interface CarveManifest {
  version: 1 | 2;
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
    /**
     * Emitted chant source file path(s), relative to the manifest's directory
     * (absolute in version-1 manifests). The manifest sits at the scaffolded
     * project's root, so these are also project-root-relative — the same base
     * `chant graph --format ir` uses for `sourceLoc.file`, which is the join
     * from a carved Terraform address to the chant entity it became (#2040).
     */
    files: string[];
    /**
     * Deferred outbound inputs declared as build parameters in the emitted
     * project (#998), keyed by parameter name.
     */
    params?: Record<
      string,
      {
        /** The carved resource's own Terraform attribute the value enters through. */
        tfAttr: string;
        /** The survivor the Terraform source read, e.g. `aws_vpc.main`. */
        survivor: string;
        /** Survivor attribute(s) read. */
        attrs: string[];
        /** State-resolved default, when scalar. */
        default?: string | number | boolean;
      }
    >;
    at: string;
  };
  /** Recorded by `carve bridge`. */
  bridge?: {
    /** Files written, relative to the manifest's directory (absolute in version-1 manifests). */
    written: string[];
    appliedInPlace: boolean;
    /** The git-applyable `.patch` carrying the whole survivor edit, relative to the manifest's directory (absolute in version-1 manifests). */
    patch?: string;
    /** Carved addresses whose own `.tf` block the rewrites remove (#998). */
    excised?: string[];
    at: string;
  };
  /** Recorded by `carve apply`. */
  apply?: {
    marker: OwnershipMarker;
    ownershipTags: Record<string, string>;
    /** Emitted files the marker was stamped into (`--write-source`), relative to the manifest's directory (absolute in version-1 manifests). */
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

/**
 * Relative-to-`outDir` spelling of a recorded file path. Absolute entries
 * (the run-time spelling every step naturally produces, and every version-1
 * manifest on disk) are rewritten against the RESOLVED outDir — a caller's
 * relative `--output` must not change what "relative to the manifest's
 * directory" means (#2059). Already-relative entries pass through: they can
 * only have come from a reader honouring the contract, and re-basing them
 * against an unknowable original cwd would corrupt, not normalize.
 */
function relativizePath(outDir: string, p: string): string {
  return isAbsolute(p) ? relative(resolve(outDir), p) : p;
}

/**
 * Normalize a manifest to the version-2 on-disk contract: recorded file
 * paths relative to the manifest's own directory (#2039). `from` and
 * `statePath` stay absolute — they locate the Terraform estate, a different
 * tree the manifest does not travel with.
 */
function normalizeManifest(outDir: string, manifest: CarveManifest): CarveManifest {
  const out: CarveManifest = { ...manifest, version: CARVE_MANIFEST_VERSION };
  if (manifest.emit) {
    out.emit = { ...manifest.emit, files: manifest.emit.files.map((f) => relativizePath(outDir, f)) };
  }
  if (manifest.bridge) {
    out.bridge = {
      ...manifest.bridge,
      written: manifest.bridge.written.map((f) => relativizePath(outDir, f)),
      ...(manifest.bridge.patch !== undefined ? { patch: relativizePath(outDir, manifest.bridge.patch) } : {}),
    };
  }
  if (manifest.apply?.stampedFiles) {
    out.apply = { ...manifest.apply, stampedFiles: manifest.apply.stampedFiles.map((f) => relativizePath(outDir, f)) };
  }
  return out;
}

/**
 * Resolve a manifest-recorded file path against the manifest's directory.
 * Absolute paths (version-1 manifests) pass through untouched, so both
 * on-disk spellings read the same.
 */
export function resolveManifestFilePath(manifestDir: string, p: string): string {
  // Always ABSOLUTE (#2059): `join` with a relative manifestDir produced a
  // cwd-relative path, which `relativizePath` then passed through untouched —
  // so `carve apply --output carveout` recorded `stampedFiles` relative to
  // wherever the command happened to run, two spellings in one manifest.
  return isAbsolute(p) ? p : resolve(manifestDir, p);
}

/** Write (or overwrite) a manifest into the output dir. Returns the path. */
export function writeCarveManifest(outDir: string, manifest: CarveManifest): string {
  mkdirSync(outDir, { recursive: true });
  const path = carveManifestPath(outDir, manifest.target);
  writeFileSync(path, JSON.stringify(normalizeManifest(outDir, manifest), null, 2) + "\n");
  return path;
}

/** Read a manifest, or null when absent/unreadable/not a known-version manifest. */
export function readCarveManifest(path: string): CarveManifest | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as CarveManifest;
    if (parsed?.version !== 1 && parsed?.version !== 2) return null;
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

/**
 * Read-modify-write a section of an existing manifest. No-op when absent.
 * The whole manifest is re-normalized on write, so updating a version-1
 * manifest also migrates its recorded paths to the relative contract.
 */
export function updateCarveManifest(
  outDir: string,
  target: string,
  patch: Partial<Pick<CarveManifest, "boundary" | "emit" | "bridge" | "apply">>,
): string | undefined {
  const path = carveManifestPath(outDir, target);
  const manifest = readCarveManifest(path);
  if (!manifest) return undefined;
  Object.assign(manifest, patch);
  writeFileSync(path, JSON.stringify(normalizeManifest(outDir, manifest), null, 2) + "\n");
  return path;
}
