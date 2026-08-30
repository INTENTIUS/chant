/**
 * Git plumbing operations for the chant/lifecycle orphan branch.
 *
 * All operations use git plumbing commands — no checkout, no branch switching,
 * no working tree changes.
 */
import { getRuntime } from "../runtime-adapter";

const STATE_BRANCH = "chant/lifecycle";

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
 */
/**
 * Bounded retry budget for {@link writeBlobToPath}'s own internal CAS retry
 * (#1959 finding 1). A conflict caused by some *other* env/file entry
 * changing concurrently (the ordinary case — e.g. two operator ticks
 * targeting different envs) is safe to resolve by simply rebuilding the tree
 * against the new tip and retrying; this bounds how many times it does that
 * before giving up and surfacing the conflict.
 */
const WRITE_BLOB_RETRY_ATTEMPTS = 5;

export async function writeBlobToPath(
  environment: string,
  filename: string,
  content: string,
  commitMessage: string,
  opts?: { cwd?: string; expectPriorPathSha?: string | null },
): Promise<string> {
  const rt = getRuntime();
  const cwd = opts?.cwd;

  // 1. Write blob — hash-object reads from stdin. Fed directly via spawn's
  // stdin (no shell involved), so content is written byte-for-byte: no `sh`
  // `echo` reinterpreting backslash-escape sequences (e.g. `\n` inside JSON,
  // as in a serialized kubectl.kubernetes.io/last-applied-configuration
  // annotation) and no shell-quoting dance around embedded single quotes.
  // Content-addressed and idempotent, so this stays outside the retry loop
  // below — nothing about a CAS conflict on the ref ever invalidates it.
  const blobResult = await rt.spawn(["git", "hash-object", "-w", "--stdin"], { cwd, stdin: content });
  if (blobResult.exitCode !== 0) {
    throw new Error(`git hash-object failed: ${blobResult.stderr}`);
  }
  const blobSha = blobResult.stdout.trim();

  const path = `${environment}/${filename}`;

  // 2-5. Read tree, build the commit, and CAS-update the branch ref — retried
  // on a conflict (#1959 finding 1). `writeBlobToPath` had no retry of its
  // own before this: a conflict from step 5's `updateRefCAS` simply threw,
  // breaking every pre-existing caller (observation-baseline.ts,
  // snapshot.ts, build-ledger-store.ts, and — via `appendReleaseRecordLine`
  // below — release-ledger.ts) the moment any concurrent writer touched the
  // orphan branch, e.g. a live `chant operator` ticking a different env.
  //
  // Safety of a *blind* retry (same `content`/`blobSha`, freshly rebuilt
  // tree) hinges on whether *our own* target path (`environment/filename`)
  // is what actually caused the conflict:
  //   - If some OTHER path changed (the ordinary multi-env/multi-file case),
  //     our data is unaffected — rebuilding the tree from the new tip and
  //     retrying the ref update is always correct, no matter what kind of
  //     write the caller is doing (replace or append).
  //   - If OUR OWN path changed concurrently, a blind retry using `content`
  //     computed before that race would silently clobber the other writer's
  //     change — safe only for a caller whose `content` is a self-contained
  //     replacement (writeObservationBaseline, writeSnapshot,
  //     persistBuildManifest), never for a read-modify-write caller whose
  //     `content` already embeds a stale read (an append). Since this
  //     function can't tell those apart, it does NOT blind-retry in that
  //     case — it re-throws immediately so a read-modify-write caller's own
  //     outer retry (appendConvergeRecord, appendGateResolution,
  //     appendReleaseRecordLine below) can re-read and recompute `content`
  //     fresh before trying again, exactly as they already do.
  //
  //   - A read-modify-write caller must pass `expectPriorPathSha`. Without it
  //     attempt 1 has no prior sha to compare, so a commit landing between the
  //     caller's baseline read and this function's first tree read reads as the
  //     ambient starting state rather than a conflict, and is overwritten from
  //     the caller's stale content.
  let lastErr: unknown;
  let priorPathSha: string | null | undefined = opts?.expectPriorPathSha;
  for (let attempt = 1; attempt <= WRITE_BLOB_RETRY_ATTEMPTS; attempt++) {
    // 2. Read existing tree (if branch exists) to preserve other env/file
    // entries. `tip` is the commit sha `entries` was read from, and must stay
    // the commit parent and CAS oldValue below. Re-resolving the branch name
    // there instead can observe a newer tip than `entries` reflects, which
    // makes the CAS succeed against a tree built from a stale read.
    const { tip, entries: existingTree } = await readTree(cwd);
    const currentPathSha = existingTree.find((e) => e.env === environment && e.name === filename)?.sha ?? null;

    if (priorPathSha !== undefined && currentPathSha !== priorPathSha) {
      // Our own path moved since our previous attempt started — a genuine
      // content-level race on the exact file we're writing, not just a CAS
      // conflict from a sibling path. Not safe to paper over here.
      throw lastErr ?? new RefCASConflictError(`refs/heads/${STATE_BRANCH}`, priorPathSha, "target path changed concurrently");
    }
    priorPathSha = currentPathSha;

    // 3. Build new tree entries
    const entries = mergeTreeEntry(existingTree, path, blobSha);

    // mktree needs a nested tree structure. Build env subtree first, then root tree.
    // Build env subtree
    const envEntries = entries
      .filter((e) => e.env === environment)
      .map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.name}`)
      .join("\n");

    const envTreeResult = await rt.spawn(["git", "mktree"], { cwd, stdin: `${envEntries}\n` });
    if (envTreeResult.exitCode !== 0) {
      throw new Error(`git mktree (env) failed: ${envTreeResult.stderr}`);
    }
    const envTreeSha = envTreeResult.stdout.trim();

    // Build root tree: collect env subtrees
    const rootEntries: string[] = [];
    const envsSeen = new Set<string>();
    for (const e of entries) {
      if (!envsSeen.has(e.env)) {
        envsSeen.add(e.env);
        if (e.env === environment) {
          rootEntries.push(`040000 tree ${envTreeSha}\t${environment}`);
        } else {
          rootEntries.push(`040000 tree ${e.envTreeSha!}\t${e.env}`);
        }
      }
    }

    const rootTreeResult = await rt.spawn(["git", "mktree"], {
      cwd,
      stdin: `${rootEntries.join("\n")}\n`,
    });
    if (rootTreeResult.exitCode !== 0) {
      throw new Error(`git mktree (root) failed: ${rootTreeResult.stderr}`);
    }
    const rootTreeSha = rootTreeResult.stdout.trim();

    // 4. Create commit — parented on `tip`, the exact sha `existingTree` was
    // read from (see the comment on step 2), not a fresh re-resolution of
    // the branch name.
    const parentRef = tip;
    const parentArgs = parentRef ? ["-p", parentRef] : [];
    const commitResult = await rt.spawn(
      ["git", "commit-tree", ...parentArgs, "-m", commitMessage, rootTreeSha],
      { cwd },
    );
    if (commitResult.exitCode !== 0) {
      throw new Error(`git commit-tree failed: ${commitResult.stderr}`);
    }
    const commitSha = commitResult.stdout.trim();

    // 5. Update ref — CAS-guarded against `parentRef` (#1485): closes the
    // local race two concurrent writers used to hit silently (whoever called
    // update-ref last simply overwrote the other's tree, no error). A
    // conflict here throws RefCASConflictError instead of clobbering.
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
  opts?: { cwd?: string },
): Promise<string | null> {
  const rt = getRuntime();
  const result = await rt.spawn(
    ["git", "show", `${STATE_BRANCH}:${environment}/${filename}`],
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
  opts?: { cwd?: string },
): Promise<string | null> {
  const rt = getRuntime();
  const result = await rt.spawn(
    ["git", "rev-parse", "--verify", `${STATE_BRANCH}:${environment}/${filename}`],
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
 * Read a snapshot from the orphan branch.
 */
export async function readSnapshot(
  environment: string,
  lexicon: string,
  opts?: { cwd?: string },
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
  opts?: { cwd?: string },
): Promise<string | null> {
  const rt = getRuntime();
  const result = await rt.spawn(
    ["git", "show", `${ref}:${environment}/${lexicon}.json`],
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
  const filename = "releases.jsonl";

  let lastErr: unknown;
  for (let attempt = 1; attempt <= WRITE_BLOB_RETRY_ATTEMPTS; attempt++) {
    try {
      const priorSha = await readPathSha(environment, filename, opts);
      const existing = priorSha ? await readBlobBySha(priorSha, opts) : null;
      const content = existing ? `${existing.replace(/\n$/, "")}\n${recordJson}` : recordJson;
      return await writeBlobToPath(environment, filename, content, "Release record", {
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
  opts?: { cwd?: string },
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
export async function listLedgerEnvironments(opts?: { cwd?: string }): Promise<string[]> {
  const tip = await getStateBranchTip(opts?.cwd);
  if (!tip) return [];
  const rt = getRuntime();
  const rootResult = await rt.spawn(["git", "ls-tree", STATE_BRANCH], { cwd: opts?.cwd });
  if (rootResult.exitCode !== 0) return [];

  const envs: string[] = [];
  const lines = rootResult.stdout.trim().split("\n").filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^(\d+)\s+(\w+)\s+([0-9a-f]+)\t(.+)$/);
    if (!match) continue;
    const [, , type, , name] = match;
    if (type !== "tree") continue;
    const hasLedger = await readBlobFromPath(name, "releases.jsonl", opts);
    if (hasLedger) envs.push(name);
  }
  return envs.sort();
}

/**
 * List every filename directly under `<dir>/` on the orphan branch (no
 * recursion), or `[]` when the branch/directory doesn't exist yet. Generic
 * sibling of `readEnvironmentSnapshots`'s inline file listing, factored out
 * so ./build-ledger-store.ts (#609) can enumerate every persisted build
 * manifest (`_builds/<digest>.json`) without duplicating this `git ls-tree
 * --name-only` call.
 */
export async function listFilesInDir(dir: string, opts?: { cwd?: string }): Promise<string[]> {
  const tip = await getStateBranchTip(opts?.cwd);
  if (!tip) return [];
  const rt = getRuntime();
  const lsResult = await rt.spawn(
    ["git", "ls-tree", "--name-only", `${STATE_BRANCH}:${dir}/`],
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
  const lsResult = await rt.spawn(
    ["git", "ls-tree", "--name-only", `${STATE_BRANCH}:${environment}/`],
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
  opts?: { cwd?: string; environment?: string },
): Promise<Array<{ commit: string; date: string; message: string }>> {
  const rt = getRuntime();
  const result = await rt.spawn(
    ["git", "log", "--format=%H %aI %s", STATE_BRANCH],
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
 * Push the state branch to remote with --force-with-lease.
 *
 * If the remote chant/lifecycle ref has advanced past the local remote-tracking
 * SHA captured at the start of this push, the push is rejected and we throw
 * StaleLifecycleBranchError so the caller can surface a recovery hint.
 *
 * Returns false (without throwing) only when no remote is configured at all.
 */
export async function pushLifecycle(opts?: { cwd?: string }): Promise<boolean> {
  const rt = getRuntime();
  const remoteResult = await rt.spawn(["git", "remote"], { cwd: opts?.cwd });
  if (remoteResult.exitCode !== 0 || !remoteResult.stdout.trim()) return false;

  const remote = remoteResult.stdout.trim().split("\n")[0];

  // Capture the lease SHA — if null, the remote ref doesn't exist yet
  // (first-time push) and we send `--force-with-lease=ref:` (empty SHA),
  // which git interprets as "ref does not exist on remote".
  const expected = await getRemoteLifecycleBranchSha(remote, opts);
  const lease = `refs/heads/${STATE_BRANCH}:${expected ?? ""}`;

  const pushResult = await rt.spawn(
    ["git", "push", `--force-with-lease=${lease}`, remote, `${STATE_BRANCH}:${STATE_BRANCH}`],
    { cwd: opts?.cwd },
  );

  if (pushResult.exitCode !== 0) {
    const stderr = pushResult.stderr ?? "";
    if (
      stderr.includes("stale info") ||
      stderr.includes("rejected") ||
      stderr.includes("non-fast-forward")
    ) {
      throw new StaleLifecycleBranchError(expected, stderr);
    }
    return false;
  }
  return true;
}

/**
 * Fetch the state branch from remote.
 */
export async function fetchLifecycle(opts?: { cwd?: string }): Promise<boolean> {
  const rt = getRuntime();
  const remoteResult = await rt.spawn(["git", "remote"], { cwd: opts?.cwd });
  if (remoteResult.exitCode !== 0 || !remoteResult.stdout.trim()) return false;

  const remote = remoteResult.stdout.trim().split("\n")[0];
  const fetchResult = await rt.spawn(
    ["git", "fetch", remote, `${STATE_BRANCH}:${STATE_BRANCH}`],
    { cwd: opts?.cwd },
  );
  return fetchResult.exitCode === 0;
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
 * second machine is rejected rather than silently clobbered. Plain `--force`
 * underneath that lease — a lease ref's value is a bare blob SHA, not a
 * commit descending from the previous one, so there is no "fast-forward" to
 * preserve, only the CAS the lease guard already provides.
 *
 * Returns `false` (never throws) when no remote is configured — a
 * remote-less project's lease is local-only by construction (see
 * `./lease.ts`'s module doc), or when the push itself is rejected (the
 * caller re-reads and retries; see `acquireLease`).
 */
export async function pushRef(ref: string, opts?: { cwd?: string }): Promise<boolean> {
  const rt = getRuntime();
  const remoteResult = await rt.spawn(["git", "remote"], { cwd: opts?.cwd });
  if (remoteResult.exitCode !== 0 || !remoteResult.stdout.trim()) return false;
  const remote = remoteResult.stdout.trim().split("\n")[0];

  const remoteRef = `refs/remotes/${remote}/${ref.replace(/^refs\//, "")}`;
  const expectedResult = await rt.spawn(["git", "rev-parse", "--verify", remoteRef], { cwd: opts?.cwd });
  const expected = expectedResult.exitCode === 0 ? expectedResult.stdout.trim() : null;
  const lease = `${ref}:${expected ?? ""}`;

  const pushResult = await rt.spawn(
    ["git", "push", "--force", `--force-with-lease=${lease}`, remote, `${ref}:${ref}`],
    { cwd: opts?.cwd },
  );
  return pushResult.exitCode === 0;
}

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
  const rt = getRuntime();
  const remoteResult = await rt.spawn(["git", "remote"], { cwd: opts?.cwd });
  if (remoteResult.exitCode !== 0 || !remoteResult.stdout.trim()) return false;
  const remote = remoteResult.stdout.trim().split("\n")[0];
  const fetchResult = await rt.spawn(["git", "fetch", remote, `+${remoteRef}:${localRef}`], { cwd: opts?.cwd });
  return fetchResult.exitCode === 0;
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

interface TreeEntry {
  mode: string;
  type: string;
  sha: string;
  name: string;
  env: string;
  envTreeSha?: string;
}

async function getStateBranchTip(cwd?: string): Promise<string | null> {
  const rt = getRuntime();
  const result = await rt.spawn(
    ["git", "rev-parse", "--verify", `refs/heads/${STATE_BRANCH}`],
    { cwd },
  );
  if (result.exitCode !== 0) return null;
  return result.stdout.trim();
}

/**
 * Read the orphan branch's tip and every env/file tree entry under it as one
 * consistent snapshot. Every listing must stay pinned to the resolved `tip`
 * sha, never to `STATE_BRANCH`: the read spans several `ls-tree` calls (root
 * plus one per env subtree) and a branch name re-resolves on each, so a
 * concurrent commit splices entries from two commits into one array
 * undetectably. Callers need the returned `tip` as their commit parent.
 */
async function readTree(cwd?: string): Promise<{ tip: string | null; entries: TreeEntry[] }> {
  const rt = getRuntime();
  const tip = await getStateBranchTip(cwd);
  if (!tip) return { tip: null, entries: [] };

  // List root tree to get env directories — pinned to `tip`, not `STATE_BRANCH`.
  const rootResult = await rt.spawn(
    ["git", "ls-tree", tip],
    { cwd },
  );
  if (rootResult.exitCode !== 0) return { tip, entries: [] };

  const entries: TreeEntry[] = [];
  const lines = rootResult.stdout.trim().split("\n").filter(Boolean);

  for (const line of lines) {
    // Format: mode type sha\tname
    const match = line.match(/^(\d+)\s+(\w+)\s+([0-9a-f]+)\t(.+)$/);
    if (!match) continue;
    const [, mode, type, sha, name] = match;

    if (type === "tree") {
      // This is an env directory — list its contents, still pinned to `tip`.
      const envResult = await rt.spawn(
        ["git", "ls-tree", `${tip}:${name}/`],
        { cwd },
      );
      if (envResult.exitCode !== 0) continue;

      const envLines = envResult.stdout.trim().split("\n").filter(Boolean);
      for (const envLine of envLines) {
        const envMatch = envLine.match(/^(\d+)\s+(\w+)\s+([0-9a-f]+)\t(.+)$/);
        if (!envMatch) continue;
        entries.push({
          mode: envMatch[1],
          type: envMatch[2],
          sha: envMatch[3],
          name: envMatch[4],
          env: name,
          envTreeSha: sha,
        });
      }
    }
  }

  return { tip, entries };
}

function mergeTreeEntry(
  existing: TreeEntry[],
  path: string,
  blobSha: string,
): TreeEntry[] {
  const [env, filename] = path.split("/");
  const entries = existing.filter(
    (e) => !(e.env === env && e.name === filename),
  );
  entries.push({
    mode: "100644",
    type: "blob",
    sha: blobSha,
    name: filename,
    env,
  });
  return entries;
}
