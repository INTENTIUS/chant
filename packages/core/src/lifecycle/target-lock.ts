/**
 * Target locks (#4293): a pull request holds a lock on each target its
 * change reaches, so no other pull request applies or locks those targets
 * until it merges or closes, or someone runs `chant unlock` on it.
 *
 * A target is a name the caller picks: a component, a workspace member, or
 * a lexicon's own unit such as a Terraform root. The locks of one gate live
 * in one file, `_locks/<gate>.json` on `chant/lifecycle`, under the member's
 * ledger prefix in a workspace member (./git.ts `ledgerDir`). The gate is
 * the pull-request loop's, `pr-apply` unless the pipeline names another, so
 * two pipelines with their own gates keep their own locks.
 *
 * Every change is a new commit on the branch, written with the read-then-CAS
 * the other ledgers use and then pushed. A lock counts only once the remote
 * has it: when the push is refused because another writer moved the branch,
 * the local commit is dropped, the branch is read again and the decision is
 * made again. So two jobs that lock the same target at once cannot both win.
 * A repository with no remote is one machine, and the local write decides.
 *
 * A lock held by a pull request that is no longer open is released: the
 * holder merged or closed. The caller says which pull requests are open
 * (`isOpen`, from the forge). Without it every lock counts as held, and only
 * `chant unlock` releases one.
 *
 * The file is coordination, not a record of work. ws-074 holds: the
 * repository is the database, and the file is one more ledger on the
 * branch, so any clone can read who holds what.
 */
import { getRuntime } from "../runtime-adapter";
import {
  fetchLifecycleStatus,
  pushLifecycleStatus,
  readBlobBySha,
  readPathSha,
  RefCASConflictError,
  writeBlobToPath,
} from "./git";
import { lockRowsConflict } from "./lock-rows";
import { resolveMemberLedger } from "./member-ledger";

/** The directory on `chant/lifecycle` that holds the lock files. */
export const LOCKS_DIR = "_locks";

const STATE_BRANCH = "chant/lifecycle";
/** A scratch ref this module owns, for reading the remote tip after a refused push. */
const PROBE_REF = "refs/chant/target-lock-probe";
const ATTEMPTS = 5;

/**
 * How a lock was taken. `plan`: the pull request's plan took it (`ci.locks:
 * plan`). `apply`: its apply took it. `lock`: someone ran `chant lock`.
 */
export type TargetLockStage = "plan" | "apply" | "lock";

export const TARGET_LOCK_STAGES = ["plan", "apply", "lock"] as const satisfies readonly TargetLockStage[];

/** One target's lock: the pull request that holds it, who took it, when, how, and the head it took it at. */
export interface TargetLock {
  pr: number;
  by: string;
  at: string;
  stage: TargetLockStage;
  /** The pull request's head commit when the lock was taken. Absent when the caller did not say. */
  head?: string;
}

/** `_locks/<gate>.json`. */
export interface TargetLockFile {
  version: 1;
  locks: Record<string, TargetLock>;
}

/** A lock another open pull request holds on a target the caller needs. */
export interface HeldTargetLock extends TargetLock {
  target: string;
}

/** Says whether pull request `pr` is still open. */
export type PullRequestOpen = (pr: number) => Promise<boolean>;

export interface TargetLockOptions {
  cwd?: string;
  /** Whether a holder is still open. Absent: every holder counts as open. */
  isOpen?: PullRequestOpen;
}

export type TakeTargetLocksResult =
  | {
      ok: true;
      /** The targets now locked, sorted. */
      taken: string[];
      /** Plan locks of the same pull request on targets it no longer reaches, released (`releaseStalePlan`). */
      released: string[];
      /** Locks of merged or closed pull requests that this write dropped. */
      expired: string[];
      /** Whether the remote has the write. False with no remote, or when recording is off. */
      pushed: boolean;
    }
  | { ok: false; held: HeldTargetLock[] };

/** The path of `gate`'s lock file on `chant/lifecycle`, under a member's prefix when it has one. */
export function targetLockPath(gate: string, memberPrefix = ""): string {
  return `${memberPrefix}${LOCKS_DIR}/${gate}.json`;
}

/** A gate name that is safe as a file name. */
export function targetLockGateProblem(gate: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(gate) ? null : `the gate name ${JSON.stringify(gate)} is not a lock file name: letters, digits, '.', '_' and '-', starting with a letter or digit`;
}

const isStage = (v: unknown): v is TargetLockStage => typeof v === "string" && (TARGET_LOCK_STAGES as readonly string[]).includes(v);

/** Parse a lock file. Anything that is not a version 1 file with a map of locks reads as no locks; a malformed entry is dropped. */
export function parseTargetLocks(text: string | null): TargetLockFile {
  if (!text) return { version: 1, locks: {} };
  try {
    const doc = JSON.parse(text) as { version?: unknown; locks?: unknown };
    if (doc?.version === 1 && doc.locks && typeof doc.locks === "object" && !Array.isArray(doc.locks)) {
      const locks: Record<string, TargetLock> = {};
      for (const [target, raw] of Object.entries(doc.locks as Record<string, Record<string, unknown>>)) {
        if (!raw || !Number.isInteger(raw.pr) || typeof raw.by !== "string" || typeof raw.at !== "string" || !isStage(raw.stage)) continue;
        locks[target] = { pr: raw.pr as number, by: raw.by, at: raw.at, stage: raw.stage, ...(typeof raw.head === "string" ? { head: raw.head } : {}) };
      }
      return { version: 1, locks };
    }
  } catch {
    // An unreadable file holds no locks.
  }
  return { version: 1, locks: {} };
}

/** The file's text: targets sorted, so two writes of the same locks are the same blob. */
export function renderTargetLocks(file: TargetLockFile): string {
  const locks = Object.fromEntries(Object.keys(file.locks).sort().map((t) => [t, file.locks[t]]));
  return `${JSON.stringify({ version: 1, locks }, null, 2)}\n`;
}

/**
 * Fetch `chant/lifecycle`, refusing a ledger this checkout cannot read: a
 * lock decided on a stale branch is no lock. The row leases of
 * ./resource-lock.ts (#4552) fetch through it too.
 */
export async function fetchForLocks(cwd?: string): Promise<void> {
  const fetched = await fetchLifecycleStatus({ cwd });
  if (fetched.status === "diverged") throw new Error(`the local ${STATE_BRANCH} has forked from ${fetched.remote}'s, so the locks cannot be read: ${fetched.stderr}`);
  if (fetched.status === "unreachable") throw new Error(`cannot fetch ${STATE_BRANCH} from ${fetched.remote}, so the locks cannot be read${fetched.stderr ? `: ${fetched.stderr}` : ""}`);
}

async function readCurrent(gate: string, cwd?: string): Promise<{ sha: string | null; file: TargetLockFile }> {
  const sha = await readPathSha(LOCKS_DIR, `${gate}.json`, { cwd });
  return { sha, file: parseTargetLocks(sha ? await readBlobBySha(sha, { cwd }) : null) };
}

/** The locks of `gate` as the remote holds them now, fetched first. */
export async function readTargetLocks(gate: string, opts: { cwd?: string } = {}): Promise<TargetLockFile> {
  const problem = targetLockGateProblem(gate);
  if (problem) throw new Error(problem);
  await fetchForLocks(opts.cwd);
  return (await readCurrent(gate, opts.cwd)).file;
}

/** A memo of `isOpen`, so one decision asks the forge about each pull request once. */
function openMemo(isOpen?: PullRequestOpen): PullRequestOpen {
  const seen = new Map<number, Promise<boolean>>();
  return (pr) => {
    if (!isOpen) return Promise.resolve(true);
    if (!seen.has(pr)) seen.set(pr, isOpen(pr));
    return seen.get(pr)!;
  };
}

/**
 * The locks on `targets` that an open pull request other than `pr` holds, by
 * target. Under the resource grain (#4552, ruling C) a `stack` row and the
 * `urn` rows of that stack conflict, so a lock on either holds the other.
 */
async function heldIn(file: TargetLockFile, targets: readonly string[], pr: number | null, open: PullRequestOpen): Promise<HeldTargetLock[]> {
  const held: HeldTargetLock[] = [];
  const seen = new Set<string>();
  for (const wanted of [...new Set(targets)].sort()) {
    for (const [target, l] of Object.entries(file.locks)) {
      if (seen.has(target) || !lockRowsConflict(wanted, target)) continue;
      if (l.pr !== pr && (await open(l.pr))) {
        seen.add(target);
        held.push({ target, ...l });
      }
    }
  }
  return held.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
}

/**
 * The locks on `targets` that an open pull request other than `pr` holds.
 * Reads only: an apply calls this to refuse a target another pull request
 * holds. `pr` null (an apply of a green commit) counts every open holder.
 */
export async function heldTargetLocks(gate: string, targets: readonly string[], pr: number | null, opts: TargetLockOptions = {}): Promise<HeldTargetLock[]> {
  if (targets.length === 0) return [];
  const file = await readTargetLocks(gate, opts);
  return heldIn(file, targets, pr, openMemo(opts.isOpen));
}

/** The local tip of `chant/lifecycle`, or "" when there is none. */
export async function localTip(cwd?: string): Promise<string> {
  const out = await getRuntime().spawn(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${STATE_BRANCH}`], { cwd });
  return out.exitCode === 0 ? out.stdout.trim() : "";
}

/**
 * After a refused push: drop the lock commit `ours` from the local branch by
 * moving it to the remote's tip, so the next attempt reads what the other
 * writer pushed. Done only when `parent`, the tip before the write, is in
 * the remote's history, so no other local commit is lost. Throws otherwise.
 */
export async function dropRefusedWrite(remote: string, ours: string, parent: string, cwd?: string): Promise<void> {
  const rt = getRuntime();
  const env = { LC_ALL: "C", LANGUAGE: "" };
  const probe = await rt.spawn(["git", "fetch", "--force", remote, `${STATE_BRANCH}:${PROBE_REF}`], { cwd, env });
  if (probe.exitCode !== 0) throw new Error(`the push of the locks was refused and ${STATE_BRANCH} could not be read again from ${remote}: ${probe.stderr.trim()}`);
  try {
    if (parent) {
      const contains = await rt.spawn(["git", "merge-base", "--is-ancestor", parent, PROBE_REF], { cwd, env });
      if (contains.exitCode !== 0) throw new Error(`the push of the locks was refused, and the local ${STATE_BRANCH} holds commits ${remote} does not; push or fetch ${STATE_BRANCH} and lock again`);
    }
    const tip = (await rt.spawn(["git", "rev-parse", "--verify", PROBE_REF], { cwd, env })).stdout.trim();
    const moved = await rt.spawn(["git", "update-ref", `refs/heads/${STATE_BRANCH}`, tip, ours], { cwd, env });
    if (moved.exitCode !== 0) throw new Error(`could not drop the refused lock commit from ${STATE_BRANCH}: ${moved.stderr.trim()}`);
    await rt.spawn(["git", "update-ref", `refs/remotes/${remote}/${STATE_BRANCH}`, tip], { cwd, env });
  } finally {
    await rt.spawn(["git", "update-ref", "-d", PROBE_REF], { cwd, env });
  }
}

/**
 * Write `next` over the file read at `sha`, then push. Returns null when the
 * branch moved under the write (locally or on the remote), so the caller
 * reads and decides again.
 */
async function writeAndPush(gate: string, sha: string | null, next: TargetLockFile, message: string, cwd?: string): Promise<{ pushed: boolean } | null> {
  const parent = await localTip(cwd);
  let commit: string;
  try {
    commit = await writeBlobToPath(LOCKS_DIR, `${gate}.json`, renderTargetLocks(next), message, { cwd, expectPriorPathSha: sha });
  } catch (err) {
    if (err instanceof RefCASConflictError) return null;
    throw err;
  }
  const push = await pushLifecycleStatus({ cwd });
  switch (push.status) {
    case "pushed":
      return { pushed: true };
    case "no-remote":
    case "not-recorded":
      return { pushed: false };
    case "stale":
      await dropRefusedWrite(push.remote, commit, parent, cwd);
      await fetchForLocks(cwd);
      return null;
    case "failed":
      throw new Error(`the locks were written but the push of ${STATE_BRANCH} to ${push.remote} failed, so they do not count yet: ${push.stderr}`);
  }
}

/**
 * Lock `targets` for pull request `holder.pr`. A target locked by another
 * pull request that is still open is held, and nothing is locked. A target
 * locked by one that merged or closed is taken over, and its lock dropped.
 * Targets this pull request already holds stay its own, with the new head.
 * An apply or a `chant lock` takes over the pull request's own plan locks;
 * a plan keeps its own apply and `chant lock` locks as they are. With
 * `releaseStalePlan`, the pull request's plan locks on targets it no longer
 * reaches are released.
 */
export async function takeTargetLocks(
  gate: string,
  targets: readonly string[],
  holder: TargetLock,
  opts: TargetLockOptions & { releaseStalePlan?: boolean } = {},
): Promise<TakeTargetLocksResult> {
  const problem = targetLockGateProblem(gate);
  if (problem) throw new Error(problem);
  for (const t of targets) if (t.trim() === "") throw new Error("a lock target is a non-empty name");
  const wanted = [...new Set(targets)].sort();
  const open = openMemo(opts.isOpen);
  await fetchForLocks(opts.cwd);
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const { sha, file } = await readCurrent(gate, opts.cwd);
    const held = await heldIn(file, wanted, holder.pr, open);
    if (held.length > 0) return { ok: false, held };

    const next: TargetLockFile = { version: 1, locks: {} };
    const released: string[] = [];
    const expired: string[] = [];
    for (const [target, l] of Object.entries(file.locks)) {
      if (l.pr === holder.pr) {
        if (opts.releaseStalePlan && l.stage === "plan" && !wanted.includes(target)) {
          released.push(target);
          continue;
        }
      } else if (opts.isOpen && !(await open(l.pr))) {
        expired.push(target);
        continue;
      }
      next.locks[target] = l;
    }
    for (const target of wanted) {
      const own = file.locks[target];
      next.locks[target] = holder.stage === "plan" && own?.pr === holder.pr && own.stage !== "plan" ? own : holder;
    }
    const done = { ok: true as const, taken: wanted, released: released.sort(), expired: expired.sort() };
    if (renderTargetLocks(next) === renderTargetLocks(file) && sha !== null) return { ...done, pushed: false };
    if (wanted.length === 0 && released.length === 0 && expired.length === 0) return { ...done, pushed: false };
    const wrote = await writeAndPush(gate, sha, next, `Lock ${wanted.length} target${wanted.length === 1 ? "" : "s"} of ${gate} for pull request ${holder.pr} (${holder.stage})`, opts.cwd);
    if (wrote) return { ...done, pushed: wrote.pushed };
  }
  throw new Error(`could not write the locks of ${gate}: ${STATE_BRANCH} kept moving; lock again`);
}

/**
 * Release the locks pull request `pr` holds on `gate`: every one, or only
 * those on `targets`. Returns the targets released, sorted.
 */
export async function releaseTargetLocks(
  gate: string,
  pr: number,
  opts: { cwd?: string; targets?: readonly string[] } = {},
): Promise<{ released: string[]; pushed: boolean }> {
  const problem = targetLockGateProblem(gate);
  if (problem) throw new Error(problem);
  await fetchForLocks(opts.cwd);
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const { sha, file } = await readCurrent(gate, opts.cwd);
    const mine = Object.keys(file.locks)
      .filter((t) => file.locks[t].pr === pr && (!opts.targets || opts.targets.includes(t)))
      .sort();
    if (mine.length === 0) return { released: [], pushed: false };
    const next: TargetLockFile = { version: 1, locks: Object.fromEntries(Object.entries(file.locks).filter(([t]) => !mine.includes(t))) };
    const wrote = await writeAndPush(gate, sha, next, `Unlock ${mine.length} target${mine.length === 1 ? "" : "s"} of ${gate} held by pull request ${pr}`, opts.cwd);
    if (wrote) return { released: mine, pushed: wrote.pushed };
  }
  throw new Error(`could not write the locks of ${gate}: ${STATE_BRANCH} kept moving; unlock again`);
}

/** The lock file's path for the project at `cwd`, for messages. */
export async function targetLockPathAt(gate: string, cwd?: string): Promise<string> {
  const { prefix } = await resolveMemberLedger(cwd ?? process.cwd());
  return targetLockPath(gate, prefix);
}

const STAGE_WORDS: Record<TargetLockStage, string> = { plan: "planned", apply: "applied", lock: "locked with chant lock" };

/**
 * One line naming the targets others hold, for a refusal or a note.
 * `name` says how the forge names a holder (GitLab: `merge request !7`).
 */
export function describeHeldTargetLocks(held: readonly HeldTargetLock[], name: (pr: number) => string = (pr) => `pull request ${pr}`): string {
  const byPr = new Map<number, HeldTargetLock[]>();
  for (const h of held) byPr.set(h.pr, [...(byPr.get(h.pr) ?? []), h]);
  return [...byPr]
    .map(([pr, hs]) => `${hs.map((h) => h.target).join(", ")} ${hs.length === 1 ? "is" : "are"} locked by ${name(pr)} (${STAGE_WORDS[hs[0].stage]} by ${hs[0].by})`)
    .join("; ");
}
