/**
 * Build-archive manifest store (#609, epic #551 follow-up to #564/#568/#606/
 * #613/#614): persists a `BuildArchiveManifest`
 * (../components/verbs/build-archive.ts) to a durable, content-addressed
 * location so it survives past the in-process build/run that assembled it.
 *
 * **The gap this closes.** `docker-build` (../components/verbs/build.ts) and
 * friends assemble a real `BuildArchiveManifest` in memory — complete with
 * `sbom`/config-BOM entries (#606/#613) and per-artifact
 * `reproducibility`/`provenance` (#614) — but nothing ever wrote it anywhere
 * durable. `build-ledger.ts`'s `buildLedgerEntries`/`componentBomSummary` are
 * unit-tested against a manifest handed to them directly, but
 * `chant components status` (../cli/handlers/components.ts) had no manifest
 * to hand them at all: `componentBom` and `build.reproducibility` were always
 * `null` in that CLI path. This module is the missing durable layer — write
 * once at build time, read back by digest at status time.
 *
 * **Storage choice: the `chant/lifecycle` orphan branch, a sibling namespace
 * to the release ledger.** Reuses the exact git-plumbing
 * `writeBlobToPath`/`readBlobFromPath`/`listFilesInDir` (./git.ts) that
 * `writeSnapshot`/`appendReleaseRecordLine` already use — same hash-object →
 * mktree → commit-tree → update-ref pipeline, same `--force-with-lease` push
 * discipline (`pushLifecycle`), same "no checkout, no working tree changes"
 * property. Rejected alternatives:
 *  - **A new on-disk directory in the working tree** — would need its own
 *    persistence/sync story (commit it? gitignore it? sync across CI
 *    runners?) that the orphan branch already solves for the release ledger;
 *    introducing a second mechanism for a manifest that is conceptually the
 *    same kind of durable, git-native record would be needless divergence.
 *  - **A path under `<env>/`** — a build archive is *not* env-scoped. The
 *    whole point of promote-by-digest (epic #551 "4. Build archive +
 *    deferred publish") is that one build's manifest is referenced from
 *    every environment it gets promoted to; writing it under a single env
 *    directory would either duplicate it per env (defeating "byte-identical
 *    across envs") or arbitrarily pick one env as "the" owner. Manifests
 *    instead live under a fixed top-level `_builds/` directory on the same
 *    orphan branch, keyed by `manifestDigest` — a peer of the per-env
 *    directories `writeSnapshot`/the release ledger already create there,
 *    never nested inside one.
 *
 * **Content-addressed, keyed by `manifestDigest`.** One file per manifest,
 * `_builds/<manifestDigest-with-":"->"_">.json`, so a rebuild of
 * byte-identical inputs (same `manifestDigest`, per
 * ../components/verbs/build-archive.ts's module doc) overwrites its own
 * entry with identical content rather than accumulating duplicates —
 * `writeBlobToPath` already replaces-by-path, so this falls out for free.
 * `findBuildManifestByArtifactDigest` additionally resolves "the manifest
 * that produced artifact digest X" (the join key `chant components status`
 * actually has on hand — a `ReleaseRecord.digest` is an *artifact* digest,
 * not a manifest digest) by scanning every stored manifest's `contents` for
 * a matching entry. This is a linear scan over however many manifests have
 * been persisted; fine for the ledger's expected scale (one manifest per
 * build), and avoids maintaining a second reverse-index file that could get
 * out of sync with the manifests themselves.
 */

import { sortedJsonReplacer } from "../utils";
import { writeBlobToPath, readBlobFromPath, listFilesInDir } from "./git";
import type { BuildArchiveManifest } from "../components/verbs/build-archive";

/** Fixed top-level directory on the `chant/lifecycle` orphan branch that holds every persisted build manifest — a peer of the per-env directories, never nested inside one (see module doc for why). */
const BUILDS_DIR = "_builds";

/** Turn a `sha256:...`-style digest into a filesystem/git-tree-safe filename stem (`:` is not usable in a git tree entry name the way this plumbing constructs it). */
function digestToFilenameStem(digest: string): string {
  return digest.replace(/:/g, "_");
}

function manifestFilename(manifestDigest: string): string {
  return `${digestToFilenameStem(manifestDigest)}.json`;
}

/**
 * Persist a `BuildArchiveManifest` to the orphan branch, keyed by its own
 * `manifestDigest`. Does not push to the remote — call `pushLifecycle`
 * (./git.ts) afterward, the same two-step (`write` then `push`) shape
 * `appendReleaseRecord`/`takeSnapshot` use, so a caller persisting several
 * manifests (or a manifest plus a release record) in one run can batch the
 * push into one network round-trip.
 *
 * Idempotent: persisting the same manifest twice (identical `manifestDigest`)
 * overwrites the same path with identical bytes — safe to call more than
 * once for the same build.
 */
export async function persistBuildManifest(
  manifest: BuildArchiveManifest,
  opts?: { cwd?: string },
): Promise<{ commit: string }> {
  const json = JSON.stringify(manifest, sortedJsonReplacer);
  const commit = await writeBlobToPath(BUILDS_DIR, manifestFilename(manifest.manifestDigest), json, "Build manifest", opts);
  return { commit };
}

/**
 * Read a persisted `BuildArchiveManifest` back by its own `manifestDigest`.
 * Returns `null` when no manifest was ever persisted under that digest
 * (never throws — a status query for a digest with no recorded build is a
 * normal, expected state, matching `readSnapshot`'s null-on-missing
 * convention).
 */
export async function readBuildManifest(
  manifestDigest: string,
  opts?: { cwd?: string },
): Promise<BuildArchiveManifest | null> {
  const content = await readBlobFromPath(BUILDS_DIR, manifestFilename(manifestDigest), opts);
  if (!content) return null;
  try {
    return JSON.parse(content) as BuildArchiveManifest;
  } catch {
    return null;
  }
}

/** List the `manifestDigest` of every build manifest persisted on the orphan branch. */
export async function listBuildManifestDigests(opts?: { cwd?: string }): Promise<string[]> {
  const files = await listFilesInDir(BUILDS_DIR, opts);
  return files
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, "").replace(/_/g, ":"));
}

/**
 * Read every persisted build manifest. Best-effort: a manifest file that
 * fails to parse is skipped rather than failing the whole read (mirrors
 * `readReleaseLedger`'s "skip malformed lines" degrade-gracefully
 * convention) — the caller only gets the count implicitly via array length,
 * since a corrupted manifest blob is a much rarer/more surprising event than
 * a hand-edited ledger line and not expected to need the same "surfaced
 * count" treatment.
 */
export async function readAllBuildManifests(opts?: { cwd?: string }): Promise<BuildArchiveManifest[]> {
  const digests = await listBuildManifestDigests(opts);
  const manifests: BuildArchiveManifest[] = [];
  for (const digest of digests) {
    const manifest = await readBuildManifest(digest, opts);
    if (manifest) manifests.push(manifest);
  }
  return manifests;
}

/**
 * Find the persisted manifest that carries an entry (any kind — image,
 * template, asset, or sbom) whose `digest` equals `artifactDigest`. This is
 * the lookup `chant components status` actually needs: a `ReleaseRecord`
 * (../lifecycle/release-ledger.ts) records the *artifact* digest that was
 * promoted/deployed, not the manifest's own aggregate `manifestDigest` — so
 * resolving "the build behind this deployed digest" means searching
 * manifest contents, not a direct keyed lookup. Returns `undefined` when no
 * persisted manifest contains a matching entry (no build was ever persisted
 * for that artifact digest — e.g. it predates #609, or was recorded via the
 * standalone `chant components release` command with no corresponding
 * `chant build`/`run` in this checkout).
 *
 * A `ReleaseRecord.manifestDigest`, when present (an optional field a caller
 * may have supplied at record time), lets a caller skip this scan entirely
 * via `readBuildManifest` directly — this function is the fallback for the
 * common case where only the artifact digest is known.
 */
export async function findBuildManifestByArtifactDigest(
  artifactDigest: string,
  opts?: { cwd?: string },
): Promise<BuildArchiveManifest | undefined> {
  const manifests = await readAllBuildManifests(opts);
  return manifests.find((m) => m.contents.some((entry) => entry.digest === artifactDigest));
}
