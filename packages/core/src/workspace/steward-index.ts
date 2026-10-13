/**
 * What `chant workspace status` reads of a project's stewards and Ops
 * (#3636), kept per tree so a status doesn't import every `*.op.ts` file
 * each time it runs.
 *
 * Discovery (`../op/discover.ts`) has to import the Op modules, and an Op
 * module may do work when it is imported: run git, read files, even start
 * another chant. Status needs only plain fields of what it finds: each
 * steward's name, file, form, vault, capabilities and Ops, and of each Op
 * its name, schedule, labels, work lease kind and `changesCheckout`. The
 * first status on a tree discovers them and writes that index to
 * `<cache dir>/workspace-stewards/<checkout>/<key>.json`; later ones read
 * it back, until the tree changes. The cache dir is the one the graph cache
 * uses (`./graph-cache.ts`): `$CHANT_CACHE_DIR`, else
 * `$XDG_CACHE_HOME/chant`, else `~/.cache/chant`, outside the workspace,
 * since a read never changes the workspace it reads.
 *
 * The tree is the checkout's `HEAD` tree plus every changed or untracked
 * file `git status` lists (its path and contents), and the chant version,
 * so a commit, an edit or a new file anywhere in the checkout discovers
 * again. Files git ignores (`node_modules`) are not part of it. An index is
 * only written when every Op file imported, so an import that failed is
 * tried again by the next status. `CHANT_STEWARD_INDEX=0` turns the index
 * off, for an Op module whose declaration depends on more than its tree.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { CHANT_VERSION } from "../cli/version";
import { discoverOps, discoverStewards } from "../op/discover";
import { stewardBesideOf, type StewardForm } from "../op/steward";
import type { OpConfig } from "../op/types";

const execFileAsync = promisify(execFile);

/** Bumped when the index's shape changes, so an older index is never read. */
const INDEX_FORMAT = 1;

/** Where the indexes of the checkout at `top` live, and the checkout's real path. */
function indexDir(top: string, env: NodeJS.ProcessEnv = process.env): { dir: string; checkout: string } {
  const base = env.CHANT_CACHE_DIR || join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "chant");
  let checkout = resolve(top);
  try {
    checkout = realpathSync(checkout);
  } catch {
    // Keyed on the path as given.
  }
  return { dir: join(base, "workspace-stewards", createHash("sha256").update(checkout).digest("hex").slice(0, 16)), checkout };
}

/** How many indexes a checkout keeps: the newest, by when they were written. */
const KEPT = 32;

/** What status reads of an Op. */
export interface IndexedOp {
  name: string;
  schedule: { cron: string } | null;
  /** Absent when the Op has none. */
  labels?: Record<string, string>;
  workLease: { kind: string | null } | null;
  changesCheckout: boolean;
}

/** What status reads of a steward. */
export interface IndexedSteward {
  name: string;
  /** The `*.op.ts` file declaring it, absolute. */
  filePath: string;
  /** Every Op it runs: its turns' Ops, then those beside them. */
  ops: IndexedOp[];
  /** The Ops it runs beside its turns (#2861), and whether each declares a ready step. */
  beside: { op: string; ready: boolean }[];
  form: { default: StewardForm; environments: Record<string, StewardForm> };
  capabilities: string[];
  vault: string | null;
}

export interface StewardIndex {
  /** In discovery's order. */
  stewards: IndexedSteward[];
  /** Files that could not be imported. */
  errors: string[];
  /** Stewards dropped as second writers. */
  conflicts: string[];
  /** The project's Ops that no steward lists, or null when they couldn't be discovered. */
  otherOps: IndexedOp[] | null;
}

function indexOp(op: OpConfig): IndexedOp {
  return {
    name: op.name,
    schedule: op.schedule ? { cron: op.schedule.cron } : null,
    ...(op.labels ? { labels: { ...op.labels } } : {}),
    workLease: op.workLease ? { kind: op.workLease.kind ?? null } : null,
    changesCheckout: op.changesCheckout === true,
  };
}

/** Discover the stewards and Ops under `memberDir`, importing every Op file. Throws as `discoverStewards` does. */
export async function discoverStewardIndex(memberDir: string): Promise<StewardIndex> {
  const { stewards, errors, conflicts } = await discoverStewards({ cwd: memberDir });
  const listed = [...stewards.values()].map(({ declaration, filePath }) => ({
    name: declaration.name,
    filePath,
    ops: declaration.ops.map(indexOp),
    beside: stewardBesideOf(declaration).map((b) => ({ op: b.op, ready: b.ready !== null && b.ready !== undefined })),
    form: { default: declaration.form.default, environments: { ...declaration.form.environments } },
    capabilities: Array.isArray(declaration.capabilities) ? [...declaration.capabilities] : [],
    vault: typeof declaration.vault === "string" ? declaration.vault : null,
  }));
  let otherOps: IndexedOp[] | null = null;
  // Only a project with a steward has waits to look for among its other Ops.
  if (listed.length > 0) {
    const declared = new Set(listed.flatMap((s) => s.ops.map((op) => op.name)));
    try {
      otherOps = [...(await discoverOps({ cwd: memberDir })).ops.values()].map((d) => indexOp(d.config)).filter((op) => !declared.has(op.name));
    } catch {
      otherOps = null;
    }
  }
  return { stewards: listed, errors, conflicts, otherOps };
}

async function git(args: string[], cwd: string): Promise<string> {
  // A read: `git status` must not take the index lock from a writer.
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  const { stdout } = await execFileAsync("git", args, { cwd, env, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * The key of the tree `memberDir` is in: its `HEAD` tree, each changed or
 * untracked file's path and contents, the chant version and `memberDir`.
 * Null outside a checkout, or when git can't say.
 */
export async function treeKey(memberDir: string): Promise<{ key: string; dir: string; checkout: string } | null> {
  try {
    const top = (await git(["rev-parse", "--show-toplevel"], memberDir)).trim();
    const head = (await git(["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], top).catch(() => "")).trim();
    const changed = (await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], top))
      .split("\0")
      .filter((e) => e.length > 3)
      .map((e) => e.slice(3))
      .sort();
    const h = createHash("sha256");
    h.update(`${INDEX_FORMAT}\0${CHANT_VERSION}\0${resolve(memberDir)}\0${head}\0`);
    for (const path of changed) {
      h.update(`${path}\0`);
      try {
        const full = join(top, path);
        h.update(statSync(full).isFile() ? readFileSync(full) : "dir");
      } catch {
        h.update("gone");
      }
      h.update("\0");
    }
    return { key: h.digest("hex"), ...indexDir(top) };
  } catch {
    return null;
  }
}

/**
 * Remove all but the {@link KEPT} newest indexes of this checkout, and the
 * indexes of checkouts that are gone (each directory names its checkout in
 * its `checkout` file).
 */
function prune(dir: string): void {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const { f } of files.slice(KEPT)) rmSync(join(dir, f), { force: true });
  const parent = dirname(dir);
  for (const other of readdirSync(parent)) {
    const at = join(parent, other);
    if (at === dir) continue;
    try {
      if (!existsSync(readFileSync(join(at, "checkout"), "utf-8"))) rmSync(at, { recursive: true, force: true });
    } catch {
      // No checkout file, or being written: left alone.
    }
  }
}

function isIndex(v: unknown): v is StewardIndex {
  const i = v as StewardIndex;
  return !!i && Array.isArray(i.stewards) && Array.isArray(i.errors) && Array.isArray(i.conflicts) && (i.otherOps === null || Array.isArray(i.otherOps));
}

/**
 * The stewards and Ops under `memberDir`: from the index for its tree when
 * there is one, else discovered and indexed. Throws as `discoverStewards`
 * does.
 */
export async function readStewardIndex(memberDir: string, deps: { discover?: typeof discoverStewardIndex } = {}): Promise<StewardIndex> {
  const discover = deps.discover ?? discoverStewardIndex;
  if (process.env.CHANT_STEWARD_INDEX === "0") return discover(memberDir);
  const tree = await treeKey(memberDir);
  if (!tree) return discover(memberDir);
  const file = join(tree.dir, `${tree.key}.json`);
  try {
    const kept = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    if (isIndex(kept)) return kept;
  } catch {
    // None yet, or unreadable: discover.
  }
  const index = await discover(memberDir);
  if (index.errors.length === 0) {
    try {
      mkdirSync(tree.dir, { recursive: true });
      writeFileSync(join(tree.dir, "checkout"), tree.checkout);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(index));
      renameSync(tmp, file);
      prune(tree.dir);
    } catch {
      // A cache dir that can't be written: status still works, discovering each time.
    }
  }
  return index;
}
