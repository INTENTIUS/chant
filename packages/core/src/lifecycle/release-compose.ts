/**
 * `chant release compose` (#4168 4.3, mode b): a release of chosen changes
 * on a base, when trunk carries work that is not ready to ship.
 *
 * The changes are named by pull request (`--pr <n>`) or work item
 * (`--work <id>`) and found on trunk's first-parent line after the base:
 * a pull request by the merge record `_merges/<sha>.json` on
 * `chant/lifecycle` (./merge-record.ts) or the squash subject `... (#n)`,
 * a work item by the commit's `Chant-Record: work:<id>` trailers or a merge
 * record that names it. Each commit is cherry-picked in trunk order onto the
 * base, in a temporary detached worktree, with a `Chant-Composed-From: <sha>`
 * trailer, and the result goes on the branch `chant/compose/<name>`, pushed
 * so the forge's CI builds it (decision 6).
 *
 * It only appends. A branch that exists is composed onto from its tip, with
 * the base it already has; a change it already carries is skipped. On a
 * conflict it stops, names the change and the files, and writes nothing: a
 * person resolves it in a pull request to the compose branch.
 *
 * Without `yes` it is a dry run: the picks are made in the temporary
 * worktree, so a conflict shows now, and no ref is moved or pushed.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPOSE_BRANCH_PREFIX, COMPOSED_FROM_TRAILER, compositionOnTrunk } from "./compose-refs";

export type ComposeCode =
  | "not-a-git-repository"
  | "compose-name-invalid"
  | "compose-nothing-chosen"
  | "compose-base-unknown"
  | "compose-base-differs"
  | "compose-branch-diverged"
  | "compose-source-unknown"
  | "compose-conflict"
  | "compose-push-refused";

export class ComposeError extends Error {
  constructor(
    readonly code: ComposeCode,
    message: string,
    readonly fix?: string,
    /** With `compose-conflict`: the change that did not apply and the files it conflicts in. */
    readonly conflict?: { commit: string; subject: string; files: string[] },
  ) {
    super(message);
    this.name = "ComposeError";
  }
}

export interface ComposeRequest {
  cwd: string;
  name: string;
  /** A release label or digest, or a commit. Required when the branch does not exist yet. */
  base?: string;
  prs: readonly number[];
  works: readonly string[];
  /** Move the branch and push it. Otherwise a dry run. */
  yes: boolean;
  /** The trunk branch, `ci.green.branch` as the cut resolves it. */
  trunk: { remote: string; branch: string };
  /** Push the branch to the trunk's remote with `yes`. Default true. */
  push?: boolean;
}

/** One trunk commit a compose picks, and why. */
export interface ComposeSource {
  commit: string;
  subject: string;
  pr: number | null;
  work: string[];
  /** The `--pr` and `--work` values that chose it. */
  chosenBy: string[];
}

export interface ComposeResult {
  name: string;
  branch: string;
  base: string;
  /** The branch's tip before the compose, or null when it is new. */
  from: string | null;
  /** The commits picked now, in trunk order. */
  picked: ComposeSource[];
  /** Chosen commits the branch already carries. */
  already: ComposeSource[];
  /** The branch's tip after the picks. Under a dry run, the tip it would have. */
  tip: string;
  /** Whether the branch was moved here. False under a dry run. */
  written: boolean;
  /** Whether it was pushed. */
  pushed: boolean;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PR_IN_SUBJECT = /\(#(\d+)\)\s*$/;

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, ...(env ? { env } : {}) }).trim();
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

const isAncestor = (top: string, a: string, b: string): boolean => spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: top, stdio: "ignore" }).status === 0;

/** The branch a compose name lives on. */
export function composeBranchName(name: string): string {
  return `${COMPOSE_BRANCH_PREFIX}${name}`;
}

async function resolveBase(top: string, cwd: string, ref: string): Promise<string> {
  const { resolveRelease } = await import("./release-store");
  const found = await resolveRelease(ref, { cwd }).catch(() => null);
  if (found) return found.release.commit;
  const sha = tryGit(top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!sha) {
    throw new ComposeError("compose-base-unknown", `--base ${ref} names no release of this member and no commit this clone has`, "Name a release label (chant release list) or a commit, after fetching it.");
  }
  return sha;
}

/** The merge record of `sha`, as stored, or null. */
async function mergeRecordOf(cwd: string, sha: string): Promise<Record<string, unknown> | null> {
  const { readBlobFromPath } = await import("./git");
  const text = await readBlobFromPath("_merges", `${sha}.json`, { cwd }).catch(() => null);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The pull request and work items a merge record names. */
function fromMergeRecord(merge: Record<string, unknown> | null): { pr: number | null; work: string[] } {
  if (!merge) return { pr: null, work: [] };
  const source = merge.source as { kind?: unknown; pr?: unknown; records?: unknown } | undefined;
  const pr = source?.kind === "pull-request" && typeof source.pr === "number" ? source.pr : typeof merge.pr === "number" ? merge.pr : null;
  const work =
    source?.kind === "work-item" && Array.isArray(source.records)
      ? source.records.filter((r): r is { kind: string; id: string } => !!r && typeof r === "object" && (r as { kind?: unknown }).kind === "work").map((r) => r.id)
      : [];
  return { pr, work };
}

/**
 * Compose the chosen changes onto the base, on `chant/compose/<name>`.
 * Throws {@link ComposeError} before any ref moves.
 */
export async function composeRelease(req: ComposeRequest): Promise<ComposeResult> {
  const top = tryGit(req.cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) throw new ComposeError("not-a-git-repository", "a compose picks commits, and this directory is not in a git repository");
  if (!NAME.test(req.name)) {
    throw new ComposeError("compose-name-invalid", `"${req.name}" can't name a compose branch: use letters, digits, dots, dashes and underscores, starting with a letter or digit`);
  }
  if (req.prs.length === 0 && req.works.length === 0) {
    throw new ComposeError("compose-nothing-chosen", "a compose needs the changes it carries", "Name them: --pr <n> or --work <id>, each as often as needed.");
  }
  const { remote } = req.trunk;
  const branch = composeBranchName(req.name);
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  const localRef = `refs/heads/${branch}`;
  // The branch as the remote has it, when the remote is reachable; a new branch is absent there.
  if (tryGit(top, ["remote", "get-url", remote]) !== null) tryGit(top, ["fetch", "--quiet", "--no-tags", remote, `+${localRef}:${remoteRef}`]);
  const remoteTip = tryGit(top, ["rev-parse", "--verify", "--quiet", `${remoteRef}^{commit}`]);
  const localTip = tryGit(top, ["rev-parse", "--verify", "--quiet", `${localRef}^{commit}`]);
  if (remoteTip && localTip && !isAncestor(top, localTip, remoteTip) && !isAncestor(top, remoteTip, localTip)) {
    throw new ComposeError(
      "compose-branch-diverged",
      `${branch} here and on ${remote} have diverged, and a compose only appends`,
      `Keep the remote's: git branch -f ${branch} ${remote}/${branch}`,
    );
  }
  const from = remoteTip && localTip ? (isAncestor(top, localTip, remoteTip) ? remoteTip : localTip) : (remoteTip ?? localTip);
  const trunkRef =
    tryGit(top, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${req.trunk.branch}^{commit}`]) ??
    tryGit(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${req.trunk.branch}^{commit}`]);
  if (!trunkRef) throw new ComposeError("compose-source-unknown", `this clone has neither ${remote}/${req.trunk.branch} nor ${req.trunk.branch}, so there is no trunk to pick from`);
  // What the branch carries: back to trunk, past a commit a person made on it, such as a resolved conflict.
  const existing = from ? compositionOnTrunk(top, from, trunkRef, branch) : null;

  let base: string;
  if (from) {
    base = existing?.base ?? from;
    if (req.base !== undefined) {
      const asked = await resolveBase(top, req.cwd, req.base);
      if (asked !== base) {
        throw new ComposeError(
          "compose-base-differs",
          `${branch} is composed on ${base.slice(0, 12)}, and --base names ${asked.slice(0, 12)}; a compose only appends to its branch`,
          `Drop --base to add to ${branch}, or compose under another name.`,
        );
      }
    }
  } else {
    if (req.base === undefined) throw new ComposeError("compose-base-unknown", `${branch} does not exist yet, so the compose needs --base`, "Name the release or commit to compose on: --base <label|sha>");
    base = await resolveBase(top, req.cwd, req.base);
  }

  // Trunk's first-parent commits after the base, oldest first.
  const line = (tryGit(top, ["rev-list", "--first-parent", "--reverse", trunkRef, `^${base}`]) ?? "").split("\n").filter(Boolean);
  const { commitDetails } = await import("../workspace/intent");
  const { recordTrailers } = await import("../workspace/release-candidates");
  const details = commitDetails(top, line);

  const chosen = new Map<string, ComposeSource>();
  const choose = (sha: string, by: string, pr: number | null, work: string[]) => {
    const entry = chosen.get(sha) ?? { commit: sha, subject: details.get(sha)?.subject ?? "", pr, work, chosenBy: [] };
    if (!entry.chosenBy.includes(by)) entry.chosenBy.push(by);
    chosen.set(sha, entry);
  };
  const unmatched = new Set<string>([...req.prs.map((n) => `--pr ${n}`), ...req.works.map((w) => `--work ${w}`)]);
  for (const sha of line) {
    const d = details.get(sha);
    const merge = fromMergeRecord(await mergeRecordOf(req.cwd, sha));
    const subjectPr = PR_IN_SUBJECT.exec(d?.subject ?? "");
    const pr = merge.pr ?? (subjectPr ? Number(subjectPr[1]) : null);
    const work = [...new Set([...recordTrailers(d?.trailers ?? {}).work, ...merge.work])];
    for (const n of req.prs) {
      if (pr === n) {
        choose(sha, `--pr ${n}`, pr, work);
        unmatched.delete(`--pr ${n}`);
      }
    }
    for (const w of req.works) {
      if (work.includes(w)) {
        choose(sha, `--work ${w}`, pr, work);
        unmatched.delete(`--work ${w}`);
      }
    }
  }
  if (unmatched.size > 0) {
    throw new ComposeError(
      "compose-source-unknown",
      `${[...unmatched].join(", ")} names no commit on ${remote}/${req.trunk.branch} after ${base.slice(0, 12)}`,
      "A pull request is found by its merge record or its squash subject (#n), and a work item by a Chant-Record: work:<id> trailer. Fetch trunk and chant/lifecycle if it merged elsewhere.",
    );
  }

  // Trunk order, and what the branch already carries.
  const carried = new Set(existing?.sources ?? []);
  const ordered = line.filter((sha) => chosen.has(sha)).map((sha) => chosen.get(sha)!);
  const already = ordered.filter((s) => carried.has(s.commit));
  const picked = ordered.filter((s) => !carried.has(s.commit));

  const tip = picked.length === 0 ? (from ?? base) : pickOnto(top, from ?? base, picked);
  let written = false;
  let pushed = false;
  if (req.yes && picked.length > 0) {
    git(top, ["update-ref", "-m", `chant release compose ${req.name}`, localRef, tip, localTip ?? ""]);
    written = true;
  }
  if (req.yes && (req.push ?? true) && tryGit(top, ["remote", "get-url", remote]) !== null && tip !== remoteTip) {
    try {
      git(top, ["push", "--quiet", remote, `${tip}:${localRef}`]);
      tryGit(top, ["update-ref", remoteRef, tip]);
      pushed = true;
    } catch (err) {
      const stderr = (err as { stderr?: Buffer | string }).stderr?.toString().trim() ?? String(err);
      throw new ComposeError("compose-push-refused", `${branch} was composed here at ${tip.slice(0, 12)} and ${remote} refused the push: ${stderr}`, `Push it by hand once the remote allows it: git push ${remote} ${branch}`);
    }
  }
  return { name: req.name, branch, base, from, picked, already, tip, written, pushed };
}

/**
 * Cherry-pick `sources` in order onto `start` in a temporary detached
 * worktree, each with its trailer, and return the last commit. Throws
 * `compose-conflict` naming the change and its files when one does not
 * apply. The worktree is removed either way.
 */
function pickOnto(top: string, start: string, sources: readonly ComposeSource[]): string {
  const realTop = realpathSync(top);
  const dir = mkdtempSync(join(tmpdir(), "chant-compose-"));
  git(realTop, ["worktree", "add", "--detach", "--quiet", dir, start]);
  try {
    for (const s of sources) {
      const parents = (tryGit(dir, ["rev-list", "--parents", "-n", "1", s.commit]) ?? "").split(" ").length - 1;
      const args = ["cherry-pick", "--allow-empty", "--keep-redundant-commits", ...(parents > 1 ? ["-m", "1"] : []), s.commit];
      const run = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
      if (run.status !== 0) {
        const files = (tryGit(dir, ["diff", "--name-only", "--diff-filter=U"]) ?? "").split("\n").filter(Boolean);
        tryGit(dir, ["cherry-pick", "--abort"]);
        const what = [s.pr !== null ? `#${s.pr}` : null, ...s.work.map((w) => `work:${w}`)].filter(Boolean).join(", ");
        throw new ComposeError(
          "compose-conflict",
          `${s.commit.slice(0, 12)} (${s.subject}${what ? `; ${what}` : ""}) does not apply on the composed commits${files.length > 0 ? `: it conflicts in ${files.join(", ")}` : `: ${(run.stderr || run.stdout).trim()}`}. Nothing was written`,
          "Resolve it by hand in a pull request to the compose branch, or compose without that change.",
          { commit: s.commit, subject: s.subject, files },
        );
      }
      git(dir, ["commit", "--quiet", "--amend", "--no-edit", "--allow-empty", "--no-verify", "--trailer", `${COMPOSED_FROM_TRAILER}: ${s.commit}`]);
    }
    return git(dir, ["rev-parse", "HEAD"]);
  } finally {
    try {
      git(realTop, ["worktree", "remove", "--force", dir]);
    } catch {
      rmSync(dir, { recursive: true, force: true });
      tryGit(realTop, ["worktree", "prune"]);
    }
  }
}
