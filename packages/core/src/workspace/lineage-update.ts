/**
 * Bring one lineage scope to a new version of its source, file by file,
 * without deleting the project's edits (#2540, ws-038).
 *
 * For each path, three hashes decide what happens: the merge base recorded in
 * the lock, the source's new version, and the file in the tree.
 *
 * | tree            | source                   | result                                  |
 * |-----------------|--------------------------|-----------------------------------------|
 * | equals base     | anything                 | replaced (or removed) by the source     |
 * | equals source   | anything                 | kept; base moves to the source          |
 * | edited          | unchanged from base      | kept; base stays                        |
 * | edited          | changed, merges cleanly  | merged; base moves to the source (*)    |
 * | edited          | changed or removed       | kept; a manual step                     |
 * | deleted         | unchanged from base      | stays deleted                           |
 * | deleted         | changed                  | stays deleted; a manual step            |
 * | untracked file  | adds the same path       | kept; a manual step                     |
 *
 * The table is for `owned` files. A `seed` file is never touched again, and a
 * `generated` file is left for its command to rebuild (D9, D14). Files in the
 * scope directory that the lineage does not list are never touched. This is
 * the per-file rule of ws-005.
 *
 * (*) Only when the caller passes {@link MergeOptions}: the merge base's
 * content, rebuilt by `chant workspace upgrade` (#2550), and a merge function.
 * A file merges only when every hunk is clean; otherwise it is kept as it was
 * and becomes one manual step. `chant vendor pull` passes no base, since a
 * vendor source keeps no history to rebuild it from, so every conflicting
 * path there is a manual step.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { contentDigest, defaultFileClass, fileHash, type Lineage, type ManualStep } from "./lineage-lock";

export interface UpdateResult {
  written: string[];
  /** Edited files that took the source's changes through a clean three-way merge. */
  merged: string[];
  /** `seed` files, which an update never touches, and `generated` files, which their command rebuilds. */
  skipped: Array<{ path: string; class: "seed" | "generated"; command?: string }>;
  removed: string[];
  kept: string[];
  manualSteps: ManualStep[];
}

/** The three-way merge, for `chant workspace upgrade`. */
export interface MergeOptions {
  /** The merge base's content, by path. A path missing here cannot be merged. */
  base: Map<string, Buffer>;
  /** Merged bytes, or null when a hunk conflicts. */
  merge: (base: Buffer, ours: Buffer, theirs: Buffer) => Buffer | null;
}

/**
 * Apply `upstream` (relative path to bytes) to the scope directory `dir`,
 * updating `lineage` in place: its files, digest and manual steps. Open manual
 * steps for paths this update touches again are replaced, others are kept.
 */
export function applyUpstream(dir: string, lineage: Lineage, upstream: Map<string, Buffer>, merging?: MergeOptions): UpdateResult {
  const result: UpdateResult = { written: [], merged: [], skipped: [], removed: [], kept: [], manualSteps: [] };
  const steps = new Map(lineage.manualSteps.map((s) => [s.path, s]));
  const paths = new Set([...Object.keys(lineage.files), ...upstream.keys()]);

  for (const path of [...paths].sort()) {
    const abs = join(dir, path);
    const entry = lineage.files[path];
    if (entry && entry.class !== "owned") {
      // D9: a seed is written once, and a generated file is rebuilt by its
      // command rather than merged. Neither is written here.
      result.skipped.push({ path, class: entry.class, ...(entry.command ? { command: entry.command } : {}) });
      continue;
    }
    const base = lineage.files[path]?.sha256;
    const incoming = upstream.get(path);
    const theirs = incoming ? fileHash(incoming) : undefined;
    const local = existsSync(abs) ? fileHash(readFileSync(abs)) : undefined;
    const step = (reason: ManualStep["reason"]): void => {
      const s: ManualStep = { path, reason, upstream: theirs ?? null };
      steps.set(path, s);
      result.manualSteps.push(s);
    };
    const record = (sha: string): void => {
      lineage.files[path] = { ...(lineage.files[path] ?? defaultFileClass(path)), sha256: sha };
      steps.delete(path);
    };

    if (theirs === undefined) {
      // The source no longer has the file.
      if (local === undefined || local === base) {
        if (local !== undefined) {
          rmSync(abs);
          result.removed.push(path);
        }
        delete lineage.files[path];
        steps.delete(path);
      } else {
        step("removed-upstream");
        result.kept.push(path);
      }
      continue;
    }

    if (local === theirs) {
      record(theirs);
      continue;
    }
    if (local === undefined) {
      if (base === undefined) {
        write(abs, incoming!);
        result.written.push(path);
        record(theirs);
      } else if (base === theirs) {
        steps.delete(path);
      } else {
        step("deleted-locally");
      }
      continue;
    }
    if (base !== undefined && local === base) {
      write(abs, incoming!);
      result.written.push(path);
      record(theirs);
      continue;
    }
    // The tree has its own version of the file.
    if (base !== undefined && base === theirs) {
      result.kept.push(path);
      steps.delete(path);
      continue;
    }
    const baseData = merging?.base.get(path);
    if (merging && baseData && fileHash(baseData) === base) {
      const merged = merging.merge(baseData, readFileSync(abs), incoming!);
      if (merged) {
        writeFileSync(abs, merged);
        result.merged.push(path);
        record(theirs);
        continue;
      }
    }
    result.kept.push(path);
    step(base === undefined ? "exists-locally" : "changed-locally");
  }

  lineage.manualSteps = [...steps.values()].sort((a, b) => a.path.localeCompare(b.path));
  lineage.address = { ...(lineage.address ?? {}), digest: contentDigest(upstream) };
  return result;
}

function write(abs: string, data: Buffer): void {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
}
