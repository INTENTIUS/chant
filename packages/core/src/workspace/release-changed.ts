/**
 * The `release-changed` read (#5134, design #5132 decisions 3 and 4): the
 * members of a workspace whose members release separately, that a release at
 * one commit has to cut, in the order to publish them.
 *
 * `chant release changed [--at <sha>] [--bump-member <member>=<level>]... [--json]`
 * prints this document. It runs in the root of the workspace whose `chant`
 * members are the releasable units (the nested `release/` workspace of a
 * repository that publishes many packages), reads local refs and tags only,
 * and never fetches.
 *
 * For each `chant` member it finds the commit of its last release: the newest
 * cut in the member's ledger, else the newest legacy tag, one of the
 * `release.legacyTags` prefixes of the root's `chant.config.ts` or the
 * member's own followed by a version (`release/npm/0.124.44`,
 * `chant-v0.124.44`). It then lists the
 * paths changed from there to the commit, takes the outer member that holds
 * each (`memberHolding`, the outermost workspace's members, one of which has
 * the member's own name), and drops the paths `changes.ignore` matches and
 * the generated files. A member with paths left, or with no release yet, is
 * `changed`.
 *
 * The closure then runs to a fixed point:
 *
 * - upward: a member of the release also releases each workspace dependency
 *   of it, direct or transitive, that is `changed` (`needed-by <member>`; a
 *   changed member no other member needs keeps `paths-changed`).
 *   Dependencies are the `dependencies`, `peerDependencies` and
 *   `optionalDependencies` of the member's package.json at the commit, as
 *   `publish_layers` reads them.
 * - downward: a dependent the release does not already take is added when
 *   the range its last release's package.json gives a dependency does not
 *   admit that dependency's next label (`range-broken-by <member>`). The next
 *   label is the last label bumped by `--bump-member` (default patch).
 *
 * Members come in dependency layers, each layer sorted by name.
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
// @ts-ignore — picomatch has no types declaration
import picomatch from "picomatch";
import { findWorkspaceRoot } from "../project-root";
import { readAllReleases, readCuts } from "../lifecycle/release-store";
import { resolveMemberLedger } from "../lifecycle/member-ledger";
import { readDeclaration, readerVersion, type Declaration } from "./declaration";
import { isGeneratedPath } from "./generated-files";
import { memberHolding } from "./record-assets";
import { workingTree } from "./tree";
import { changelogBump } from "../lifecycle/release-changelog";

export const RELEASE_CHANGED_CONTRACT_VERSION = 1;
export const RELEASE_CHANGED_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/release-changed/v1/release-changed.schema.json";

/** Why the read stopped. Closed; each code is in `reason-codes.ts`. */
export const RELEASE_CHANGED_ERROR_CODES = ["not-a-git-repository", "declaration-missing", "revision-unknown", "bump-invalid", "ledger-unreadable", "intent-invalid"] as const;

/** Why a member is in the release. Closed; each code is in `reason-codes.ts`. */
export const RELEASE_CHANGED_REASON_CODES = ["paths-changed", "needed-by", "range-broken-by", "intent-pending"] as const;

export const RELEASE_BUMPS = ["major", "minor", "patch"] as const;
export type ReleaseBump = (typeof RELEASE_BUMPS)[number];

export interface ReleaseChangedReason {
  code: (typeof RELEASE_CHANGED_REASON_CODES)[number];
  /** The member that needs this one (`needed-by`) or whose next label breaks its range (`range-broken-by`); null for `changed`. */
  member: string | null;
}

export interface LastRelease {
  /** The label of the release, or null when its cut has none. */
  label: string | null;
  /** The full sha it was cut from. */
  commit: string;
  /** `ledger` for a cut in the member's ledger, `legacy` for a legacy tag. */
  source: "ledger" | "legacy";
}

export interface ReleaseChangedMember {
  member: string;
  /** The dependency layer, 0 for the members that need no other member of the release. Members of one layer publish together. */
  layer: number;
  reason: ReleaseChangedReason;
  /** The member's last release, or null when it has none. */
  last: LastRelease | null;
  /** The bump applied to `last.label`. */
  bump: ReleaseBump;
  /**
   * Where the bump came from (#5159): `flag` for `--bump-member`, `commits`
   * or `intents` for the higher of the conventional commits over `paths`
   * since the last release and the pending intent files (`commits` when
   * they tie), `default` for a patch when neither gives one.
   */
  bumpFrom: "flag" | "commits" | "intents" | "default";
  /** The intent files under `.chant/release/` that name the member and that no cut of it consumed (#5159), by path. */
  intents: string[];
  /** The label a release of it would carry, or null when there is no last label to bump. */
  next: string | null;
  /** The changed paths that count, from the outermost workspace root. Empty for a member taken only by the closure. */
  paths: string[];
}

export type ReleaseChangedDocument =
  | {
      $schema: string;
      contract: number;
      chant: string;
      /** The full sha the read was made at. */
      at: string;
      /** In publish order: layer, then name. */
      members: ReleaseChangedMember[];
    }
  | { $schema: string; contract: number; chant: string; error: { code: (typeof RELEASE_CHANGED_ERROR_CODES)[number]; message: string } };

export interface ReleaseChangedQuery {
  cwd: string;
  /** The commit to read at; the tip of the trunk without it. */
  at?: string;
  /** `<member>=<level>` bumps; a member with none gets a patch. */
  bump?: string[];
}

class ReadFailure extends Error {
  constructor(
    readonly code: (typeof RELEASE_CHANGED_ERROR_CODES)[number],
    message: string,
  ) {
    super(message);
  }
}

function git(top: string, args: string[]): string {
  return execFileSync("git", args, { cwd: top, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 }).trim();
}

function tryGit(top: string, args: string[]): string | null {
  try {
    return git(top, args);
  } catch {
    return null;
  }
}

// --- versions and ranges -----------------------------------------------------

type Version = [number, number, number];

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** `1.2.3` (a leading `v` allowed) as numbers, or null. */
export function parseVersion(text: string): Version | null {
  const m = VERSION.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const compare = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The label `bump` makes of `label`, or null when `label` is not a version. */
export function bumpLabel(label: string, bump: ReleaseBump): string | null {
  const v = parseVersion(label);
  if (!v) return null;
  if (bump === "major") return `${v[0] + 1}.0.0`;
  if (bump === "minor") return `${v[0]}.${v[1] + 1}.0`;
  return `${v[0]}.${v[1]}.${v[2] + 1}`;
}

/** The version a partial like `1`, `1.2` or `1.x` stands for, with the position of its first wildcard. */
function partial(text: string): { v: Version; given: number } | null {
  const parts = text.replace(/^v/, "").split(/[-+]/)[0].split(".");
  if (parts.length === 0 || parts.length > 3) return null;
  const nums: number[] = [];
  let given = 0;
  for (const p of parts) {
    if (/^[xX*]$/.test(p) || p === "") break;
    if (!/^\d+$/.test(p)) return null;
    nums.push(Number(p));
    given++;
  }
  while (nums.length < 3) nums.push(0);
  return { v: [nums[0], nums[1], nums[2]], given };
}

/** Whether one space-separated comparator set admits `v`. Null when it is not a range chant reads. */
function setAdmits(set: string, v: Version): boolean | null {
  const tokens = set
    .replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1")
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return true;
  for (const token of tokens) {
    const m = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(token)!;
    const op = m[1] ?? "";
    const p = partial(m[2]);
    if (!p) return null;
    const lo = p.v;
    let ok: boolean;
    if (op === "^") {
      // ^1.2.3 is <2.0.0; ^0.2.3 is <0.3.0; ^0.0.3 is <0.0.4.
      let hi: Version;
      if (lo[0] > 0 || p.given <= 1) hi = [lo[0] + 1, 0, 0];
      else if (lo[1] > 0 || p.given <= 2) hi = [0, lo[1] + 1, 0];
      else hi = [0, 0, lo[2] + 1];
      ok = compare(v, lo) >= 0 && compare(v, hi) < 0;
    } else if (op === "~") {
      const hi: Version = p.given <= 1 ? [lo[0] + 1, 0, 0] : [lo[0], lo[1] + 1, 0];
      ok = compare(v, lo) >= 0 && compare(v, hi) < 0;
    } else if (op === ">=") ok = compare(v, lo) >= 0;
    else if (op === ">") ok = p.given >= 3 ? compare(v, lo) > 0 : compare(v, [lo[0], lo[1], lo[2]]) >= 0 && !(p.given === 0) && compare(v, p.given === 1 ? [lo[0] + 1, 0, 0] : [lo[0], lo[1] + 1, 0]) >= 0;
    else if (op === "<=") ok = p.given >= 3 ? compare(v, lo) <= 0 : compare(v, p.given === 1 ? [lo[0] + 1, 0, 0] : [lo[0], lo[1] + 1, 0]) < 0;
    else if (op === "<") ok = compare(v, lo) < 0;
    else if (p.given >= 3) ok = compare(v, lo) === 0;
    else if (p.given === 0) ok = true;
    else ok = compare(v, lo) >= 0 && compare(v, p.given === 1 ? [lo[0] + 1, 0, 0] : [lo[0], lo[1] + 1, 0]) < 0;
    if (!ok) return false;
  }
  return true;
}

/**
 * Whether the npm range `range` admits `label`. A range chant does not read
 * (`workspace:*`, a URL, a tag) admits everything: it forces no release.
 */
export function rangeAdmits(range: string, label: string): boolean {
  const v = parseVersion(label);
  if (!v) return true;
  const sets = range.split("||").map((s) => s.trim());
  let unread = false;
  for (const set of sets) {
    const hit = setAdmits(set, v);
    if (hit === null) unread = true;
    else if (hit) return true;
  }
  return unread;
}

/** The higher of two bumps; null is lower than any. */
function maxBump(a: ReleaseBump | null, b: ReleaseBump | null): ReleaseBump | null {
  if (a === null) return b;
  if (b === null) return a;
  const order: ReleaseBump[] = ["patch", "minor", "major"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

/**
 * The bump the conventional commits in `from..to` that touch `paths` (from
 * the repository root) give, as `changelogBump` decides it (#5159), or null
 * when none does. The paths go to git on its standard input, literally.
 */
function commitBumpOver(top: string, from: string, to: string, paths: readonly string[]): ReleaseBump | null {
  let out: string;
  try {
    out = execFileSync("git", ["log", "--no-merges", "--format=%B%x1e", `${from}..${to}`, "--stdin"], {
      cwd: top,
      encoding: "utf-8",
      input: `--\n${paths.join("\n")}\n`,
      env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const messages = out.split("\x1e").map((m) => m.trim()).filter(Boolean);
  return messages.length > 0 ? changelogBump(messages) : null;
}

// --- the workspace -----------------------------------------------------------

interface Package {
  /** The package name, or null when its package.json is missing. */
  name: string | null;
  /** Dependency package name to range, over dependencies, peers and optional dependencies. */
  ranges: Map<string, string>;
}

function readPackage(top: string, rev: string, path: string): Package {
  const text = tryGit(top, ["show", `${rev}:${path}`]);
  if (text === null) return { name: null, ranges: new Map() };
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { name: null, ranges: new Map() };
  }
  const ranges = new Map<string, string>();
  for (const key of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    const block = json[key];
    if (block && typeof block === "object") for (const [n, r] of Object.entries(block as Record<string, unknown>)) if (typeof r === "string" && !ranges.has(n)) ranges.set(n, r);
  }
  return { name: typeof json.name === "string" ? json.name : null, ranges };
}

/** The outermost workspace root at or above `dir`. */
function outermostRoot(dir: string): string {
  let root = dir;
  for (;;) {
    const up = findWorkspaceRoot(dirname(root));
    if (!up || up.dir === root) return root;
    root = up.dir;
  }
}

const posix = (p: string): string => (sep === "/" ? p : p.split(sep).join("/"));

/**
 * The directory whose commits count for the member at `memberDir` (#5159):
 * as `release changed` maps paths, the directory of the outermost
 * workspace's member of the same name when there is one (a release member
 * under `release/<name>` releases the package at `packages/<name>`), else
 * the member's own directory.
 */
export function memberSourcePath(memberDir: string): string {
  const dir = resolve(memberDir);
  try {
    const found = findWorkspaceRoot(dir);
    if (!found) return dir;
    const rootDir = realpathSync(found.dir);
    const real = realpathSync(dir);
    const own = readDeclaration(workingTree(rootDir)).members.find((m) => m.dir !== "." && realpathSync(join(rootDir, m.dir)) === real);
    if (!own) return dir;
    const outerDir = realpathSync(outermostRoot(rootDir));
    if (outerDir === rootDir) return dir;
    const outer = readDeclaration(workingTree(outerDir)).members.find((m) => m.name === own.name && m.kind !== "workspace");
    return outer ? join(outerDir, outer.dir) : dir;
  } catch {
    return dir;
  }
}

/** The member's last release from its ledger, or null, and its cuts. */
async function ledgerRelease(memberDir: string): Promise<{ last: LastRelease | null; cuts: import("../lifecycle/release-store").ReleaseCut[] }> {
  const loc = { cwd: memberDir };
  await resolveMemberLedger(memberDir);
  const { releases } = await readAllReleases(loc);
  const { cuts } = await readCuts(loc);
  const commitOf = new Map(releases.map((r) => [r.releaseDigest, r.commit]));
  let best: { at: string; label: string | null; commit: string } | null = null;
  for (const c of cuts) {
    const commit = commitOf.get(c.releaseDigest);
    if (commit === undefined) continue;
    if (!best || c.timestamp > best.at) best = { at: c.timestamp, label: c.label, commit };
  }
  return { last: best ? { label: best.label, commit: best.commit, source: "ledger" } : null, cuts };
}

/**
 * A shape the version tags of earlier releases take: the literal before and
 * after the version. A `release.legacyTags` prefix is a shape with no
 * suffix; a `release.tag` template gives one through `tagShape`, with
 * `render`, the tag a label gets, so a match is confirmed by rendering it
 * back (#5200).
 */
export interface VersionTagShape {
  prefix: string;
  suffix: string;
  render?: (label: string) => string;
}

/**
 * The newest tag of `shapes` that names a version, as a release, or null.
 * The version between prefix and suffix holds no `/`: `release/npm/core/0.125.0`
 * is a member's tag, not one of the prefix `release/`. The label drops a
 * leading `v`, unless the shape's `render` only gives the tag back with it.
 * With `at`, only a tag on that commit or an ancestor of it counts; with
 * `stable`, only a version with no prerelease part; with `skip`, no
 * version it lists (written without a leading `v`).
 */
export function tagHistoryRelease(top: string, shapes: readonly VersionTagShape[], opts: { at?: string; stable?: boolean; skip?: readonly string[] } = {}): (LastRelease & { tag: string }) | null {
  const found: Array<{ v: Version; label: string; tag: string }> = [];
  for (const shape of shapes) {
    const tags = tryGit(top, ["tag", "-l", `${shape.prefix}*${shape.suffix}`]) ?? "";
    for (const tag of tags.split("\n").filter(Boolean)) {
      if (!tag.startsWith(shape.prefix) || !tag.endsWith(shape.suffix) || tag.length <= shape.prefix.length + shape.suffix.length) continue;
      const rest = tag.slice(shape.prefix.length, tag.length - shape.suffix.length);
      const v = parseVersion(rest);
      if (!v || rest.includes("/") || !/^v?\d/.test(rest)) continue;
      if (opts.stable && /[-+]/.test(rest)) continue;
      if (opts.skip?.includes(rest.replace(/^v/, ""))) continue;
      const label = [rest.replace(/^v/, ""), rest].find((l) => {
        if (!shape.render) return true;
        try {
          return shape.render(l) === tag;
        } catch {
          return false;
        }
      });
      if (label !== undefined) found.push({ v, label, tag });
    }
  }
  found.sort((a, b) => compare(b.v, a.v));
  for (const best of found) {
    const commit = tryGit(top, ["rev-list", "-n", "1", best.tag]);
    if (!commit) continue;
    if (opts.at !== undefined && commit !== opts.at && tryGit(top, ["merge-base", "--is-ancestor", commit, opts.at]) === null) continue;
    return { label: best.label, commit, source: "legacy", tag: best.tag };
  }
  return null;
}

/** The newest legacy tag of `prefixes` that names a version, as a release, or null. */
function legacyRelease(top: string, prefixes: readonly string[]): LastRelease | null {
  const hit = tagHistoryRelease(top, prefixes.map((prefix) => ({ prefix, suffix: "" })));
  return hit ? { label: hit.label, commit: hit.commit, source: hit.source } : null;
}

/** The `release` settings of the `chant.config.ts` (or `.json`) in `dir` that pick a next label; empty when it has none or can't be read. */
export async function releaseSettingsAt(dir: string): Promise<{ legacyTags: string[]; breakingOnZero?: "minor" | "major" }> {
  if (!existsSync(join(dir, "chant.config.ts")) && !existsSync(join(dir, "chant.config.json"))) return { legacyTags: [] };
  try {
    const { loadChantConfig } = await import("../config");
    const release = (await loadChantConfig(dir)).config.release;
    return { legacyTags: [...(release?.legacyTags ?? [])], ...(release?.breakingOnZero ? { breakingOnZero: release.breakingOnZero } : {}) };
  } catch {
    return { legacyTags: [] };
  }
}

/**
 * The settings for the member at `memberDir` (#5200, #5191): its own
 * `release.legacyTags` with those of the workspace root it sits in, and its
 * own `release.breakingOnZero`, else the root's. A project with no
 * workspace reads its own config alone.
 */
export async function memberReleaseSettings(memberDir: string, root?: { dir: string; settings: Awaited<ReturnType<typeof releaseSettingsAt>> }): Promise<{ legacyTags: string[]; breakingOnZero: "minor" | "major" }> {
  const own = await releaseSettingsAt(memberDir);
  let outer = root;
  if (outer === undefined) {
    const found = findWorkspaceRoot(memberDir);
    if (found && resolve(found.dir) !== resolve(memberDir)) outer = { dir: found.dir, settings: await releaseSettingsAt(found.dir) };
  }
  const same = outer !== undefined && realpathOr(outer.dir) === realpathOr(memberDir);
  const rootSettings = outer && !same ? outer.settings : { legacyTags: [] as string[] };
  return {
    legacyTags: [...new Set([...own.legacyTags, ...rootSettings.legacyTags])],
    breakingOnZero: own.breakingOnZero ?? rootSettings.breakingOnZero ?? "minor",
  };
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * The bump a commit gives on the version `label` (#5191): on 0.x, unless
 * `breakingOnZero` is `major`, a breaking change bumps minor and a feature
 * patch, since a 0.x project moves to 1.0.0 by choice (an intent file or a
 * typed level of `major`). Any other version, or a null bump, is as given.
 */
export function zeroShift(bump: ReleaseBump | null, label: string | null, breakingOnZero: "minor" | "major"): ReleaseBump | null {
  if (bump === null || breakingOnZero === "major" || label === null) return bump;
  const v = parseVersion(label);
  if (!v || v[0] !== 0) return bump;
  return bump === "major" ? "minor" : "patch";
}

/** Read what a release at a commit of the workspace at `query.cwd` has to cut. */
export async function releaseChangedDocument(query: ReleaseChangedQuery): Promise<ReleaseChangedDocument> {
  const head = { $schema: RELEASE_CHANGED_SCHEMA_ID, contract: RELEASE_CHANGED_CONTRACT_VERSION, chant: readerVersion() };
  try {
    return { ...head, ...(await read(query)) };
  } catch (err) {
    if (err instanceof ReadFailure) return { ...head, error: { code: err.code, message: err.message } };
    return { ...head, error: { code: "ledger-unreadable", message: `reading the changed members failed: ${err instanceof Error ? err.message : String(err)}` } };
  }
}

async function read(query: ReleaseChangedQuery): Promise<{ at: string; members: ReleaseChangedMember[] }> {
  const cwd = resolve(query.cwd);
  const top = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) throw new ReadFailure("not-a-git-repository", "the changed members are read from commits and tags, and this directory is not in a git repository");
  const found = findWorkspaceRoot(cwd);
  if (!found) throw new ReadFailure("declaration-missing", "release changed reads a workspace of release members, and there is no chant.workspace.json between this directory and the git root");
  const rootDir = realpathSync(found.dir);
  const declaration = readDeclaration(workingTree(rootDir));
  const outerDir = realpathSync(outermostRoot(rootDir));
  const outer: Declaration = outerDir === rootDir ? declaration : readDeclaration(workingTree(outerDir));
  const outerFromTop = posix(relative(top, outerDir));

  // The commit.
  let at: string | null;
  if (query.at !== undefined) {
    at = tryGit(top, ["rev-parse", "--verify", "--quiet", `${query.at}^{commit}`]);
    if (!at) throw new ReadFailure("revision-unknown", `--at ${query.at} names no commit in this clone`);
  } else {
    const { resolveTrunk } = await import("../lifecycle/release-workstation");
    const trunk = resolveTrunk(top, declaration.ci?.green?.branch ?? null);
    at =
      tryGit(top, ["rev-parse", "--verify", "--quiet", `refs/remotes/${trunk.remote}/${trunk.branch}^{commit}`]) ??
      tryGit(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${trunk.branch}^{commit}`]);
    if (!at) throw new ReadFailure("revision-unknown", `this clone knows no ${trunk.branch}; fetch it, or name a commit with --at`);
  }

  const members = declaration.members.filter((m) => m.kind === "chant" && m.dir !== ".").map((m) => ({ name: m.name, dir: m.dir }));
  const names = new Set(members.map((m) => m.name));

  const bumps = new Map<string, ReleaseBump>();
  for (const entry of query.bump ?? []) {
    const [member, level, ...extra] = entry.split("=");
    if (!member || !level || extra.length > 0 || !(RELEASE_BUMPS as readonly string[]).includes(level)) throw new ReadFailure("bump-invalid", `--bump-member ${entry} is not <member>=major|minor|patch`);
    if (!names.has(member)) throw new ReadFailure("bump-invalid", `--bump-member names ${member}, which is not a chant member of this declaration (${[...names].sort().join(", ") || "none"})`);
    bumps.set(member, level as ReleaseBump);
  }

  // #5159: the intent files at the commit, each naming members of this declaration.
  const { readIntents, consumedIntents, pendingIntents, ReleaseIntentError } = await import("../lifecycle/release-intents");
  let intentFiles: import("../lifecycle/release-intents").ReleaseIntent[];
  try {
    intentFiles = readIntents(top, at);
  } catch (err) {
    if (err instanceof ReleaseIntentError) throw new ReadFailure("intent-invalid", err.message);
    throw err;
  }
  for (const f of intentFiles) {
    for (const name of f.members.keys()) {
      if (name !== "*" && !names.has(name)) throw new ReadFailure("intent-invalid", `the intent file ${f.path} names ${name}, which is not a chant member of this declaration (${[...names].sort().join(", ") || "none"})`);
    }
  }

  // Each member's package, last release and the paths changed since.
  const outerMemberOf = (name: string) => outer.members.find((m) => m.name === name);
  const pkgDir = (name: string): string => {
    const holder = outerMemberOf(name) ?? declaration.members.find((m) => m.name === name)!;
    return holder === outerMemberOf(name) ? holder.dir : posix(relative(outerDir, join(rootDir, holder.dir)));
  };
  const rootSettings = await releaseSettingsAt(rootDir);
  const legacyLast = rootSettings.legacyTags.length > 0 ? legacyRelease(top, rootSettings.legacyTags) : null;
  const ignore = (outer.changes?.ignore ?? []).map((g) => picomatch(g, { dot: true }) as (p: string) => boolean);

  interface Info {
    name: string;
    dir: string;
    pkg: Package;
    last: LastRelease | null;
    paths: string[];
    changed: boolean;
    /** The level the commits over `paths` since the last release give, or null. */
    commitBump: ReleaseBump | null;
    /** The pending intent files that name it. */
    intents: Array<{ path: string; bump: ReleaseBump }>;
    /** The package.json of its last release, for the ranges it published. */
    published: Package | null;
  }
  const info = new Map<string, Info>();
  for (const m of members) {
    const dir = pkgDir(m.name);
    const memberDir = join(rootDir, m.dir);
    if (!existsSync(memberDir)) throw new ReadFailure("ledger-unreadable", `member ${m.name} has no directory ${m.dir}`);
    const ledger = await ledgerRelease(memberDir);
    // #5200: a member's own legacyTags count beside the root's; #5191: its breakingOnZero, else the root's.
    const settings = await memberReleaseSettings(memberDir, { dir: rootDir, settings: rootSettings });
    const last = ledger.last ?? (settings.legacyTags.length > rootSettings.legacyTags.length ? legacyRelease(top, settings.legacyTags) : legacyLast);
    let paths: string[] = [];
    if (last) {
      if (tryGit(top, ["cat-file", "-e", `${last.commit}^{commit}`]) === null) throw new ReadFailure("ledger-unreadable", `the last release of ${m.name} is at ${last.commit.slice(0, 12)}, which this clone does not have`);
      const diff = tryGit(top, ["diff", "--name-only", "--no-renames", last.commit, at]) ?? "";
      for (const file of diff.split("\n").filter(Boolean)) {
        const path = outerFromTop === "." || outerFromTop === "" ? file : file.startsWith(`${outerFromTop}/`) ? file.slice(outerFromTop.length + 1) : null;
        if (path === null) continue;
        if (memberHolding(path, outer.members) !== m.name && !(outerMemberOf(m.name) === undefined && memberHolding(path, declaration.members) === m.name)) continue;
        if (ignore.some((match) => match(path))) continue;
        if (isGeneratedPath(outer, path)) continue;
        paths.push(path);
      }
      paths = [...new Set(paths)].sort();
    }
    const prefix = outerFromTop === "." || outerFromTop === "" ? "" : `${outerFromTop}/`;
    const intents = pendingIntents(intentFiles, [m.name], consumedIntents(ledger.cuts)).map((i) => ({ path: i.path, bump: i.bump }));
    info.set(m.name, {
      name: m.name,
      dir,
      pkg: readPackage(top, at, `${prefix}${dir}/package.json`),
      last,
      paths,
      changed: last === null || paths.length > 0 || intents.length > 0,
      commitBump: last && paths.length > 0 ? zeroShift(commitBumpOver(top, last.commit, at, paths.map((p) => `${prefix}${p}`)), last.label, settings.breakingOnZero) : null,
      intents,
      published: last ? readPackage(top, last.commit, `${prefix}${dir}/package.json`) : null,
    });
  }

  // Dependencies among members, by package name.
  const memberOfPackage = new Map<string, string>();
  for (const i of info.values()) if (i.pkg.name) memberOfPackage.set(i.pkg.name, i.name);
  const needs = new Map<string, string[]>();
  for (const i of info.values()) needs.set(i.name, [...new Set([...i.pkg.ranges.keys()].map((n) => memberOfPackage.get(n)).filter((n): n is string => n !== undefined && n !== i.name))].sort());

  const nextOf = (name: string): { bump: ReleaseBump; bumpFrom: ReleaseChangedMember["bumpFrom"]; next: string | null } => {
    const i = info.get(name)!;
    const flag = bumps.get(name);
    const fromIntents = i.intents.reduce<ReleaseBump | null>((b, x) => maxBump(b, x.bump), null);
    const computed = maxBump(i.commitBump, fromIntents);
    const bump = flag ?? computed ?? "patch";
    const bumpFrom = flag ? "flag" : computed === null ? "default" : i.commitBump === computed ? "commits" : "intents";
    const label = i.last?.label;
    return { bump, bumpFrom, next: label ? bumpLabel(label, bump) : null };
  };

  // The closure.
  const chosen = new Map<string, ReleaseChangedReason>();
  const queue: string[] = [];
  for (const i of [...info.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (i.changed) {
      chosen.set(i.name, { code: i.last !== null && i.paths.length === 0 ? "intent-pending" : "paths-changed", member: null });
      queue.push(i.name);
    }
  }
  const take = (name: string, reason: ReleaseChangedReason): void => {
    if (chosen.has(name)) return;
    chosen.set(name, reason);
    queue.push(name);
  };
  while (queue.length > 0) {
    const m = queue.shift()!;
    // Upward: a changed dependency, direct or through members that did not change.
    const seen = new Set<string>([m]);
    const walk = [...(needs.get(m) ?? [])];
    while (walk.length > 0) {
      const d = walk.shift()!;
      if (seen.has(d)) continue;
      seen.add(d);
      if (info.get(d)!.changed) take(d, { code: "needed-by", member: m });
      walk.push(...(needs.get(d) ?? []));
    }
    // Downward: a dependent whose published range does not admit the next label.
    const { next } = nextOf(m);
    if (next === null) continue;
    const pkgName = info.get(m)!.pkg.name;
    if (pkgName === null) continue;
    for (const p of [...info.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      if (chosen.has(p.name) || !(needs.get(p.name) ?? []).includes(m)) continue;
      const range = p.published?.ranges.get(pkgName);
      if (range !== undefined && !rangeAdmits(range, next)) take(p.name, { code: "range-broken-by", member: m });
    }
  }

  // Layers: Kahn over the chosen members, with an edge for each dependency reachable through the whole graph.
  const reach = (from: string): Set<string> => {
    const out = new Set<string>();
    const stack = [...(needs.get(from) ?? [])];
    while (stack.length > 0) {
      const d = stack.pop()!;
      if (out.has(d)) continue;
      out.add(d);
      stack.push(...(needs.get(d) ?? []));
    }
    return out;
  };
  // A changed member another member of the release depends on is there because that member needs it.
  for (const [name, reason] of chosen) {
    if (reason.code !== "paths-changed" && reason.code !== "intent-pending") continue;
    const needer = [...chosen.keys()].sort().find((m) => m !== name && chosen.get(m)!.code !== "range-broken-by" && reach(m).has(name));
    if (needer !== undefined) chosen.set(name, { code: "needed-by", member: needer });
  }
  const before = new Map([...chosen.keys()].map((m) => [m, [...reach(m)].filter((d) => chosen.has(d) && d !== m)]));
  const layerOf = new Map<string, number>();
  const left = new Set(chosen.keys());
  for (let layer = 0; left.size > 0; layer++) {
    let ready = [...left].filter((m) => !before.get(m)!.some((d) => left.has(d))).sort();
    // A dependency cycle cannot be ordered; its members share the layer.
    if (ready.length === 0) ready = [...left].sort();
    for (const m of ready) {
      layerOf.set(m, layer);
      left.delete(m);
    }
  }

  const out: ReleaseChangedMember[] = [...chosen.keys()]
    .sort((a, b) => layerOf.get(a)! - layerOf.get(b)! || a.localeCompare(b))
    .map((name) => {
      const i = info.get(name)!;
      const { bump, bumpFrom, next } = nextOf(name);
      return { member: name, layer: layerOf.get(name)!, reason: chosen.get(name)!, last: i.last, bump, bumpFrom, next, paths: i.paths, intents: i.intents.map((x) => x.path) };
    });
  return { at, members: out };
}
