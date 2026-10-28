/**
 * Git plumbing operations for the chant/lifecycle orphan branch.
 *
 * All operations use git plumbing commands — no checkout, no branch switching,
 * no working tree changes.
 */
import { getRuntime } from "../runtime-adapter";
import { memberLedgerPrefix, resolveMemberLedger } from "./member-ledger";
import { LIFECYCLE_LOCAL_NOTE } from "./local-note";
import { ledgerRecordingOff, NO_RECORD_PUSH_NOTE, overlayTip, setOverlayTip } from "./no-record";
import type { LedgerReadPort } from "./ledger-port";

const STATE_BRANCH = "chant/lifecycle";

/**
 * The branch path of `dir` for the project at `cwd` (#2538): `dir` itself at
 * level 0 and for the root member `.`, `_members/<member>/<dir>` for any
 * other workspace member. Every store in this module and the ones built on it
 * (releases, snapshots, observation baselines, runs, converge records, gates,
 * build records) goes through here, so none of them names the prefix itself.
 * See ./member-ledger.ts for who counts as a member.
 */
export async function ledgerDir(dir: string, opts?: LedgerLocation): Promise<string> {
  return `${await ledgerPrefixOf(opts)}${dir}`;
}

/**
 * Where to read, when the caller is not standing in the member it reads
 * (#3865): a reader such as behold's lists many members from one checkout. Both
 * fields override what `cwd` resolves to; `ledgerPrefix` wins over `member`.
 */
export interface LedgerLocation {
  cwd?: string;
  /** A member's name, or its path of names in a nested workspace, outermost first. `"."` and `[]` name the flat layout. */
  member?: string | readonly string[];
  /** The prefix `resolveMemberLedger` returns: `""`, or `_members/<member>/` per level. */
  ledgerPrefix?: string;
}

async function ledgerPrefixOf(opts?: LedgerLocation): Promise<string> {
  if (opts?.ledgerPrefix !== undefined) return opts.ledgerPrefix;
  if (opts?.member !== undefined) {
    return memberLedgerPrefix((typeof opts.member === "string" ? [opts.member] : [...opts.member]).filter((m) => m !== "."));
  }
  return (await resolveMemberLedger(opts?.cwd ?? process.cwd())).prefix;
}

/**
 * The identity chant's ledger commits fall back to when the checkout has none
 * of its own (#2301).
 *
 * A CI checkout is the ordinary case here, not an exotic one: GitLab CI,
 * GitHub Actions and Forgejo Actions all clone without `user.email` or
 * `user.name`, and `git commit-tree` refuses outright rather than inventing
 * one — `fatal: unable to auto-detect email address`. Every write in this
 * module goes through `commit-tree`, so before #2301 a gate's pending fact,
 * a run record, a snapshot and a release record all died the same way the
 * moment they ran anywhere but a developer's laptop.
 *
 * This is a *fallback*, applied per-invocation via `git -c` and field by
 * field: only the half the checkout cannot supply is filled in. A configured
 * `user.name` or `user.email` — a developer's, or a CI job that sets one
 * deliberately — is left exactly as it is and still authors these commits, and
 * nothing is written to the repository's config either way. Override the
 * fallback with `CHANT_LIFECYCLE_COMMITTER_NAME` / `_EMAIL` when a project
 * wants its ledger commits attributed to a bot account it controls.
 */
const LEDGER_COMMITTER_NAME = "chant";
const LEDGER_COMMITTER_EMAIL = "chant@localhost";

/**
 * `git -c` arguments that give {@link writeBlobToPath}'s `commit-tree` a
 * committer when — and only when — the checkout cannot supply one itself.
 * Empty for any checkout that has an identity, which keeps every existing
 * caller's commits byte-identical to what they were before #2301.
 */
async function ledgerCommitIdentityArgs(cwd?: string): Promise<string[]> {
  const rt = getRuntime();
  const probe = await rt.spawn(["git", "var", "GIT_COMMITTER_IDENT"], { cwd, env: C_LOCALE_ENV });
  if (probe.exitCode === 0) return [];

  // Per-field, not all-or-nothing (#2309 review). `git var` fails if *either*
  // half is missing, so filling in both would overwrite a configured
  // `user.name` in the checkout that has a name but no email — which is not
  // what "a configured identity is left exactly as it is" promises.
  const args: string[] = [];
  for (const [key, envVar, fallback] of [
    ["user.name", "CHANT_LIFECYCLE_COMMITTER_NAME", LEDGER_COMMITTER_NAME],
    ["user.email", "CHANT_LIFECYCLE_COMMITTER_EMAIL", LEDGER_COMMITTER_EMAIL],
  ] as const) {
    const configured = await rt.spawn(["git", "config", "--get", key], { cwd, env: C_LOCALE_ENV });
    if (configured.exitCode === 0 && configured.stdout.trim() !== "") continue;
    args.push("-c", `${key}=${process.env[envVar]?.trim() || fallback}`);
  }
  return args;
}

/**
 * Prefix every failure out of the ledger write path with what was being
 * written and where (#2301 deliverable 2). `git commit-tree failed: <stderr>`
 * on its own does not say that the thing that failed was chant recording a
 * fact on its own branch, and the caller that swallows it is one stack frame
 * away from printing nothing at all.
 */
function ledgerWriteError(stage: string, path: string, stderr: string): Error {
  return new Error(
    `cannot write ${path} on the ${STATE_BRANCH} branch: ${stage} failed: ${(stderr ?? "").trim()}`,
  );
}

/**
 * Bounded retry budget for {@link writeBlobToPath}'s own internal CAS retry
 * (#1959 finding 1). A conflict caused by some *other* env/file entry
 * changing concurrently (the ordinary case — e.g. two operator ticks
 * targeting different envs) is safe to resolve by simply rebuilding the tree
 * against the new tip and retrying; this bounds how many times it does that
 * before giving up and surfacing the conflict.
 */
const WRITE_BLOB_RETRY_ATTEMPTS = 5;

/**
 * Write a blob to an arbitrary `<environment>/<filename>` path on the orphan
 * branch, preserving every other env/file entry already on the branch.
 *
 * Pipeline: hash-object → mktree → commit-tree → update-ref. Factored out of
 * `writeSnapshot` so the release ledger (#568, epic #551 "Build & deploy
 * observability") can reuse the identical git-plumbing path for a different
 * filename (`releases.jsonl`) under the same env directory, rather than a
 * parallel storage mechanism.
 *
 * Exported (not just used internally) so ./build-ledger-store.ts (#609) can
 * reuse this exact plumbing for a top-level directory that isn't really an
 * "environment" (`_builds`, keyed by manifest digest rather than env name) —
 * a build archive is promoted by digest across environments, never owned by
 * one, so it belongs in its own digest-keyed namespace on the same orphan
 * branch rather than duplicated per env. The parameter is still named
 * `environment` because it is literally the first path segment / root-tree
 * entry name this function's tree-building logic groups by; callers outside
 * this module that pass a non-env value (like `_builds`) are relying on that
 * generic behavior, not on any env-specific semantics.
 *
 * `environment` is relative to the project's ledger (#2538): a workspace
 * member's write lands under `_members/<member>/` ({@link ledgerDir}). The
 * write itself is {@link writeLedgerFiles} with one file.
 */
export async function writeBlobToPath(
  environment: string,
  filename: string,
  content: string,
  commitMessage: string,
  opts?: LedgerLocation & { expectPriorPathSha?: string | null },
): Promise<string> {
  const dir = await ledgerDir(environment, opts);
  return writeLedgerFiles(
    [{ path: `${dir}/${filename}`, content, ...(opts?.expectPriorPathSha !== undefined ? { expectPriorSha: opts.expectPriorPathSha } : {}) }],
    commitMessage,
    opts,
  );
}

/** One file for {@link writeLedgerFiles}. */
export interface LedgerFileWrite {
  /** The file's full path on the branch, such as `_members/api/prod/releases.jsonl`. No prefix is added. */
  path: string;
  content: string;
  /**
   * For a read-modify-write caller: the blob sha the caller's content was
   * computed from (`null` for "the file did not exist"). A different sha on
   * the branch is a conflict, never a blind retry.
   */
  expectPriorSha?: string | null;
}

/**
 * One file for {@link writeLedgerFiles} to remove (#4036): retention's
 * garbage collection takes a stored change set, release or template out of
 * the tree in a new commit. The history keeps it.
 */
export interface LedgerFileRemoval {
  /** The file's full path on the branch. No prefix is added. */
  path: string;
  remove: true;
  /** The blob sha the caller saw at the path; a different sha, or no file, is a conflict. */
  expectPriorSha?: string | null;
}

const isRemoval = (f: LedgerFileWrite | LedgerFileRemoval): f is LedgerFileRemoval => (f as LedgerFileRemoval).remove === true;

/**
 * Write several files to the branch in one commit (#2538). Paths are full
 * branch paths, so one commit can write the ledgers of several members, for
 * example `_members/api/prod/releases.jsonl` and
 * `_members/web/prod/releases.jsonl` together. {@link writeBlobToPath} is the
 * one-file case with the project's own member prefix applied.
 *
 * Pipeline, per attempt: read the directories each path passes through at
 * the branch tip, replace the entries, rebuild the touched trees bottom-up
 * with `git mktree`, `commit-tree` on that tip, then CAS-update the ref.
 * Every entry the write does not touch is carried over as it is, so the tree
 * of an unchanged directory keeps its sha.
 */
export async function writeLedgerFiles(
  files: Array<LedgerFileWrite | LedgerFileRemoval>,
  commitMessage: string,
  opts?: {
    cwd?: string;
    /**
     * The branch tip the caller read before deciding what to write (#4036).
     * A different tip is a conflict, thrown at once and never retried here,
     * so a caller whose choice depends on files it does not write (garbage
     * collection reading the gate ledgers) reads again.
     */
    expectTip?: string;
  },
): Promise<string> {
  const rt = getRuntime();
  const cwd = opts?.cwd;
  if (files.length === 0) throw new Error("writeLedgerFiles needs at least one file");
  // Failures name the first path; one file is the ordinary case.
  const path = files[0].path;
  for (const f of files) {
    const segs = f.path.split("/");
    if (segs.length < 2 || segs.some((seg) => seg === "")) {
      throw new Error(`cannot write ${f.path} on the ${STATE_BRANCH} branch: a ledger path is <dir>/<file>`);
    }
  }

  // 1. Write the blobs — hash-object reads from stdin. Fed directly via
  // spawn's stdin (no shell involved), so content is written byte-for-byte:
  // no `sh` `echo` reinterpreting backslash-escape sequences (e.g. `\n`
  // inside JSON, as in a serialized
  // kubectl.kubernetes.io/last-applied-configuration annotation) and no
  // shell-quoting dance around embedded single quotes. Content-addressed
  // and idempotent, so this stays outside the retry loop below.
  // A removal has no blob: its sha is null, and step 3 deletes the entry.
  const blobs: { path: string; sha: string | null }[] = [];
  for (const f of files) {
    if (isRemoval(f)) {
      blobs.push({ path: f.path, sha: null });
      continue;
    }
    const blobResult = await rt.spawn(["git", "hash-object", "-w", "--stdin"], { cwd, stdin: f.content });
    if (blobResult.exitCode !== 0) {
      throw ledgerWriteError("git hash-object", f.path, blobResult.stderr);
    }
    blobs.push({ path: f.path, sha: blobResult.stdout.trim() });
  }

  // Resolved once, outside the retry loop: whether the checkout can name a
  // committer does not change between attempts (#2301).
  const identityArgs = await ledgerCommitIdentityArgs(cwd);

  // Creating the ledger branch is a different act from extending it, and only
  // one of them is safe to do blind (#2309 review). With no local
  // `chant/lifecycle`, everything below builds a tree from an empty read and
  // commits it with no parent — a brand-new root commit that *replaces* the
  // branch rather than appending to it, which `updateRefCAS` cannot catch
  // because "the ref does not exist" is perfectly true locally.
  //
  // Until #2301 this was mostly hidden: `commit-tree` died for want of a
  // committer before it could happen. Supplying an identity turned that loud
  // failure into a silent branch fabrication on every writer that reaches
  // here without a ledger — a run record, a snapshot, a release, a build
  // manifest — and a fabricated branch is precisely the fork the guard above
  // exists to refuse. So the guard runs here, at the one seam they all pass
  // through, rather than at each of their call sites.
  //
  // Only when the branch is absent: an extend costs no fetch, and the check
  // that matters is whether the history this is about to discard exists
  // somewhere. `requireLifecycleLedger` allows `no-remote` and `absent`, so a
  // genuinely first write still creates the branch.
  if ((await getStateBranchTip(cwd)) === null) {
    await requireLifecycleLedger({ ...(cwd ? { cwd } : {}) });
  }

  // 2-5. Read the trees, build the commit, and CAS-update the branch ref —
  // retried on a conflict (#1959 finding 1). Before that retry existed a
  // conflict from step 5's `updateRefCAS` simply threw, breaking every caller
  // (observation-baseline.ts, snapshot.ts, build-ledger-store.ts, and — via
  // `appendReleaseRecordLine` below — release-ledger.ts) the moment any
  // concurrent writer touched the orphan branch, e.g. a live `chant
  // operator` ticking a different env.
  //
  // Safety of a *blind* retry (same content and blob, freshly rebuilt tree)
  // hinges on whether *our own* target paths are what actually caused the
  // conflict:
  //   - If some OTHER path changed (the ordinary multi-env/multi-file case),
  //     our data is unaffected — rebuilding the tree from the new tip and
  //     retrying the ref update is always correct, no matter what kind of
  //     write the caller is doing (replace or append).
  //   - If one of OUR paths changed concurrently, a blind retry using
  //     content computed before that race would silently clobber the other
  //     writer's change — safe only for a caller whose content is a
  //     self-contained replacement (writeObservationBaseline, writeSnapshot,
  //     persistBuildManifest), never for a read-modify-write caller whose
  //     content already embeds a stale read (an append). Since this function
  //     can't tell those apart, it does NOT blind-retry in that case — it
  //     re-throws immediately so a read-modify-write caller's own outer retry
  //     (appendConvergeRecord, appendGateResolution, appendReleaseRecordLine
  //     below) can re-read and recompute content fresh before trying again.
  //
  //   - A read-modify-write caller must pass `expectPriorSha`. Without it
  //     attempt 1 has no prior sha to compare, so a commit landing between the
  //     caller's baseline read and this function's first tree read reads as
  //     the ambient starting state rather than a conflict, and is overwritten
  //     from the caller's stale content.
  const prior = new Map<string, string | null | undefined>(files.map((f) => [f.path, f.expectPriorSha]));
  let lastErr: unknown;
  for (let attempt = 1; attempt <= WRITE_BLOB_RETRY_ATTEMPTS; attempt++) {
    // 2. Read the tip once and every listing from that sha. `tip` must stay
    // the commit parent and CAS oldValue below. Re-resolving the branch name
    // there instead can observe a newer tip than the listings reflect, which
    // makes the CAS succeed against a tree built from a stale read.
    const tip = await getStateBranchTip(cwd);
    if (opts?.expectTip !== undefined && tip !== opts.expectTip) {
      throw new RefCASConflictError(`refs/heads/${STATE_BRANCH}`, opts.expectTip, `the branch moved to ${tip ?? "(none)"} since it was read`);
    }
    const trees = new Map<string, Map<string, TreeLine>>();
    const listing = async (dir: string): Promise<Map<string, TreeLine>> => {
      let entries = trees.get(dir);
      if (!entries) {
        entries = tip ? await listTreeAt(tip, dir, cwd) : new Map();
        trees.set(dir, entries);
      }
      return entries;
    };

    for (const b of blobs) {
      const { dir, name } = splitPath(b.path);
      const current = (await listing(dir)).get(name);
      const currentSha = current?.type === "blob" ? current.sha : null;
      const expected = prior.get(b.path);
      if (expected !== undefined && currentSha !== expected) {
        // Our own path moved since the caller read it or our previous
        // attempt started — a genuine content-level race on the exact file
        // we're writing, not just a CAS conflict from a sibling path. Not
        // safe to paper over here.
        throw lastErr ?? new RefCASConflictError(`refs/heads/${STATE_BRANCH}`, expected, "target path changed concurrently");
      }
      prior.set(b.path, currentSha);
    }

    // 3. Replace the entries, listing every directory up to the root so the
    // rebuild below has each parent in hand.
    for (const b of blobs) {
      const { dir, name } = splitPath(b.path);
      if (b.sha === null) (await listing(dir)).delete(name);
      else (await listing(dir)).set(name, { mode: "100644", type: "blob", sha: b.sha });
      for (let d = dir; d !== ""; d = parentDir(d)) await listing(parentDir(d));
    }

    // 4. Rebuild the touched trees, deepest first, then the root. A directory
    // a removal left empty is dropped from its parent, as git itself would.
    const touched = [...trees.keys()].sort((a, b) => depth(b) - depth(a) || (a < b ? -1 : 1));
    let rootTreeSha = "";
    for (const dir of touched) {
      if (dir !== "" && trees.get(dir)!.size === 0) {
        trees.get(parentDir(dir))!.delete(baseName(dir));
        continue;
      }
      const lines = [...trees.get(dir)!].map(([name, e]) => `${e.mode} ${e.type} ${e.sha}\t${name}`).join("\n");
      const result = await rt.spawn(["git", "mktree"], { cwd, stdin: lines === "" ? "" : `${lines}\n` });
      if (result.exitCode !== 0) {
        throw ledgerWriteError(`git mktree (${dir === "" ? "root" : dir})`, path, result.stderr);
      }
      const sha = result.stdout.trim();
      if (dir === "") rootTreeSha = sha;
      else trees.get(parentDir(dir))!.set(baseName(dir), { mode: "040000", type: "tree", sha });
    }

    // 5. Create the commit — parented on `tip`, the exact sha every listing
    // was read from (see step 2), not a fresh re-resolution of the branch.
    const parentRef = tip;
    const parentArgs = parentRef ? ["-p", parentRef] : [];
    const commitResult = await rt.spawn(
      ["git", ...identityArgs, "commit-tree", ...parentArgs, "-m", commitMessage, rootTreeSha],
      { cwd },
    );
    if (commitResult.exitCode !== 0) {
      throw ledgerWriteError("git commit-tree", path, commitResult.stderr);
    }
    const commitSha = commitResult.stdout.trim();

    // 6. Update ref — CAS-guarded against `parentRef` (#1485): closes the
    // local race two concurrent writers used to hit silently (whoever called
    // update-ref last simply overwrote the other's tree, no error). A
    // conflict here throws RefCASConflictError instead of clobbering.
    // #3955: a run that records nothing moves its in-memory tip instead of
    // the branch, under the same compare-and-swap: nothing awaits between the
    // read of the tip and the move, so two writes in this process cannot both
    // parent on the same commit.
    if (ledgerRecordingOff()) {
      const key = await overlayKey(cwd);
      const branch = overlayTip(key) === undefined ? await readRefSha(`refs/heads/${STATE_BRANCH}`, { cwd }) : null;
      // Read again after the await: another write may have moved the tip meanwhile.
      const moved = overlayTip(key);
      const current = moved !== undefined ? moved : branch;
      if (current === parentRef) {
        setOverlayTip(key, commitSha, files.map((f) => f.path), commitMessage);
        return commitSha;
      }
      lastErr = new RefCASConflictError(`refs/heads/${STATE_BRANCH}`, parentRef, `the run's unrecorded tip is ${current ?? "(none)"}`);
      continue;
    }
    try {
      await updateRefCAS(`refs/heads/${STATE_BRANCH}`, commitSha, parentRef, { cwd });
      return commitSha;
    } catch (err) {
      if (!(err instanceof RefCASConflictError)) throw err;
      lastErr = err;
      // Loop and rebuild against the new tip — see the safety analysis
      // above; the top of the next iteration decides whether that's safe.
    }
  }
  throw lastErr;
}

/**
 * Read a blob from an arbitrary `<environment>/<filename>` path on the orphan
 * branch. Returns null when the path doesn't exist (missing branch, env, or
 * file). Sibling of `writeBlobToPath`. Exported for the same reason
 * `writeBlobToPath` is — ./build-ledger-store.ts (#609) reads manifests back
 * from the `_builds` namespace through this identical helper.
 */
export async function readBlobFromPath(
  environment: string,
  filename: string,
  opts?: LedgerLocation,
): Promise<string | null> {
  const rt = getRuntime();
  const dir = await ledgerDir(environment, opts);
  const result = await rt.spawn(
    ["git", "show", `${await ledgerRevision(opts?.cwd)}:${dir}/${filename}`],
    { cwd: opts?.cwd },
  );
  if (result.exitCode !== 0) return null;
  return result.stdout;
}

/**
 * Read the blob SHA stored at `<environment>/<filename>` on the orphan branch,
 * or `null` if absent. Sibling of `readBlobFromPath` returning the
 * content-address rather than the content. A read-modify-write ledger append
 * pairs this with {@link readBlobBySha} to pin its baseline read to an exact
 * sha, then passes that sha as `writeBlobToPath`'s `expectPriorPathSha`.
 */
export async function readPathSha(
  environment: string,
  filename: string,
  opts?: LedgerLocation,
): Promise<string | null> {
  const rt = getRuntime();
  const dir = await ledgerDir(environment, opts);
  const result = await rt.spawn(
    ["git", "rev-parse", "--verify", `${await ledgerRevision(opts?.cwd)}:${dir}/${filename}`],
    { cwd: opts?.cwd },
  );
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

/**
 * Storage key for a snapshot on the orphan branch. Single-stack projects key by
 * lexicon (`<env>/<lexicon>.json`, unchanged). A multi-stack project (see
 * `stacks` in ChantConfig, #932) folds the stack in as `<stack>__<lexicon>`
 * (`<env>/<stack>__<lexicon>.json`) so sibling stacks that deploy the same
 * lexicon don't overwrite each other's snapshots. The `__` separator can't
 * collide with a lexicon name (lexicons are single tokens) and round-trips
 * through `readSnapshot`/`readEnvironmentSnapshots` unchanged.
 */
export function snapshotStorageKey(lexicon: string, stack?: string): string {
  return stack ? `${stack}__${lexicon}` : lexicon;
}

/**
 * Write a state snapshot JSON to the orphan branch.
 *
 * Nothing in chant calls this since #4519: snapshots go through the index
 * store (./snapshot-store.ts), whose default is `refs/chant/snapshots`. Kept
 * for code outside chant that wrote snapshots here itself.
 *
 * Pipeline: hash-object → mktree → commit-tree → update-ref
 */
export async function writeSnapshot(
  environment: string,
  lexicon: string,
  json: string,
  opts?: { cwd?: string },
): Promise<string> {
  return writeBlobToPath(environment, `${lexicon}.json`, json, "State snapshot", opts);
}

/**
 * Read a snapshot from the orphan branch. Since #4519 this is the read side
 * of the read-only orphan-branch store (./snapshot-store.ts); chant's own
 * readers go through the store.
 */
export async function readSnapshot(
  environment: string,
  lexicon: string,
  opts?: LedgerLocation,
): Promise<string | null> {
  return readBlobFromPath(environment, `${lexicon}.json`, opts);
}

/**
 * Read a snapshot at a specific orphan-branch commit (#822). `readSnapshot` reads
 * the branch tip; this reads `<ref>:<env>/<lexicon>.json` for any commit `ref`
 * (as listed by {@link listSnapshots}), so two historical snapshots can be diffed.
 * Returns null if that env/lexicon wasn't captured at `ref`.
 */
export async function readSnapshotAt(
  environment: string,
  lexicon: string,
  ref: string,
  opts?: LedgerLocation,
): Promise<string | null> {
  const rt = getRuntime();
  const dir = await ledgerDir(environment, opts);
  const result = await rt.spawn(
    ["git", "show", `${ref}:${dir}/${lexicon}.json`],
    { cwd: opts?.cwd },
  );
  if (result.exitCode !== 0) return null;
  return result.stdout;
}

/**
 * Append one immutable release record line to `<environment>/releases.jsonl`
 * on the orphan branch (#568, epic #551 "Build & deploy observability"). Same
 * git-plumbing path `writeSnapshot` uses, just a different filename under the
 * env directory and append-only (JSON Lines) instead of replace-whole-file:
 * each deploy adds one line, never rewrites a previous one, so the ledger
 * stays a durable, append-only history rather than a point-in-time snapshot.
 *
 * Low-level plumbing over an already-serialized line; ../release-ledger.ts's
 * `appendReleaseRecord` is the typed, validated public API most callers want
 * — named distinctly here (`ReleaseRecordLine`) to avoid re-export ambiguity
 * between the two modules.
 *
 * Returns the new orphan-branch commit SHA — the caller still owns pushing
 * via `pushLifecycle` under the same concurrent-write lease `writeSnapshot`
 * uses.
 *
 * Retries the whole read-modify-append cycle on `RefCASConflictError`
 * (#1959 finding 1), the same shape `appendConvergeRecord`
 * (./converge-ledger.ts) and `appendGateResolution` (./gate-ledger.ts) use
 * for their own append-only ledgers: `writeBlobToPath`'s own retry only
 * absorbs a conflict caused by some *other* env/file changing — a conflict
 * on this exact `releases.jsonl` (e.g. two deploys to the same env racing)
 * needs `existing` re-read fresh so the appended line list is rebuilt onto
 * whatever the other writer just committed, not silently dropped by
 * retrying with a blob computed from a stale read.
 *
 * The baseline read must be `readPathSha` + `readBlobBySha` rather than
 * `readBlobFromPath`, so the exact sha `existing` came from can be passed as
 * `expectPriorPathSha`. See `writeBlobToPath` for the race that closes.
 */
export async function appendReleaseRecordLine(
  environment: string,
  recordJson: string,
  opts?: { cwd?: string },
): Promise<string> {
  return appendLedgerLine(environment, "releases.jsonl", recordJson, "Release record", opts);
}

/**
 * Append one line to `<environment>/<filename>` on the orphan branch, with
 * the same read, append and compare-and-swap retry as
 * {@link appendReleaseRecordLine}. The deploy outcomes of
 * ../lifecycle/deploy-outcome.ts (#4035) are appended through here, beside
 * the environment's `releases.jsonl`.
 */
export async function appendLedgerLine(
  environment: string,
  filename: string,
  recordJson: string,
  commitMessage: string,
  opts?: { cwd?: string },
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= WRITE_BLOB_RETRY_ATTEMPTS; attempt++) {
    try {
      const priorSha = await readPathSha(environment, filename, opts);
      const existing = priorSha ? await readBlobBySha(priorSha, opts) : null;
      const content = `${existing ? `${existing.replace(/\n$/, "")}\n` : ""}${recordJson}\n`;
      return await writeBlobToPath(environment, filename, content, commitMessage, {
        ...opts,
        expectPriorPathSha: priorSha,
      });
    } catch (err) {
      if (!(err instanceof RefCASConflictError)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Read every release record line for `environment` from the orphan branch,
 * oldest first, as raw JSON strings. Returns `[]` when no ledger exists yet
 * for that env (never throws — a component that has never recorded a deploy
 * is a normal, expected state). ../release-ledger.ts's `readReleaseLedger`
 * parses/validates these lines into typed `ReleaseRecord`s.
 */
export async function readReleaseLedgerLines(
  environment: string,
  opts?: LedgerLocation,
): Promise<string[]> {
  const content = await readBlobFromPath(environment, "releases.jsonl", opts);
  if (!content) return [];
  return content.split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * List every environment that has a release ledger on the orphan branch —
 * the root-level directories under `chant/lifecycle` that carry a
 * `releases.jsonl` entry. Used by `chant components status` (no env arg) to
 * discover which environments to report on.
 */
export async function listLedgerEnvironments(opts?: LedgerLocation): Promise<string[]> {
  const envs: string[] = [];
  for (const name of await listLedgerTrees(opts)) {
    const hasLedger = await readBlobFromPath(name, "releases.jsonl", opts);
    if (hasLedger) envs.push(name);
  }
  return envs.sort();
}

/**
 * The directories directly under the ledger's base: the root for the flat
 * layout, `_members/<member>/` for a member. `[]` when the branch, or the
 * base, is absent.
 */
export async function listLedgerTrees(opts?: LedgerLocation): Promise<string[]> {
  const tip = await getStateBranchTip(opts?.cwd);
  if (!tip) return [];
  const rt = getRuntime();
  // A member lists the directories under its own `_members/<member>/`; the
  // flat layout lists the root, where `_members` holds no releases.jsonl and
  // so never reads as an environment (#2538).
  const base = await ledgerDir("", opts);
  // `--full-tree`: from a subdirectory, a bare `ls-tree` lists only that
  // subdirectory's part of the tree (#2550).
  const rootResult = await rt.spawn(
    ["git", "ls-tree", "--full-tree", base === "" ? tip : `${tip}:${base}`],
    { cwd: opts?.cwd },
  );
  if (rootResult.exitCode !== 0) return [];
  const trees: string[] = [];
  for (const line of rootResult.stdout.trim().split("\n").filter(Boolean)) {
    const match = line.match(/^(\d+)\s+(\w+)\s+([0-9a-f]+)\t(.+)$/);
    if (match && match[2] === "tree") trees.push(match[4]);
  }
  return trees;
}

/**
 * List every filename directly under `<dir>/` on the orphan branch (no
 * recursion), or `[]` when the branch/directory doesn't exist yet. Generic
 * sibling of `readEnvironmentSnapshots`'s inline file listing, factored out
 * so ./build-ledger-store.ts (#609) can enumerate every persisted build
 * manifest (`_builds/<digest>.json`) without duplicating this `git ls-tree
 * --name-only` call.
 */
export async function listFilesInDir(dir: string, opts?: LedgerLocation): Promise<string[]> {
  const tip = await getStateBranchTip(opts?.cwd);
  if (!tip) return [];
  const rt = getRuntime();
  const path = await ledgerDir(dir, opts);
  const lsResult = await rt.spawn(
    ["git", "ls-tree", "--full-tree", "--name-only", `${tip}:${path}/`],
    { cwd: opts?.cwd },
  );
  if (lsResult.exitCode !== 0) return [];
  return lsResult.stdout.trim().split("\n").filter(Boolean);
}

/**
 * Read all snapshots for an environment (all lexicons).
 */
export async function readEnvironmentSnapshots(
  environment: string,
  opts?: { cwd?: string },
): Promise<Map<string, string>> {
  const rt = getRuntime();
  const snapshots = new Map<string, string>();

  // List files in the environment directory
  const dir = await ledgerDir(environment, opts);
  const lsResult = await rt.spawn(
    ["git", "ls-tree", "--full-tree", "--name-only", `${await ledgerRevision(opts?.cwd)}:${dir}/`],
    { cwd: opts?.cwd },
  );
  if (lsResult.exitCode !== 0) return snapshots;

  const files = lsResult.stdout.trim().split("\n").filter(Boolean);
  for (const file of files) {
    if (file.endsWith(".json")) {
      const lexicon = file.replace(/\.json$/, "");
      const content = await readSnapshot(environment, lexicon, opts);
      if (content) snapshots.set(lexicon, content);
    }
  }

  return snapshots;
}

/**
 * List snapshot history from the orphan branch.
 */
export async function listSnapshots(
  opts?: LedgerLocation & { environment?: string },
): Promise<Array<{ commit: string; date: string; message: string }>> {
  const rt = getRuntime();
  // A member sees the commits that touched its own ledger (#2538); the flat
  // layout keeps today's whole-branch history.
  const base = await ledgerDir("", opts);
  const result = await rt.spawn(
    // `:(top)`: a pathspec is otherwise relative to the directory git runs in.
    ["git", "log", "--format=%H %aI %s", await ledgerRevision(opts?.cwd), ...(base === "" ? [] : ["--", `:(top)${base}`])],
    { cwd: opts?.cwd },
  );
  if (result.exitCode !== 0) return [];

  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [commit, date, ...rest] = line.split(" ");
      return { commit, date, message: rest.join(" ") };
    });
}

/**
 * Thrown by pushLifecycle when the remote chant/lifecycle branch has moved since
 * the local snapshot was prepared — i.e. another snapshot for this or a
 * different env was pushed concurrently. The caller should fetch and retry.
 */
export class StaleLifecycleBranchError extends Error {
  readonly expected: string | null;
  constructor(expected: string | null, stderr: string) {
    super(
      "chant/lifecycle remote branch has moved since this run started — " +
      "another snapshot was pushed concurrently. " +
      `git stderr: ${stderr.trim()}`,
    );
    this.name = "StaleLifecycleBranchError";
    this.expected = expected;
  }
}

/**
 * Look up the remote-tracking SHA for chant/lifecycle, if any. Returns null when
 * the remote ref doesn't exist locally yet (e.g. first-ever snapshot).
 */
export async function getRemoteLifecycleBranchSha(
  remote: string,
  opts?: { cwd?: string },
): Promise<string | null> {
  const rt = getRuntime();
  const ref = `refs/remotes/${remote}/${STATE_BRANCH}`;
  const result = await rt.spawn(["git", "rev-parse", "--verify", ref], { cwd: opts?.cwd });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

/**
 * Why a push of the state branch did or did not reach the remote.
 *
 * - `pushed` — the remote now holds the local tip.
 * - `no-remote` — nothing to push to; local is the whole ledger.
 * - `stale` — the remote moved past the tip this checkout last saw (another
 *   writer pushed); fetch, re-apply and retry.
 * - `failed` — git refused for another reason (no network, no credentials,
 *   a protected branch); `stderr` is git's first words on it.
 */
export type LifecyclePushStatus =
  | { status: "pushed"; remote: string; commit: string }
  | { status: "no-remote" }
  /** Recording is off for this process (#3955, ./no-record.ts): nothing was written to the branch, so nothing was pushed. */
  | { status: "not-recorded" }
  | { status: "stale"; remote: string; expected: string | null; stderr: string }
  | { status: "failed"; remote: string; stderr: string };

/**
 * Point `refs/remotes/<remote>/chant/lifecycle` at `sha`, the remote tip this
 * checkout has just seen (#3391).
 *
 * The push's lease is that ref, and git only keeps it up to date when the
 * remote's configured fetch refspec covers `chant/lifecycle`. A single-branch
 * clone (`git clone --single-branch`, a CI checkout of one ref, a shallow
 * clone) has a refspec for its one branch only, so neither the explicit
 * `chant/lifecycle:chant/lifecycle` fetch nor a successful push touches the
 * tracking ref. The first push of a new branch then succeeds against an empty
 * lease, and every later one is refused as stale against a remote that holds
 * exactly what this checkout last pushed. Recording the tip ourselves, only at
 * the two moments it is known (a fetch that fast-forwarded or found the local
 * branch ahead, and a push that landed), keeps the lease honest without
 * widening the clone's refspec. It is never set from a diverged fetch: that is
 * the case the lease exists to refuse.
 */
async function trackRemoteLifecycle(remote: string, sha: string, cwd?: string): Promise<void> {
  const rt = getRuntime();
  await rt.spawn(["git", "update-ref", `refs/remotes/${remote}/${STATE_BRANCH}`, sha], { cwd, env: C_LOCALE_ENV });
}

/**
 * Push the state branch to the ledger remote with --force-with-lease and say
 * what happened (#3391). Never throws for a git refusal; {@link pushLifecycle}
 * is the throwing form most callers use.
 */
export async function pushLifecycleStatus(opts?: { cwd?: string }): Promise<LifecyclePushStatus> {
  if (ledgerRecordingOff()) return { status: "not-recorded" };
  const rt = getRuntime();
  const cwd = opts?.cwd;
  const found = await ledgerRemote(cwd);
  if (found === null) return { status: "no-remote" };
  if ("failed" in found) return { status: "failed", remote: "(unknown)", stderr: found.stderr };
  const { remote } = found;

  // Capture the lease SHA — if null, the remote ref doesn't exist yet
  // (first-time push) and we send `--force-with-lease=ref:` (empty SHA),
  // which git interprets as "ref does not exist on remote".
  const expected = await getRemoteLifecycleBranchSha(remote, opts);
  const lease = `refs/heads/${STATE_BRANCH}:${expected ?? ""}`;
  const tip = await getStateBranchTip(cwd);

  const pushResult = await rt.spawn(
    ["git", "push", `--force-with-lease=${lease}`, remote, `${STATE_BRANCH}:${STATE_BRANCH}`],
    { cwd, env: C_LOCALE_ENV },
  );

  if (pushResult.exitCode !== 0) {
    const stderr = (pushResult.stderr ?? "").trim();
    if (
      stderr.includes("stale info") ||
      stderr.includes("rejected") ||
      stderr.includes("non-fast-forward")
    ) {
      return { status: "stale", remote, expected, stderr };
    }
    return { status: "failed", remote, stderr };
  }
  if (tip) await trackRemoteLifecycle(remote, tip, cwd);
  return { status: "pushed", remote, commit: tip ?? "" };
}

/**
 * Push the state branch to remote with --force-with-lease.
 *
 * If the remote chant/lifecycle ref has advanced past the local remote-tracking
 * SHA captured at the start of this push, the push is rejected and we throw
 * StaleLifecycleBranchError so the caller can surface a recovery hint.
 *
 * Returns false (without throwing) when no remote is configured, or when git
 * refused the push for a reason other than a stale lease.
 *
 * The remote is the ledger's ({@link ledgerRemote}: `origin` when there is one),
 * the same one {@link fetchLifecycleStatus} reads, and a push that lands
 * records the tip it pushed as the remote-tracking ref, so the next push's
 * lease is right in a single-branch clone too (#3391).
 */
export async function pushLifecycle(opts?: { cwd?: string }): Promise<boolean> {
  const result = await pushLifecycleStatus(opts);
  if (result.status === "stale") throw new StaleLifecycleBranchError(result.expected, result.stderr);
  return result.status === "pushed";
}

/**
 * One line on why a push did not land, for a write document's `notPushed`
 * (#3391), or null when it did.
 */
export function describeLifecyclePush(result: LifecyclePushStatus): string | null {
  const said = (stderr: string) => (stderr ? `; git said: ${stderr.split("\n").find((l) => l.trim()) ?? stderr}` : "");
  switch (result.status) {
    case "pushed":
      return null;
    case "no-remote":
      return `this repository has no remote, so ${STATE_BRANCH} stays local`;
    case "not-recorded":
      return NO_RECORD_PUSH_NOTE;
    case "stale":
      return `"${result.remote}" holds ${STATE_BRANCH} commits this checkout has not fetched, so the push was refused; fetch ${STATE_BRANCH} and write again${said(result.stderr)}`;
    case "failed":
      return `the push of ${STATE_BRANCH} to "${result.remote}" failed${said(result.stderr)}`;
  }
}

/**
 * Push the ledger branch and say, in one line, why it did not land (#2310,
 * #3677). No remote reads as {@link LIFECYCLE_LOCAL_NOTE}; a push that git
 * refused or that failed keeps its own reason, so a renderer can warn about
 * that case alone. Never throws.
 */
export async function pushLifecycleReport(opts?: { cwd?: string }): Promise<{ pushed: boolean; pushWarning?: string }> {
  try {
    return pushReportOf(await pushLifecycleStatus(opts));
  } catch (err) {
    return { pushed: false, pushWarning: err instanceof Error ? err.message : String(err) };
  }
}

function pushReportOf(result: LifecyclePushStatus): { pushed: boolean; pushWarning?: string } {
  switch (result.status) {
    case "pushed":
      return { pushed: true };
    case "no-remote":
      return { pushed: false, pushWarning: LIFECYCLE_LOCAL_NOTE };
    case "not-recorded":
      return { pushed: false, pushWarning: NO_RECORD_PUSH_NOTE };
    case "stale":
      return { pushed: false, pushWarning: new StaleLifecycleBranchError(result.expected, result.stderr).message };
    case "failed":
      return { pushed: false, pushWarning: describeLifecyclePush(result) ?? "the push did not land" };
  }
}

/** How many pushes {@link pushLifecycleRebasing} makes, as the snapshot store's `publishRef` does. */
export const LIFECYCLE_PUSH_TRIES = 3;

/**
 * Thrown by {@link pushLifecycleRebasing} when the ledger branch did not reach
 * the remote: another writer pushed before each of its tries, or this
 * checkout's commits do not replay on the remote's tip. What this run wrote
 * stays in this checkout's `chant/lifecycle` only.
 */
export class LifecyclePushLostError extends Error {
  readonly remote: string;
  readonly tries: number;
  constructor(remote: string, tries: number, detail: string) {
    super(
      `${STATE_BRANCH} was not pushed to "${remote}" after ${tries} ${tries === 1 ? "try" : "tries"}: ${detail}. ` +
        `The records this run wrote are only in this checkout; run the command again.`,
    );
    this.name = "LifecyclePushLostError";
    this.remote = remote;
    this.tries = tries;
  }
}

/** Scratch ref for the remote tip while {@link rebaseLifecycleOnRemote} replays onto it. */
const REBASE_REF = "refs/chant/lifecycle-rebase";

/**
 * Put this checkout's `chant/lifecycle` commits that the remote lacks on top
 * of the remote's tip (fetched again), and point the push's lease at that
 * tip. Each commit is replayed with `git merge-tree --write-tree` against its
 * own parent and keeps its author and message; nothing touches a work tree.
 * Returns why it could not, such as a commit whose files the other writer
 * changed too.
 */
async function rebaseLifecycleOnRemote(remote: string, cwd?: string): Promise<{ error: string } | { rebased: number }> {
  const rt = getRuntime();
  const run = (args: string[], env: Record<string, string> = {}) => rt.spawn(["git", ...args], { cwd, env: { ...C_LOCALE_ENV, ...env } });
  const firstLine = (s: string | undefined) => (s ?? "").trim().split("\n")[0] ?? "";
  try {
    const fetched = await run(["fetch", "--no-tags", "--force", remote, `refs/heads/${STATE_BRANCH}:${REBASE_REF}`]);
    if (fetched.exitCode !== 0) return { error: `the fetch of the remote's tip failed (git said: ${firstLine(fetched.stderr)})` };
    const remoteTip = (await run(["rev-parse", "--verify", REBASE_REF])).stdout.trim();
    const local = await getStateBranchTip(cwd);
    if (!remoteTip || !local) return { error: "the remote's tip or the local branch could not be read" };
    if ((await run(["merge-base", "--is-ancestor", remoteTip, local])).exitCode === 0) {
      // Already on the remote's history: only the lease was behind.
      await trackRemoteLifecycle(remote, remoteTip, cwd);
      return { rebased: 0 };
    }
    const ours = (await run(["rev-list", "--reverse", "--first-parent", local, `^${remoteTip}`])).stdout.trim().split("\n").filter(Boolean);
    const identityArgs = await ledgerCommitIdentityArgs(cwd);
    let onto = remoteTip;
    for (const commit of ours) {
      const parent = await run(["rev-parse", "--verify", "--quiet", `${commit}^1`]);
      if (parent.exitCode !== 0) return { error: `${commit.slice(0, 12)} shares no history with the remote's ${STATE_BRANCH}` };
      const merged = await run(["merge-tree", "--write-tree", `--merge-base=${parent.stdout.trim()}`, onto, commit]);
      const subject = firstLine((await run(["log", "-1", "--format=%s", commit])).stdout);
      if (merged.exitCode === 1) return { error: `"${subject}" (${commit.slice(0, 12)}) changes files the other writer changed too` };
      if (merged.exitCode !== 0) return { error: `git merge-tree failed on ${commit.slice(0, 12)} (git said: ${firstLine(merged.stderr)})` };
      const tree = firstLine(merged.stdout);
      const [name, email, date] = (await run(["log", "-1", "--format=%an%x00%ae%x00%aI", commit])).stdout.replace(/\n$/, "").split("\0");
      const message = (await run(["log", "-1", "--format=%B", commit])).stdout;
      const made = await rt.spawn(["git", ...identityArgs, "commit-tree", tree, "-p", onto, "-F", "-"], {
        cwd,
        stdin: message,
        env: { ...C_LOCALE_ENV, GIT_AUTHOR_NAME: name ?? "", GIT_AUTHOR_EMAIL: email ?? "", GIT_AUTHOR_DATE: date ?? "" },
      });
      if (made.exitCode !== 0) return { error: `git commit-tree failed on ${commit.slice(0, 12)} (git said: ${firstLine(made.stderr)})` };
      onto = made.stdout.trim();
    }
    try {
      await updateRefCAS(`refs/heads/${STATE_BRANCH}`, onto, local, { cwd });
    } catch (err) {
      if (err instanceof RefCASConflictError) return { error: `${STATE_BRANCH} moved in this checkout while it was replayed` };
      throw err;
    }
    await trackRemoteLifecycle(remote, remoteTip, cwd);
    return { rebased: ours.length };
  } finally {
    await run(["update-ref", "-d", REBASE_REF]);
  }
}

/**
 * {@link pushLifecycleReport} for a writer whose records must reach the
 * remote, such as the merge record `pr-record` writes. A push refused because
 * another writer pushed first fetches the remote's tip, replays this
 * checkout's commits on it ({@link rebaseLifecycleOnRemote}) and pushes again,
 * up to {@link LIFECYCLE_PUSH_TRIES} pushes in all. After the last refusal, or
 * a replay that cannot be made, it throws {@link LifecyclePushLostError}. No
 * remote, recording off and a push git refused for another reason (no
 * network, no credentials) are returned as {@link pushLifecycleReport}
 * returns them.
 */
export async function pushLifecycleRebasing(opts?: { cwd?: string; tries?: number }): Promise<{ pushed: boolean; pushWarning?: string }> {
  const tries = Math.max(1, opts?.tries ?? LIFECYCLE_PUSH_TRIES);
  const cwd = opts?.cwd;
  for (let attempt = 1; ; attempt++) {
    let result: LifecyclePushStatus;
    try {
      result = await pushLifecycleStatus({ cwd });
    } catch (err) {
      return { pushed: false, pushWarning: err instanceof Error ? err.message : String(err) };
    }
    if (result.status !== "stale") return pushReportOf(result);
    if (attempt >= tries) {
      const said = result.stderr.trim().split("\n")[0];
      throw new LifecyclePushLostError(result.remote, attempt, `another writer pushed before each try${said ? ` (git said: ${said})` : ""}`);
    }
    const rebased = await rebaseLifecycleOnRemote(result.remote, cwd);
    if ("error" in rebased) throw new LifecyclePushLostError(result.remote, attempt, rebased.error);
  }
}

/**
 * Fetch the state branch from remote.
 */
export async function fetchLifecycle(opts?: { cwd?: string }): Promise<boolean> {
  return (await fetchLifecycleStatus(opts)).status === "fetched";
}

/**
 * Why a fetch of the ledger branch did or did not produce local history
 * (#2303).
 *
 * `fetchLifecycle`'s boolean cannot answer the question the gate actually
 * needs answered. "No local `chant/lifecycle`" has two causes that a reader
 * of an empty ledger cannot tell apart, and they call for opposite
 * behaviour: on a project whose ledger has never been written, an empty
 * ledger is the truth; in a CI checkout that fetched only the pipeline's own
 * ref, an empty ledger is history the checkout simply cannot see. Reading the
 * second as the first is what makes a second pending fact look correct, so
 * these are separate outcomes:
 *
 * - `fetched` — the branch is now in this checkout (or already was, and is
 *   up to date). Whatever the ledger says is the whole truth.
 * - `no-remote` — nothing to fetch from. A single-machine project; local is
 *   authoritative by construction, the same assumption `chant operator`'s
 *   lease already documents.
 * - `absent` — the remote answered and has no `chant/lifecycle`. The ledger
 *   is genuinely empty; this is a project's first gate.
 * - `diverged` — both sides have the branch and neither contains the other.
 *   Appending here would drop one side's facts.
 * - `unreachable` — a remote is configured and did not answer (no network,
 *   no credentials, a shallow-clone refspec that cannot resolve). Whether
 *   anything is on the branch is unknown, which is exactly the state that
 *   must not be read as "nothing has been approved".
 */
export type LifecycleFetchStatus =
  | { status: "fetched" }
  | { status: "no-remote" }
  | { status: "absent"; remote: string }
  | { status: "ahead"; remote: string }
  | { status: "diverged"; remote: string; stderr: string }
  | { status: "unreachable"; remote: string; stderr: string };

/**
 * git's wording when the remote answered and simply does not carry the ref.
 *
 * Matched against output forced to `LC_ALL=C` ({@link C_LOCALE_ENV}) — both of
 * these strings are in git's translation catalogs, so on a distro git built
 * with NLS and a non-C `LANG` an unpinned locale would fail to match and send
 * a project's genuine first gate down the `unreachable` path, refusing it.
 */
const NO_SUCH_REMOTE_REF_RE = /couldn't find remote ref|no such ref was fetched/i;
/** git's wording when the refspec would not fast-forward the local branch. Same locale caveat. */
const NON_FAST_FORWARD_RE = /non-fast-forward|rejected/i;

/**
 * `git` invocations here are parsed by their output, so they are pinned to the
 * C locale. `LC_ALL` alone is enough — it outranks `LC_MESSAGES` and `LANG` —
 * but `LANGUAGE` is GNU gettext's own override and outranks all of them, so it
 * is cleared too.
 */
const C_LOCALE_ENV = { LC_ALL: "C", LANGUAGE: "" };

/**
 * The remote the ledger lives on.
 *
 * `origin` when it exists, rather than whichever name sorts first — a repo
 * with a `backup` remote alongside `origin` would otherwise fetch the ledger
 * from `backup`. A non-zero exit is *not* read as "no remote": a git that
 * failed to answer is not evidence that a project is single-machine, and
 * treating it as one is what lets an unreadable ledger look empty.
 */
async function ledgerRemote(cwd?: string): Promise<{ remote: string } | { failed: true; stderr: string } | null> {
  const rt = getRuntime();
  const result = await rt.spawn(["git", "remote"], { cwd, env: C_LOCALE_ENV });
  if (result.exitCode !== 0) return { failed: true, stderr: (result.stderr ?? "").trim() };
  const names = result.stdout.trim().split("\n").map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) return null;
  return { remote: names.includes("origin") ? "origin" : names[0] };
}

/** A scratch ref this module owns, used to resolve the remote tip without touching the ledger branch. */
const PROBE_REF = "refs/chant/lifecycle-probe";

/**
 * Fetch `chant/lifecycle` and say what happened, in the terms
 * {@link LifecycleFetchStatus} defines.
 *
 * The refspec is deliberately un-forced (`chant/lifecycle:chant/lifecycle`,
 * no leading `+`), so a local branch holding facts the remote does not have is
 * never rewound by a read.
 *
 * git reports "non-fast-forward" for two states that could not be more
 * different, which is why the rejection is not taken at face value (#2309
 * review): a local branch *ahead* of the remote — the ordinary state right
 * after an append whose push has not landed yet — and a local branch that has
 * genuinely *forked*. Resolving the remote tip into a scratch ref and asking
 * whether it is an ancestor of the local tip separates them. Reading a fork as
 * the ledger is what destroys approvals; refusing an append that is merely
 * ahead would break the retry that is supposed to repair a failed push.
 */
export async function fetchLifecycleStatus(opts?: { cwd?: string }): Promise<LifecycleFetchStatus> {
  const rt = getRuntime();
  const cwd = opts?.cwd;
  const found = await ledgerRemote(cwd);
  if (found === null) return { status: "no-remote" };
  if ("failed" in found) {
    return { status: "unreachable", remote: "(unknown)", stderr: found.stderr };
  }
  const { remote } = found;

  const fetchResult = await rt.spawn(
    ["git", "fetch", remote, `${STATE_BRANCH}:${STATE_BRANCH}`],
    { cwd, env: C_LOCALE_ENV },
  );
  if (fetchResult.exitCode === 0) {
    // The local branch is now the remote's tip; record it for the push's lease (#3391).
    const tip = await getStateBranchTip(cwd);
    if (tip) await trackRemoteLifecycle(remote, tip, cwd);
    return { status: "fetched" };
  }

  const stderr = (fetchResult.stderr ?? "").trim();
  if (NO_SUCH_REMOTE_REF_RE.test(stderr)) return { status: "absent", remote };
  if (!NON_FAST_FORWARD_RE.test(stderr)) return { status: "unreachable", remote, stderr };

  // Rejected. Resolve the remote tip into our own scratch ref (forced: the ref
  // is this module's, and nothing reads it but the next two lines) and ask
  // whether the local branch already contains it.
  const probe = await rt.spawn(
    ["git", "fetch", "--force", remote, `${STATE_BRANCH}:${PROBE_REF}`],
    { cwd, env: C_LOCALE_ENV },
  );
  if (probe.exitCode !== 0) {
    return { status: "unreachable", remote, stderr: (probe.stderr ?? "").trim() || stderr };
  }
  const contains = await rt.spawn(
    ["git", "merge-base", "--is-ancestor", PROBE_REF, `refs/heads/${STATE_BRANCH}`],
    { cwd, env: C_LOCALE_ENV },
  );
  const remoteTip = contains.exitCode === 0 ? (await rt.spawn(["git", "rev-parse", "--verify", PROBE_REF], { cwd, env: C_LOCALE_ENV })).stdout.trim() : "";
  await rt.spawn(["git", "update-ref", "-d", PROBE_REF], { cwd, env: C_LOCALE_ENV });
  if (contains.exitCode === 0) {
    // Ahead of the remote: its tip is in our history, so it is the right lease (#3391).
    if (remoteTip) await trackRemoteLifecycle(remote, remoteTip, cwd);
    return { status: "ahead", remote };
  }
  return { status: "diverged", remote, stderr };
}

/**
 * Thrown when the ledger branch cannot be read, rather than being reported as
 * empty (#2303).
 */
export class LifecycleLedgerUnreadableError extends Error {
  constructor(
    public readonly reason: "unreachable" | "diverged",
    public readonly remote: string,
    public readonly stderr: string,
    detail: string,
  ) {
    super(
      `the ${STATE_BRANCH} ledger branch ${detail}, so what is on it cannot be read. ` +
        `Refusing rather than treating an unreadable ledger as an empty one.` +
        (reason === "diverged"
          ? `\n  Two histories claim to be the ledger; appending to either one drops the other's facts. ` +
            `Inspect both before doing anything else:\n` +
            `    git fetch ${remote} ${STATE_BRANCH}:refs/chant/remote-ledger\n` +
            `    git log --oneline ${STATE_BRANCH} refs/chant/remote-ledger`
          : `\n  Fetch it and retry: git fetch ${remote} ${STATE_BRANCH}:${STATE_BRANCH}`) +
        (stderr ? `\n  git said: ${stderr.split("\n")[0]}` : ""),
    );
    this.name = "LifecycleLedgerUnreadableError";
  }
}

/**
 * Bring the ledger branch into this checkout before reading or appending to
 * it, and refuse when it cannot be (#2303).
 *
 * The gate's read is the one that has to be right: `evaluateGate` decides
 * whether to walk through or to record a *new* pending fact purely from what
 * the ledger says, so a read that reports history it cannot see as an empty
 * ledger makes the second run of an already-approved commit record a second
 * pending fact and gate again. That is what a GitLab CI retry did on
 * INTENTIUS/choudoufu#1026 — two pending records for one commit, with
 * different expiries — because a GitLab checkout fetches the pipeline's own
 * ref at depth 20 and nothing else. `GIT_DEPTH: 0` does not help: GitLab
 * fetches refspecs, not all branches.
 *
 * There was a separate, laxer guard for the read until #2309's review, on the
 * reasoning that a checkout which already has the branch "has real history to
 * read". That reasoning is only sound when the local branch *is* the remote's
 * history, and it let the worst case through: on a fork, the gate read a
 * ledger missing every remote approval, recorded a fresh pending fact, and
 * pushed. The push was not protected either — a rejected non-fast-forward
 * fetch still updates `refs/remotes/<remote>/chant/lifecycle` opportunistically
 * in a full clone, so `pushLifecycle`'s `--force-with-lease` matched the tip
 * it had just learned and forced. Verified on git 2.50.1: a remote holding a
 * pending fact and an approval ended up holding neither.
 *
 * So there is one rule now, for readers and writers alike:
 *
 * - `diverged` always refuses. A fork is not the ledger, and nothing good
 *   comes of reading one as if it were.
 * - `unreachable` refuses only when the checkout has no local history at all,
 *   which is the case that would otherwise read as an empty ledger. With
 *   local history and no answer from the remote, the read proceeds and the
 *   push's lease fails safely on its own — refusing there would strand every
 *   offline run.
 * - `fetched`, `no-remote`, `absent` and `ahead` all proceed. `ahead` is the
 *   ordinary state right after an append whose push has not landed, and is
 *   exactly what a retry needs to be able to repair.
 */
export async function requireLifecycleLedger(opts?: { cwd?: string }): Promise<void> {
  const hadLocal = (await getStateBranchTip(opts?.cwd)) !== null;
  const result = await fetchLifecycleStatus(opts);

  if (result.status === "diverged") {
    throw new LifecycleLedgerUnreadableError(
      "diverged",
      result.remote,
      result.stderr,
      `has diverged from the copy on "${result.remote}" — neither contains the other`,
    );
  }
  if (result.status === "unreachable" && !hadLocal) {
    throw new LifecycleLedgerUnreadableError(
      "unreachable",
      result.remote,
      result.stderr,
      `is not in this checkout and could not be fetched from "${result.remote}"`,
    );
  }
}

// ── Generic ref CAS (#1485) ──────────────────────────────────────────────────
//
// `writeBlobToPath`'s own `update-ref` call (above) had no compare-and-swap
// until this issue: two concurrent local writers could each build a tree from
// what they read as "current", and whichever called `update-ref` last simply
// overwrote the ref with no error — the other writer's change vanished
// silently. The primitives below give any caller (this module's own
// `writeBlobToPath`, and `./lease.ts`'s lease ref) a compare-and-swap guard
// building on what `git update-ref` already supports natively: pass the
// value you last observed as `<oldvalue>`, and the update only lands if the
// ref still points there. No lock file — `update-ref` itself is already an
// atomic local mutex (lockfile-then-rename under the hood), so this is
// exactly the "extend the ref-write helper" shape, not a second mechanism.

/**
 * Thrown by {@link updateRefCAS}/{@link deleteRefCAS} when `ref` no longer
 * points at the `oldValue` the caller last observed — another writer moved
 * it concurrently. Deliberately a distinct type from a generic git failure so
 * callers (a lease acquire, a retried ledger append) can tell "I lost a race"
 * from "git itself failed" and react differently to each.
 */
export class RefCASConflictError extends Error {
  constructor(
    public readonly ref: string,
    public readonly expected: string | null,
    stderr: string,
  ) {
    super(
      `ref "${ref}" moved concurrently — expected ${expected ?? "(ref must not exist)"}, ` +
        `but another writer updated it first. git stderr: ${stderr.trim()}`,
    );
    this.name = "RefCASConflictError";
  }
}

/**
 * Thrown by {@link updateRefCAS}/{@link deleteRefCAS} when the ref update
 * failed because git found a stale `.lock` file already sitting next to the
 * ref (#1959 finding 2) — what a `chant operator`/`chant approve`/etc.
 * process leaves behind when it is killed (SIGKILL, OOM, `kill -9`) mid-write,
 * *before* `git update-ref`'s own lockfile-then-rename completes. This is
 * exactly the crash this feature must recover from, and it is NOT a CAS
 * conflict: nobody else actually holds the ref (no other writer is racing,
 * the previous one is simply dead), so it must never be misread as "someone
 * else updated it first" — see `./lease.ts`'s `acquireLease`, which used to
 * (before this fix) read this as "lease held by someone else" and quietly
 * back off forever, since the dead process's lock file never goes away on
 * its own.
 */
export class StaleLockError extends Error {
  constructor(
    public readonly ref: string,
    public readonly lockPath: string,
    stderr: string,
  ) {
    super(
      `ref "${ref}" has a stale lock file at ${lockPath} — a previous git process ` +
        `(e.g. a killed \`chant operator\`) was interrupted mid-write and left it ` +
        `behind. Fix: remove it (\`rm ${lockPath}\`) and retry. git stderr: ${stderr.trim()}`,
    );
    this.name = "StaleLockError";
  }
}

/** Matches git's "Unable to create '<path>.lock': File exists." — the one stable, version-independent phrase every `git update-ref`/`git commit` etc. failure due to a leftover lock file uses, regardless of which ref or which git version. */
const STALE_LOCK_RE = /Unable to create '([^']+)':\s*File exists/;

/** Read the SHA `ref` currently points to, or `null` if it doesn't exist. Works for any ref, not just the lifecycle branch. */
export async function readRefSha(ref: string, opts?: { cwd?: string }): Promise<string | null> {
  const rt = getRuntime();
  const result = await rt.spawn(["git", "rev-parse", "--verify", ref], { cwd: opts?.cwd });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

/**
 * Turn a failed `git update-ref`'s stderr into the right error type (#1959
 * finding 2). Real git collapses several distinct failure modes into the
 * same nonzero exit code — a genuine CAS mismatch, a stale lock file left by
 * a killed process, and an outright bad ref name all just say "update_ref
 * failed" — so this doesn't trust the exit code alone:
 *
 *  1. A stale `.lock` file has a stable, distinctive message (see
 *     `STALE_LOCK_RE`) — checked first and reported as its own
 *     {@link StaleLockError}, never as a conflict.
 *  2. Otherwise, re-read the ref's actual current value and compare it to
 *     `oldValue`: if it genuinely differs, this is a real CAS conflict —
 *     {@link RefCASConflictError}. This is the authoritative check (not
 *     stderr text matching) so it holds across git versions/locales.
 *  3. If the ref's actual value still matches `oldValue` — the CAS itself
 *     should have succeeded — the failure is something else entirely (a bad
 *     ref name, a permissions problem, disk full, ...) and is surfaced as a
 *     plain `Error`, not miscategorized as either of the above.
 */
async function classifyRefFailure(
  ref: string,
  oldValue: string | null,
  stderr: string,
  opts?: { cwd?: string },
): Promise<Error> {
  const lockMatch = stderr.match(STALE_LOCK_RE);
  if (lockMatch) {
    return new StaleLockError(ref, lockMatch[1], stderr);
  }
  const actual = await readRefSha(ref, opts);
  if (actual !== oldValue) {
    return new RefCASConflictError(ref, oldValue, stderr);
  }
  return new Error(`git update-ref failed for ref "${ref}": ${stderr.trim()}`);
}

/**
 * Compare-and-swap update of an arbitrary ref. `oldValue` is the SHA the
 * caller last observed the ref at, or `null` to assert the ref does not yet
 * exist (git's own convention: an empty `<oldvalue>` argument to
 * `update-ref` means "must not exist"). Throws {@link RefCASConflictError}
 * when the ref genuinely moved since `oldValue` was read, {@link
 * StaleLockError} when a leftover lock file from a killed process is
 * blocking the write, or a plain `Error` for anything else — never silently
 * overwrites, and never misclassifies one failure as another (#1959 finding
 * 2; see {@link classifyRefFailure}).
 */
export async function updateRefCAS(
  ref: string,
  newValue: string,
  oldValue: string | null,
  opts?: { cwd?: string },
): Promise<void> {
  const rt = getRuntime();
  const result = await rt.spawn(["git", "update-ref", ref, newValue, oldValue ?? ""], { cwd: opts?.cwd });
  if (result.exitCode !== 0) {
    throw await classifyRefFailure(ref, oldValue, result.stderr ?? "", opts);
  }
}

/**
 * Compare-and-swap delete of an arbitrary ref — `oldValue` is required (no
 * "delete unconditionally" escape hatch here) so releasing a lease you no
 * longer hold can never delete someone else's newer one. Same failure
 * classification as {@link updateRefCAS} (#1959 finding 2).
 */
export async function deleteRefCAS(ref: string, oldValue: string, opts?: { cwd?: string }): Promise<void> {
  const rt = getRuntime();
  const result = await rt.spawn(["git", "update-ref", "-d", ref, oldValue], { cwd: opts?.cwd });
  if (result.exitCode !== 0) {
    throw await classifyRefFailure(ref, oldValue, result.stderr ?? "", opts);
  }
}

/**
 * Write arbitrary content as a git blob object — no tree, no commit, no ref
 * update. The building block a CAS ref's value can point at directly: a
 * lease record (`./lease.ts`) has no meaningful "tree of files", so its ref
 * targets a blob SHA rather than a commit the way `writeBlobToPath`'s tree-
 * building pipeline does.
 */
export async function writeBlob(content: string, opts?: { cwd?: string }): Promise<string> {
  const rt = getRuntime();
  const result = await rt.spawn(["git", "hash-object", "-w", "--stdin"], { cwd: opts?.cwd, stdin: content });
  if (result.exitCode !== 0) throw new Error(`git hash-object failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** Read a blob's raw content by its SHA (whatever object a ref points at directly). Returns `null` when the object doesn't exist locally. */
export async function readBlobBySha(sha: string, opts?: { cwd?: string }): Promise<string | null> {
  const rt = getRuntime();
  const result = await rt.spawn(["git", "cat-file", "blob", sha], { cwd: opts?.cwd });
  if (result.exitCode !== 0) return null;
  return result.stdout;
}

/**
 * Push one arbitrary ref (e.g. a lease ref) to the remote, guarded the same
 * way {@link pushLifecycle} guards the ledger branch: `--force-with-lease`
 * keyed to the remote SHA last observed locally, so a concurrent push from a
 * second machine is rejected rather than silently clobbered. The lease alone
 * lets a push replace a value that is not an ancestor — a lease ref's value is
 * a bare blob SHA, not a commit descending from the previous one — as long as
 * the remote still holds the expected value. No `--force` beside it: git lets
 * `--force` override `--force-with-lease`, which made every lease push
 * unconditional before #2732.
 *
 * Returns `false` (never throws) when no remote is configured — a
 * remote-less project's lease is local-only by construction (see
 * `./lease.ts`'s module doc), or when the push itself is rejected (the
 * caller re-reads and retries; see `acquireLease`). {@link pushRefStatus}
 * tells those two apart.
 */
export async function pushRef(ref: string, opts?: { cwd?: string; expect?: string | null }): Promise<boolean> {
  return (await pushRefStatus(ref, opts)) === "pushed";
}

/** What {@link pushRefStatus} did: the remote took the ref, there is no remote, or the remote refused it. */
export type PushRefStatus = "pushed" | "no-remote" | "rejected";

/**
 * {@link pushRef}, saying why a push did not land (#2732).
 *
 * `opts.expect` is the value the caller last saw the ref at on the remote
 * (`null`: absent there), and becomes the `--force-with-lease` expectation.
 * Without it the expectation is `refs/remotes/<remote>/<ref>`, which nothing
 * fetches a lease ref into, so it reads as "absent" and only a first push
 * lands. A lease passes the value of its own remote-tracking ref instead
 * (`./lease.ts`'s `readLease`).
 *
 * A ref that no longer exists locally is pushed as a deletion, under the same
 * expectation, so a released lease is released on the remote too. Deleting a
 * ref the caller expects to be absent already is a no-op that reports
 * `pushed`.
 */
export async function pushRefStatus(ref: string, opts?: { cwd?: string; expect?: string | null }): Promise<PushRefStatus> {
  // #3955: a run that records nothing pushes nothing, a lease ref included.
  // The lease still holds in this checkout, the way it does in one with no remote.
  if (ledgerRecordingOff()) return "no-remote";
  const rt = getRuntime();
  const remoteResult = await rt.spawn(["git", "remote"], { cwd: opts?.cwd });
  if (remoteResult.exitCode !== 0 || !remoteResult.stdout.trim()) return "no-remote";
  const remote = remoteResult.stdout.trim().split("\n")[0];

  let expected: string | null;
  if (opts?.expect !== undefined) {
    expected = opts.expect;
  } else {
    const remoteRef = `refs/remotes/${remote}/${ref.replace(/^refs\//, "")}`;
    const expectedResult = await rt.spawn(["git", "rev-parse", "--verify", remoteRef], { cwd: opts?.cwd });
    expected = expectedResult.exitCode === 0 ? expectedResult.stdout.trim() : null;
  }
  const lease = `${ref}:${expected ?? ""}`;

  const local = await readRefSha(ref, opts);
  if (local === null && expected === null) return "pushed";
  const refspec = local === null ? `:${ref}` : `${ref}:${ref}`;
  const pushResult = await rt.spawn(
    ["git", "push", `--force-with-lease=${lease}`, remote, refspec],
    { cwd: opts?.cwd },
  );
  return pushResult.exitCode === 0 ? "pushed" : "rejected";
}

/** What {@link fetchRefIntoStatus} found: the ref fetched, no remote, the remote answered without the ref, or the fetch failed. */
export type FetchRefStatus = "fetched" | "no-remote" | "missing" | "failed";

/**
 * Fetch one arbitrary remote ref into a local ref of a possibly *different*
 * name (#1959 finding 3). `+` forces the update even when it isn't a
 * fast-forward (a lease ref's new value is rarely a descendant of its old
 * one). Returns `false` (never throws) when no remote is configured.
 *
 * The `localRef !== remoteRef` shape exists so a read path can observe what
 * the remote currently holds without ever touching a local ref another code
 * path treats as CAS-authoritative — see {@link fetchRef}'s doc and
 * `./lease.ts`'s `readLease`, which fetches into a side tracking ref
 * (`refs/chant/lease-remote/<op>`) for exactly this reason.
 */
export async function fetchRefInto(
  remoteRef: string,
  localRef: string,
  opts?: { cwd?: string },
): Promise<boolean> {
  return (await fetchRefIntoStatus(remoteRef, localRef, opts)) === "fetched";
}

/**
 * {@link fetchRefInto}, saying why nothing was fetched (#2732). `missing`
 * means the remote answered and does not carry the ref, which for a lease is
 * the news that it was released there.
 */
export async function fetchRefIntoStatus(
  remoteRef: string,
  localRef: string,
  opts?: { cwd?: string },
): Promise<FetchRefStatus> {
  const rt = getRuntime();
  const remoteResult = await rt.spawn(["git", "remote"], { cwd: opts?.cwd });
  if (remoteResult.exitCode !== 0 || !remoteResult.stdout.trim()) return "no-remote";
  const remote = remoteResult.stdout.trim().split("\n")[0];
  const fetchResult = await rt.spawn(["git", "fetch", remote, `+${remoteRef}:${localRef}`], { cwd: opts?.cwd, env: C_LOCALE_ENV });
  if (fetchResult.exitCode === 0) return "fetched";
  return NO_SUCH_REMOTE_REF_RE.test(fetchResult.stderr ?? "") ? "missing" : "failed";
}

/**
 * Fetch one arbitrary ref from remote into the same local ref name.
 *
 * **Caution for a read path (#1959 finding 3):** this force-overwrites
 * `ref` locally (`+ref:ref`) — safe for a ref only a CAS write path ever
 * mutates locally between fetches, but NOT safe to call from a plain read
 * before every read if some other local writer (in the same clone) might be
 * mid-write: fetching here would force the local ref back to whatever the
 * remote last had, clobbering a just-written, not-yet-pushed local value out
 * from under it. `./lease.ts`'s `readLease` used to do exactly that; it now
 * uses {@link fetchRefInto} against a side tracking ref instead. Prefer
 * `fetchRefInto` for any new read-before-decide path.
 */
export async function fetchRef(ref: string, opts?: { cwd?: string }): Promise<boolean> {
  return fetchRefInto(ref, ref, opts);
}

/**
 * Get the current HEAD commit SHA of the main working branch.
 */
export async function getHeadCommit(opts?: { cwd?: string }): Promise<string> {
  const rt = getRuntime();
  const result = await rt.spawn(["git", "rev-parse", "HEAD"], { cwd: opts?.cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

// ── Internal helpers ────────────────────────────────────────────

/** One entry of a tree listing, keyed by its name in the listing's map. */
interface TreeLine {
  mode: string;
  type: string;
  sha: string;
}

async function getStateBranchTip(cwd?: string): Promise<string | null> {
  if (ledgerRecordingOff()) {
    const tip = overlayTip(await overlayKey(cwd));
    if (tip !== undefined) return tip;
  }
  const rt = getRuntime();
  const result = await rt.spawn(
    ["git", "rev-parse", "--verify", `refs/heads/${STATE_BRANCH}`],
    { cwd },
  );
  if (result.exitCode !== 0) return null;
  return result.stdout.trim();
}

/**
 * What a read names to see the ledger: `chant/lifecycle`, or, in a run that
 * records nothing (#3955), the in-memory tip its own writes built, once it
 * has written. Reads outside this module that name the branch themselves go
 * through here so they see the run's writes too.
 */
export async function ledgerRevision(cwd?: string): Promise<string> {
  if (!ledgerRecordingOff()) return STATE_BRANCH;
  return overlayTip(await overlayKey(cwd)) ?? STATE_BRANCH;
}

/** The repository a run's in-memory ledger tip belongs to (#3955): its common git directory, so worktrees and members share one. */
const overlayKeys = new Map<string, string>();
async function overlayKey(cwd?: string): Promise<string> {
  const from = cwd ?? process.cwd();
  const cached = overlayKeys.get(from);
  if (cached !== undefined) return cached;
  const result = await getRuntime().spawn(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: from, env: C_LOCALE_ENV });
  const key = result.exitCode === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : from;
  overlayKeys.set(from, key);
  return key;
}

/**
 * The entries of directory `dir` (branch-relative, `""` for the root) in
 * commit `tip`, or an empty map when it does not exist. Always pinned to the
 * resolved `tip` sha, never to `STATE_BRANCH`: a write reads several
 * directories, and a branch name re-resolves on each read, so a concurrent
 * commit would splice entries from two commits into one tree undetectably.
 *
 * `--full-tree` (#2550): run from a project in a subdirectory of the
 * repository, a bare `ls-tree` lists only the part of the tree under that
 * subdirectory, which on the orphan branch is nothing. The write then
 * rebuilt the branch from an empty tree, and an append's CAS refused it as a
 * concurrent change.
 */
async function listTreeAt(tip: string, dir: string, cwd?: string): Promise<Map<string, TreeLine>> {
  const rt = getRuntime();
  const entries = new Map<string, TreeLine>();
  const result = await rt.spawn(["git", "ls-tree", "--full-tree", dir === "" ? tip : `${tip}:${dir}/`], { cwd });
  if (result.exitCode !== 0) return entries;
  for (const line of result.stdout.split("\n")) {
    // Format: mode type sha\tname
    const match = line.match(/^(\d+)\s+(\w+)\s+([0-9a-f]+)\t(.+)$/);
    if (match) entries.set(match[4], { mode: match[1], type: match[2], sha: match[3] });
  }
  return entries;
}

function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf("/");
  return { dir: path.slice(0, slash), name: path.slice(slash + 1) };
}

function parentDir(dir: string): string {
  const slash = dir.lastIndexOf("/");
  return slash < 0 ? "" : dir.slice(0, slash);
}

function baseName(dir: string): string {
  return dir.slice(dir.lastIndexOf("/") + 1);
}

function depth(dir: string): number {
  return dir === "" ? 0 : dir.split("/").length;
}

/**
 * The branch's read side as a {@link LedgerReadPort} for the member `opts`
 * names (#3865): what the bundle-safe readers (`./release-read.ts`,
 * `./wave-plans.ts`) are handed. A product with its own way to read the
 * branch passes its own port instead and never loads this module.
 */
export function gitLedgerReadPort(opts?: LedgerLocation): LedgerReadPort {
  return {
    read: (dir, file) => readBlobFromPath(dir, file, opts),
    list: (dir) => listFilesInDir(dir, opts),
    trees: () => listLedgerTrees(opts),
  };
}
