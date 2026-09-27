/**
 * The per-member cache behind `chant workspace graph` (#2876, ws-059).
 *
 * ws-018 made chant the composer for declared workspaces, and a viewer
 * rereads the composed graph on every refresh. Without a cache every read
 * starts every member's chant again, so this module keeps each member's
 * source read on disk and serves it while nothing the read depends on has
 * changed.
 *
 * An entry is served only when every part of its key still matches:
 *
 * 1. The read is a source read. A member command line holding `--live`,
 *    `--overlay` or `--traffic` observes an account, which changes with
 *    nothing on disk to notice, so it is never cached or even stamped.
 * 2. The member's stamp ({@link memberStamp}) is unchanged. It covers the
 *    member's files and the install state its toolchain resolves through.
 *    With `--at` the tree is the commit's, which never changes, so the commit
 *    id stands in for the files.
 * 3. The toolchain is unchanged: the real path of its `bin/chant` and its
 *    package version, plus its source files when it is a checkout rather
 *    than an install.
 * 4. The member's command line and the ambient environment are unchanged,
 *    since `--env`, build parameters and `buildParams` env mappings all
 *    reach the answer. A few variables a shell changes on its own are left
 *    out ({@link VOLATILE_ENV}); any other difference is a miss.
 *
 * A stamp that can't be taken caches nothing. So does a stamp that moved
 * between the start and the end of the read, a member whose read failed, and
 * a working-tree read whose newest file is younger than
 * {@link FRESH_WINDOW_MS}: some file systems keep mtimes to the second, so an
 * edit in the same tick as the read could otherwise hide behind an equal
 * stamp.
 *
 * Entries live outside the workspace, in the user's cache directory
 * ({@link graphCacheDir}), because a read never changes the workspace it
 * reads (the conformance kit checks exactly that, #2679). One JSON file per
 * key, written to a temporary name and renamed into place so concurrent
 * readers never see half an entry. Each workspace holds at most
 * {@link MAX_ENTRIES} entries and {@link MAX_BYTES} bytes; the least recently
 * used go first.
 *
 * The key never looks at how a member is read, only at what the read takes
 * in, so a member read through a generated reader project caches by its own
 * directory's stamp like any other.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ParsedArgs } from "../cli/registry";
import { readMemberIr } from "./compose-graph";
import { memberArgv, type MemberPlan, type RunUnit, type Toolchain, type UnitResult } from "./member-commands";

/** The version of the entry format. An entry of any other version is a miss. */
export const CACHE_FORMAT = 1;

/** Overrides where chant keeps caches: `$CHANT_CACHE_DIR`, else `$XDG_CACHE_HOME/chant`, else `~/.cache/chant`. */
export const CACHE_DIR_ENV = "CHANT_CACHE_DIR";

export const MAX_ENTRIES = 512;
export const MAX_BYTES = 128 * 1024 * 1024;

/** A working-tree read whose newest file is younger than this is not stored. */
export const FRESH_WINDOW_MS = 2000;

/** Member flags that make a read observe an account. Such a read is never cached. */
export const LIVE_FLAGS = ["--live", "--overlay", "--traffic"] as const;

/** Environment variables a shell or terminal changes on its own, left out of the key. */
export const VOLATILE_ENV: readonly (string | RegExp)[] = [
  "_",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "COLUMNS",
  "LINES",
  "WINDOWID",
  /^TERM/,
  /^ITERM_/,
  /^TMUX/,
  /^SSH_/,
  /^VSCODE_/,
  /^npm_/,
  /^VITEST/,
  /^__/,
  CACHE_DIR_ENV,
];

/** Directories no stamp walks into, whatever their depth. */
const SKIPPED = new Set(["node_modules", "dist", ".git"]);

/** Files, looked up from a member's directory to the file-system root, whose change means the install moved. */
const INSTALL_FILES = [
  join("node_modules", ".package-lock.json"),
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
];

/** Whether a member command line is a source read, and so may be cached. */
export function isCacheableArgv(argv: readonly string[]): boolean {
  return !argv.some((a) => LIVE_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface Stamp {
  /** `sha256:<hex>`. */
  value: string;
  /** The newest mtime among the files stamped, in ms; 0 for a revision stamp. */
  newest: number;
}

/**
 * Every regular file under `abs`, as `<relative path>\0<mtime ms>\0<size>`
 * lines sorted by path. Directories named `node_modules`, `dist` or `.git`,
 * every dot-directory, and the directories in `exclude` (relative to `abs`)
 * are left out. Throws when the directory can't be read.
 */
function fileLines(abs: string, exclude: readonly string[]): { lines: string[]; newest: number } {
  const excluded = new Set(exclude.map((e) => resolve(abs, e)));
  const lines: string[] = [];
  let newest = 0;
  const walk = (at: string): void => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, e.name);
      if (e.isDirectory()) {
        if (SKIPPED.has(e.name) || e.name.startsWith(".") || excluded.has(path)) continue;
        walk(path);
      } else if (e.isFile()) {
        const st = statSync(path);
        lines.push(`${relative(abs, path).split(sep).join("/")}\0${st.mtimeMs}\0${st.size}`);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      }
    }
  };
  walk(abs);
  lines.sort();
  return { lines, newest };
}

/** The install files found from `abs` up to the file-system root, with their mtime and size. */
function installLines(abs: string): string[] {
  const lines: string[] = [];
  for (let dir = resolve(abs); ; dir = dirname(dir)) {
    for (const name of INSTALL_FILES) {
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (st.isFile()) lines.push(`${path}\0${st.mtimeMs}\0${st.size}`);
      } catch {
        // Not here.
      }
    }
    if (dirname(dir) === dir) break;
  }
  return lines;
}

/**
 * A member's stamp: its files and the install state around it. `abs` is the
 * member's directory on disk, `exclude` the directories inside it that are
 * other members' (set for member `.`). With `at`, the commit id stands in for
 * the files, since a commit's tree never changes. Returns `undefined` when the
 * stamp can't be taken, and then nothing is cached.
 */
export function memberStamp(abs: string, exclude: readonly string[] = [], at?: { commit: string; dir: string }): Stamp | undefined {
  try {
    const install = installLines(abs);
    if (at) return { value: `sha256:${sha256(["at", at.commit, at.dir, ...install].join("\n"))}`, newest: 0 };
    const { lines, newest } = fileLines(abs, exclude);
    return { value: `sha256:${sha256(["files", ...lines, "install", ...install].join("\n"))}`, newest };
  } catch {
    return undefined;
  }
}

/**
 * What distinguishes one chant from another for the key: the real path of its
 * `bin/chant`, the version its package declares, and, for a chant that isn't
 * installed under a `node_modules` directory (a source checkout), the stamp
 * of its package's `src`, since a checkout changes without a version bump.
 */
export function toolchainStamp(toolchain: Toolchain): string {
  const pkgDir = dirname(dirname(toolchain.identity));
  let version = "";
  try {
    version = String((JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8")) as { version?: unknown }).version ?? "");
  } catch {
    // A bin outside a package: its path alone names it.
  }
  const installed = toolchain.identity.split(sep).includes("node_modules");
  let source = "";
  if (!installed && existsSync(join(pkgDir, "src"))) {
    source = memberStamp(join(pkgDir, "src"))?.value ?? `unstamped:${Date.now()}`;
  }
  return `${toolchain.identity}\0${version}\0${source}`;
}

/** What a kind's reader adds to the key: its graph block, and the installed version of the package supplying it. */
export function readerStamp(reader: { lexicon: string; config: unknown; packageDir: string }): string {
  let version = "";
  try {
    version = String((JSON.parse(readFileSync(join(reader.packageDir, "package.json"), "utf-8")) as { version?: unknown }).version ?? "");
  } catch {
    // An unreadable manifest keys on the directory alone.
  }
  return JSON.stringify([reader.lexicon, reader.config, reader.packageDir, version]);
}

/** The ambient environment, less {@link VOLATILE_ENV}, as one digest. */
export function environmentStamp(env: NodeJS.ProcessEnv = process.env): string {
  const keep = Object.keys(env)
    .filter((k) => !VOLATILE_ENV.some((v) => (typeof v === "string" ? v === k : v.test(k))))
    .sort();
  return sha256(keep.map((k) => `${k}=${env[k] ?? ""}`).join("\0"));
}

export interface KeyParts {
  member: string;
  dir: string;
  stamp: string;
  toolchain: string;
  argv: readonly string[];
  env: string;
}

export function cacheKey(parts: KeyParts): string {
  return sha256(JSON.stringify([CACHE_FORMAT, parts.member, parts.dir, parts.stamp, parts.toolchain, parts.argv, parts.env]));
}

/** One stored read. */
export interface CacheEntry {
  format: number;
  key: string;
  member: string;
  stamp: string;
  /** The chant version the read reported, or null. */
  chant: string | null;
  /** The member's `chant graph --format ir` output. */
  stdout: string;
}

export interface GraphCache {
  dir: string;
  get(key: string): CacheEntry | undefined;
  put(entry: CacheEntry): void;
}

/**
 * The directory holding the cache of the workspace rooted at `root`:
 * `<cache dir>/workspace-graph/<first 16 hex digits of sha256(real path of root)>`,
 * where the cache dir is `$CHANT_CACHE_DIR`, else `$XDG_CACHE_HOME/chant`,
 * else `~/.cache/chant`.
 */
export function graphCacheDir(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = env[CACHE_DIR_ENV] || join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "chant");
  let real = resolve(root);
  try {
    real = realpathSync(real);
  } catch {
    // A root that can't be resolved keys on the path as given.
  }
  return join(base, "workspace-graph", sha256(real).slice(0, 16));
}

/**
 * The cache for the workspace rooted at `root` (absolute, on disk). Nothing is
 * created until the first `put`. Every failure to read or write is a miss or
 * a skipped store, never an error: the cache can only make a read faster.
 */
export function openGraphCache(root: string, env: NodeJS.ProcessEnv = process.env): GraphCache {
  const dir = graphCacheDir(root, env);
  const file = (key: string) => join(dir, `${key}.json`);
  return {
    dir,
    get(key) {
      try {
        const entry = JSON.parse(readFileSync(file(key), "utf-8")) as CacheEntry;
        if (entry.format !== CACHE_FORMAT || entry.key !== key || typeof entry.stdout !== "string") return undefined;
        const now = new Date();
        utimesSync(file(key), now, now);
        return entry;
      } catch {
        return undefined;
      }
    },
    put(entry) {
      try {
        mkdirSync(dir, { recursive: true });
        const tmp = join(dir, `.${entry.key}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
        writeFileSync(tmp, JSON.stringify(entry));
        renameSync(tmp, file(entry.key));
        prune(dir);
      } catch {
        // A cache that can't be written costs the next read a run, nothing more.
      }
    },
  };
}

/** Drop the least recently used entries until the bounds hold. */
function prune(dir: string): void {
  const entries = readdirSync(dir)
    .filter((n) => n.endsWith(".json") && !n.startsWith("."))
    .map((n) => {
      try {
        const st = statSync(join(dir, n));
        return { path: join(dir, n), mtime: st.mtimeMs, size: st.size };
      } catch {
        return undefined;
      }
    })
    .filter((e): e is { path: string; mtime: number; size: number } => e !== undefined)
    .sort((a, b) => b.mtime - a.mtime);
  let bytes = 0;
  entries.forEach((e, i) => {
    bytes += e.size;
    if (i >= MAX_ENTRIES || bytes > MAX_BYTES) rmSync(e.path, { force: true });
  });
}

// ── Reading a plan through the cache ─────────────────────────────────────────

/** A member read the cache answered, or one it will store once it has run. */
interface Pending {
  key: string;
  stamp: Stamp;
  abs: string;
  exclude: string[];
  at?: { commit: string; dir: string };
  member: string;
}

export interface CacheSplit {
  /** The members the cache answered, as results a run would have produced. */
  hits: UnitResult[];
  /** Each member's stamp, by unit id: served or about to be read. */
  stamps: Map<string, string>;
  pending: Map<string, Pending>;
  /** When the lookup started; a file younger than this less {@link FRESH_WINDOW_MS} keeps a read out of the cache. */
  started: number;
}

/**
 * Look every member of a `graph` plan up in the cache. `at` is the commit
 * being read, or null for the working tree. Members with a cacheable command
 * line whose stamp can be taken end up in `hits` or in `pending`.
 */
export function splitCached(plan: MemberPlan, args: ParsedArgs, cache: GraphCache, at: string | null, argvFor: (unit: RunUnit) => string[] = (u) => memberArgv("graph", u, args)): CacheSplit {
  const started = Date.now();
  const env = environmentStamp();
  const hits: UnitResult[] = [];
  const stamps = new Map<string, string>();
  const pending = new Map<string, Pending>();
  for (const group of plan.groups) {
    const tool = toolchainStamp(group.toolchain);
    for (const unit of group.units) {
      if (unit.group) continue;
      const argv = argvFor(unit);
      if (!isCacheableArgv(argv)) continue;
      // A member read through a generated reader project (#2874) is also keyed on
      // the kind's graph block and the version of the package that reads it.
      const reader = unit.reader ? readerStamp(unit.reader) : "";
      const abs = unit.dir === "." ? plan.workspace.root : join(plan.workspace.root, ...unit.dir.split("/"));
      const revision = at ? { commit: at, dir: unit.dir } : undefined;
      const stamp = memberStamp(abs, unit.exclude, revision);
      if (!stamp) continue;
      stamps.set(unit.id, stamp.value);
      const key = cacheKey({ member: unit.member, dir: unit.dir, stamp: stamp.value, toolchain: `${tool}\0${reader}`, argv, env });
      const entry = cache.get(key);
      if (entry) {
        hits.push({ unit, toolchain: group.toolchain, chant: entry.chant, mode: "member-run", id: unit.id, member: unit.member, dir: unit.dir, exclude: unit.exclude, exitCode: 0, stdout: entry.stdout, stderr: "" });
      } else {
        pending.set(unit.id, { key, stamp, abs, exclude: unit.exclude, ...(revision ? { at: revision } : {}), member: unit.member });
      }
    }
  }
  return { hits, stamps, pending, started };
}

/** The plan without the units in `ids`; a toolchain left with no units is dropped. */
export function withoutUnits(plan: MemberPlan, ids: ReadonlySet<string>): MemberPlan {
  if (ids.size === 0) return plan;
  const groups = plan.groups.map((g) => ({ ...g, units: g.units.filter((u) => !ids.has(u.id)) })).filter((g) => g.units.length > 0);
  return { ...plan, groups };
}

/**
 * Store the reads that may be cached: the member exited 0, printed an IR, and
 * its stamp is the same after the read as before it. A working-tree read of a
 * file younger than the window is not stored.
 */
export function storeReads(split: CacheSplit, results: readonly UnitResult[], cache: GraphCache): void {
  for (const r of results) {
    const p = split.pending.get(r.id);
    if (!p || r.exitCode !== 0 || "reason" in readMemberIr(r.stdout)) continue;
    if (!p.at && p.stamp.newest > split.started - FRESH_WINDOW_MS) continue;
    const after = memberStamp(p.abs, p.exclude, p.at);
    if (!after || after.value !== p.stamp.value) continue;
    cache.put({ format: CACHE_FORMAT, key: p.key, member: p.member, stamp: p.stamp.value, chant: r.chant, stdout: r.stdout });
  }
}
