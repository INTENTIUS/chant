/**
 * The one discovery walk (chant#2527).
 *
 * Every command that decides which files chant reads walks the tree here:
 * source discovery (`./files.ts`'s `findInfraFiles`, behind build, graph,
 * list, explain and lexicon detection), `chant lint`, component discovery,
 * Op discovery and the `chant audit` walk. They used to have five walkers
 * with five sets of rules. v0.80.0 warned about every file whose status the
 * convergence changes (#2571), and this module is that convergence. It is on
 * #2525's level-0 exception list.
 *
 * The rules, for every walker:
 *
 * - `node_modules` and `.git` are never entered.
 * - Dot-directories are skipped. The audit walk keeps `.github` and
 *   `.forgejo`, which hold the CI files it audits.
 * - `dist` is skipped.
 * - Git-ignored paths are skipped, nested `.gitignore` files, `.git/info/exclude`
 *   and the global excludes file included, the way git itself decides. Only
 *   paths below the scan root are asked about: when the scan root is itself
 *   ignored, nothing under it is dropped for being ignored, so building or
 *   linting an ignored directory still reads it.
 * - When the scan root is inside a chant project, a child directory holding a
 *   project config is a boundary and is not entered. A `chant.config.json`
 *   holding only lint keys is a fragment, not a project config, and is not a
 *   boundary. A `chant.config.ts` always is one, since telling a lint-only one
 *   apart would mean running it. When the scan root is outside every project,
 *   every child project is read. Op discovery always stops at child projects
 *   below its root.
 * - The project's `exclude` globs (#2519) drop what they match, and its
 *   `include` globs re-admit what `exclude` or any rule above would skip.
 *   `node_modules`, `.git` and workspace members are the exceptions: include
 *   never re-admits them.
 * - Workspace members and group matches leave the root project's walk
 *   (#2525 rule 3), and only when a workspace declaration exists. Without one nothing is loaded and
 *   nothing is excluded; see {@link workspaceMemberDirs}.
 *
 * The walk is synchronous: the audit walk it replaced was, and the glob and
 * ignore facts are gathered once before it starts.
 */

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, type Dirent } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
// @ts-ignore — picomatch has no types declaration
import picomatch from "picomatch";
import { findProjectConfig, findWorkspaceRoot } from "../project-root";
import { isLintOnlyFragment, type DiscoveryGlobs } from "../config";

/** The commands that walk the tree. */
export type DiscoveryWalker = "source" | "lint" | "components" | "ops" | "audit";

/** Dot-directories the audit walk enters anyway, since they hold the CI files it audits. */
export const AUDIT_DOT_DIRS: ReadonlySet<string> = new Set([".github", ".forgejo"]);

/** Directories no rule and no glob ever lets the walk into. */
const NEVER_ENTER = new Set(["node_modules", ".git"]);

/** One walk: which walker, where from, which files it wants, and the facts only some walkers have. */
export interface WalkOptions {
  walker: DiscoveryWalker;
  /** The directory the walk starts from. Joined onto, never resolved, so relative roots give relative paths. */
  root: string;
  /**
   * Which files the walker wants, by name and full path. Called only for a
   * file every rule above has let through, so a marker check here reads only
   * files that could be returned.
   */
  accept: (name: string, fullPath: string) => boolean;
  /**
   * The project's discovery globs. Omitted, none apply. Callers that can load
   * the project config resolve them with `resolveDiscoveryGlobs`.
   */
  globs?: DiscoveryGlobs;
  /** Sort each directory's entries by name. The audit walk does, for a stable limit. */
  sorted?: boolean;
  /** Follow symlinked directories and files. `chant lint` always did; the others never did. */
  followSymlinks?: boolean;
  /**
   * The audit walk's file limit. Every file the walk takes counts, accepted or
   * not; `truncated` is set once a file past the limit is met.
   */
  limit?: { max: number; truncated: boolean };
  /**
   * Called for a dot-directory the walk skips. Returning true takes the
   * directory's own path as a file without entering it (the audit walk's
   * `.terraform`, which TF023 reports by its presence).
   */
  takeSkippedDir?: (name: string, fullPath: string) => boolean;
  /**
   * Paths the git-ignore rule leaves alone, to be judged by the caller. The
   * audit walk keeps Terraform state paths for TF023, which has its own
   * `.gitignore` reading.
   */
  keepIgnored?: (fullPath: string) => boolean;
  /** Directories that leave this walk, absolute. See {@link workspaceMemberDirs}. */
  excludeDirs?: readonly string[];
}

// ── Globs ────────────────────────────────────────────────────────────────────

/** A project's `exclude` and `include` globs, compiled against the config's directory. */
interface CompiledGlobs {
  /** True when an `exclude` pattern matches the path or a directory above it. */
  excluded(full: string): boolean;
  /** True when an `include` pattern matches the path or a directory above it. */
  included(full: string): boolean;
  /** True when some `include` pattern names a path strictly below directory `full`. */
  includeBelow(full: string): boolean;
}

/** Path parts below `home`, or undefined for `home` itself or a path outside it. */
function partsBelow(home: string, full: string): string[] | undefined {
  const rel = relative(home, resolve(full));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep);
}

function compileGlobs(globs: DiscoveryGlobs | undefined): CompiledGlobs | undefined {
  if (!globs || (globs.exclude.length === 0 && globs.include.length === 0)) return undefined;
  const home = resolve(globs.root);
  const matcher = (patterns: string[]): ((full: string) => boolean) => {
    if (patterns.length === 0) return () => false;
    const match: (p: string) => boolean = picomatch(patterns, { dot: true });
    return (full) => {
      const parts = partsBelow(home, full);
      return parts !== undefined && parts.some((_, i) => match(parts.slice(0, i + 1).join("/")));
    };
  };
  // The literal directory part of each include pattern: `.cache/keep/**`
  // gives `.cache/keep`. The walk enters a skipped directory on the way to it.
  const bases = globs.include.map((p) => (picomatch.scan(p) as { base: string }).base).filter((b) => b !== "");
  return {
    excluded: matcher(globs.exclude),
    included: matcher(globs.include),
    includeBelow: (full) => {
      const parts = partsBelow(home, full);
      if (parts === undefined) return false;
      const rel = parts.join("/");
      return bases.some((b) => b.startsWith(`${rel}/`));
    },
  };
}

// ── Git ──────────────────────────────────────────────────────────────────────

/**
 * The untracked paths git ignores under `root`, absolute, with fully ignored
 * directories listed once. One `git ls-files` call. A tree outside git, a
 * missing `git`, or a root that is itself ignored yields an empty set: ignore
 * rules are asked only about paths below the scan root.
 */
export function gitIgnoredBelow(root: string): Set<string> {
  let out: string;
  try {
    out = execFileSync("git", ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return new Set();
  }
  const ignored = new Set<string>();
  const abs = resolve(root);
  for (const entry of out.split("\0")) {
    if (entry === "") continue;
    const rel = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    // `./` (or `.`): the scan root is itself ignored.
    if (rel === "." || rel === "") return new Set();
    ignored.add(join(abs, rel));
  }
  return ignored;
}

// ── Boundaries ───────────────────────────────────────────────────────────────

/** A directory that holds a project config: `chant.config.ts`, or a `chant.config.json` that is not a lint-only fragment. */
export function isProjectBoundary(dir: string): boolean {
  if (existsSync(join(dir, "chant.config.ts"))) return true;
  const json = join(dir, "chant.config.json");
  return existsSync(json) && !isLintOnlyFragment(json);
}

/** Whether child projects end the walk from `root`: always for Ops, otherwise when `root` is inside a project. */
export function childProjectsAreBoundaries(walker: DiscoveryWalker, root: string): boolean {
  return walker === "ops" || findProjectConfig(root).configPath !== undefined;
}

// ── Workspace members ────────────────────────────────────────────────────────

/**
 * The directories a workspace declaration moves out of the root project's
 * discovery (#2525 rule 3), absolute and strictly below `root`, or none:
 * every member's directory but the root's, and every group match
 * (`rootExclusions` in `../workspace/declaration.ts`).
 *
 * Level 0 pays for `findWorkspaceRoot`, which only tests whether a
 * `chant.workspace.json` or `.jsonc` exists from `root` up to the git root,
 * and loads nothing. Only when a declaration is found are the workspace
 * modules loaded to read it. A declaration that fails to read excludes
 * nothing here; `chant workspace ls` is where its errors are reported. This
 * is the only place discovery asks about workspaces; the walkers pass the
 * result as `excludeDirs`.
 */
export async function workspaceMemberDirs(root: string): Promise<string[]> {
  const found = findWorkspaceRoot(root);
  if (!found) return [];
  const start = resolve(root);
  const [{ readDeclaration, resolveGroups, rootExclusions }, { workingTree }] = await Promise.all([
    import("../workspace/declaration"),
    import("../workspace/tree"),
  ]);
  let dirs: string[];
  try {
    const tree = workingTree(found.dir);
    const declaration = readDeclaration(tree);
    dirs = rootExclusions(declaration, resolveGroups(declaration, tree)).map((e) => resolve(found.dir, e.dir));
  } catch {
    return [];
  }
  return dirs.filter((d) => partsBelow(start, d) !== undefined);
}

// ── Markers ──────────────────────────────────────────────────────────────────

/** The first `bytes` of a file as UTF-8, or "" when it can't be read. */
export function readHead(file: string, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.toString("utf8", 0, n);
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ── The walk ─────────────────────────────────────────────────────────────────

/** Walk `opts.root` under the rules in the module doc and return the files `accept` took. */
export function walkDiscovery(opts: WalkOptions): string[] {
  const out: string[] = [];
  const globs = compileGlobs(opts.globs);
  const ignored = gitIgnoredBelow(opts.root);
  const boundaries = childProjectsAreBoundaries(opts.walker, opts.root);
  const excludeDirs = new Set((opts.excludeDirs ?? []).map((d) => resolve(d)));
  const dotDirsKept = opts.walker === "audit" ? AUDIT_DOT_DIRS : new Set<string>();
  const limit = opts.limit;

  const isIgnored = (full: string): boolean => ignored.size > 0 && ignored.has(resolve(full));

  /** Take a path; false once the limit is reached. */
  const take = (full: string): boolean => {
    if (limit && out.length >= limit.max) {
      limit.truncated = true;
      return false;
    }
    out.push(full);
    return true;
  };

  const kind = (dir: string, e: Dirent): "dir" | "file" | undefined => {
    if (e.isDirectory()) return "dir";
    if (e.isFile()) return "file";
    if (opts.followSymlinks && e.isSymbolicLink()) {
      try {
        const s = statSync(join(dir, e.name));
        return s.isDirectory() ? "dir" : s.isFile() ? "file" : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  /**
   * Walk `dir`. `probing` is true below a directory a rule skipped that the
   * walk entered only because an `include` pattern names something inside
   * it: there, only what `include` matches is taken.
   */
  const walk = (dir: string, probing: boolean): boolean => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    if (opts.sorted) entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (limit?.truncated) return false;
      const full = join(dir, e.name);
      const type = kind(dir, e);
      if (type === "dir") {
        if (NEVER_ENTER.has(e.name) || excludeDirs.has(resolve(full))) continue;
        const dotSkip = e.name.startsWith(".") && !dotDirsKept.has(e.name);
        if (dotSkip && opts.takeSkippedDir?.(e.name, full)) {
          if (!take(full)) return false;
          continue;
        }
        const ruleSkip =
          dotSkip ||
          e.name === "dist" ||
          (isIgnored(full) && !opts.keepIgnored?.(full)) ||
          (boundaries && isProjectBoundary(full));
        if (ruleSkip || probing) {
          if (globs?.included(full)) {
            if (!walk(full, false)) return false;
          } else if (globs?.includeBelow(full)) {
            if (!walk(full, true)) return false;
          }
          continue;
        }
        if (!walk(full, false)) return false;
      } else if (type === "file") {
        const skipped =
          probing ||
          (isIgnored(full) && !opts.keepIgnored?.(full)) ||
          (globs?.excluded(full) ?? false);
        if (skipped && !globs?.included(full)) continue;
        if (!opts.accept(e.name, full)) continue;
        if (!take(full)) return false;
      }
    }
    return true;
  };

  walk(opts.root, false);
  return out;
}
