/**
 * The index store (#4519): one seam for every snapshot and every other index,
 * with the store chosen per project.
 *
 * A snapshot is one kind of index, a chant project's observed resources. The
 * same store holds what behold indexes from a direct cloud read and the
 * graphs choudoufu and plunge print (INTENTIUS/behold#1025). Every index is
 * derived, stamped, never read for a mutation decision, and safe to lose:
 * losing the store costs history and the cost of observing again, never
 * correctness. The rule has a test, ./index-store-load-bearing.test.ts.
 *
 * ## The seam
 *
 * {@link SnapshotStore}: write, read latest, list, read at, for snapshots;
 * the same four for index versions. Every snapshot read and write in chant
 * goes through it. The git plumbing in ./git.ts (`readSnapshot` and the rest)
 * is now the read side of the orphan-branch store and nothing else.
 *
 * ## One logical key space, two families
 *
 * - `snapshots`: `<env>/<key>.json` and `_members/<member>/<env>/<key>.json`,
 *   exactly the orphan branch's layout (`snapshotStorageKey`). A snapshot
 *   keeps one key, and its history is the store's own: commits on a git ref,
 *   object versions in a versioned bucket.
 * - `index`: `<source path>/<scope path>/<observedAt>-<digest12>.json`
 *   (./index-document.ts), one immutable object per read, written once and
 *   never overwritten, with `scope.json` beside the versions.
 *
 * ## Stores
 *
 * | kind | snapshots | index versions |
 * |---|---|---|
 * | `git-ref` (default) | `refs/chant/snapshots`, root of the ref | `_index/...` on the same ref |
 * | `local` | `<dir>/snapshots/...` | `<dir>/index/...` |
 * | `s3` | `<prefix>/snapshots/...` | `<prefix>/index/...` |
 * | `none` | dropped | dropped |
 * | `orphan-branch` | read-only: `chant/lifecycle` | none |
 *
 * The default `git-ref` store also reads the `chant/lifecycle` branch when
 * the ref has no answer, so snapshots written before #4519 stay readable. It
 * never writes there. A project created after #4519 has no `chant/lifecycle`
 * branch unless it writes an Op record: gates, run ledgers, deploy records,
 * releases and the other Ops records are not an index and stay on the branch.
 *
 * ## Choosing a store
 *
 * `snapshots` in chant.config.ts, and these environment variables over it:
 * `CHANT_SNAPSHOT_STORE` (`git-ref`, `local`, `s3`, `none`, `orphan-branch`),
 * `CHANT_SNAPSHOT_STORE_DIR` (local), and `CHANT_SNAPSHOT_S3_BUCKET`,
 * `_PREFIX`, `_REGION`, `_ENDPOINT`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`,
 * `_SESSION_TOKEN` (s3). See ./snapshot-store-s3.ts for the credential rule.
 *
 * Secret masking happens before a store sees the data (./snapshot.ts and
 * ../deep-observation.ts's one list), so no store holds a secret.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getRuntime } from "../runtime-adapter";
import {
  fetchLifecycle,
  ledgerDir,
  listFilesInDir,
  listLedgerTrees,
  listSnapshots as listOrphanSnapshots,
  readBlobFromPath,
  readRefSha,
  readSnapshotAt as readOrphanSnapshotAt,
  RefCASConflictError,
  updateRefCAS,
  type LedgerLocation,
} from "./git";
import { ledgerRecordingOff } from "./no-record";
import {
  INDEX_SCOPE_FILE,
  indexVersionName,
  isIndexVersionName,
  validateIndexDocument,
  type IndexDocument,
  type IndexScope,
} from "./index-document";
import { S3Medium, type S3Fetch, type S3StoreSettings } from "./snapshot-store-s3";

/** The first chant that writes snapshots through the store, to `refs/chant/snapshots` by default. */
export const SNAPSHOT_STORE_FLOOR = "0.124.54";

/** The ref the default store writes. */
export const SNAPSHOT_REF = "refs/chant/snapshots";

/** Where index versions sit on a git ref. The underscore keeps it clear of every environment name, as `_gates` and `_members` are. */
export const GIT_INDEX_DIR = "_index";

export type SnapshotStoreKind = "git-ref" | "orphan-branch" | "local" | "s3" | "none";

/** One entry of a snapshot history, newest first. */
export interface SnapshotVersion {
  /** What {@link SnapshotStore.readAt} takes: a commit on a git store, an object version id on s3, a modification time on local. */
  version: string;
  /** ISO time of the write. */
  date: string;
  message: string;
  /** The snapshot key the entry is for, when the store keeps history per key (s3, local). */
  key?: string;
}

/** What a write did. A store that keeps nothing, or a run that records nothing, says so instead of throwing. */
export interface StoreWrite {
  written: boolean;
  /** The commit, object version or file time the write made. */
  version?: string;
  /** The store path written, relative to its family root. */
  path?: string;
  /** Why nothing was written. */
  reason?: string;
}

/** What publishing a store's writes did: pushed to a remote, kept local, or refused. */
export interface StorePublish {
  status: "pushed" | "local" | "nothing" | "stale" | "failed";
  detail?: string;
}

/**
 * The index store. Snapshot methods take the snapshot's environment and key
 * (`snapshotStorageKey(lexicon, stack)`), and a {@link LedgerLocation} for a
 * workspace member; index methods take a scope key (`stamp.scopeKey`).
 */
export interface SnapshotStore {
  readonly kind: SnapshotStoreKind;
  /** `refs/chant/snapshots`, a directory, `s3://bucket/prefix`, `nowhere`: for messages. */
  readonly where: string;
  /** False for `none` and the read-only orphan-branch store. */
  readonly writable: boolean;

  write(environment: string, key: string, json: string, at?: LedgerLocation): Promise<StoreWrite>;
  readLatest(environment: string, key: string, at?: LedgerLocation): Promise<string | null>;
  readAt(environment: string, key: string, version: string, at?: LedgerLocation): Promise<string | null>;
  /** Snapshot history, newest first; with `environment`, only that environment's. */
  list(opts?: LedgerLocation & { environment?: string }): Promise<SnapshotVersion[]>;
  /** The snapshot keys an environment holds now. */
  keys(environment: string, at?: LedgerLocation): Promise<string[]>;
  /** The environments that hold a snapshot now. */
  environments(at?: LedgerLocation): Promise<string[]>;

  /** Write one index version. Refuses a stamp that disagrees with itself; never overwrites. */
  writeIndex(doc: IndexDocument): Promise<StoreWrite>;
  /** Version names under a scope key, oldest first (name order is time order). */
  listIndex(scopeKey: string): Promise<string[]>;
  readIndexAt(scopeKey: string, version: string): Promise<IndexDocument | null>;
  readIndexLatest(scopeKey: string): Promise<IndexDocument | null>;
  /** The scope a scope key's digest stands for, from its `scope.json`. */
  readIndexScope(scopeKey: string): Promise<IndexScope | null>;

  /** Bring remote history in, when the store has a remote. Never rewinds local writes. Never throws. */
  fetch(at?: LedgerLocation): Promise<void>;
  /** Send this process's writes to the remote, when the store has one. Never throws. */
  publish(at?: LedgerLocation): Promise<StorePublish>;
}

/** Every snapshot an environment holds, by key. The old `readEnvironmentSnapshots`, through a store. */
export async function readEnvironmentSnapshotsFrom(
  store: SnapshotStore,
  environment: string,
  at?: LedgerLocation,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const key of await store.keys(environment, at)) {
    const content = await store.readLatest(environment, key, at);
    if (content !== null) out.set(key, content);
  }
  return out;
}

// ── Media ────────────────────────────────────────────────────────────────

/** Names directly under a directory. */
interface Listing {
  files: string[];
  dirs: string[];
}

/** Get, put and list over paths relative to the store's root. */
interface Medium {
  get(path: string): Promise<string | null>;
  put(path: string, content: string, opts?: { ifAbsent?: boolean; message?: string }): Promise<{ exists: boolean; version?: string }>;
  list(dir: string): Promise<Listing>;
  /** History of every path under `dir` ("" for all), newest first. */
  history(dir: string): Promise<SnapshotVersion[]>;
  /** The content of `path` at a version {@link history} returned. */
  getAt(path: string, version: string): Promise<string | null>;
  fetch(): Promise<void>;
  publish(): Promise<StorePublish>;
}

const C_LOCALE = { LC_ALL: "C", LANGUAGE: "" };
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T/;

async function git(args: string[], opts: { cwd?: string; stdin?: string; env?: Record<string, string> }) {
  return getRuntime().spawn(["git", ...args], { ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}), env: { ...C_LOCALE, ...(opts.env ?? {}) } });
}

/** The remote a ref is pushed to: `origin` when it exists, else the first. */
async function remoteOf(cwd?: string): Promise<string | null> {
  const result = await git(["remote"], { cwd });
  if (result.exitCode !== 0) return null;
  const names = result.stdout.trim().split("\n").map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) return null;
  return names.includes("origin") ? "origin" : names[0];
}

/** `user.name`/`user.email` for a checkout that has none, as the ledger's own writes do (#2301). */
async function identityEnv(cwd?: string): Promise<Record<string, string>> {
  const probe = await git(["var", "GIT_COMMITTER_IDENT"], { cwd });
  if (probe.exitCode === 0) return {};
  const name = process.env.CHANT_LIFECYCLE_COMMITTER_NAME?.trim() || "chant";
  const email = process.env.CHANT_LIFECYCLE_COMMITTER_EMAIL?.trim() || "chant@localhost";
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
}

/** One file written to a ref. */
export interface RefFileWrite {
  path: string;
  content: string;
  /** Leave an existing file alone and report it. */
  ifAbsent?: boolean;
}

/**
 * Commit files onto `ref`, keeping every other path the ref holds, with a
 * compare-and-swap on the ref. Builds the tree in a scratch index, so the
 * working tree, the real index and HEAD are never touched. A conflict with
 * another writer is retried against the new tip: every caller writes a
 * self-contained replacement or a new path, so a retry is always correct.
 *
 * Returns the new commit, or null when every `ifAbsent` file existed.
 */
export async function commitFilesToRef(
  ref: string,
  files: RefFileWrite[],
  message: string,
  opts?: {
    cwd?: string;
    /** Build on this commit instead of the ref's tip (`null`: a root commit). The ref is still swapped from its current value. */
    parent?: string | null;
  },
): Promise<{ commit: string | null; existed: string[] }> {
  const cwd = opts?.cwd;
  const top = await git(["rev-parse", "--show-toplevel"], { cwd });
  const root = top.exitCode === 0 && top.stdout.trim() !== "" ? top.stdout.trim() : cwd;
  const blobs: Array<{ path: string; sha: string; ifAbsent: boolean }> = [];
  for (const f of files) {
    if (f.path.split("/").some((s) => s === "" || s === "." || s === "..")) throw new Error(`cannot write ${f.path} on ${ref}: not a clean path`);
    const h = await git(["hash-object", "-w", "--stdin"], { cwd: root, stdin: f.content });
    if (h.exitCode !== 0) throw new Error(`cannot write ${f.path} on ${ref}: git hash-object failed: ${h.stderr.trim()}`);
    blobs.push({ path: f.path, sha: h.stdout.trim(), ifAbsent: !!f.ifAbsent });
  }
  const ident = await identityEnv(root);
  const scratch = mkdtempSync(join(tmpdir(), "chant-store-"));
  const indexFile = join(scratch, "index");
  const env = { ...ident, GIT_INDEX_FILE: indexFile };
  let lastErr: unknown;
  try {
    for (let attempt = 1; attempt <= 5; attempt++) {
      // With `parent` the commit builds on that commit (a remote tip) and swaps the ref from whatever it holds now.
      const current = await readRefSha(ref, { cwd: root });
      const tip = opts?.parent !== undefined ? opts.parent : current;
      const read = await git(tip ? ["read-tree", tip] : ["read-tree", "--empty"], { cwd: root, env });
      if (read.exitCode !== 0) throw new Error(`cannot write ${ref}: git read-tree failed: ${read.stderr.trim()}`);
      const existed: string[] = [];
      const writes: typeof blobs = [];
      for (const b of blobs) {
        if (b.ifAbsent && tip) {
          const there = await git(["cat-file", "-e", `${tip}:${b.path}`], { cwd: root });
          if (there.exitCode === 0) {
            existed.push(b.path);
            continue;
          }
        }
        writes.push(b);
      }
      if (writes.length === 0) return { commit: null, existed };
      for (const b of writes) {
        const u = await git(["update-index", "--add", "--cacheinfo", `100644,${b.sha},${b.path}`], { cwd: root, env });
        if (u.exitCode !== 0) throw new Error(`cannot write ${b.path} on ${ref}: git update-index failed: ${u.stderr.trim()}`);
      }
      const tree = await git(["write-tree"], { cwd: root, env });
      if (tree.exitCode !== 0) throw new Error(`cannot write ${ref}: git write-tree failed: ${tree.stderr.trim()}`);
      const commit = await git(["commit-tree", ...(tip ? ["-p", tip] : []), "-m", message, tree.stdout.trim()], { cwd: root, env: ident });
      if (commit.exitCode !== 0) throw new Error(`cannot write ${ref}: git commit-tree failed: ${commit.stderr.trim()}`);
      const sha = commit.stdout.trim();
      try {
        await updateRefCAS(ref, sha, current, { cwd: root });
        return { commit: sha, existed };
      } catch (err) {
        if (!(err instanceof RefCASConflictError)) throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  } finally {
    try {
      if (existsSync(indexFile)) unlinkSync(indexFile);
      rmdirSync(scratch);
    } catch {
      // A scratch directory left in tmpdir is harmless.
    }
  }
}

/** `refs/chant/snapshots` → `refs/chant/remote/snapshots`: where a fetch lands, so a read never rewinds local writes. */
function trackingRefOf(ref: string): string {
  return ref.replace(/^refs\/chant\//, "refs/chant/remote/");
}

/**
 * Fetch `ref` and fast-forward the local ref when it is behind. A local ref
 * ahead of or diverged from the remote is kept as it is: its writes go out
 * on the next {@link publishRef}, which rebases them.
 */
export async function fetchRefFastForward(ref: string, opts?: { cwd?: string }): Promise<"fetched" | "no-remote" | "missing" | "kept" | "failed"> {
  const cwd = opts?.cwd;
  const remote = await remoteOf(cwd);
  if (!remote) return "no-remote";
  const tracking = trackingRefOf(ref);
  const f = await git(["fetch", "--no-tags", remote, `+${ref}:${tracking}`], { cwd });
  if (f.exitCode !== 0) return /couldn't find remote ref|no such ref was fetched/i.test(f.stderr ?? "") ? "missing" : "failed";
  const remoteSha = await readRefSha(tracking, { cwd });
  if (!remoteSha) return "missing";
  const local = await readRefSha(ref, { cwd });
  if (local === remoteSha) return "fetched";
  if (local === null) {
    await updateRefCAS(ref, remoteSha, null, { cwd }).catch(() => undefined);
    return "fetched";
  }
  const behind = await git(["merge-base", "--is-ancestor", local, remoteSha], { cwd });
  if (behind.exitCode === 0) {
    await updateRefCAS(ref, remoteSha, local, { cwd }).catch(() => undefined);
    return "fetched";
  }
  return "kept";
}

/**
 * Push `ref` under a lease on the remote tip last fetched. A refused push
 * (another machine pushed first) fetches, commits `pending` again on the
 * remote tip, and pushes once more, up to three times.
 */
export async function publishRef(
  ref: string,
  pending: ReadonlyMap<string, string>,
  message: string,
  opts?: { cwd?: string },
): Promise<StorePublish> {
  const cwd = opts?.cwd;
  if (ledgerRecordingOff()) return { status: "nothing", detail: "recording is off for this run" };
  const local = await readRefSha(ref, { cwd });
  if (!local) return { status: "nothing" };
  const remote = await remoteOf(cwd);
  if (!remote) return { status: "local", detail: "no remote configured" };
  const tracking = trackingRefOf(ref);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const expected = await readRefSha(tracking, { cwd });
    const tip = await readRefSha(ref, { cwd });
    if (tip === expected) return { status: "pushed", detail: `${remote} ${ref}` };
    const push = await git(["push", "--no-verify", `--force-with-lease=${ref}:${expected ?? ""}`, remote, `${ref}:${ref}`], { cwd });
    if (push.exitCode === 0) {
      if (tip) await git(["update-ref", tracking, tip], { cwd });
      return { status: "pushed", detail: `${remote} ${ref}` };
    }
    // Refused: bring the remote in and put this process's writes on top of it.
    const fetched = await fetchRefFastForward(ref, { cwd });
    if (fetched === "failed") return { status: "failed", detail: (push.stderr ?? "").trim().split("\n")[0] };
    const remoteTip = await readRefSha(tracking, { cwd });
    if (pending.size === 0 || !remoteTip) return { status: "stale", detail: (push.stderr ?? "").trim().split("\n")[0] };
    const files = [...pending].map(([path, content]) => ({ path, content }));
    // Local commits that are not this process's writes are dropped here: a snapshot is observed again, never needed.
    const rebuilt = await commitFilesToRef(ref, files, message, { cwd, parent: remoteTip });
    if (rebuilt.commit === null) return { status: "pushed", detail: `${remote} ${ref}` };
  }
  return { status: "stale", detail: `${remote} kept moving; run the command again` };
}

class GitRefMedium implements Medium {
  /** This process's writes, by path, for {@link publishRef} to replay on a refused push. */
  private readonly pending = new Map<string, string>();
  constructor(readonly ref: string, private readonly cwd?: string) {}

  async get(path: string): Promise<string | null> {
    const r = await git(["cat-file", "blob", `${this.ref}:${path}`], { cwd: this.cwd });
    return r.exitCode === 0 ? r.stdout : null;
  }

  async put(path: string, content: string, opts?: { ifAbsent?: boolean; message?: string }) {
    if (ledgerRecordingOff()) throw new NotRecorded();
    const { commit, existed } = await commitFilesToRef(this.ref, [{ path, content, ifAbsent: opts?.ifAbsent }], opts?.message ?? "Index store write", { cwd: this.cwd });
    if (existed.includes(path)) return { exists: true };
    this.pending.set(path, content);
    return { exists: false, ...(commit ? { version: commit } : {}) };
  }

  async list(dir: string): Promise<Listing> {
    const tip = await readRefSha(this.ref, { cwd: this.cwd });
    if (!tip) return { files: [], dirs: [] };
    const r = await git(["ls-tree", "--full-tree", dir === "" ? tip : `${tip}:${dir}`], { cwd: this.cwd });
    const out: Listing = { files: [], dirs: [] };
    if (r.exitCode !== 0) return out;
    for (const line of r.stdout.split("\n")) {
      const m = line.match(/^\d+\s+(\w+)\s+[0-9a-f]+\t(.+)$/);
      if (!m) continue;
      (m[1] === "tree" ? out.dirs : out.files).push(m[2]);
    }
    return out;
  }

  async history(dir: string): Promise<SnapshotVersion[]> {
    const tip = await readRefSha(this.ref, { cwd: this.cwd });
    if (!tip) return [];
    const r = await git(["log", "--format=%H %aI %s", tip, ...(dir === "" ? [] : ["--", `:(top)${dir}`])], { cwd: this.cwd });
    if (r.exitCode !== 0) return [];
    return r.stdout.trim().split("\n").filter(Boolean).map((line) => {
      const [version, date, ...rest] = line.split(" ");
      return { version, date, message: rest.join(" ") };
    });
  }

  async getAt(path: string, version: string): Promise<string | null> {
    const r = await git(["cat-file", "blob", `${version}:${path}`], { cwd: this.cwd });
    return r.exitCode === 0 ? r.stdout : null;
  }

  async fetch(): Promise<void> {
    try {
      await fetchRefFastForward(this.ref, { cwd: this.cwd });
    } catch {
      // A fetch that fails leaves local history as it is, which every reader handles.
    }
  }

  async publish(): Promise<StorePublish> {
    try {
      return await publishRef(this.ref, this.pending, "Index store write", { cwd: this.cwd });
    } catch (err) {
      return { status: "failed", detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

class NotRecorded extends Error {}

class LocalMedium implements Medium {
  constructor(readonly root: string) {}

  async get(path: string): Promise<string | null> {
    try {
      return readFileSync(join(this.root, path), "utf8");
    } catch {
      return null;
    }
  }

  async put(path: string, content: string, opts?: { ifAbsent?: boolean }) {
    const file = join(this.root, path);
    mkdirSync(dirname(file), { recursive: true });
    if (opts?.ifAbsent) {
      try {
        writeFileSync(file, content, { flag: "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return { exists: true };
        throw err;
      }
    } else {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, content);
      renameSync(tmp, file);
    }
    return { exists: false, version: statSync(file).mtime.toISOString() };
  }

  async list(dir: string): Promise<Listing> {
    const out: Listing = { files: [], dirs: [] };
    try {
      for (const e of readdirSync(join(this.root, dir), { withFileTypes: true })) {
        if (e.name.endsWith(".tmp")) continue;
        (e.isDirectory() ? out.dirs : out.files).push(e.name);
      }
    } catch {
      // Absent: nothing there.
    }
    return out;
  }

  /** A directory keeps no history: one entry per file there now, at its modification time. */
  async history(dir: string): Promise<SnapshotVersion[]> {
    const out: SnapshotVersion[] = [];
    const walk = async (d: string): Promise<void> => {
      const l = await this.list(d);
      for (const f of l.files) {
        const rel = d === "" ? f : `${d}/${f}`;
        const date = statSync(join(this.root, rel)).mtime.toISOString();
        out.push({ version: date, date, message: rel, key: rel });
      }
      for (const sub of l.dirs) await walk(d === "" ? sub : `${d}/${sub}`);
    };
    await walk(dir);
    return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  /** `latest`, or a time: the file as it is now, when it was written at or before that time. */
  async getAt(path: string, version: string): Promise<string | null> {
    const content = await this.get(path);
    if (content === null || version === "latest") return content;
    if (!ISO_TIME_RE.test(version)) return null;
    return statSync(join(this.root, path)).mtime.toISOString() <= new Date(version).toISOString() ? content : null;
  }

  async fetch(): Promise<void> {}
  async publish(): Promise<StorePublish> {
    return { status: "local", detail: this.root };
  }
}

class S3StoreMedium implements Medium {
  constructor(readonly s3: S3Medium) {}

  get(path: string) {
    return this.s3.get(path);
  }

  async put(path: string, content: string, opts?: { ifAbsent?: boolean }) {
    const r = await this.s3.put(path, content, opts);
    return { exists: r.exists, ...(r.versionId ? { version: r.versionId } : {}) };
  }

  async list(dir: string): Promise<Listing> {
    const out: Listing = { files: [], dirs: [] };
    for (const name of await this.s3.list(dir.replace(/\/$/, ""))) {
      if (name.endsWith("/")) out.dirs.push(name.slice(0, -1));
      else out.files.push(name);
    }
    return out;
  }

  /** The bucket's object versions under `dir`. Without versioning on, only the latest of each key. */
  async history(dir: string): Promise<SnapshotVersion[]> {
    return (await this.s3.versions(dir.replace(/\/$/, ""))).map((v) => ({ version: v.versionId, date: v.lastModified, message: v.key, key: v.key }));
  }

  /** A version id, or a time: the newest version written at or before it. */
  async getAt(path: string, version: string): Promise<string | null> {
    if (!ISO_TIME_RE.test(version)) return this.s3.get(path, version);
    const at = new Date(version).toISOString();
    const versions = (await this.s3.versions(dirname(path))).filter((v) => v.key === path && new Date(v.lastModified).toISOString() <= at);
    return versions.length === 0 ? null : this.s3.get(path, versions[0].versionId);
  }

  async fetch(): Promise<void> {}
  async publish(): Promise<StorePublish> {
    return { status: "pushed", detail: this.s3.where };
  }
}

// ── Stores ───────────────────────────────────────────────────────────────

interface Layout {
  /** Prefix of the snapshot family: `""` on a git ref, `snapshots/` elsewhere. */
  snapshots: string;
  /** Prefix of the index family: `_index/` on a git ref, `index/` elsewhere. */
  index: string;
}

const isSnapshotFile = (name: string): boolean => name.endsWith(".json") && name !== "observation-baseline.json";

/** A store over one medium, for the `git-ref`, `local` and `s3` kinds. */
class MediumStore implements SnapshotStore {
  readonly writable = true;
  constructor(
    readonly kind: SnapshotStoreKind,
    readonly where: string,
    private readonly medium: Medium,
    private readonly layout: Layout,
    private readonly cwd?: string,
  ) {}

  private loc(at?: LedgerLocation): LedgerLocation {
    return { ...(this.cwd ? { cwd: this.cwd } : {}), ...(at ?? {}) };
  }

  private async envDir(environment: string, at?: LedgerLocation): Promise<string> {
    return `${this.layout.snapshots}${await ledgerDir(environment, this.loc(at))}`;
  }

  async write(environment: string, key: string, json: string, at?: LedgerLocation): Promise<StoreWrite> {
    const path = `${await this.envDir(environment, at)}/${key}.json`;
    try {
      const r = await this.medium.put(path, json, { message: "State snapshot" });
      return { written: true, path, ...(r.version ? { version: r.version } : {}) };
    } catch (err) {
      if (err instanceof NotRecorded) return { written: false, path, reason: "recording is off for this run" };
      throw err;
    }
  }

  async readLatest(environment: string, key: string, at?: LedgerLocation): Promise<string | null> {
    return this.medium.get(`${await this.envDir(environment, at)}/${key}.json`);
  }

  async readAt(environment: string, key: string, version: string, at?: LedgerLocation): Promise<string | null> {
    return this.medium.getAt(`${await this.envDir(environment, at)}/${key}.json`, version);
  }

  async list(opts?: LedgerLocation & { environment?: string }): Promise<SnapshotVersion[]> {
    const { environment, ...at } = opts ?? {};
    const base = `${this.layout.snapshots}${await ledgerDir(environment ?? "", this.loc(at))}`.replace(/\/$/, "");
    const all = await this.medium.history(base);
    // A git ref's root also holds the index family; its commits are not snapshots.
    return all.filter((v) => !(v.key ?? "").startsWith(this.layout.index) && v.message !== "Index version");
  }

  async keys(environment: string, at?: LedgerLocation): Promise<string[]> {
    const l = await this.medium.list(await this.envDir(environment, at));
    return l.files.filter(isSnapshotFile).map((f) => f.slice(0, -".json".length)).sort();
  }

  async environments(at?: LedgerLocation): Promise<string[]> {
    const base = `${this.layout.snapshots}${await ledgerDir("", this.loc(at))}`.replace(/\/$/, "");
    return (await this.medium.list(base)).dirs.filter((d) => !d.startsWith("_")).sort();
  }

  async writeIndex(doc: IndexDocument): Promise<StoreWrite> {
    validateIndexDocument(doc);
    const { stamp } = doc;
    const dir = `${this.layout.index}${stamp.scopeKey}`;
    const path = `${dir}/${indexVersionName(stamp.observedAt, stamp.digest)}`;
    try {
      await this.medium.put(`${dir}/${INDEX_SCOPE_FILE}`, `${JSON.stringify(stamp.scope, null, 2)}\n`, { ifAbsent: true, message: "Index version" });
      const r = await this.medium.put(path, `${JSON.stringify(doc, null, 2)}\n`, { ifAbsent: true, message: "Index version" });
      if (r.exists) return { written: false, path, reason: "this version is already in the store, and a version is never overwritten" };
      return { written: true, path, ...(r.version ? { version: r.version } : {}) };
    } catch (err) {
      if (err instanceof NotRecorded) return { written: false, path, reason: "recording is off for this run" };
      throw err;
    }
  }

  async listIndex(scopeKey: string): Promise<string[]> {
    return (await this.medium.list(`${this.layout.index}${scopeKey}`)).files.filter(isIndexVersionName).sort();
  }

  async readIndexAt(scopeKey: string, version: string): Promise<IndexDocument | null> {
    if (!isIndexVersionName(version)) return null;
    const text = await this.medium.get(`${this.layout.index}${scopeKey}/${version}`);
    return text === null ? null : (JSON.parse(text) as IndexDocument);
  }

  async readIndexLatest(scopeKey: string): Promise<IndexDocument | null> {
    const versions = await this.listIndex(scopeKey);
    return versions.length === 0 ? null : this.readIndexAt(scopeKey, versions[versions.length - 1]);
  }

  async readIndexScope(scopeKey: string): Promise<IndexScope | null> {
    const text = await this.medium.get(`${this.layout.index}${scopeKey}/${INDEX_SCOPE_FILE}`);
    return text === null ? null : (JSON.parse(text) as IndexScope);
  }

  fetch(): Promise<void> {
    return this.medium.fetch();
  }

  publish(): Promise<StorePublish> {
    return this.medium.publish();
  }
}

/** `none`: every write is dropped and every read is empty, which is every reader's fallback. */
class NoneStore implements SnapshotStore {
  readonly kind = "none" as const;
  readonly where = "nowhere (snapshots are off)";
  readonly writable = false;
  private readonly dropped = (path?: string): StoreWrite => ({ written: false, ...(path ? { path } : {}), reason: "the snapshot store is none" });
  async write(environment: string, key: string) {
    return this.dropped(`${environment}/${key}.json`);
  }
  async readLatest() {
    return null;
  }
  async readAt() {
    return null;
  }
  async list() {
    return [];
  }
  async keys() {
    return [];
  }
  async environments() {
    return [];
  }
  async writeIndex(doc: IndexDocument) {
    validateIndexDocument(doc);
    return this.dropped();
  }
  async listIndex() {
    return [];
  }
  async readIndexAt() {
    return null;
  }
  async readIndexLatest() {
    return null;
  }
  async readIndexScope() {
    return null;
  }
  async fetch() {}
  async publish(): Promise<StorePublish> {
    return { status: "nothing" };
  }
}

/** `orphan-branch`: the snapshots on `chant/lifecycle`, read-only, so the ones written before #4519 stay readable. */
class OrphanBranchStore implements SnapshotStore {
  readonly kind = "orphan-branch" as const;
  readonly where = "chant/lifecycle (read-only)";
  readonly writable = false;
  constructor(private readonly cwd?: string) {}
  private loc(at?: LedgerLocation): LedgerLocation {
    return { ...(this.cwd ? { cwd: this.cwd } : {}), ...(at ?? {}) };
  }
  async write(environment: string, key: string): Promise<StoreWrite> {
    return { written: false, path: `${environment}/${key}.json`, reason: "the orphan-branch store is read-only; snapshots are written to refs/chant/snapshots" };
  }
  readLatest(environment: string, key: string, at?: LedgerLocation) {
    return readBlobFromPath(environment, `${key}.json`, this.loc(at));
  }
  readAt(environment: string, key: string, version: string, at?: LedgerLocation) {
    return readOrphanSnapshotAt(environment, key, version, this.loc(at));
  }
  async list(opts?: LedgerLocation & { environment?: string }): Promise<SnapshotVersion[]> {
    const { environment: _env, ...at } = opts ?? {};
    return (await listOrphanSnapshots(this.loc(at)))
      .filter((e) => e.message === "State snapshot")
      .map((e) => ({ version: e.commit, date: e.date, message: e.message }));
  }
  async keys(environment: string, at?: LedgerLocation) {
    return (await listFilesInDir(environment, this.loc(at))).filter(isSnapshotFile).map((f) => f.slice(0, -".json".length)).sort();
  }
  async environments(at?: LedgerLocation) {
    const out: string[] = [];
    for (const t of await listLedgerTrees(this.loc(at))) {
      if (t.startsWith("_")) continue;
      if ((await this.keys(t, at)).length > 0) out.push(t);
    }
    return out.sort();
  }
  async writeIndex(doc: IndexDocument): Promise<StoreWrite> {
    validateIndexDocument(doc);
    return { written: false, reason: "the orphan-branch store is read-only and never held an index" };
  }
  async listIndex() {
    return [];
  }
  async readIndexAt() {
    return null;
  }
  async readIndexLatest() {
    return null;
  }
  async readIndexScope() {
    return null;
  }
  async fetch(): Promise<void> {
    try {
      await fetchLifecycle(this.loc());
    } catch {
      // Unreadable remote: local history is what there is.
    }
  }
  async publish(): Promise<StorePublish> {
    return { status: "nothing" };
  }
}

/**
 * A store that writes to `primary` and reads `legacy` when `primary` has no
 * answer: the default, `refs/chant/snapshots` over the old orphan branch.
 */
class FallbackStore implements SnapshotStore {
  constructor(private readonly primary: SnapshotStore, private readonly legacy: SnapshotStore) {}
  get kind() {
    return this.primary.kind;
  }
  get where() {
    return `${this.primary.where} (reading ${this.legacy.where} for older snapshots)`;
  }
  get writable() {
    return this.primary.writable;
  }
  write(environment: string, key: string, json: string, at?: LedgerLocation) {
    return this.primary.write(environment, key, json, at);
  }
  async readLatest(environment: string, key: string, at?: LedgerLocation) {
    return (await this.primary.readLatest(environment, key, at)) ?? this.legacy.readLatest(environment, key, at);
  }
  async readAt(environment: string, key: string, version: string, at?: LedgerLocation) {
    // Both are git commits with the same layout, so one version id reads from either history.
    return (await this.primary.readAt(environment, key, version, at)) ?? this.legacy.readAt(environment, key, version, at);
  }
  async list(opts?: LedgerLocation & { environment?: string }) {
    const merged = [...(await this.primary.list(opts)), ...(await this.legacy.list(opts))];
    return merged.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }
  async keys(environment: string, at?: LedgerLocation) {
    return [...new Set([...(await this.primary.keys(environment, at)), ...(await this.legacy.keys(environment, at))])].sort();
  }
  async environments(at?: LedgerLocation) {
    return [...new Set([...(await this.primary.environments(at)), ...(await this.legacy.environments(at))])].sort();
  }
  writeIndex(doc: IndexDocument) {
    return this.primary.writeIndex(doc);
  }
  listIndex(scopeKey: string) {
    return this.primary.listIndex(scopeKey);
  }
  readIndexAt(scopeKey: string, version: string) {
    return this.primary.readIndexAt(scopeKey, version);
  }
  readIndexLatest(scopeKey: string) {
    return this.primary.readIndexLatest(scopeKey);
  }
  readIndexScope(scopeKey: string) {
    return this.primary.readIndexScope(scopeKey);
  }
  async fetch(at?: LedgerLocation) {
    await this.primary.fetch(at);
    await this.legacy.fetch(at);
  }
  publish(at?: LedgerLocation) {
    return this.primary.publish(at);
  }
}

// ── Configuration ────────────────────────────────────────────────────────

/** `snapshots` in chant.config.ts. */
export type SnapshotStoreConfig =
  | { store: "git-ref"; ref?: string; /** Read `chant/lifecycle` when the ref has no answer. Default true. */ readOrphanBranch?: boolean }
  | { store: "orphan-branch" }
  | { store: "local"; /** Relative to the project. Default `.chant/store`. */ dir?: string }
  | ({ store: "s3" } & S3StoreSettings)
  | { store: "none" };

export const SNAPSHOT_STORE_KINDS: readonly SnapshotStoreKind[] = ["git-ref", "orphan-branch", "local", "s3", "none"];

/** Default directory of a `local` store, relative to the project. */
export const DEFAULT_LOCAL_STORE_DIR = ".chant/store";

/**
 * The store configuration in effect: `CHANT_SNAPSHOT_STORE` and its
 * companions over `snapshots` in chant.config.ts over the default `git-ref`.
 */
export function snapshotStoreConfig(
  configured?: unknown,
  env: Record<string, string | undefined> = process.env,
): SnapshotStoreConfig {
  const base = (configured && typeof configured === "object" ? configured : {}) as Record<string, unknown>;
  const kind = (env.CHANT_SNAPSHOT_STORE?.trim() || (base.store as string | undefined) || "git-ref") as SnapshotStoreKind;
  if (!SNAPSHOT_STORE_KINDS.includes(kind)) {
    throw new Error(`snapshot store "${kind}" is not one of ${SNAPSHOT_STORE_KINDS.join(", ")}`);
  }
  const fromBase = base.store === kind ? base : {};
  switch (kind) {
    case "git-ref":
      return { store: "git-ref", ...(typeof fromBase.ref === "string" ? { ref: fromBase.ref } : {}), ...(fromBase.readOrphanBranch === false ? { readOrphanBranch: false } : {}) };
    case "orphan-branch":
      return { store: "orphan-branch" };
    case "none":
      return { store: "none" };
    case "local": {
      const dir = env.CHANT_SNAPSHOT_STORE_DIR?.trim() || (typeof fromBase.dir === "string" ? fromBase.dir : undefined);
      return { store: "local", ...(dir ? { dir } : {}) };
    }
    case "s3": {
      const pick = (envName: string, key: string): string | undefined => env[envName]?.trim() || (typeof fromBase[key] === "string" ? (fromBase[key] as string) : undefined);
      const bucket = pick("CHANT_SNAPSHOT_S3_BUCKET", "bucket");
      if (!bucket) throw new Error("the s3 snapshot store needs a bucket: snapshots.bucket in chant.config.ts or CHANT_SNAPSHOT_S3_BUCKET");
      const prefix = pick("CHANT_SNAPSHOT_S3_PREFIX", "prefix");
      const region = pick("CHANT_SNAPSHOT_S3_REGION", "region");
      const endpoint = pick("CHANT_SNAPSHOT_S3_ENDPOINT", "endpoint");
      const creds = fromBase.credentials as S3StoreSettings["credentials"] | undefined;
      return {
        store: "s3",
        bucket,
        ...(prefix ? { prefix } : {}),
        ...(region ? { region } : {}),
        ...(endpoint ? { endpoint } : {}),
        ...(typeof fromBase.forcePathStyle === "boolean" ? { forcePathStyle: fromBase.forcePathStyle } : {}),
        ...(creds ? { credentials: creds } : {}),
      };
    }
  }
}

/** Seams for tests: the s3 transport and the environment its credentials come from. */
export interface SnapshotStoreDeps {
  fetch?: S3Fetch;
  env?: Record<string, string | undefined>;
}

/** Build a store from its configuration. `cwd` is the project directory. */
export function createSnapshotStore(config: SnapshotStoreConfig, opts?: { cwd?: string } & SnapshotStoreDeps): SnapshotStore {
  const cwd = opts?.cwd;
  switch (config.store) {
    case "git-ref": {
      const ref = config.ref ?? SNAPSHOT_REF;
      const store = new MediumStore("git-ref", ref, new GitRefMedium(ref, cwd), { snapshots: "", index: `${GIT_INDEX_DIR}/` }, cwd);
      return config.readOrphanBranch === false ? store : new FallbackStore(store, new OrphanBranchStore(cwd));
    }
    case "orphan-branch":
      return new OrphanBranchStore(cwd);
    case "local": {
      const root = resolve(cwd ?? process.cwd(), config.dir ?? DEFAULT_LOCAL_STORE_DIR);
      return new MediumStore("local", root, new LocalMedium(root), { snapshots: "snapshots/", index: "index/" }, cwd);
    }
    case "s3": {
      const { store: _s, ...settings } = config;
      const s3 = new S3Medium(settings, { ...(opts?.fetch ? { fetch: opts.fetch } : {}), ...(opts?.env ? { env: opts.env } : {}) });
      return new MediumStore("s3", s3.where, new S3StoreMedium(s3), { snapshots: "snapshots/", index: "index/" }, cwd);
    }
    case "none":
      return new NoneStore();
  }
}

const resolved = new Map<string, SnapshotStore>();

/**
 * The project's store, built once per directory and configuration so a
 * write and the publish after it share one instance. `config` is the
 * project's loaded chant.config; without it the config is loaded from `cwd`
 * upward, and a directory with none uses the default.
 */
export async function resolveSnapshotStore(opts?: { cwd?: string; config?: { snapshots?: unknown } }): Promise<SnapshotStore> {
  const cwd = resolve(opts?.cwd ?? process.cwd());
  let configured = opts?.config?.snapshots;
  if (opts?.config === undefined) {
    try {
      const { loadChantConfigUpward } = await import("../config");
      configured = ((await loadChantConfigUpward(cwd)).config as { snapshots?: unknown }).snapshots;
    } catch {
      configured = undefined;
    }
  }
  const config = snapshotStoreConfig(configured);
  const cacheKey = `${cwd}\0${JSON.stringify(config)}`;
  let store = resolved.get(cacheKey);
  if (!store) {
    store = createSnapshotStore(config, { cwd });
    resolved.set(cacheKey, store);
  }
  return store;
}

/** Forget every resolved store. For tests. */
export function resetResolvedSnapshotStores(): void {
  resolved.clear();
}

/**
 * The snapshot family as a {@link import("./ledger-port").LedgerReadPort}:
 * `trees` are the environments, `list(env)` the snapshot files, `read` a file.
 * `chant query` reads its `resources` and `snapshots` tables through this, so
 * the tables are the same whichever store holds them.
 */
export function snapshotReadPort(store: SnapshotStore, at?: LedgerLocation) {
  return {
    read: async (dir: string, file: string) => (file.endsWith(".json") ? store.readLatest(dir, file.slice(0, -".json".length), at) : null),
    list: async (dir: string) => (await store.keys(dir, at)).map((k) => `${k}.json`),
    trees: () => store.environments(at),
  };
}
