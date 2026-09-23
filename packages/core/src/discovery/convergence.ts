/**
 * The warning release for chant#2527, which converges the discovery walkers.
 *
 * Five walkers decide which files chant reads: source discovery
 * (`./files.ts`'s `findInfraFiles`, behind build, graph, list and explain),
 * lint (`../cli/commands/lint.ts`), component discovery
 * (`../components/discover.ts`), Op discovery (`../op/discover.ts`) and the
 * audit walk (`../audit/discover.ts`). They disagree about dot-directories,
 * git-ignored files, `dist` and child projects. The next release makes them
 * agree:
 *
 * - dot-directories are skipped, except `.github` and `.forgejo` for audit;
 * - git-ignored files are skipped, nested `.gitignore` files included, with
 *   ignore rules evaluated only for paths below the scan root;
 * - `dist` is skipped;
 * - when the scan root is inside a project, a child directory holding a
 *   project config is a boundary (a lint-only `chant.config.json` fragment is
 *   not one); when it is outside a project, every child project is read; Op
 *   discovery always stops at child projects below its root;
 * - the source-root quirk goes: today source and component discovery read
 *   the first child project they meet as the project's own source and skip
 *   every later one.
 *
 * This release changes none of that. It runs after each walk, classifies the
 * files the walk returned (and, where the next release reads more, the
 * subtrees the walk skipped) under the converged rules, and prints one
 * warning per affected group on stderr, naming the `include` or `exclude`
 * glob (#2519) that keeps today's behaviour. The warning goes away only when
 * that glob is in the project config.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
// @ts-ignore — picomatch has no types declaration
import picomatch from "picomatch";
import { findProjectConfig } from "../project-root";
import { isLintOnlyFragment, loadChantConfig } from "../config";

/** The walker a warning is about, which is also how the warning names it. */
export type DiscoveryWalker = "source" | "lint" | "components" | "ops" | "audit";

const WALKER_LABEL: Record<DiscoveryWalker, string> = {
  source: "Source discovery (build, graph, list, explain)",
  lint: "chant lint",
  components: "Component discovery",
  ops: "Op discovery",
  audit: "chant audit",
};

/** Why a file's status changes next release. */
type Cause = "dot-dir" | "dist" | "child-project" | "source-root" | "git-ignored" | "every-child" | "ignored-above-root";

interface Change {
  file: string;
  /** `skip`: read today, skipped next release. `read`: the reverse. */
  kind: "skip" | "read";
  cause: Cause;
  /** The directory (or, for a lone ignored file, the file) the cause attaches to. */
  anchor: string;
}

/** Dot-directories the audit walk keeps, since they hold the CI files it audits. */
const AUDIT_DOT_DIRS = new Set([".github", ".forgejo"]);

/** Generated type stubs `chant init` and `chant update` write: never worth a warning. */
const GENERATED_TYPES = `${sep}.chant${sep}types${sep}`;

export interface DiscoveryWalkInput {
  walker: DiscoveryWalker;
  /** The directory the walk started from. */
  root: string;
  /** The files the walk returned, absolute. */
  files: readonly string[];
  /**
   * Source and component discovery: the first child project the walk met,
   * which it read as the project's own source.
   */
  sourceRoot?: string | null;
  /**
   * Source and component discovery: the child projects the walk skipped
   * because it had already met one. Read next release when the scan root is
   * outside a project.
   */
  skippedChildren?: readonly string[];
  /** The walker's file filter, applied to what a skipped child holds. */
  fileOk?: (name: string, fullPath: string) => boolean | Promise<boolean>;
  /**
   * Lint only: the files the walk found before its git-ignore filter dropped
   * some, and the paths that filter reported ignored. The filter's call
   * carries the scan root as an extra probe, so no second `git` call is made.
   */
  lintIgnored?: { raw: readonly string[]; ignored: ReadonlySet<string> };
}

/**
 * Paths `git check-ignore` reports ignored, in one batched call run from
 * `cwd`. A path is reported exactly as given. A tree outside git, a missing
 * `git`, or nothing ignored (exit 1) yields an empty set.
 */
export function gitIgnoredPaths(paths: readonly string[], cwd: string): Set<string> {
  if (paths.length === 0) return new Set();
  try {
    const out = execFileSync("git", ["check-ignore", "--stdin"], {
      cwd,
      input: paths.join("\n"),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return new Set(out.split(/\r?\n/).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** The probe for a directory in a `git check-ignore` batch: a trailing slash makes git match it as a directory. */
export function dirProbe(dir: string): string {
  return dir.endsWith(sep) ? dir : dir + sep;
}

/** A child directory that ends a scan inside a project next release: it holds a project config, not a lint-only fragment. */
function isProjectBoundary(dir: string): boolean {
  if (existsSync(join(dir, "chant.config.ts"))) return true;
  const json = join(dir, "chant.config.json");
  return existsSync(json) && !isLintOnlyFragment(json);
}

/** Ancestor directories of `file` strictly below `root`, outermost first. */
function dirsBetween(root: string, file: string): string[] {
  const rel = relative(root, dirname(file));
  if (rel === "" || rel.startsWith("..")) return [];
  const parts = rel.split(sep);
  return parts.map((_, i) => join(root, ...parts.slice(0, i + 1)));
}

/** Walk a subtree the old walker skipped, under the converged directory rules. */
async function walkConverged(
  dir: string,
  walker: DiscoveryWalker,
  fileOk: (name: string, fullPath: string) => boolean | Promise<boolean>,
  out: string[],
): Promise<void> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      if (entry.name.startsWith(".") && !(walker === "audit" && AUDIT_DOT_DIRS.has(entry.name))) continue;
      await walkConverged(full, walker, fileOk, out);
    } else if (entry.isFile() && (await fileOk(entry.name, full))) {
      out.push(full);
    }
  }
}

/**
 * Classify a walk's files under the converged rules and return what changes.
 * Exported for tests; {@link warnDiscoveryChanges} is the entry point.
 */
export async function discoveryChanges(input: DiscoveryWalkInput): Promise<Change[]> {
  const root = resolve(input.root);
  const walker = input.walker;
  const inProject = findProjectConfig(root).configPath !== undefined;
  const boundaries = walker === "ops" || inProject;
  const sourceRoot = input.sourceRoot ? resolve(input.sourceRoot) : null;

  const boundaryMemo = new Map<string, boolean>();
  const boundary = (dir: string): boolean => {
    let hit = boundaryMemo.get(dir);
    if (hit === undefined) {
      hit = isProjectBoundary(dir);
      boundaryMemo.set(dir, hit);
    }
    return hit;
  };

  /** The directory rule that skips `file` next release, outermost first. */
  const dirCause = (file: string): { cause: Cause; anchor: string } | undefined => {
    for (const dir of dirsBetween(root, file)) {
      const name = dir.slice(dir.lastIndexOf(sep) + 1);
      if (name.startsWith(".") && !(walker === "audit" && AUDIT_DOT_DIRS.has(name))) return { cause: "dot-dir", anchor: dir };
      if (name === "dist") return { cause: "dist", anchor: dir };
      if (boundaries && boundary(dir)) return { cause: dir === sourceRoot ? "source-root" : "child-project", anchor: dir };
    }
    return undefined;
  };

  const changes: Change[] = [];
  const pendingIgnore: string[] = [];
  const lint = input.lintIgnored;
  const lintRootIgnored = lint ? lint.ignored.has(dirProbe(root)) || lint.ignored.has(dirProbe(input.root)) : false;

  const files = lint ? lint.raw : input.files;
  for (const given of files) {
    // Walkers join onto the path they were given, which may be relative;
    // lint's ignored set holds the paths exactly as it passed them to git.
    const file = resolve(given);
    if (file.includes(GENERATED_TYPES)) continue;
    const skip = dirCause(file);
    if (lint) {
      const ignoredToday = lint.ignored.has(given);
      if (ignoredToday && lintRootIgnored && !skip) {
        // Ignored only because the scan root itself is: today's filter drops
        // it, the converged rule (ignore rules below the root only) reads it.
        changes.push({ file, kind: "read", cause: "ignored-above-root", anchor: root });
        continue;
      }
      if (ignoredToday) continue; // skipped today and next release alike
    }
    if (skip) {
      changes.push({ file, kind: "skip", ...skip });
      continue;
    }
    if (!lint) pendingIgnore.push(file);
  }

  // Outside a project the next release reads every child project; today the
  // walk read only the first one it met.
  const added: string[] = [];
  const addedAnchor = new Map<string, string>();
  if (!inProject && input.skippedChildren?.length && input.fileOk) {
    for (const child of input.skippedChildren) {
      const found: string[] = [];
      await walkConverged(child, walker, input.fileOk, found);
      for (const f of found) {
        if (f.includes(GENERATED_TYPES)) continue;
        added.push(f);
        addedAnchor.set(f, child);
      }
    }
  }

  // One batched `git check-ignore` for everything the converged walk would
  // otherwise read, plus the scan root and the directories between (to name
  // the outermost ignored directory, and to apply ignore rules below the scan
  // root only).
  if (pendingIgnore.length > 0 || added.length > 0) {
    const dirs = new Set<string>();
    for (const f of [...pendingIgnore, ...added]) for (const d of dirsBetween(root, f)) dirs.add(dirProbe(d));
    const probes = [dirProbe(root), ...dirs, ...pendingIgnore, ...added];
    const ignored = gitIgnoredPaths(probes, root);
    if (ignored.size > 0 && !ignored.has(dirProbe(root))) {
      const ignoredAnchor = (file: string): string =>
        dirsBetween(root, file).find((d) => ignored.has(dirProbe(d))) ?? file;
      for (const file of pendingIgnore) {
        if (ignored.has(file)) changes.push({ file, kind: "skip", cause: "git-ignored", anchor: ignoredAnchor(file) });
      }
      for (let i = added.length - 1; i >= 0; i--) if (ignored.has(added[i])) added.splice(i, 1);
    }
  }
  for (const file of added) changes.push({ file, kind: "read", cause: "every-child", anchor: addedAnchor.get(file)! });

  return changes;
}

/** The config a fix goes in: the project config above `root`, lint-only fragments skipped. */
function globsHome(root: string): { dir: string; configPath?: string } {
  let { dir, configPath } = findProjectConfig(root);
  while (configPath && isLintOnlyFragment(configPath)) {
    const parent = dirname(dir);
    if (parent === dir) break;
    ({ dir, configPath } = findProjectConfig(parent));
  }
  return configPath ? { dir, configPath } : { dir: root };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
}

/**
 * A matcher with #2519's semantics: a pattern, relative to `home`, matches a
 * path when it matches the path or any directory above it. Dot files included.
 */
function globMatcher(patterns: string[], home: string): (path: string) => boolean {
  if (patterns.length === 0) return () => false;
  const match: (path: string) => boolean = picomatch(patterns, { dot: true });
  return (path) => {
    const rel = relative(home, path);
    if (rel === "" || rel.startsWith("..")) return false;
    const parts = rel.split(sep);
    return parts.some((_, i) => match(parts.slice(0, i + 1).join("/")));
  };
}

/**
 * Per cause: what the anchor is today, and what the next release does with it.
 * `a` is the anchor as printed (a directory ends in `/`), `r` the scan root.
 */
const REASON: Record<Cause, (a: string, r: string) => [string, string]> = {
  "dot-dir": (a) => [`${a} is a dot-directory`, "Every walker skips dot-directories from the next release"],
  dist: (a) => [`${a} is a dist directory`, "Every walker skips dist from the next release"],
  "child-project": (a) => [
    `${a} is a child project with its own chant.config`,
    "Discovery stops at child projects from the next release",
  ],
  "source-root": (a) => [
    `${a} is a child project with its own chant.config, read today as this project's own source because the walk met it first`,
    "From the next release discovery stops there, as at any child project",
  ],
  "git-ignored": (a) => [`${a} is git-ignored`, "Every walker skips git-ignored files from the next release"],
  "every-child": (a, r) => [
    `${a} is a child project, skipped today because the walk met another child project first`,
    `From the next release every child project is read, since ${r} is not inside a chant project`,
  ],
  "ignored-above-root": (_a, r) => [
    `${r} is itself git-ignored, so today nothing under it is linted`,
    "From the next release ignore rules apply below the scan root only, so the files under it are linted",
  ],
};

const MAX_LISTED = 3;
const printed = new Set<string>();

/** Forget which warnings were printed. Tests only. */
export function resetDiscoveryWarnings(): void {
  printed.clear();
}

/**
 * Print, on stderr, what the next release's converged walk will read
 * differently from the walk just made (chant#2527). Each group names its
 * files, what changes, and the `include` or `exclude` glob (#2519) that
 * keeps today's behaviour; a group whose glob is already in the project
 * config is not printed. Each warning prints once per process, however many
 * times a command walks the same tree. Returns the lines printed.
 */
export async function warnDiscoveryChanges(input: DiscoveryWalkInput): Promise<string[]> {
  let changes: Change[];
  try {
    changes = await discoveryChanges(input);
  } catch {
    return []; // the warning must never break discovery
  }
  if (changes.length === 0) return [];

  const root = resolve(input.root);
  const home = globsHome(root);
  let include: string[] = [];
  let exclude: string[] = [];
  if (home.configPath) {
    try {
      const { config } = await loadChantConfig(home.dir);
      const raw = config as unknown as Record<string, unknown>;
      include = stringList(raw.include);
      exclude = stringList(raw.exclude);
    } catch {
      // the command's own config load reports a broken config
    }
  }
  const included = globMatcher(include, home.dir);
  const excluded = globMatcher(exclude, home.dir);

  const groups = new Map<string, Change[]>();
  for (const c of changes) {
    if (c.kind === "skip" ? included(c.file) : excluded(c.file)) continue;
    const key = `${c.kind}\0${c.cause}\0${c.anchor}`;
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }
  if (groups.size === 0) return [];

  // The header names the scan root from the working directory; the files
  // and directories in each line are relative to the scan root.
  const cwd = process.cwd();
  const showDir = (p: string): string => relative(cwd, p) || "the current directory";
  const underRoot = (p: string): string => relative(root, p).split(sep).join("/");
  const where = relative(cwd, home.configPath ?? join(home.dir, "chant.config.ts")) + (home.configPath ? "" : " (a new file)");

  const lines: string[] = [];
  for (const group of [...groups.values()].sort((a, b) => (a[0].anchor < b[0].anchor ? -1 : a[0].anchor > b[0].anchor ? 1 : 0))) {
    const { kind, cause, anchor } = group[0];
    const files = group.map((c) => c.file).sort();
    const anchorIsFile = files.length === 1 && files[0] === anchor;
    const shownAnchor = anchorIsFile ? underRoot(anchor) : `${underRoot(anchor)}/`;
    const named = files.length <= MAX_LISTED ? files.map(underRoot).join(", ") : `${files.length} files under ${shownAnchor}`;
    const glob = relative(home.dir, anchor).split(sep).join("/") || "**";
    const [today, next] = REASON[cause](shownAnchor, showDir(root));
    const them = files.length === 1 ? "it" : "them";
    const fix =
      kind === "skip"
        ? `To keep reading ${them} after the change, add "${glob}" to include in ${where}, which the next release honours.`
        : `To keep skipping ${them}, add "${glob}" to exclude in ${where}.`;
    lines.push(anchorIsFile && cause === "git-ignored" ? `  ${today}. ${next}. ${fix}` : `  ${named}: ${today}. ${next}. ${fix}`);
  }

  const header = `warning: ${WALKER_LABEL[input.walker]} under ${showDir(root)} changes in the next release (chant#2527):`;
  const text = [header, ...lines].join("\n");
  if (printed.has(text)) return lines;
  printed.add(text);
  console.error(text);
  return lines;
}
