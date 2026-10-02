/**
 * Release plan store (ws-055, #2733, part of the chud retirement epic
 * #2715): persists a release plan — the work items and evidence a release
 * ships — to the `chant/lifecycle` orphan branch, content-addressed by the
 * plan's own digest.
 *
 * **Why this exists.** ws-055 (docs/design/decisions/ws-055-dev-model-
 * ledgers.md) decided where a development model's plans live: "a release
 * plan is written content-addressed to `_plans/<digest>.json` on
 * chant/lifecycle, and the release ledger record already names that
 * digest." A `ReleaseRecord.digest` (../lifecycle/release-ledger.ts) is
 * ordinarily an artifact digest; for a release a runner (the studio kit
 * today, chud before it) plans work-item by work-item, that same field
 * *is* the plan's own digest — the release ledger needs no new field to
 * point at it, it already names the plan. Reading a release through the
 * read contract (../workspace/status.ts) resolves that digest to the plan
 * exactly the way it already resolves a build archive digest to a
 * `BuildArchiveManifest` (./build-ledger-store.ts) — this module is that
 * store's plan-shaped sibling, same plumbing, same directory-per-kind
 * convention on the one orphan branch.
 *
 * **Storage.** Reuses `writeBlobToPath`/`readBlobFromPath` (./git.ts) —
 * the identical hash-object -> mktree -> commit-tree -> update-ref
 * pipeline `writeSnapshot`/`persistBuildManifest` already use. Plans live
 * under a fixed top-level `_plans/` directory, a peer of `_builds/` and the
 * per-env directories, never nested inside one — a plan is not env-scoped,
 * it is named by its own content. Per #2524 D7 / #2538, `writeBlobToPath`'s
 * `ledgerDir` already folds a workspace member's own `_members/<member>/`
 * prefix in ahead of `_plans/`, so a member's plans live at
 * `_members/<member>/_plans/<digest>.json` the same way its build records
 * live at `_members/<member>/_builds/` — this module does nothing itself
 * to earn that; it falls out of reusing the shared plumbing.
 *
 * **Content-addressed, keyed by the plan's own `digest`.** One file per
 * plan, `_plans/<digest-with-":"->"_">.json` (`:` is not usable in a git
 * tree entry name the way `readBlobFromPath`'s `<ref>:<path>` spelling
 * reads it back, the same reason `./build-ledger-store.ts` substitutes it
 * for `_builds/`). The digest is computed by whoever plans the release —
 * the release Op, or a runner like the studio kit — not by chant; this
 * module only trusts and stores it, exactly as `persistBuildManifest`
 * trusts a manifest's own `manifestDigest`.
 *
 * **A plan already written is never rewritten (#2733 acceptance).**
 * Unlike `persistBuildManifest`, which writes unconditionally every call
 * (safe only because identical content produces an identical blob and,
 * usually, an identical tree — but still a new, redundant commit on the
 * branch each time), `persistReleasePlan` reads the path first and returns
 * without writing when a plan is already stored under that digest. A plan
 * is immutable by construction (it is named by a hash of its own content),
 * so there is never a reason to overwrite one — only ever a reason to skip
 * the write.
 */

import { sortedJsonReplacer } from "../utils";
import { writeBlobToPath, readBlobFromPath, RefCASConflictError } from "./git";

/** Fixed top-level directory on the `chant/lifecycle` orphan branch that holds every persisted release plan — a peer of `_builds/` and the per-env directories, never nested inside one (see module doc for why). */
const PLANS_DIR = "_plans";

/**
 * A release plan (ws-055): the work items and evidence a release ships.
 * chant does not own this shape — it is a runner's own record, the way a
 * record kind's schema is the kind's own (../workspace/records.ts) — only
 * `digest` is required, since it is the storage key. Every other field is
 * read back and returned exactly as written.
 */
export interface ReleasePlan {
  /**
   * Content-addressed digest of this plan (`sha256:...`) — the same digest
   * the release ledger record names (`ReleaseRecord.digest`,
   * ../lifecycle/release-ledger.ts), so a record leads to its plan.
   * Computed by the caller before persisting; this module trusts it rather
   * than recomputing it, the same way `persistBuildManifest` trusts a
   * manifest's own `manifestDigest`.
   */
  digest: string;
  [key: string]: unknown;
}

/** Thrown by `persistReleasePlan` when the plan carries no usable `digest` — a plan can't be content-addressed without one. */
export class InvalidReleasePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReleasePlanError";
  }
}

/** Turn a `sha256:...`-style digest into a filesystem/git-tree-safe filename stem. */
function digestToFilenameStem(digest: string): string {
  return digest.replace(/:/g, "_");
}

function planFilename(digest: string): string {
  return `${digestToFilenameStem(digest)}.json`;
}

/**
 * Persist a release plan to the orphan branch, keyed by its own `digest`.
 * Does not push to the remote — call `pushLifecycle` (./git.ts) afterward,
 * the same two-step (`write` then `push`) shape `appendReleaseRecord`/
 * `persistBuildManifest` use, so a caller persisting a plan alongside the
 * release record it names can batch both into one push.
 *
 * Never rewrites a plan already stored under `plan.digest` (#2733
 * acceptance) — reads the path first, and returns `{ commit: null, written:
 * false }` without writing when it is already there. A `RefCASConflictError`
 * from a genuine race (another writer persisted the same digest's plan
 * between this call's read and its write) is treated the same way: the
 * plan is content-addressed, so whatever is already at that path under this
 * digest is authoritative, never overwritten.
 */
export async function persistReleasePlan(
  plan: ReleasePlan,
  opts?: { cwd?: string },
): Promise<{ commit: string | null; written: boolean }> {
  if (typeof plan.digest !== "string" || plan.digest.length === 0) {
    throw new InvalidReleasePlanError("release plan is missing its own \"digest\" field — a release plan is content-addressed by its own digest");
  }
  const filename = planFilename(plan.digest);
  const existing = await readBlobFromPath(PLANS_DIR, filename, opts);
  if (existing !== null) return { commit: null, written: false };

  const json = JSON.stringify(plan, sortedJsonReplacer);
  try {
    const commit = await writeBlobToPath(PLANS_DIR, filename, json, "Release plan", { ...opts, expectPriorPathSha: null });
    return { commit, written: true };
  } catch (err) {
    if (err instanceof RefCASConflictError) return { commit: null, written: false };
    throw err;
  }
}

/**
 * Read a persisted release plan back by its own digest — the same digest a
 * `ReleaseRecord.digest` names. Returns `null` when no plan was ever
 * persisted under that digest (never throws — most releases carry no plan
 * at all, and reading one for status is a normal, expected miss), and when
 * the stored blob fails to parse as JSON.
 *
 * `prefix` lets a multi-member reader (../workspace/status.ts) resolve a
 * specific member's plan directory directly, the same way
 * `readReleaseLedgerLines` is handed an already-member-prefixed path there
 * — `cwd` alone can't do it, since one status read walks every member from
 * one process without changing directory per member.
 */
export async function readReleasePlan(
  digest: string,
  opts?: { cwd?: string; prefix?: string },
): Promise<ReleasePlan | null> {
  const dir = `${opts?.prefix ?? ""}${PLANS_DIR}`;
  const content = await readBlobFromPath(dir, planFilename(digest), opts);
  if (!content) return null;
  try {
    return JSON.parse(content) as ReleasePlan;
  } catch {
    return null;
  }
}
