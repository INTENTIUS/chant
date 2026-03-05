/**
 * Git plumbing operations for the chant/state orphan branch.
 *
 * All operations use git plumbing commands — no checkout, no branch switching,
 * no working tree changes.
 */
import { getRuntime } from "../runtime-adapter";

const STATE_BRANCH = "chant/state";

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
  const rt = getRuntime();
  const cwd = opts?.cwd;

  // 1. Write blob
  const hashResult = await rt.spawn(
    ["git", "hash-object", "-w", "--stdin"],
    { cwd },
  );
  // hash-object reads from stdin, but spawn doesn't support piping directly.
  // Use a shell pipeline instead.
  const blobResult = await rt.spawn(
    ["sh", "-c", `echo '${json.replace(/'/g, "'\\''")}' | git hash-object -w --stdin`],
    { cwd },
  );
  if (blobResult.exitCode !== 0) {
    throw new Error(`git hash-object failed: ${blobResult.stderr}`);
  }
  const blobSha = blobResult.stdout.trim();

  // 2. Read existing tree (if branch exists) to preserve other env/lexicon entries
  const existingTree = await readTree(cwd);

  // 3. Build new tree entries
  const path = `${environment}/${lexicon}.json`;
  const entries = mergeTreeEntry(existingTree, path, blobSha);
  const treeInput = entries.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.name}`).join("\n");

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
    ["git", "commit-tree", ...parentArgs, "-m", "State snapshot", rootTreeSha],
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
 * Read a snapshot from the orphan branch.
 */
export async function readSnapshot(
  environment: string,
  lexicon: string,
  opts?: { cwd?: string },
): Promise<string | null> {
  const rt = getRuntime();
  const result = await rt.spawn(
    ["git", "show", `${STATE_BRANCH}:${environment}/${lexicon}.json`],
    { cwd: opts?.cwd },
  );
  if (result.exitCode !== 0) return null;
  return result.stdout;
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
 * Push the state branch to remote.
 */
export async function pushState(opts?: { cwd?: string }): Promise<boolean> {
  const rt = getRuntime();
  // Check if remote exists
  const remoteResult = await rt.spawn(["git", "remote"], { cwd: opts?.cwd });
  if (remoteResult.exitCode !== 0 || !remoteResult.stdout.trim()) return false;

  const remote = remoteResult.stdout.trim().split("\n")[0];
  const pushResult = await rt.spawn(
    ["git", "push", remote, `${STATE_BRANCH}:${STATE_BRANCH}`],
    { cwd: opts?.cwd },
  );
  return pushResult.exitCode === 0;
}

/**
 * Fetch the state branch from remote.
 */
export async function fetchState(opts?: { cwd?: string }): Promise<boolean> {
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
