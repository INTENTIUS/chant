/**
 * The release's label as the package version (#4840).
 *
 * A product released with `chant release cut <label>` used to set its
 * version with a commit first, because the npm target publishes the
 * package directory's `package.json`, the bundle imports the version from
 * it, and `releaseImagePins` refuses a label that is not the version.
 * `release.version` in `chant.config.ts` names the package directories
 * whose `package.json` the release stamps with the label instead, and the
 * lockfile whose entries for them follow:
 *
 * ```ts
 * release: { version: { packages: ["packages/terragucci"] } },
 * ```
 *
 * The cut stamps them after its clean-tree check and before it builds the
 * images and runs the build, and puts the files back when it is done. The
 * publish job runs `chant release stamp <label>` before its build, and
 * `chant release publish` accepts a tree whose only changes are those files
 * as the commit's own stamped with the release's label
 * ({@link stampedChanges}). By default only `version` changes. With
 * `ranges` (#5155) each workspace dependency's range follows the label the
 * release or a train gives that package: `exact` and `caret` for the
 * packages the release stamps, `train` also for the packages of the other
 * members a release train pins. scripts/release-pack.sh --train does the
 * same for chant itself, and more (the floors, the packing in dependency
 * layers), so chant's own release keeps it for now. `files` (#5156) names
 * other manifests the label goes into, by format, field or pattern, edited
 * in place (./release-version-formats.ts).
 *
 * This module reaches only Node's built-ins and git.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { ManifestStampError, resolveVersionFile, stampVersionFile, versionFilePath, type ReleaseVersionFile } from "./release-version-formats";

export { MANIFEST_FORMATS, type ManifestFormat, type ManifestFile, type FieldFile, type PatternFile, type ReleaseVersionFile } from "./release-version-formats";

/** The first chant with `release.version` and `chant release stamp` (#4840). Products feature-detect on it. */
export const RELEASE_VERSION_FLOOR = "0.124.79";

/**
 * How `release.version` treats the ranges of workspace dependencies (#5155).
 * A workspace dependency is a dependency named like a package the release
 * stamps or, under `train`, like a package of a member the train pins.
 *
 * - `keep` (the default): every range stays as committed.
 * - `exact`: a dependency on a package this release stamps becomes the label, `1.4.0`.
 * - `caret`: the same, as `^1.4.0`.
 * - `train`: `^<label>` for every workspace dependency, where a package of another member takes the label the train gives that member (`chant release stamp <label> --train <id>`). The cut, which runs before any train exists, stamps the packages of its own release only.
 */
export type ReleaseRanges = "keep" | "exact" | "caret" | "train";

/** A package name to the label a train gives it; null for a member the train pins with no label. */
export type RangeLabels = Record<string, string | null>;

const RANGE_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"] as const;

/** `release.version` in `chant.config.ts`. */
export interface ReleaseVersionConfig {
  /** The package directories, relative to the member, whose `package.json` takes the label as its `version`: `"."` for the member's own. */
  packages?: string[];
  /** The lockfile whose entries for those packages take it too. Default `package-lock.json` when the member has one; `false` for none. */
  lockfile?: string | false;
  /** What happens to the ranges of workspace dependencies: `keep` (default), `exact`, `caret` or `train`. */
  ranges?: ReleaseRanges;
  /**
   * Other files the label goes into (#5156): a path whose name says its
   * format (`Cargo.toml`, `Cargo.lock`, `pyproject.toml`, `Chart.yaml`,
   * `server.json`, `artifacthub-pkg.yml`), `{ path, format }` for one that
   * doesn't (`krew`), `{ path, field }` for a field of a JSON, YAML or TOML
   * file, or `{ path, pattern }` for a regular expression.
   */
  files?: ReleaseVersionFile[];
}

export class ReleaseVersionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = "ReleaseVersionError";
  }
}

/** A version npm takes: MAJOR.MINOR.PATCH with an optional prerelease and build. */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Refuse a label `package.json` can't carry as its version. */
export function checkVersionLabel(label: string | null): asserts label is string {
  if (label === null) {
    throw new ReleaseVersionError("release-version-no-label", "release.version stamps the release's label as the version, and this release has no label", "Cut it with a label: chant release cut <version>.");
  }
  if (!SEMVER.test(label)) {
    throw new ReleaseVersionError(
      "release-version-label-invalid",
      `release.version stamps the label as the version, and "${label}" is not a version npm takes`,
      `Label the release MAJOR.MINOR.PATCH, such as ${SEMVER.test(label.replace(/^v/, "")) ? label.replace(/^v/, "") : "1.4.0"}${/^v\d/.test(label) ? ", with no v" : ""}.`,
    );
  }
}

const norm = (p: string): string => posix.normalize(p.split("\\").join("/")).replace(/\/$/, "") || ".";

const outside = (p: string): boolean => isAbsolute(p) || norm(p).split("/").includes("..");

/** Check the declaration: at least one package or file, every path inside the member, each file's format known. */
export function checkReleaseVersion(config: ReleaseVersionConfig): void {
  if (config.ranges !== undefined && !["keep", "exact", "caret", "train"].includes(config.ranges)) {
    throw new ReleaseVersionError("release-version-invalid", `release.version.ranges is "${String(config.ranges)}", not keep, exact, caret or train`);
  }
  const files = config.files ?? [];
  if ((config.packages ?? []).length === 0 && files.length === 0) throw new ReleaseVersionError("release-version-invalid", "release.version names no package directory and no file");
  for (const p of [...(config.packages ?? []), ...(typeof config.lockfile === "string" ? [config.lockfile] : []), ...files.map(versionFilePath)]) {
    if (outside(p)) throw new ReleaseVersionError("release-version-invalid", `release.version: ${p} is not a path inside the member`);
  }
  const seen = new Set<string>();
  for (const f of files) {
    const path = norm(versionFilePath(f));
    if (seen.has(path)) throw new ReleaseVersionError("release-version-invalid", `release.version.files names ${path} twice`, "Stamp a file with one entry: a pattern with several capture groups reaches several places.");
    seen.add(path);
    asVersionError(() => resolveVersionFile(f));
  }
}

/** Run `fn`, turning a format's refusal into a {@link ReleaseVersionError}. */
function asVersionError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ManifestStampError) throw new ReleaseVersionError(err.code, err.message, err.fix);
    throw err;
  }
}

/** The lockfile the declaration names, relative to the member, or null. */
function lockfileOf(cwd: string, config: ReleaseVersionConfig): string | null {
  if (config.lockfile === false || (config.packages ?? []).length === 0) return null;
  if (typeof config.lockfile === "string") return norm(config.lockfile);
  return existsSync(resolve(cwd, "package-lock.json")) ? "package-lock.json" : null;
}

/** The files the release stamps, relative to the member: each package's `package.json`, then the lockfile, then `files`. */
export function releaseVersionFiles(cwd: string, config: ReleaseVersionConfig): string[] {
  const files = (config.packages ?? []).map((p) => (norm(p) === "." ? "package.json" : `${norm(p)}/package.json`));
  const lock = lockfileOf(cwd, config);
  return [...files, ...(lock ? [lock] : []), ...(config.files ?? []).map((f) => norm(versionFilePath(f)))];
}

/** The indent a JSON file was written with, so the stamped file differs from it in the version alone. */
function indentOf(text: string): string {
  return /^\{\r?\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
}

function rewrite(text: string, edit: (doc: Record<string, unknown>) => void): string {
  const doc = JSON.parse(text) as Record<string, unknown>;
  edit(doc);
  const out = JSON.stringify(doc, null, indentOf(text));
  return text.endsWith("\n") ? `${out}\n` : out;
}

/** The range a dependency takes under `mode` at `label`. */
function rangeAt(mode: ReleaseRanges, label: string): string {
  return mode === "exact" ? label : `^${label}`;
}

/** The workspace dependencies' ranges in one `dependencies`-bearing object, rewritten in place. A range of `*` is left. */
function rewriteRanges(holder: Record<string, unknown>, mode: ReleaseRanges, table: ReadonlyMap<string, string | null>, self: string | undefined): void {
  for (const field of RANGE_FIELDS) {
    const deps = holder[field];
    if (!deps || typeof deps !== "object") continue;
    const map = deps as Record<string, unknown>;
    for (const name of Object.keys(map)) {
      if (name === self || !table.has(name) || map[name] === "*") continue;
      const label = table.get(name);
      if (label === null || label === undefined) {
        throw new ReleaseVersionError("release-ranges-unpinned", `${name} is a package of a member the train pins with no label, so its range in ${field} has no version to take`, "Cut that member with a label, record the train again, and stamp from it.");
      }
      map[name] = rangeAt(mode, label);
    }
  }
}

/** How the ranges are rewritten: the mode and the package name to label table. */
interface RangePlan {
  mode: ReleaseRanges;
  table: ReadonlyMap<string, string | null>;
}

/**
 * One file's text stamped with `label`: a `package.json`'s `version`, or a
 * lockfile's entries for `packageDirs` (relative to the lockfile's
 * directory), with the root entry's `version` beside it for `"."`. A
 * lockfile entry that is not there is not added. With `ranges` the
 * workspace dependencies' ranges follow (#5155).
 */
export function stampText(text: string, label: string, kind: "package" | "lockfile", packageDirs: readonly string[] = [], ranges?: RangePlan): string {
  const active = ranges && ranges.mode !== "keep" ? ranges : undefined;
  if (kind === "package") {
    return rewrite(text, (doc) => {
      if (typeof doc.version !== "string") throw new ReleaseVersionError("release-version-no-package", "package.json has no version to stamp");
      doc.version = label;
      if (active) rewriteRanges(doc, active.mode, active.table, typeof doc.name === "string" ? doc.name : undefined);
    });
  }
  return rewrite(text, (doc) => {
    const packages = (doc.packages ?? {}) as Record<string, { version?: unknown; name?: unknown }>;
    for (const dir of packageDirs) {
      const key = dir === "." ? "" : dir;
      const entry = packages[key];
      if (entry && typeof entry === "object" && typeof entry.version === "string") entry.version = label;
      if (entry && typeof entry === "object" && active) rewriteRanges(entry as Record<string, unknown>, active.mode, active.table, typeof entry.name === "string" ? entry.name : undefined);
      if (key === "" && typeof doc.version === "string") doc.version = label;
    }
  });
}

/** The names of the packages `config` stamps, read from their package.json. A file that is missing or has no name is skipped; the stamp refuses it. */
export function ownNames(cwd: string, config: ReleaseVersionConfig): string[] {
  const names: string[] = [];
  for (const p of config.packages ?? []) {
    try {
      const name = (JSON.parse(readFileSync(resolve(cwd, norm(p) === "." ? "package.json" : `${norm(p)}/package.json`), "utf-8")) as { name?: unknown }).name;
      if (typeof name === "string") names.push(name);
    } catch {
      // Refused with its own code when the stamp reads the file.
    }
  }
  return names;
}

/** Each stamped file's text, given its committed text. `train` is the labels a train gives other members' packages, for `ranges: "train"`. */
function stamper(cwd: string, config: ReleaseVersionConfig, label: string, train?: RangeLabels): (file: string, text: string) => string {
  const lock = lockfileOf(cwd, config);
  const lockDir = lock ? posix.dirname(lock) : ".";
  const dirs = (config.packages ?? []).map((p) => norm(posix.relative(lockDir, norm(p))) || ".");
  const others = new Map((config.files ?? []).map((f) => [norm(versionFilePath(f)), f] as const));
  const mode = config.ranges ?? "keep";
  let plan: RangePlan | undefined;
  if (mode !== "keep") {
    const table = new Map<string, string | null>();
    if (mode === "train") for (const [name, l] of Object.entries(train ?? {})) table.set(name, l);
    for (const name of ownNames(cwd, config)) table.set(name, label);
    plan = { mode, table };
  }
  return (file, text) => {
    const other = others.get(file);
    if (other !== undefined) return asVersionError(() => stampVersionFile(other, text, label));
    return file === lock ? stampText(text, label, "lockfile", dirs, plan) : stampText(text, label, "package", [], plan);
  };
}

export interface Stamped {
  /** The files stamped, relative to the member. */
  files: string[];
  /** Put every stamped file back as it was. */
  restore(): void;
}

/**
 * Stamp the label into each file {@link releaseVersionFiles} names, and
 * return how to put them back. Refuses a label that is not a version and a
 * package directory with no `package.json`, before anything is written.
 */
export function stampReleaseVersion(i: { cwd: string; config: ReleaseVersionConfig; label: string | null; train?: RangeLabels }): Stamped {
  checkReleaseVersion(i.config);
  checkVersionLabel(i.label);
  const stamp = stamper(i.cwd, i.config, i.label, i.train);
  const files = releaseVersionFiles(i.cwd, i.config);
  const others = new Set((i.config.files ?? []).map((f) => norm(versionFilePath(f))));
  const before = new Map<string, string>();
  for (const f of files) {
    const abs = resolve(i.cwd, f);
    if (!existsSync(abs) && others.has(f)) throw new ReleaseVersionError("release-version-no-file", `release.version.files names ${f}, which does not exist`, "Name the file by its path relative to the member's chant.config.ts.");
    if (!existsSync(abs)) throw new ReleaseVersionError("release-version-no-package", `release.version names ${f}, which does not exist`, "Name the directory that holds the package.json, as the npm target does.");
    before.set(f, readFileSync(abs, "utf-8"));
  }
  const after = new Map<string, string>();
  for (const [f, text] of before) {
    try {
      after.set(f, stamp(f, text));
    } catch (err) {
      if (err instanceof ReleaseVersionError && others.has(f)) throw err;
      if (err instanceof ReleaseVersionError) throw new ReleaseVersionError(err.code, `${f}: ${err.message}`, err.fix);
      throw new ReleaseVersionError("release-version-invalid", `${f} is not JSON: ${(err as Error).message}`);
    }
  }
  for (const [f, text] of after) writeFileSync(resolve(i.cwd, f), text);
  let restored = false;
  return {
    files,
    restore() {
      if (restored) return;
      restored = true;
      for (const [f, text] of before) writeFileSync(resolve(i.cwd, f), text);
    },
  };
}

function gitShow(cwd: string, commit: string, file: string): string | null {
  try {
    return execFileSync("git", ["show", `${commit}:./${file}`], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/**
 * Of `git status --porcelain` lines, the paths (relative to the member)
 * that are a stamped file whose text is exactly the commit's stamped with
 * `label`. A publish takes those as the commit's (#4840); every other
 * change still makes the tree dirty. `top` is the repository root the
 * porcelain paths are relative to.
 */
export function stampedChanges(i: { cwd: string; top: string; commit: string; config: ReleaseVersionConfig; label: string | null; status: string; trains?: readonly RangeLabels[] }): Set<string> {
  const out = new Set<string>();
  if (i.label === null || !SEMVER.test(i.label)) return out;
  // Under `ranges: "train"` a tree is also the commit's when it was stamped from a train (#5155).
  const label = i.label;
  const stamps = [stamper(i.cwd, i.config, label), ...(i.config.ranges === "train" ? (i.trains ?? []).map((t) => stamper(i.cwd, i.config, label, t)) : [])];
  const files = new Set(releaseVersionFiles(i.cwd, i.config));
  // git prints the top as its real path (macOS's /private/var for /var).
  const cwd = realpathSync(i.cwd);
  const top = realpathSync(i.top);
  for (const line of i.status.split("\n")) {
    // Only a modified tracked file, " M" or "M ", can be a stamp.
    if (!/^(?: M|M |MM) /.test(line)) continue;
    const path = line.slice(3);
    const rel = relative(cwd, resolve(top, path)).split("\\").join("/");
    if (!files.has(rel)) continue;
    const committed = gitShow(i.cwd, i.commit, rel);
    if (committed === null) continue;
    const actual = readFileSync(resolve(i.cwd, rel), "utf-8");
    for (const stamp of stamps) {
      try {
        if (stamp(rel, committed) === actual) {
          out.add(path);
          break;
        }
      } catch {
        // This stamp can't be made from the commit's file; try the next.
      }
    }
  }
  return out;
}
