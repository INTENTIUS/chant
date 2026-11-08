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
 * ({@link stampedChanges}). Only `version` changes: dependency ranges and
 * every other field are left as committed. scripts/release-pack.sh does the
 * same for chant itself, and more (the `@intentius/` ranges, the floors, the
 * packing in dependency layers), so chant's own release keeps it.
 *
 * This module reaches only Node's built-ins and git.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { NEXT_RELEASE } from "../release-floors";

/** The first chant with `release.version` and `chant release stamp` (#4840). Products feature-detect on it. */
export const RELEASE_VERSION_FLOOR = NEXT_RELEASE;

/** `release.version` in `chant.config.ts`. */
export interface ReleaseVersionConfig {
  /** The package directories, relative to the member, whose `package.json` takes the label as its `version`: `"."` for the member's own. */
  packages: string[];
  /** The lockfile whose entries for those packages take it too. Default `package-lock.json` when the member has one; `false` for none. */
  lockfile?: string | false;
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
    throw new ReleaseVersionError("release-version-no-label", "release.version stamps the release's label into package.json, and this release has no label", "Cut it with a label: chant release cut <version>.");
  }
  if (!SEMVER.test(label)) {
    throw new ReleaseVersionError(
      "release-version-label-invalid",
      `release.version stamps the label into package.json, and "${label}" is not a version npm takes`,
      `Label the release MAJOR.MINOR.PATCH, such as ${SEMVER.test(label.replace(/^v/, "")) ? label.replace(/^v/, "") : "1.4.0"}${/^v\d/.test(label) ? ", with no v" : ""}.`,
    );
  }
}

const norm = (p: string): string => posix.normalize(p.split("\\").join("/")).replace(/\/$/, "") || ".";

const outside = (p: string): boolean => isAbsolute(p) || norm(p).split("/").includes("..");

/** Check the declaration's paths: at least one package, every path inside the member. */
export function checkReleaseVersion(config: ReleaseVersionConfig): void {
  if (config.packages.length === 0) throw new ReleaseVersionError("release-version-invalid", "release.version.packages names no package directory");
  for (const p of [...config.packages, ...(typeof config.lockfile === "string" ? [config.lockfile] : [])]) {
    if (outside(p)) throw new ReleaseVersionError("release-version-invalid", `release.version: ${p} is not a path inside the member`);
  }
}

/** The lockfile the declaration names, relative to the member, or null. */
function lockfileOf(cwd: string, config: ReleaseVersionConfig): string | null {
  if (config.lockfile === false) return null;
  if (typeof config.lockfile === "string") return norm(config.lockfile);
  return existsSync(resolve(cwd, "package-lock.json")) ? "package-lock.json" : null;
}

/** The files the release stamps, relative to the member: each package's `package.json`, then the lockfile. */
export function releaseVersionFiles(cwd: string, config: ReleaseVersionConfig): string[] {
  const files = config.packages.map((p) => (norm(p) === "." ? "package.json" : `${norm(p)}/package.json`));
  const lock = lockfileOf(cwd, config);
  return lock ? [...files, lock] : files;
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

/**
 * One file's text stamped with `label`: a `package.json`'s `version`, or a
 * lockfile's entries for `packageDirs` (relative to the lockfile's
 * directory), with the root entry's `version` beside it for `"."`. A
 * lockfile entry that is not there is not added.
 */
export function stampText(text: string, label: string, kind: "package" | "lockfile", packageDirs: readonly string[] = []): string {
  if (kind === "package") {
    return rewrite(text, (doc) => {
      if (typeof doc.version !== "string") throw new ReleaseVersionError("release-version-no-package", "package.json has no version to stamp");
      doc.version = label;
    });
  }
  return rewrite(text, (doc) => {
    const packages = (doc.packages ?? {}) as Record<string, { version?: unknown }>;
    for (const dir of packageDirs) {
      const key = dir === "." ? "" : dir;
      const entry = packages[key];
      if (entry && typeof entry === "object" && typeof entry.version === "string") entry.version = label;
      if (key === "" && typeof doc.version === "string") doc.version = label;
    }
  });
}

/** Each stamped file's text, given its committed text. */
function stamper(cwd: string, config: ReleaseVersionConfig, label: string): (file: string, text: string) => string {
  const lock = lockfileOf(cwd, config);
  const lockDir = lock ? posix.dirname(lock) : ".";
  const dirs = config.packages.map((p) => norm(posix.relative(lockDir, norm(p))) || ".");
  return (file, text) => (file === lock ? stampText(text, label, "lockfile", dirs) : stampText(text, label, "package"));
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
export function stampReleaseVersion(i: { cwd: string; config: ReleaseVersionConfig; label: string | null }): Stamped {
  checkReleaseVersion(i.config);
  checkVersionLabel(i.label);
  const stamp = stamper(i.cwd, i.config, i.label);
  const files = releaseVersionFiles(i.cwd, i.config);
  const before = new Map<string, string>();
  for (const f of files) {
    const abs = resolve(i.cwd, f);
    if (!existsSync(abs)) throw new ReleaseVersionError("release-version-no-package", `release.version names ${f}, which does not exist`, "Name the directory that holds the package.json, as the npm target does.");
    before.set(f, readFileSync(abs, "utf-8"));
  }
  const after = new Map<string, string>();
  for (const [f, text] of before) {
    try {
      after.set(f, stamp(f, text));
    } catch (err) {
      if (err instanceof ReleaseVersionError) throw new ReleaseVersionError(err.code, `${f}: ${err.message}`);
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
export function stampedChanges(i: { cwd: string; top: string; commit: string; config: ReleaseVersionConfig; label: string | null; status: string }): Set<string> {
  const out = new Set<string>();
  if (i.label === null || !SEMVER.test(i.label)) return out;
  const stamp = stamper(i.cwd, i.config, i.label);
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
    let expected: string;
    try {
      expected = stamp(rel, committed);
    } catch {
      continue;
    }
    if (readFileSync(resolve(i.cwd, rel), "utf-8") === expected) out.add(path);
  }
  return out;
}
