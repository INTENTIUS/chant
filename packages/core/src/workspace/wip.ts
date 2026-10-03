/**
 * Work in progress that survives the box (#3172, ws-085).
 *
 * ws-074 keeps work in progress as uncommitted files in a work branch's
 * working tree, and #3147 keeps an unfinished attempt under a local ref. On a
 * box (a sprite, a fountain sandbox) both sit on one disk until someone
 * commits and pushes. This module owns one ref namespace for that work and
 * replicates it under the policy a box block declares:
 *
 *   refs/chant/wip/<branch>   a chain of snapshots of the checkout on <branch>
 *
 * A snapshot is a commit whose tree is the whole working tree, staged,
 * unstaged and untracked files alike (ignored files left out), taken through
 * a temporary index so the checkout's own index is never touched. Its first
 * parent is the snapshot before it on the same ref, when there is one, and
 * its last parent is the commit `HEAD` named, so pushing the ref carries the
 * branch's commits too. Its message carries `Chant-Wip-*` trailers: the
 * branch, the head, the caller's label (hud's turn, studio's checkpoint), who
 * took it, and whether it was a save or the checkpoint a restore takes first.
 * The ref's first-parent chain is the branch's checkpoint history, newest
 * first. The branch name already separates worktrees and tabs, since a
 * branch is checked out in one worktree at a time; who took a snapshot is a
 * trailer, not a path segment.
 *
 * Replication pushes the refs a policy names (work branches, kept attempts,
 * the snapshots and the ledger branch) to a git remote under their own names,
 * never forced, and records what reached the remote under
 * `refs/chant/replica/<remote>/<ref without refs/>`, so `status` and `wip`
 * report how far each ref is from the remote without fetching. `wip fetch`
 * on a replacement box mirrors the remote into that namespace and creates or
 * fast-forwards the local refs; `wip restore` then puts the working tree back
 * exactly as it was saved.
 *
 * chant's record writes never run git (ws-074), so nothing here runs on a
 * record write. A snapshot is taken when a caller asks (`wip save`), and
 * chant pushes on its own only after a save or a work lease release, as the
 * policy says.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { KEPT_REF_PREFIX } from "../lifecycle/work-lease";
import { readDeclaration, readerVersion, WORKSPACE_ERROR_CODES, WorkspaceReadError, type BoxReplicate, type ReplicateRefClass, type ReplicateTrigger } from "./declaration";
import { IDENTITY_CODES, IdentityError, refuseUnidentified } from "./identity";
import type { ReasonCode } from "./reason-codes";
import { gitTop } from "./tree";
import { locateWorkspace } from "./which-chant";
import { scopeSource } from "./write-scope";

/** Where a branch's work-in-progress snapshots live. */
export const WIP_REF_PREFIX = "refs/chant/wip/";
/** Where chant records what reached each remote: `refs/chant/replica/<remote>/<ref without refs/>`. */
export const REPLICA_REF_PREFIX = "refs/chant/replica/";
/** The work branches a lease's run works on (`chant/work/[<member>/]<item>`). */
export const WORK_BRANCH_REF_PREFIX = "refs/heads/chant/work/";
/** The ledger branch. */
export const LEDGER_REF = "refs/heads/chant/lifecycle";

/** The version of the documents `wip` and its writes print. */
export const WIP_CONTRACT_VERSION = 1;
export const WIP_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/wip/v1/wip.schema.json";
export const WIP_WRITE_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/wip-write/v1/wip-write.schema.json";

/** Why `wip` could not read. Closed. */
export const WIP_ERROR_CODES = [...WORKSPACE_ERROR_CODES] as const satisfies readonly ReasonCode[];
export type WipErrorCode = (typeof WIP_ERROR_CODES)[number];

/** Why a `wip save|restore|push|fetch` wrote nothing. Closed. */
export const WIP_WRITE_ERROR_CODES = [
  ...WORKSPACE_ERROR_CODES,
  "write-usage-invalid",
  "wip-no-branch",
  "wip-none",
  "wip-snapshot-unknown",
  "wip-branch-other",
  "wip-race",
  "wip-policy-none",
  "wip-remote-unknown",
  ...IDENTITY_CODES,
] as const satisfies readonly ReasonCode[];
export type WipWriteErrorCode = (typeof WIP_WRITE_ERROR_CODES)[number];

/** What a snapshot was taken for: a caller's save, or the checkpoint a restore takes before it changes the working tree. */
export type WipSnapshotKind = "save" | "pre-restore";

/** One snapshot of a branch's working tree. */
export interface WipSnapshot {
  commit: string;
  /** The tree of the working tree as it was. */
  tree: string;
  /** The branch it was taken on. */
  branch: string;
  /** The commit `HEAD` named when it was taken. */
  head: string;
  kind: WipSnapshotKind;
  /** What the caller called it, such as a turn id, or null. */
  label: string | null;
  /** Who took it, as the caller named them, or null. */
  by: string | null;
  /** When it was taken, ISO 8601. */
  at: string;
}

/** A replicate policy as the read contract prints it: the box that declares it and its fields, defaults filled in. */
export interface ReplicatePolicyView {
  box: string;
  remote: string;
  refs: ReplicateRefClass[];
  on: ReplicateTrigger[];
  every: string | null;
}

/** One ref a policy replicates and where it stands against the remote. */
export interface ReplicaRefState {
  ref: string;
  class: ReplicateRefClass;
  commit: string;
  /** What the remote held at the last push or fetch through chant (or, for a branch, git's remote-tracking ref), or null when unknown. */
  replica: string | null;
  replicated: boolean;
  /** Commits reachable from `commit` that nothing known to be on the remote reaches: 0 when replicated. */
  ahead: number;
}

/** Where every replicated ref stands (#3172). Read locally; never fetches. */
export interface ReplicationState {
  policy: ReplicatePolicyView;
  /** Whether the checkout has a git remote of the policy's name. */
  remoteConfigured: boolean;
  /** True when every ref the policy names is on the remote as it is locally. */
  replicated: boolean;
  refs: ReplicaRefState[];
}

/** One ref a push or fetch moved, or could not. */
export interface RefPush {
  ref: string;
  commit: string;
  /** Why the remote refused it or could not be reached; absent when it went. */
  reason?: string;
}

/** What one push did. */
export interface ReplicationPush {
  remote: string;
  pushed: RefPush[];
  rejected: RefPush[];
  /** Refs that were already on the remote as they are locally. */
  upToDate: number;
}

type Head = { $schema: string; contract: number; chant: string };

/** What `chant workspace wip --json` prints. */
export type WipDocument =
  | (Head & {
      checkout: { branch: string | null; head: string | null };
      branches: { branch: string; ref: string; tip: string; snapshots: WipSnapshot[] }[];
      replication: ReplicationState | null;
    })
  | (Head & { error: { code: WipErrorCode; message: string } });

export type WipAction = "save" | "restore" | "push" | "fetch";

/** One ref `wip fetch` looked at, and what it did with the local ref. */
export interface FetchedRef {
  ref: string;
  class: ReplicateRefClass;
  /** What the remote has. */
  remote: string;
  /** The local ref before the fetch, or null when there was none. */
  local: string | null;
  result: "created" | "fast-forward" | "up-to-date" | "ahead" | "diverged" | "checked-out";
}

/** What `chant workspace wip save|restore|push|fetch` prints. */
export type WipWriteDocument =
  | (Head & { action: "save"; branch: string; ref: string; created: boolean; snapshot: WipSnapshot; replication: ReplicationPush | null })
  | (Head & {
      action: "restore";
      branch: string;
      ref: string;
      head: string;
      snapshot: WipSnapshot;
      checkpoint: { created: boolean; snapshot: WipSnapshot };
      headMoved: boolean;
      paths: string[];
    })
  | (Head & { action: "push"; policy: ReplicatePolicyView; replication: ReplicationPush })
  | (Head & { action: "fetch"; policy: ReplicatePolicyView; refs: FetchedRef[]; failed: string | null })
  | (Head & { action: WipAction | null; error: { code: WipWriteErrorCode; message: string } });

class WipError extends Error {
  constructor(
    readonly code: WipWriteErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ── git ──────────────────────────────────────────────────────────────────────

interface GitRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** How long a push or fetch may take before chant gives up on the remote. */
const NETWORK_TIMEOUT_MS = 120_000;

function git(top: string, args: readonly string[], opts: { env?: Record<string, string>; input?: string; timeout?: number } = {}): GitRun {
  const r = spawnSync("git", ["--no-optional-locks", ...args], {
    cwd: top,
    encoding: "utf-8",
    input: opts.input,
    // Never wait on a person: a remote that wants a password is a refused push.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
    maxBuffer: 256 * 1024 * 1024,
    timeout: opts.timeout,
  });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? r.error.message : "") };
}

function out(top: string, args: readonly string[]): string | null {
  const r = git(top, args);
  return r.ok ? r.stdout.trim() : null;
}

/** The checkout's branch and head, or a refusal when there is no branch with a commit to keep work for. */
function checkoutOf(top: string): { branch: string; head: string } {
  const branch = out(top, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const head = out(top, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!branch) throw new WipError("wip-no-branch", "HEAD is detached, so there is no branch to keep work in progress for; check out the work branch first");
  if (!head) throw new WipError("wip-no-branch", `branch ${branch} has no commit yet, so there is nothing to keep work in progress against; commit once first`);
  return { branch, head };
}

/** The ref a branch's snapshots live on. */
export function wipRef(branch: string): string {
  return `${WIP_REF_PREFIX}${branch}`;
}

/** The ref recording what `remote` holds of `ref`. */
export function replicaRef(remote: string, ref: string): string {
  return `${REPLICA_REF_PREFIX}${remote}/${ref.slice("refs/".length)}`;
}

/** The class a ref belongs to, or null when no policy replicates it. */
export function refClass(ref: string): ReplicateRefClass | null {
  if (ref.startsWith(WORK_BRANCH_REF_PREFIX)) return "work";
  if (ref.startsWith(KEPT_REF_PREFIX)) return "kept";
  if (ref.startsWith(WIP_REF_PREFIX)) return "wip";
  if (ref === LEDGER_REF) return "ledger";
  return null;
}

/** Every local ref of the given classes and its commit, sorted by ref. */
function localRefs(top: string, classes: readonly ReplicateRefClass[]): { ref: string; class: ReplicateRefClass; commit: string }[] {
  const patterns = classes.map((c) => (c === "work" ? WORK_BRANCH_REF_PREFIX : c === "kept" ? KEPT_REF_PREFIX : c === "wip" ? WIP_REF_PREFIX : LEDGER_REF));
  if (patterns.length === 0) return [];
  const text = out(top, ["for-each-ref", "--format=%(refname) %(objectname)", ...patterns]) ?? "";
  const refs: { ref: string; class: ReplicateRefClass; commit: string }[] = [];
  for (const line of text.split("\n")) {
    const [ref, commit] = line.split(" ");
    const c = ref ? refClass(ref) : null;
    if (c && classes.includes(c) && commit) refs.push({ ref, class: c, commit });
  }
  return refs.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

/** Every ref under `prefixes` and its commit. */
function refMap(top: string, prefixes: readonly string[]): Map<string, string> {
  const text = out(top, ["for-each-ref", "--format=%(refname) %(objectname)", ...prefixes]) ?? "";
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const [ref, commit] = line.split(" ");
    if (ref && commit) map.set(ref, commit);
  }
  return map;
}

// ── snapshots ────────────────────────────────────────────────────────────────

const TRAILER = /^Chant-Wip-([A-Za-z]+): (.*)$/;

/** A snapshot from a commit's id, tree, committer time and message, or null when the commit is not one. */
function parseSnapshot(commit: string, tree: string, time: string, message: string): WipSnapshot | null {
  const t: Record<string, string> = {};
  for (const line of message.split("\n")) {
    const m = TRAILER.exec(line);
    if (m) t[m[1].toLowerCase()] = m[2];
  }
  if (!t.branch || !t.head) return null;
  return {
    commit,
    tree,
    branch: t.branch,
    head: t.head,
    kind: t.kind === "pre-restore" ? "pre-restore" : "save",
    label: t.label ?? null,
    by: t.by ?? null,
    at: new Date(Number(time) * 1000).toISOString(),
  };
}

const FIELD = "\x1f";
const RECORD = "\x1e";

/**
 * The snapshots on `ref`, newest first: its first-parent chain, down to the
 * first commit that is not a snapshot (the branch commit the oldest was taken
 * on). History the branch itself reaches is never walked.
 */
export function listSnapshots(top: string, ref: string, branch: string): WipSnapshot[] {
  const tip = out(top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!tip) return [];
  const branchRef = `refs/heads/${branch}`;
  const stop = out(top, ["rev-parse", "--verify", "--quiet", `${branchRef}^{commit}`]) ? [`^${branchRef}`] : [];
  const r = git(top, ["log", "--first-parent", "-n", "10000", `--format=%H${FIELD}%T${FIELD}%ct${FIELD}%B${RECORD}`, tip, ...stop, "--"]);
  if (!r.ok) return [];
  const snapshots: WipSnapshot[] = [];
  for (const rec of r.stdout.split(RECORD)) {
    const [commit, tree, time, message] = rec.replace(/^\n/, "").split(FIELD);
    if (!commit || !tree) continue;
    const s = parseSnapshot(commit, tree, time, message ?? "");
    if (!s) break;
    snapshots.push(s);
  }
  return snapshots;
}

/** The snapshot `rev` names, or null when it is not a commit or not a snapshot. */
function readSnapshot(top: string, rev: string): WipSnapshot | null {
  const r = git(top, ["log", "-n", "1", `--format=%H${FIELD}%T${FIELD}%ct${FIELD}%B`, `${rev}^{commit}`, "--"]);
  if (!r.ok) return null;
  const [commit, tree, time, message] = r.stdout.split(FIELD);
  return commit && tree ? parseSnapshot(commit, tree, time, message ?? "") : null;
}

/** The tree of the whole working tree, staged, unstaged and untracked alike, written through a temporary index. */
function worktreeTree(top: string): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-wip-"));
  try {
    const index = join(dir, "index");
    // Start from the checkout's index so git reuses its stat data; the original is never written.
    const own = out(top, ["rev-parse", "--git-path", "index"]);
    if (own && existsSync(resolve(top, own))) copyFileSync(resolve(top, own), index);
    const env = { GIT_INDEX_FILE: index };
    const add = git(top, ["add", "--all", "--", ":/"], { env });
    if (!add.ok) throw new Error(`wip: git add into a temporary index failed: ${add.stderr.trim()}`);
    const tree = git(top, ["write-tree"], { env });
    if (!tree.ok) throw new Error(`wip: git write-tree failed: ${tree.stderr.trim()}`);
    return tree.stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A label or principal as a trailer value takes it: one line, no control characters. */
function trailerValue(value: string | undefined, flag: string): string | null {
  if (value === undefined) return null;
  // eslint-disable-next-line no-control-regex
  if (value === "" || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new WipError("write-usage-invalid", `${flag} is one line of at most 200 characters, with no control characters`);
  }
  return value;
}

interface Snapshotted {
  created: boolean;
  snapshot: WipSnapshot;
}

/** Take a snapshot of the checkout on `branch` at `head`, or return the tip when it already holds exactly this. */
function snapshot(top: string, branch: string, head: string, meta: { kind: WipSnapshotKind; label: string | null; by: string | null }): Snapshotted {
  const ref = wipRef(branch);
  const tree = worktreeTree(top);
  const previous = out(top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const prev = previous ? readSnapshot(top, previous) : null;
  if (prev && prev.tree === tree && prev.head === head && prev.label === meta.label && prev.by === meta.by && prev.kind === meta.kind) {
    return { created: false, snapshot: prev };
  }
  // A pre-restore checkpoint of a tree the tip already holds adds nothing to restore from.
  if (prev && meta.kind === "pre-restore" && prev.tree === tree && prev.head === head) return { created: false, snapshot: prev };
  const lines = [
    `chant wip: ${branch}${meta.label ? ` (${meta.label})` : ""}`,
    "",
    `Chant-Wip-Branch: ${branch}`,
    `Chant-Wip-Head: ${head}`,
    `Chant-Wip-Kind: ${meta.kind}`,
    ...(meta.label ? [`Chant-Wip-Label: ${meta.label}`] : []),
    ...(meta.by ? [`Chant-Wip-By: ${meta.by}`] : []),
    "",
  ];
  // An identity only when git has none, so a configured one is kept.
  const ident = git(top, ["var", "GIT_COMMITTER_IDENT"]).ok && git(top, ["var", "GIT_AUTHOR_IDENT"]).ok;
  const who = ident ? [] : ["-c", "user.name=chant", "-c", "user.email=chant@localhost"];
  const parents = prev ? ["-p", prev.commit, "-p", head] : ["-p", head];
  const made = git(top, [...who, "commit-tree", "--no-gpg-sign", tree, ...parents, "-F", "-"], { input: lines.join("\n") });
  if (!made.ok) throw new Error(`wip: git commit-tree failed: ${made.stderr.trim()}`);
  const commit = made.stdout.trim();
  const moved = git(top, ["update-ref", "-m", `chant wip ${meta.kind}`, ref, commit, previous ?? ""]);
  if (!moved.ok) throw new WipError("wip-race", `another writer moved ${ref} while this snapshot was taken; take it again`);
  const s = readSnapshot(top, commit);
  if (!s) throw new Error(`wip: the snapshot ${commit} does not read back`);
  return { created: true, snapshot: s };
}

// ── the policy ───────────────────────────────────────────────────────────────

/** A box's replicate policy as the read contract prints it. */
export function policyView(box: string, r: BoxReplicate): ReplicatePolicyView {
  return { box, remote: r.remote, refs: [...r.refs], on: [...r.on], every: r.every };
}

/**
 * The replicate policy the declaration in the working tree states, or null
 * when no box block declares one or there is no declaration. A declaration
 * that can't be read throws its WorkspaceReadError.
 */
export function readReplicatePolicy(cwd: string): ReplicatePolicyView | null {
  let located;
  try {
    located = locateWorkspace(cwd);
  } catch (err) {
    if (err instanceof WorkspaceReadError && err.code === "declaration-missing") return null;
    throw err;
  }
  const declaration = readDeclaration(located.tree);
  const m = declaration.members.find((x) => x.box?.replicate);
  return m ? policyView(m.name, m.box!.replicate!) : null;
}

function remotes(top: string): string[] {
  return (out(top, ["remote"]) ?? "").split("\n").filter(Boolean);
}

/** Where every ref the policy names stands against its remote, read locally (#3172). */
export function replicationState(top: string, policy: ReplicatePolicyView): ReplicationState {
  const local = localRefs(top, policy.refs);
  const replicas = refMap(top, [`${REPLICA_REF_PREFIX}${policy.remote}/`, `refs/remotes/${policy.remote}/`]);
  const known = (ref: string): string | null =>
    replicas.get(replicaRef(policy.remote, ref)) ?? (ref.startsWith("refs/heads/") ? (replicas.get(`refs/remotes/${policy.remote}/${ref.slice("refs/heads/".length)}`) ?? null) : null);
  const refs = local.map(({ ref, class: c, commit }) => {
    const replica = known(ref);
    if (replica === commit) return { ref, class: c, commit, replica, replicated: true, ahead: 0 };
    const not = replicas.size > 0 ? ["--not", `--glob=${REPLICA_REF_PREFIX}${policy.remote}/*`, `--remotes=${policy.remote}`] : [];
    const n = Number(out(top, ["rev-list", "--count", commit, ...not, "--"]) ?? "0");
    return { ref, class: c, commit, replica, replicated: false, ahead: Number.isFinite(n) ? n : 0 };
  });
  return { policy, remoteConfigured: remotes(top).includes(policy.remote), replicated: refs.every((r) => r.replicated), refs };
}

/** Push every ref the policy names that the remote doesn't hold as it is locally. Never forced. */
export function pushReplicas(top: string, policy: ReplicatePolicyView): ReplicationPush {
  const state = replicationState(top, policy);
  const todo = state.refs.filter((r) => !r.replicated);
  const result: ReplicationPush = { remote: policy.remote, pushed: [], rejected: [], upToDate: state.refs.length - todo.length };
  if (todo.length === 0) return result;
  if (!state.remoteConfigured) {
    result.rejected = todo.map((r) => ({ ref: r.ref, commit: r.commit, reason: `this checkout has no git remote named ${policy.remote}` }));
    return result;
  }
  // A pre-push hook is the repository's gate for publishing work, not for keeping it safe.
  for (let i = 0; i < todo.length; i += 200) {
    const batch = todo.slice(i, i + 200);
    const r = git(top, ["push", "--porcelain", "--no-verify", policy.remote, ...batch.map((x) => `${x.ref}:${x.ref}`)], { timeout: NETWORK_TIMEOUT_MS });
    const status = new Map<string, { flag: string; summary: string }>();
    for (const line of r.stdout.split("\n")) {
      const m = /^(.)\t([^:]+):([^\t]+)\t(.*)$/.exec(line);
      if (m) status.set(m[3], { flag: m[1], summary: m[4] });
    }
    const failure = r.stderr.trim().split("\n").filter(Boolean).pop() ?? "the push failed";
    for (const x of batch) {
      const s = status.get(x.ref);
      if (s && s.flag !== "!") {
        git(top, ["update-ref", replicaRef(policy.remote, x.ref), x.commit]);
        if (s.flag === "=") result.upToDate++;
        else result.pushed.push({ ref: x.ref, commit: x.commit });
      } else {
        result.rejected.push({ ref: x.ref, commit: x.commit, reason: s ? s.summary : failure });
      }
    }
  }
  return result;
}

/**
 * Push what the policy names after `event`, when the policy says chant pushes
 * then. Never throws: a box that can't reach its remote still saves and
 * releases, and `status` shows what is behind.
 */
export function replicateAfter(event: ReplicateTrigger, cwd: string): ReplicationPush | null {
  try {
    const policy = readReplicatePolicy(cwd);
    const top = gitTop(cwd);
    if (!policy || !top || !policy.on.includes(event)) return null;
    return pushReplicas(top, policy);
  } catch {
    return null;
  }
}

// ── the read ─────────────────────────────────────────────────────────────────

/** `chant workspace wip [--branch <branch>] --json`: every branch's snapshots, and where replication stands. */
export function workspaceWip(req: { cwd: string; branch?: string }): WipDocument {
  const head: Head = { $schema: WIP_SCHEMA_ID, contract: WIP_CONTRACT_VERSION, chant: readerVersion() };
  const top = gitTop(req.cwd);
  if (!top) return { ...head, error: { code: "not-a-git-repository", message: "work in progress is kept in git refs, and this directory is not in a git repository" } };
  let policy: ReplicatePolicyView | null;
  try {
    policy = readReplicatePolicy(req.cwd);
  } catch (err) {
    if (err instanceof WorkspaceReadError) return { ...head, error: { code: err.code as WipErrorCode, message: err.describe() } };
    throw err;
  }
  const branch = out(top, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const commit = out(top, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const branches = [...refMap(top, [WIP_REF_PREFIX])]
    .map(([ref, tip]) => ({ branch: ref.slice(WIP_REF_PREFIX.length), ref, tip }))
    .filter((b) => req.branch === undefined || b.branch === req.branch)
    .sort((a, b) => (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0))
    .map((b) => ({ ...b, snapshots: listSnapshots(top, b.ref, b.branch) }));
  return {
    ...head,
    checkout: { branch, head: commit },
    branches,
    replication: policy ? replicationState(top, policy) : null,
  };
}

// ── the writes ───────────────────────────────────────────────────────────────

function fail(action: WipAction | null, err: unknown): WipWriteDocument {
  const head: Head = { $schema: WIP_WRITE_SCHEMA_ID, contract: WIP_CONTRACT_VERSION, chant: readerVersion() };
  if (err instanceof WipError) return { ...head, action, error: { code: err.code, message: err.message } };
  if (err instanceof IdentityError) return { ...head, action, error: { code: err.code, message: err.message } };
  if (err instanceof WorkspaceReadError) return { ...head, action, error: { code: err.code as WipWriteErrorCode, message: err.describe() } };
  throw err;
}

function topOf(cwd: string): string {
  const top = gitTop(cwd);
  if (!top) throw new WorkspaceReadError("not-a-git-repository", "work in progress is kept in git refs, and this directory is not in a git repository");
  return top;
}

export interface WipSaveRequest {
  cwd: string;
  /** What the caller calls this snapshot, such as `turn:12` (`--label`). */
  label?: string;
  /** Who took it (`--by`), held to the identity rule at base (ws-080). */
  by?: string;
  /** The agent session (`CHANT_AGENT`). */
  agent?: string;
}

/** `chant workspace wip save`: snapshot the checkout's working tree onto `refs/chant/wip/<branch>`, then push when the policy says so. */
export function wipSave(req: WipSaveRequest): WipWriteDocument {
  try {
    const label = trailerValue(req.label, "--label");
    const by = trailerValue(req.by, "--by");
    const top = topOf(req.cwd);
    const policy = readReplicatePolicy(req.cwd);
    const { branch, head } = checkoutOf(top);
    if (by !== null) refuseUnidentified(scopeSource(req.cwd), [by], "--by", { agent: req.agent });
    const taken = snapshot(top, branch, head, { kind: "save", label, by });
    const replication = policy && policy.on.includes("save") ? pushReplicas(top, policy) : null;
    return {
      $schema: WIP_WRITE_SCHEMA_ID,
      contract: WIP_CONTRACT_VERSION,
      chant: readerVersion(),
      action: "save",
      branch,
      ref: wipRef(branch),
      created: taken.created,
      snapshot: taken.snapshot,
      replication,
    };
  } catch (err) {
    return fail("save", err);
  }
}

export interface WipRestoreRequest {
  cwd: string;
  /** The snapshot to restore, as a commit id or anything git resolves to one; the branch's latest when undefined. */
  snapshot?: string;
  by?: string;
  agent?: string;
}

/**
 * `chant workspace wip restore [<snapshot>]`: put the working tree back as
 * the snapshot holds it. It first takes a snapshot of the working tree as it
 * is (kind `pre-restore`), so a restore can itself be undone. The branch and
 * `HEAD` never move; the index is reset to `HEAD`, so everything restored
 * reads as uncommitted, staged or not (#3160 counts them alike). Ignored
 * files are left as they are.
 */
export function wipRestore(req: WipRestoreRequest): WipWriteDocument {
  try {
    const by = trailerValue(req.by, "--by");
    const top = topOf(req.cwd);
    const { branch, head } = checkoutOf(top);
    const ref = wipRef(branch);
    let target: WipSnapshot | null;
    if (req.snapshot === undefined) {
      target = readSnapshot(top, ref);
      if (!target) throw new WipError("wip-none", `branch ${branch} has no work-in-progress snapshot under ${ref}; chant workspace wip lists the ones there are` + "; wip fetch brings back one that was replicated");
    } else {
      target = readSnapshot(top, req.snapshot);
      if (!target) throw new WipError("wip-snapshot-unknown", `${req.snapshot} is not a work-in-progress snapshot chant took; chant workspace wip lists them`);
    }
    if (target.branch !== branch) {
      throw new WipError("wip-branch-other", `snapshot ${target.commit.slice(0, 12)} was taken on ${target.branch}, and the checkout is on ${branch}; check out ${target.branch} to restore it`);
    }
    if (by !== null) refuseUnidentified(scopeSource(req.cwd), [by], "--by", { agent: req.agent });
    const checkpoint = snapshot(top, branch, head, { kind: "pre-restore", label: `before ${target.commit.slice(0, 12)}`, by });
    const paths = restoreTree(top, checkpoint.snapshot.tree, target.tree);
    return {
      $schema: WIP_WRITE_SCHEMA_ID,
      contract: WIP_CONTRACT_VERSION,
      chant: readerVersion(),
      action: "restore",
      branch,
      ref,
      head,
      snapshot: target,
      checkpoint,
      headMoved: target.head !== head,
      paths,
    };
  } catch (err) {
    return fail("restore", err);
  }
}

/** Make the working tree, which holds `from`, hold `to`; reset the index to `HEAD`. Returns the paths changed, sorted. */
function restoreTree(top: string, from: string, to: string): string[] {
  const diff = git(top, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", from, to]);
  if (!diff.ok) throw new Error(`wip: git diff-tree failed: ${diff.stderr.trim()}`);
  const fields = diff.stdout.split("\0").filter((f) => f !== "");
  const removed: string[] = [];
  const written: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) (fields[i] === "D" ? removed : written).push(fields[i + 1]);
  for (const p of removed) {
    const file = join(top, ...p.split("/"));
    try {
      if (lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) unlinkSync(file);
    } catch {
      // Already gone.
    }
  }
  if (written.length > 0) {
    const dir = mkdtempSync(join(tmpdir(), "chant-wip-"));
    try {
      const env = { GIT_INDEX_FILE: join(dir, "index") };
      const read = git(top, ["read-tree", to], { env });
      if (!read.ok) throw new Error(`wip: git read-tree failed: ${read.stderr.trim()}`);
      const co = git(top, ["checkout-index", "--force", "-z", "--stdin"], { env, input: `${written.join("\0")}\0` });
      if (!co.ok) throw new Error(`wip: git checkout-index failed: ${co.stderr.trim()}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const reset = git(top, ["read-tree", "HEAD"]);
  if (!reset.ok) throw new Error(`wip: resetting the index to HEAD failed: ${reset.stderr.trim()}`);
  return [...removed, ...written].sort();
}

function requirePolicy(top: string, cwd: string, verb: string): ReplicatePolicyView {
  const policy = readReplicatePolicy(cwd);
  if (!policy) throw new WipError("wip-policy-none", `no box block declares replicate, so wip ${verb} has no remote; declare one on the box (box.replicate) in a reviewed change`);
  if (!remotes(top).includes(policy.remote)) {
    throw new WipError("wip-remote-unknown", `the replicate policy on ${policy.box}'s box names the remote ${policy.remote}, and this checkout has none; the host adds it, with its credential, before chant pushes`);
  }
  return policy;
}

/** `chant workspace wip push`: push every ref the policy names that the remote doesn't hold, for a host's schedule (`every`). */
export function wipPush(req: { cwd: string }): WipWriteDocument {
  try {
    const top = topOf(req.cwd);
    const policy = requirePolicy(top, req.cwd, "push");
    return { $schema: WIP_WRITE_SCHEMA_ID, contract: WIP_CONTRACT_VERSION, chant: readerVersion(), action: "push", policy, replication: pushReplicas(top, policy) };
  } catch (err) {
    return fail("push", err);
  }
}

/**
 * `chant workspace wip fetch`: on a replacement box, mirror what the remote
 * holds of the policy's refs into `refs/chant/replica/<remote>/`, then create
 * each local ref that is missing and fast-forward each that is behind. A
 * branch checked out in any worktree, and a local ref that has moved on or
 * forked, are left as they are and reported.
 */
export function wipFetch(req: { cwd: string }): WipWriteDocument {
  try {
    const top = topOf(req.cwd);
    const policy = requirePolicy(top, req.cwd, "fetch");
    const remote = policy.remote;
    const mirror = (ref: string) => replicaRef(remote, ref);
    const specs = policy.refs
      .filter((c) => c !== "ledger")
      .map((c) => {
        const prefix = c === "work" ? WORK_BRANCH_REF_PREFIX : c === "kept" ? KEPT_REF_PREFIX : WIP_REF_PREFIX;
        return `+${prefix}*:${mirror(prefix)}*`;
      });
    let failed: string | null = null;
    if (specs.length > 0) {
      const r = git(top, ["fetch", "--no-tags", "--prune", "--no-write-fetch-head", remote, ...specs], { timeout: NETWORK_TIMEOUT_MS });
      if (!r.ok) failed = r.stderr.trim().split("\n").filter(Boolean).pop() ?? "the fetch failed";
    }
    if (policy.refs.includes("ledger") && failed === null) {
      // The ledger may not be on the remote yet; that is not a failure.
      const r = git(top, ["fetch", "--no-tags", "--no-write-fetch-head", remote, `+${LEDGER_REF}:${mirror(LEDGER_REF)}`], { timeout: NETWORK_TIMEOUT_MS });
      if (!r.ok && !/couldn't find remote ref|no such ref/i.test(r.stderr)) failed = r.stderr.trim().split("\n").filter(Boolean).pop() ?? "the fetch failed";
    }
    const checkedOut = new Set(
      (out(top, ["worktree", "list", "--porcelain"]) ?? "")
        .split("\n")
        .filter((l) => l.startsWith("branch "))
        .map((l) => l.slice("branch ".length)),
    );
    const base = `${REPLICA_REF_PREFIX}${remote}/`;
    const refs: FetchedRef[] = [];
    for (const [replica, sha] of refMap(top, [base])) {
      const ref = `refs/${replica.slice(base.length)}`;
      const c = refClass(ref);
      if (!c || !policy.refs.includes(c)) continue;
      const local = out(top, ["rev-parse", "--verify", "--quiet", ref]);
      let result: FetchedRef["result"];
      if (local === sha) result = "up-to-date";
      else if (local === null) result = git(top, ["update-ref", ref, sha, ""]).ok ? "created" : "diverged";
      else if (checkedOut.has(ref)) result = "checked-out";
      else if (git(top, ["merge-base", "--is-ancestor", local, sha]).ok) result = git(top, ["update-ref", ref, sha, local]).ok ? "fast-forward" : "diverged";
      else if (git(top, ["merge-base", "--is-ancestor", sha, local]).ok) result = "ahead";
      else result = "diverged";
      refs.push({ ref, class: c, remote: sha, local, result });
    }
    refs.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    return { $schema: WIP_WRITE_SCHEMA_ID, contract: WIP_CONTRACT_VERSION, chant: readerVersion(), action: "fetch", policy, refs, failed };
  } catch (err) {
    return fail("fetch", err);
  }
}
