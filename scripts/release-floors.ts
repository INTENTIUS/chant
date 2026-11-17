#!/usr/bin/env tsx
/**
 * The contract floors that name the next chant release, and a check that
 * every floor names a version that exists (#4480).
 *
 *   npx tsx scripts/release-floors.ts                  check the working tree
 *   npx tsx scripts/release-floors.ts --rev <sha>      check a commit's tree
 *   npx tsx scripts/release-floors.ts --release <v>    count <v> as a release (the one being cut)
 *   npx tsx scripts/release-floors.ts --npm            also ask npm for the published versions
 *   npx tsx scripts/release-floors.ts --train-plan <f> count core's label in a release train's plan as a release;
 *                                                      with core not in the train, check nothing (#5154)
 *   npx tsx scripts/release-floors.ts --set <v>        set the next release's number
 *   npx tsx scripts/release-floors.ts --freeze <v> [--next <n>] [--rev <sha>]
 *                                                      after <v> shipped: its floors become literals (optional)
 *   npx tsx scripts/release-floors.ts --pack <cmd...>  run <cmd> (core's build) with every floor at the
 *                                                      version it ships with, then put the sources back
 *
 * The one place the number is set is NEXT_RELEASE in
 * packages/core/src/release-floors.ts. Each floor constant added since the
 * last release is that constant, and the schema and docs text that repeats
 * one is listed in NEXT_RELEASE_TEXT below. `--set` rewrites the constant
 * and every listed text; the check fails when a listed text names another
 * version than the constant.
 *
 * The check then fails when a floor names a version that has no release and
 * no local build stamp. A floor is NEXT_RELEASE and every `export const
 * <NAME>_FLOOR = "<version>"` under packages/core/src and in each lexicon's
 * src/chant-floors.ts (#4916). A lexicon floor that names the next release
 * imports NEXT_RELEASE from `@intentius/chant/release-floors`, and
 * `--freeze` writes it as a literal the same way.
 *
 * Packages have their own versions (#5138). A core floor is a version of
 * `@intentius/chant`, and a floor in a lexicon's src/chant-floors.ts is a
 * version of that lexicon, checked against that lexicon's releases: its
 * `lexicon-<n>-v<v>` and `release/npm/lexicon-<n>/<v>` tags, the lockstep
 * labels every package shipped at, its npm versions with `--npm`, and its own
 * package.json stamp. scripts/floor-table.ts records which package each
 * floor's version belongs to.
 *
 * A published release is read from the checkout's tags, release/npm/<v> and
 * chant-v<v>, so the default mode needs no network; fetch the tags first
 * (`git fetch origin 'refs/tags/release/*:refs/tags/release/*'
 * 'refs/tags/chant-v*:refs/tags/chant-v*'`), as `just release` does. `--npm`
 * adds `npm view <package> versions`.
 *
 * npm is the source of truth for what was published (#4503). A tag can exist
 * in one checkout and not on origin (chant-v0.81.0 did: npm lists 0.81.0,
 * origin's tags skip from 0.80.0 to 0.82.0), so a check that read tags only
 * passed on the maintainer's checkout and would fail on a clean CI checkout.
 * `just release` and the release train's check both run with `--npm`; the
 * tags-only default is for an offline look at the working tree.
 *
 * A local build stamp is the version of packages/core/package.json in the
 * working tree when it differs from the committed one: a local `npm pack`
 * build (install-local-chant.sh) stamps every package
 * at the version they build, uncommitted, so a build stamped at NEXT_RELEASE
 * passes. `--release <v>` counts <v> the same way, for a cut, which checks
 * the commit it cuts before any stamp exists. `--train-plan <file>` reads
 * <v> from the plan `chant workspace train cut` hands `release.train.check`
 * (CHANT_TRAIN_PLAN, #5154): the label of the member `core`. A train that
 * does not release core checks nothing, since its floors ship with the core
 * already published.
 *
 * After a release ships, its floors stay at the version they shipped with
 * (#4501). The release tags say which: a core floor still NEXT_RELEASE
 * shipped in the oldest of core's releases, walking back from the newest,
 * whose release commit already declared it (#5260), and a floor no release
 * declares ships in the next one. Core's `prepack` runs its build under
 * `--pack`, which writes each floor as that literal, NEXT_RELEASE as the
 * version being packed (core's stamped package.json version, or else
 * NEXT_RELEASE or the patch after core's newest release, whichever is
 * newer), and the floor table again, then puts the sources back. So a
 * release train needs no commit between releases: a floor that shipped in
 * 0.124.103 packs as "0.124.103" in every later release, and a floor merged
 * after that cut packs as the next release's label. The check reads floors
 * the same way, and a cut's check (`--release`, `--train-plan`) gives the
 * floors no release declares the label being cut. With `--npm` it refuses
 * when npm lists a core version newer than every core release tag in the
 * checkout, since its tags would be missing from the walk.
 *
 * `--freeze <v>` writes those literals into the sources, for a tree that
 * reads plainly; the build no longer needs it. Run once <v> is published and
 * while NEXT_RELEASE is still <v>, it writes "<v>" in place of NEXT_RELEASE
 * in each floor constant that <v> shipped (dropping an import of
 * NEXT_RELEASE the file no longer uses), drops those floors' entries from
 * NEXT_RELEASE_TEXT (the texts already carry "<v>"), and sets NEXT_RELEASE
 * to `--next`, or <v> with its patch number raised. A lexicon floor still
 * NEXT_RELEASE is not resolved from core's tags, so the check still fails
 * while one is NEXT_RELEASE and NEXT_RELEASE names a version that has a
 * release.
 *
 * A floor shipped in <v> when it was already NEXT_RELEASE at <v>'s release
 * commit (#4540): the commit `release/npm/<v>`, `chant-v<v>` or core's member
 * tag `release/npm/core/<v>` names, or `--rev`. A floor merged after the cut stays NEXT_RELEASE and moves to the
 * new number, and so do its NEXT_RELEASE_TEXT entries and the texts they
 * list. With no tag and no `--rev` the freeze refuses rather than guess.
 * It then prints the tests a freeze leaves stale: a test that asserts
 * `toBe(NEXT_RELEASE)` and names a frozen floor, and, when a floor file
 * dropped its import, a bundle test whose expected module list names
 * packages/core/src/release-floors.ts.
 *
 * The check also fails while packages/core/src/floor-table.data.ts, the
 * table of every floor a product reads (#4792), is not what
 * scripts/floor-table.ts writes from the floors, and `--freeze` writes it
 * again once the floors are literals.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { TABLE_FILE, tableAgainst, writeTable } from "./floor-table";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
const CONSTANT_FILE = "packages/core/src/release-floors.ts";
const CONSTANT_RE = /export const NEXT_RELEASE = "(\d+\.\d+\.\d+)";/;
const LEXICON_FLOORS_FILE = /^lexicons\/([^/]+)\/src\/chant-floors\.ts$/;
const FLOOR_RE = /export const ([A-Z0-9_]+_FLOOR) = (?:"(\d+\.\d+\.\d+)"|(NEXT_RELEASE));/g;

/**
 * Text outside TypeScript that repeats a floor naming the next release. `{v}`
 * is the version; each text must occur `count` times in `file` with
 * NEXT_RELEASE in its place.
 */
const NEXT_RELEASE_TEXT: { file: string; text: string; count: number; floor: string }[] = [
  // --freeze empties this list after a release ships (#4501); each entry is one line.
];

interface Args {
  rev?: string;
  release: string[];
  npm: boolean;
  set?: string;
  freeze?: string;
  next?: string;
  /** `--train-plan <file>`: a train without core checks nothing. */
  trainWithoutCore?: boolean;
  /** `--pack <cmd...>`: the command to run with the floors resolved. */
  pack?: string[];
}

/** Core's label in a `chant workspace train cut` plan (#5154), or null when the train does not release core. */
export function coreLabelOfPlan(text: string): string | null {
  const plan = JSON.parse(text) as { members?: Array<{ member?: unknown; label?: unknown }> };
  const core = (plan.members ?? []).find((m) => m.member === "core");
  return typeof core?.label === "string" ? core.label : null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { release: [], npm: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--pack") {
      args.pack = argv.slice(i + 1);
      if (args.pack.length === 0) throw new Error("--pack needs a command");
      break;
    }
    if (a === "--rev") args.rev = value();
    else if (a === "--release") args.release.push(value());
    else if (a === "--npm") args.npm = true;
    else if (a === "--train-plan") {
      const label = coreLabelOfPlan(readFileSync(value(), "utf-8"));
      if (label === null) args.trainWithoutCore = true;
      else args.release.push(label);
    }
    else if (a === "--set") args.set = value();
    else if (a === "--freeze") args.freeze = value();
    else if (a === "--next") args.next = value();
    else throw new Error(`unknown argument ${a}`);
  }
  if (args.next && !args.freeze) throw new Error("--next goes with --freeze");
  for (const v of [...args.release, ...[args.set, args.freeze, args.next].filter((v): v is string => v !== undefined)]) {
    if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`${v} is not a version`);
  }
  return args;
}

function git(args: string[], cwd = ROOT): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
}

function reader(rev: string | undefined): (file: string) => string {
  return rev ? (file) => git(["show", `${rev}:${file}`]) : (file) => readFileSync(join(ROOT, file), "utf-8");
}

function nextRelease(read: (file: string) => string): string {
  const m = CONSTANT_RE.exec(read(CONSTANT_FILE));
  if (!m) throw new Error(`${CONSTANT_FILE} has no NEXT_RELEASE = "<version>"`);
  return m[1];
}

function count(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Every floor constant under packages/core/src and in the lexicons' floors files, with the version it names. */
function floors(read: (file: string) => string, rev: string | undefined, next: string): Floor[] {
  const out: Floor[] = [];
  for (const file of floorFiles(rev)) {
    const src = read(file);
    const lexicon = LEXICON_FLOORS_FILE.exec(file)?.[1];
    for (const m of src.matchAll(FLOOR_RE)) out.push({ name: m[1], file, version: m[2] ?? next, symbolic: m[3] !== undefined, ...(lexicon ? { lexicon } : {}) });
  }
  return out;
}

export interface Floor {
  name: string;
  file: string;
  version: string;
  /** The lexicon whose release the version belongs to; absent for chant core. */
  lexicon?: string;
  /** The constant is NEXT_RELEASE, not a literal. */
  symbolic?: boolean;
}

/** The files floors are declared in: core's sources, and each lexicon's src/chant-floors.ts (#4916). */
function floorFiles(rev: string | undefined): string[] {
  return git(rev ? ["ls-tree", "-r", "--name-only", rev, "--", "packages/core/src", "lexicons"] : ["ls-files", "--", "packages/core/src", "lexicons"])
    .split("\n")
    .filter((f) => (f.startsWith("packages/core/src/") && f.endsWith(".ts") && !f.endsWith(".test.ts")) || LEXICON_FLOORS_FILE.test(f));
}

/**
 * NEXT_RELEASE and each floor still set to it, as problem lines, when
 * NEXT_RELEASE names a version that has a release (#4501): those floors
 * shipped and must be literals before NEXT_RELEASE moves on. The check
 * passes it lexicon floors only; a core floor is resolved from the release
 * tags (#5260).
 */
export function shippedSymbolic(next: string, named: Floor[], known: Set<string>, stamp?: string): string[] {
  // A working tree stamped with NEXT_RELEASE is a local pack of that
  // release: its own release/npm/<next> tag already exists, but the floors
  // ship as NEXT_RELEASE in this pack and are frozen after it reaches npm.
  if (stamp === next) return [];
  if (!known.has(next)) return [];
  return named
    .filter((f) => f.symbolic)
    .map((f) => `${f.file}: ${f.name} is NEXT_RELEASE, and ${next} has shipped; run \`just release-floors --freeze ${next}\``);
}

/**
 * One source file with every `<NAME>_FLOOR = NEXT_RELEASE;` written as the
 * literal `version`, or only those in `names` when given, and its import of
 * NEXT_RELEASE dropped when nothing else in it names NEXT_RELEASE.
 */
export function freezeFloorSource(src: string, version: string, names?: ReadonlySet<string>): string {
  let out = src.replace(/(export const ([A-Z0-9_]+_FLOOR) = )NEXT_RELEASE;/g, (whole, head: string, name: string) =>
    names === undefined || names.has(name) ? `${head}"${version}";` : whole,
  );
  if (out === src) return src;
  const importRe = /^import \{ NEXT_RELEASE \} from "[^"]*release-floors(?:\.js)?";\n/m;
  const rest = out.replace(importRe, "");
  if (!/\bNEXT_RELEASE\b/.test(rest)) out = rest;
  return out;
}

/**
 * This script's source with NEXT_RELEASE_TEXT emptied: every line between its
 * opening and closing bracket that holds an entry goes, except an entry whose
 * `floor` is in `keep` (a floor that stays NEXT_RELEASE, #4540).
 */
export function freezeTextList(src: string, keep: ReadonlySet<string> = new Set()): string {
  const open = src.indexOf("const NEXT_RELEASE_TEXT:");
  if (open === -1) throw new Error("no NEXT_RELEASE_TEXT list");
  const start = src.indexOf("[\n", open) + 2;
  const end = src.indexOf("\n];\n", start - 1);
  if (start < 2 || end === -1) throw new Error("NEXT_RELEASE_TEXT is not a bracketed list");
  const lines = src.slice(start, end + 1).split("\n");
  const kept = lines.filter((l) => !/^\s*\{ file: /.test(l) || keep.has(/floor: "([A-Z0-9_]+)"/.exec(l)?.[1] ?? ""));
  return src.slice(0, start) + kept.join("\n") + src.slice(end + 1);
}

/**
 * Which symbolic floors a freeze of a release writes as literals (#4540): a
 * floor symbolic now that was already symbolic at the release commit. Every
 * other symbolic floor was merged after the cut and stays NEXT_RELEASE.
 */
export function splitFreeze(atRelease: readonly Floor[], now: readonly Floor[]): { freeze: string[]; keep: string[] } {
  const shipped = new Set(atRelease.filter((f) => f.symbolic).map((f) => f.name));
  const symbolic = [...new Set(now.filter((f) => f.symbolic).map((f) => f.name))].sort();
  return { freeze: symbolic.filter((n) => shipped.has(n)), keep: symbolic.filter((n) => !shipped.has(n)) };
}

/** The bundle's module list entry a frozen floor file stops importing. */
const FLOORS_MODULE = `"${CONSTANT_FILE}"`;

/**
 * The tests a freeze leaves stale (#4540), as lines to print: one that
 * asserts `toBe(NEXT_RELEASE)` and names a frozen floor, which now holds the
 * literal, and, when a floor file dropped its import of NEXT_RELEASE, a
 * bundle test whose expected module list names the floors module, which
 * may have dropped out of that bundle.
 */
export function staleFloorTests(tests: readonly { file: string; src: string }[], frozen: ReadonlySet<string>, droppedImport: boolean): string[] {
  const out: string[] = [];
  for (const { file, src } of tests) {
    if (/toBe\(NEXT_RELEASE\)/.test(src)) {
      const names = [...frozen].filter((n) => new RegExp(`\\b${n}\\b`).test(src)).sort();
      if (names.length > 0) out.push(`${file}: asserts toBe(NEXT_RELEASE) and names ${names.join(", ")}, which now hold the literal; assert the version`);
    }
    if (droppedImport && src.includes(FLOORS_MODULE)) out.push(`${file}: lists ${CONSTANT_FILE} in an expected module list; a frozen floor file no longer imports it, so check the bundle still does`);
  }
  return out;
}

/**
 * The commit core's release <v> was cut from: the one its lockstep tag
 * (`release/npm/<v>`, `chant-v<v>`) or core's member tag
 * (`release/npm/core/<v>`) names. Another member's tag is not a core release
 * (#5135).
 */
export function releaseCommit(version: string, cwd = ROOT): string | undefined {
  for (const tag of [`release/npm/${version}`, `chant-v${version}`, `release/npm/core/${version}`]) {
    try {
      return git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`], cwd).trim() || undefined;
    } catch {
      // not this tag
    }
  }
  return undefined;
}

/** `v` with its patch number raised. */
export function nextPatch(v: string): string {
  const [major, minor, patch] = v.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

/** `a` against `b` as `x.y.z` versions: negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/**
 * The release each symbolic floor shipped in (#5260). `releases` is core's
 * releases, newest first; `declaredAt` gives the floor names a release's
 * commit declares, or undefined for a release to pass over (no tag, or a
 * commit that is not an ancestor of the one read). A floor the newest
 * release declares shipped in it or an earlier one, so the walk goes back
 * until a release does not declare it: the last release that did is its
 * first. A floor the newest release does not declare is not in the map; it
 * ships in the next release.
 */
export function shippedIn(symbolic: readonly string[], releases: readonly string[], declaredAt: (version: string) => ReadonlySet<string> | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const pending = new Set(symbolic);
  for (const version of releases) {
    if (pending.size === 0) break;
    const declared = declaredAt(version);
    if (declared === undefined) continue;
    for (const name of [...pending]) {
      if (declared.has(name)) out.set(name, version);
      else pending.delete(name);
    }
  }
  return out;
}

/** The floor names a commit declares under packages/core/src. */
function declaredFloorsAt(commit: string): Set<string> {
  let out = "";
  try {
    out = git(["grep", "-h", "-o", "-E", "export const [A-Z0-9_]+_FLOOR = ", commit, "--", "packages/core/src"]);
  } catch {
    // git grep exits 1 when nothing matches.
  }
  return new Set([...out.matchAll(/export const ([A-Z0-9_]+_FLOOR) = /g)].map((m) => m[1]));
}

function isAncestor(commit: string, of: string): boolean {
  try {
    git(["merge-base", "--is-ancestor", commit, of]);
    return true;
  } catch {
    return false;
  }
}

/** The release each core floor still NEXT_RELEASE at `head` shipped in, from the checkout's release tags (#5260). */
function shippedFromTags(symbolic: readonly string[], head: string): Map<string, string> {
  if (symbolic.length === 0) return new Map();
  const releases = [...releasedVersions(releaseTags())].sort((a, b) => compareVersions(b, a));
  return shippedIn(symbolic, releases, (version) => {
    const commit = releaseCommit(version);
    return commit && isAncestor(commit, head) ? declaredFloorsAt(commit) : undefined;
  });
}

/** The newest version in a set, or undefined for none. */
function newest(versions: Iterable<string>): string | undefined {
  let out: string | undefined;
  for (const v of versions) if (out === undefined || compareVersions(v, out) > 0) out = v;
  return out;
}

/**
 * The version a pack gives NEXT_RELEASE and the floors no release declares
 * (#5260): the stamp core's package.json carries (the train's label), or
 * else NEXT_RELEASE or the patch after core's newest release, whichever is
 * newer, so a checkout whose NEXT_RELEASE already shipped packs past it.
 */
export function packVersion(next: string, stamp: string | undefined, newestRelease: string | undefined): string {
  if (stamp) return stamp;
  if (newestRelease && compareVersions(next, newestRelease) <= 0) return nextPatch(newestRelease);
  return next;
}

/**
 * One source file with each `<NAME>_FLOOR = NEXT_RELEASE;` written as the
 * version it ships with: `shipped`'s release for a floor in it, else
 * `version`. The import of NEXT_RELEASE goes when nothing else names it.
 */
export function resolveFloorSource(src: string, shipped: ReadonlyMap<string, string>, version: string): string {
  const byVersion = new Map<string, Set<string>>();
  for (const m of src.matchAll(/export const ([A-Z0-9_]+_FLOOR) = NEXT_RELEASE;/g)) {
    const v = shipped.get(m[1]) ?? version;
    byVersion.set(v, (byVersion.get(v) ?? new Set()).add(m[1]));
  }
  let out = src;
  for (const [v, names] of byVersion) out = freezeFloorSource(out, v, names);
  return out;
}

/**
 * The versions with a release of one package, from a tag list (`git tag -l`
 * output) and, when given, npm's list of that package's published versions.
 * `release/npm/<v>` and `chant-v<v>` are lockstep releases that shipped every
 * package. A lexicon's own releases are `lexicon-<n>-v<v>` and the member tag
 * `release/npm/lexicon-<n>/<v>`; core's member tag is `release/npm/core/<v>`.
 */
export function releasedVersions(tags: string[], npmVersions?: string[], lexicon?: string): Set<string> {
  // Lexicon names are lowercase letters, digits and hyphens: no regex escaping needed.
  const member = new RegExp(`^release/npm/${lexicon ? `lexicon-${lexicon}` : "core"}/(\\d+\\.\\d+\\.\\d+)$`);
  const lexiconTag = lexicon ? new RegExp(`^lexicon-${lexicon}-v(\\d+\\.\\d+\\.\\d+)$`) : undefined;
  const out = new Set<string>();
  for (const raw of tags) {
    const t = raw.trim();
    const m = /^(?:release\/npm\/|chant-v)(\d+\.\d+\.\d+)$/.exec(t) ?? member.exec(t) ?? lexiconTag?.exec(t);
    if (m) out.add(m[1]);
  }
  for (const v of npmVersions ?? []) out.add(v);
  return out;
}

/** A checkout's release tags. `[0-9]*` keeps a member tag (`release/npm/core/1.0.0`) out of the lockstep labels. */
export function listReleaseTags(cwd = ROOT): string[] {
  return git(["tag", "-l", "release/npm/[0-9]*", "release/npm/core/*", "release/npm/lexicon-*", "chant-v*", "lexicon-*-v*"], cwd).split("\n");
}

/** The checkout's release tags, read once. */
let tagCache: string[] | undefined;
function releaseTags(): string[] {
  tagCache ??= listReleaseTags();
  return tagCache;
}

/** The versions of one package with a release (`lexicon` is a lexicon's name; none is chant core): the checkout's tags, and npm's list with --npm. */
function released(npm: boolean, lexicon?: string): Set<string> {
  const tags = releaseTags();
  if (!npm) return releasedVersions(tags, undefined, lexicon);
  const pkg = lexicon ? `@intentius/chant-lexicon-${lexicon}` : "@intentius/chant";
  let versions: string[] = [];
  try {
    versions = JSON.parse(execFileSync("npm", ["view", pkg, "versions", "--json"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })) as string[];
  } catch (err) {
    // A lexicon never published has no versions; core's list must come back.
    if (!lexicon) throw err;
  }
  return releasedVersions(tags, Array.isArray(versions) ? versions : [versions as unknown as string], lexicon);
}

/** Each floor whose version is not in `allowed`, as a problem line. */
export function unreleasedFloors(
  named: { name: string; file: string; version: string; lexicon?: string }[],
  allowed: Set<string> | ((lexicon?: string) => Set<string>),
  npm: boolean,
): string[] {
  const allowedFor = (lexicon?: string) => (typeof allowed === "function" ? allowed(lexicon) : allowed);
  return named
    .filter((f) => !allowedFor(f.lexicon).has(f.version))
    .map(
      (f) =>
        `${f.file}: ${f.name} names ${f.version}, which has no ${f.lexicon ? `@intentius/chant-lexicon-${f.lexicon} ` : ""}release tag${npm ? " or npm version" : ""} and no local build stamp`,
    );
}

/**
 * A problem line when npm lists a core version newer than every core release
 * tag in the checkout (#5260): the floors that release shipped would be read
 * as unreleased and packed at the next label.
 */
export function missingTags(newestPublished: string | undefined, newestTagged: string | undefined): string[] {
  if (newestPublished === undefined || (newestTagged !== undefined && compareVersions(newestPublished, newestTagged) <= 0)) return [];
  return [
    `@intentius/chant ${newestPublished} is on npm and this checkout has no release tag for it, so the floors it shipped can't be found; ` +
      `fetch the tags (git fetch origin 'refs/tags/release/*:refs/tags/release/*' 'refs/tags/chant-v*:refs/tags/chant-v*')`,
  ];
}

/** The working tree's stamp: a package's package.json version (core's by default) when it differs from HEAD's. */
function localStamp(lexicon?: string): string | undefined {
  const file = lexicon ? `lexicons/${lexicon}/package.json` : "packages/core/package.json";
  const working = (JSON.parse(readFileSync(join(ROOT, file), "utf-8")) as { version?: string }).version;
  let committed: string | undefined;
  try {
    committed = (JSON.parse(git(["show", `HEAD:${file}`])) as { version?: string }).version;
  } catch {
    committed = undefined;
  }
  return working && working !== committed ? working : undefined;
}

function freeze(version: string, next: string | undefined, rev: string | undefined): void {
  const read = reader(undefined);
  const current = nextRelease(read);
  if (current !== version) throw new Error(`NEXT_RELEASE is ${current}, not ${version}; --freeze takes the version that shipped`);
  const to = next ?? nextPatch(version);
  // #4540: only the floors the release's commit already held shipped in it.
  const at = rev ?? releaseCommit(version);
  if (!at) {
    throw new Error(
      `no release/npm/${version} or chant-v${version} tag in this checkout, so the commit ${version} was cut from is unknown; ` +
        `fetch the tags (git fetch origin 'refs/tags/release/*:refs/tags/release/*' 'refs/tags/chant-v*:refs/tags/chant-v*') or pass --rev <sha>`,
    );
  }
  const { freeze: shipped, keep } = splitFreeze(floors(reader(at), at, version), floors(read, undefined, version));
  const names = new Set(shipped);
  let frozen = 0;
  let droppedImport = false;
  for (const file of floorFiles(undefined)) {
    const src = read(file);
    const out = freezeFloorSource(src, version, names);
    if (out === src) continue;
    writeFileSync(join(ROOT, file), out);
    if (/^import \{ NEXT_RELEASE \}/m.test(src) && !/^import \{ NEXT_RELEASE \}/m.test(out)) droppedImport = true;
    frozen++;
  }
  // The texts of a floor that stays NEXT_RELEASE move with it, as --set moves them.
  const kept = new Set(keep);
  const byFile = new Map<string, string>();
  for (const t of NEXT_RELEASE_TEXT.filter((e) => kept.has(e.floor))) {
    const src = byFile.get(t.file) ?? read(t.file);
    const from = t.text.replaceAll("{v}", version);
    if (count(src, from) !== t.count) throw new Error(`${t.file}: expected ${t.count} of "${from}" before moving it to ${to}; run the check first`);
    byFile.set(t.file, src.replaceAll(from, t.text.replaceAll("{v}", to)));
  }
  for (const [file, src] of byFile) writeFileSync(join(ROOT, file), src);
  const self = "scripts/release-floors.ts";
  writeFileSync(join(ROOT, self), freezeTextList(read(self), kept));
  writeFileSync(join(ROOT, CONSTANT_FILE), read(CONSTANT_FILE).replace(CONSTANT_RE, `export const NEXT_RELEASE = "${to}";`));
  // #4792: the table's rows for the frozen floors take the literal too.
  if (writeTable(ROOT)) console.log(`wrote ${TABLE_FILE}`);
  console.log(`froze ${shipped.length} floors at ${version} (release commit ${at.slice(0, 12)}) in ${frozen} files, NEXT_RELEASE ${version} -> ${to}`);
  if (keep.length > 0) console.log(`left on NEXT_RELEASE, merged after ${version}'s commit: ${keep.join(", ")}${byFile.size > 0 ? `; their texts moved to ${to} in ${byFile.size} files` : ""}`);
  const tests = git(["ls-files", "--", "*.test.ts"])
    .split("\n")
    .filter((f) => f !== "")
    .map((file) => ({ file, src: read(file) }));
  const stale = staleFloorTests(tests, names, droppedImport);
  if (stale.length > 0) {
    console.log(`update these tests:`);
    for (const line of stale) console.log(`  ${line}`);
  }
}

/**
 * Core's sources with every core floor at the version it ships with
 * (#5260), as a map of file to text: the floor files, NEXT_RELEASE_TEXT's
 * files, and the constant. The floor table follows from them.
 */
function packSources(version: string, shipped: ReadonlyMap<string, string>): Map<string, string> {
  const read = reader(undefined);
  const next = nextRelease(read);
  const out = new Map<string, string>();
  for (const file of floorFiles(undefined)) {
    if (LEXICON_FLOORS_FILE.test(file)) continue;
    const src = read(file);
    const resolved = resolveFloorSource(src, shipped, version);
    if (resolved !== src) out.set(file, resolved);
  }
  for (const t of NEXT_RELEASE_TEXT) {
    const src = out.get(t.file) ?? read(t.file);
    const to = shipped.get(t.floor) ?? version;
    out.set(t.file, src.replaceAll(t.text.replaceAll("{v}", next), t.text.replaceAll("{v}", to)));
  }
  const constant = out.get(CONSTANT_FILE) ?? read(CONSTANT_FILE);
  out.set(CONSTANT_FILE, constant.replace(CONSTANT_RE, `export const NEXT_RELEASE = "${version}";`));
  return out;
}

/**
 * `--pack <cmd...>` (#5260): core's prepack. Writes every core floor as the
 * version it ships with, NEXT_RELEASE as the version being packed, and the
 * floor table, runs the command (the build), and puts every file back as it
 * was, whatever the command did.
 */
function pack(command: string[]): number {
  const read = reader(undefined);
  const next = nextRelease(read);
  const symbolic = floors(read, undefined, next).filter((f) => f.symbolic && !f.lexicon).map((f) => f.name);
  const shipped = shippedFromTags(symbolic, "HEAD");
  const version = packVersion(next, localStamp(), newest(releasedVersions(releaseTags())));
  const files = packSources(version, shipped);
  const saved = new Map<string, string>();
  for (const file of [...files.keys(), TABLE_FILE]) saved.set(file, read(file));
  let status = 1;
  try {
    for (const [file, text] of files) writeFileSync(join(ROOT, file), text);
    writeTable(ROOT);
    const shown = [...shipped].map(([n, v]) => `${n} ${v}`);
    // stderr: `npm pack --json` prints the JSON on stdout, after prepack's own output.
    console.error(`release floors: packing with NEXT_RELEASE ${version}${shown.length > 0 ? `; shipped earlier: ${shown.join(", ")}` : ""}`);
    const run = spawnSync(command[0]!, command.slice(1), { stdio: ["inherit", 2, "inherit"] });
    if (run.error) throw run.error;
    status = run.status ?? 1;
  } finally {
    for (const [file, text] of saved) writeFileSync(join(ROOT, file), text);
  }
  return status;
}

function set(version: string): void {
  const read = reader(undefined);
  const old = nextRelease(read);
  const constant = read(CONSTANT_FILE).replace(CONSTANT_RE, `export const NEXT_RELEASE = "${version}";`);
  writeFileSync(join(ROOT, CONSTANT_FILE), constant);
  const byFile = new Map<string, string>();
  for (const t of NEXT_RELEASE_TEXT) {
    const src = byFile.get(t.file) ?? read(t.file);
    const from = t.text.replaceAll("{v}", old);
    if (count(src, from) !== t.count) throw new Error(`${t.file}: expected ${t.count} of "${from}" before setting ${version}; run the check first`);
    byFile.set(t.file, src.replaceAll(from, t.text.replaceAll("{v}", version)));
  }
  for (const [file, src] of byFile) writeFileSync(join(ROOT, file), src);
  console.log(`NEXT_RELEASE ${old} -> ${version} in ${CONSTANT_FILE} and ${byFile.size} files of text`);
}

function localStampOf(lexicon: string, rev: string | undefined): string | undefined {
  return rev ? undefined : localStamp(lexicon);
}

function check(args: Args): number {
  const read = reader(args.rev);
  const next = nextRelease(read);
  const problems: string[] = [];

  for (const t of NEXT_RELEASE_TEXT) {
    const want = t.text.replaceAll("{v}", next);
    const n = count(read(t.file), want);
    if (n !== t.count) problems.push(`${t.file}: "${want}" occurs ${n} times, expected ${t.count} (${t.floor}); NEXT_RELEASE is ${next}, so set the text with --set`);
  }

  const known = released(args.npm);
  const stamp = args.rev ? undefined : localStamp();
  const allowedCache = new Map<string, Set<string>>();
  // #5138: a lexicon floor is checked against that lexicon's own releases and stamp.
  const allowed = (lexicon?: string): Set<string> => {
    const key = lexicon ?? "";
    let set = allowedCache.get(key);
    if (!set) {
      const own = lexicon ? localStampOf(lexicon, args.rev) : stamp;
      set = new Set([...(lexicon ? released(args.npm, lexicon) : known), ...args.release, ...(own ? [own] : [])]);
      allowedCache.set(key, set);
    }
    return set;
  };
  // #5260: a core floor still NEXT_RELEASE packs as the release that first
  // declared it, and one no release declares as the version being cut (the
  // last --release or the train's core label), or else as `--pack` would pack it.
  const declared = floors(read, args.rev, next);
  const symbolicCore = declared.filter((f) => f.symbolic && !f.lexicon).map((f) => f.name);
  const shipped = shippedFromTags(symbolicCore, args.rev ?? "HEAD");
  const cutting = args.release.at(-1);
  const unshipped = cutting ?? packVersion(next, stamp, newest(releasedVersions(releaseTags())));
  const named = [
    { name: "NEXT_RELEASE", file: CONSTANT_FILE, version: cutting ?? next },
    ...declared.map((f) => (f.symbolic && !f.lexicon ? { ...f, version: shipped.get(f.name) ?? unshipped } : f)),
  ];
  problems.push(...unreleasedFloors(named, allowed, args.npm));
  // A lexicon floor is not resolved from core's tags, so it must still be frozen.
  problems.push(...shippedSymbolic(next, declared.filter((f) => f.lexicon), known, stamp));
  if (args.npm && symbolicCore.length > 0) problems.push(...missingTags(newest(known), newest(releasedVersions(releaseTags()))));
  // #4792: the floor table a product reads lists every floor, at its version.
  const table = tableAgainst(ROOT, args.rev);
  if (table.want !== table.have) problems.push(`${TABLE_FILE}: ${table.have === undefined ? "missing" : "does not list every floor at its version"}; run \`npx tsx scripts/floor-table.ts\``);

  const where = args.rev ? `at ${args.rev}` : "in the working tree";
  if (problems.length > 0) {
    console.error(`release floors ${where}: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  ${p}`);
    const sources = [`${known.size} released versions`, ...(stamp ? [`local stamp ${stamp}`] : []), ...args.release.map((r) => `--release ${r}`)];
    console.error(`  (checked against ${sources.join(", ")})`);
    return 1;
  }
  const fromTags = [...shipped].map(([n, v]) => `${n} ${v}`);
  console.log(`release floors ${where}: ${named.length} floors and ${NEXT_RELEASE_TEXT.length} texts agree; NEXT_RELEASE is ${next}${fromTags.length > 0 ? `; on NEXT_RELEASE and shipped, packed at their release: ${fromTags.join(", ")}` : ""}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = parseArgs(process.argv.slice(2));
  if (args.set) set(args.set);
  else if (args.freeze) freeze(args.freeze, args.next, args.rev);
  else if (args.pack) process.exit(pack(args.pack));
  else if (args.trainWithoutCore) console.log("release floors: the train does not release core, so no core floor ships with it");
  else process.exit(check(args));
}
