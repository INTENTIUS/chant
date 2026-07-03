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
 */
async function writeBlobToPath(
  environment: string,
  filename: string,
  content: string,
  commitMessage: string,
  opts?: { cwd?: string },
): Promise<string> {
  const rt = getRuntime();
  const cwd = opts?.cwd;

  // 1. Write blob — hash-object reads from stdin, but spawn() doesn't expose
  // a stdin handle, so we run via a shell pipeline (`echo … | git hash-object`).
  const blobResult = await rt.spawn(
    ["sh", "-c", `echo '${content.replace(/'/g, "'\\''")}' | git hash-object -w --stdin`],
    { cwd },
  );
  if (blobResult.exitCode !== 0) {
    throw new Error(`git hash-object failed: ${blobResult.stderr}`);
  }
  const blobSha = blobResult.stdout.trim();

  // 2. Read existing tree (if branch exists) to preserve other env/file entries
  const existingTree = await readTree(cwd);

  // 3. Build new tree entries
  const path = `${environment}/${filename}`;
  const entries = mergeTreeEntry(existingTree, path, blobSha);

  // mktree needs a nested tree structure. Build env subtree first, then root tree.
  // Build env subtree
  const envEntries = entries
    .filter((e) => e.env === environment)
    .map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.name}`)
    .join("\n");

  const envTreeResult = await rt.spawn(
    ["sh", "-c", `printf '%s\\n' ${shellQuoteLines(envEntries)} | git mktree`],
    { cwd },
  );
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

  const rootTreeResult = await rt.spawn(
    ["sh", "-c", `printf '%s\\n' ${shellQuoteLines(rootEntries.join("\n"))} | git mktree`],
    { cwd },
  );
  if (rootTreeResult.exitCode !== 0) {
    throw new Error(`git mktree (root) failed: ${rootTreeResult.stderr}`);
  }
  const rootTreeSha = rootTreeResult.stdout.trim();

  // 4. Create commit
  const parentRef = await getStateBranchTip(cwd);
  const parentArgs = parentRef ? ["-p", parentRef] : [];
  const commitResult = await rt.spawn(
    ["git", "commit-tree", ...parentArgs, "-m", commitMessage, rootTreeSha],
    { cwd },
  );
  if (commitResult.exitCode !== 0) {
    throw new Error(`git commit-tree failed: ${commitResult.stderr}`);
  }
  const commitSha = commitResult.stdout.trim();

  // 5. Update ref
  const updateResult = await rt.spawn(
    ["git", "update-ref", `refs/heads/${STATE_BRANCH}`, commitSha],
    { cwd },
  );
  if (updateResult.exitCode !== 0) {
    throw new Error(`git update-ref failed: ${updateResult.stderr}`);
  }

  return commitSha;
}

/**
 * Read a blob from an arbitrary `<environment>/<filename>` path on the orphan
 * branch. Returns null when the path doesn't exist (missing branch, env, or
 * file). Sibling of `writeBlobToPath`.
 */
async function readBlobFromPath(
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
 */
export async function appendReleaseRecordLine(
  environment: string,
  recordJson: string,
  opts?: { cwd?: string },
): Promise<string> {
  const filename = "releases.jsonl";
  const existing = await readBlobFromPath(environment, filename, opts);
  const content = existing ? `${existing.replace(/\n$/, "")}\n${recordJson}` : recordJson;
  return writeBlobToPath(environment, filename, content, "Release record", opts);
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

async function readTree(cwd?: string): Promise<TreeEntry[]> {
  const rt = getRuntime();
  const tip = await getStateBranchTip(cwd);
  if (!tip) return [];

  // List root tree to get env directories
  const rootResult = await rt.spawn(
    ["git", "ls-tree", STATE_BRANCH],
    { cwd },
  );
  if (rootResult.exitCode !== 0) return [];

  const entries: TreeEntry[] = [];
  const lines = rootResult.stdout.trim().split("\n").filter(Boolean);

  for (const line of lines) {
    // Format: mode type sha\tname
    const match = line.match(/^(\d+)\s+(\w+)\s+([0-9a-f]+)\t(.+)$/);
    if (!match) continue;
    const [, mode, type, sha, name] = match;

    if (type === "tree") {
      // This is an env directory — list its contents
      const envResult = await rt.spawn(
        ["git", "ls-tree", `${STATE_BRANCH}:${name}/`],
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

  return entries;
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

function shellQuoteLines(input: string): string {
  // Escape for printf in shell
  return `'${input.replace(/'/g, "'\\''")}'`;
}
