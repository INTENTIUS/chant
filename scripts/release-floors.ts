#!/usr/bin/env tsx
/**
 * The contract floors that name the next chant release, and a check that
 * every floor names a version that exists (#4480).
 *
 *   npx tsx scripts/release-floors.ts                  check the working tree
 *   npx tsx scripts/release-floors.ts --rev <sha>      check a commit's tree
 *   npx tsx scripts/release-floors.ts --release <v>    count <v> as a release (the one being cut)
 *   npx tsx scripts/release-floors.ts --npm            also ask npm for the published versions
 *   npx tsx scripts/release-floors.ts --set <v>        set the next release's number
 *   npx tsx scripts/release-floors.ts --freeze <v> [--next <n>] [--rev <sha>]
 *                                                      after <v> shipped: its floors become literals
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
 * <NAME>_FLOOR = "<version>"` under packages/core/src.
 *
 * A published release is read from the checkout's tags, release/npm/<v> and
 * chant-v<v>, so the default mode needs no network; fetch the tags first
 * (`git fetch origin 'refs/tags/release/*:refs/tags/release/*'
 * 'refs/tags/chant-v*:refs/tags/chant-v*'`), as `just release` does. `--npm`
 * adds `npm view @intentius/chant versions`.
 *
 * npm is the source of truth for what was published (#4503). A tag can exist
 * in one checkout and not on origin (chant-v0.81.0 did: npm lists 0.81.0,
 * origin's tags skip from 0.80.0 to 0.82.0), so a check that read tags only
 * passed on the maintainer's checkout and would fail on a clean CI checkout.
 * scripts/release-pack.sh and `just release` both run with `--npm`; the
 * tags-only default is for an offline look at the working tree.
 *
 * A local build stamp is the version of packages/core/package.json in the
 * working tree when it differs from the committed one: scripts/release-pack.sh
 * and a local `npm pack` build (install-local-chant.sh) stamp every package
 * at the version they build, uncommitted, so a build stamped at NEXT_RELEASE
 * passes. `--release <v>` counts <v> the same way, for `just release`, which
 * checks the commit it cuts before any stamp exists.
 *
 * After a release ships, its floors stay at the version they shipped with
 * (#4501). `--freeze <v>`, run once <v> is published and while NEXT_RELEASE
 * is still <v>, writes "<v>" in place of NEXT_RELEASE in each floor constant
 * that <v> shipped (dropping an import of NEXT_RELEASE the file no longer
 * uses), drops those floors' entries from NEXT_RELEASE_TEXT (the texts
 * already carry "<v>"), and sets NEXT_RELEASE to `--next`, or <v> with its
 * patch number raised. The check fails while a floor is still NEXT_RELEASE
 * and NEXT_RELEASE names a version that has a release, so a shipped floor
 * can't stay symbolic and move with the next `--set`.
 *
 * A floor shipped in <v> when it was already NEXT_RELEASE at <v>'s release
 * commit (#4540): the commit `release/npm/<v>` (or `chant-v<v>`) names, or
 * `--rev`. A floor merged after the cut stays NEXT_RELEASE and moves to the
 * new number, and so do its NEXT_RELEASE_TEXT entries and the texts they
 * list. With no tag and no `--rev` the freeze refuses rather than guess.
 * It then prints the tests a freeze leaves stale: a test that asserts
 * `toBe(NEXT_RELEASE)` and names a frozen floor, and, when a floor file
 * dropped its import, a bundle test whose expected module list names
 * packages/core/src/release-floors.ts.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
const CONSTANT_FILE = "packages/core/src/release-floors.ts";
const CONSTANT_RE = /export const NEXT_RELEASE = "(\d+\.\d+\.\d+)";/;
const FLOOR_RE = /export const ([A-Z0-9_]+_FLOOR) = (?:"(\d+\.\d+\.\d+)"|(NEXT_RELEASE));/g;

/**
 * Text outside TypeScript that repeats a floor naming the next release. `{v}`
 * is the version; each text must occur `count` times in `file` with
 * NEXT_RELEASE in its place.
 */
const NEXT_RELEASE_TEXT: { file: string; text: string; count: number; floor: string }[] = [
  // --freeze empties this list after a release ships (#4501); each entry is one line.
  { file: "packages/core/src/workspace/release-candidates.schema.json", text: "Written by chant {v} and newer.", count: 2, floor: "RELEASE_CANDIDATES_CLOSES_FLOOR" },
  { file: "docs/src/content/docs/reference/workspace-read-contract.mdx", text: "`candidates[].groups[].issue` | {v} |", count: 1, floor: "RELEASE_CANDIDATES_CLOSES_FLOOR" },
  { file: "packages/core/src/workspace/intent.schema.json", text: "Added within version 1 by chant {v}.", count: 1, floor: "INTENT_CLOSES_FLOOR" },
  { file: "packages/core/src/workspace/intent-record.schema.json", text: "Added within version 1 by chant {v}.", count: 1, floor: "INTENT_CLOSES_FLOOR" },
  { file: "docs/src/content/docs/reference/workspace-read-contract.mdx", text: "`commits[].closes` | {v} |", count: 1, floor: "INTENT_CLOSES_FLOOR" },
  { file: "packages/core/src/workspace/release-candidates.schema.json", text: "Added by #4692, written by chant {v} and newer.", count: 1, floor: "RELEASE_CANDIDATES_LANE_FLOOR" },
  { file: "packages/core/src/workspace/releases.schema.json", text: "Added by #4692, written by chant {v} and newer.", count: 1, floor: "RELEASE_CUT_LANE_FLOOR" },
  { file: "docs/src/content/docs/reference/workspace-read-contract.mdx", text: "| `release-candidates` | `lane` | {v} |", count: 1, floor: "RELEASE_CANDIDATES_LANE_FLOOR" },
  { file: "docs/src/content/docs/reference/workspace-read-contract.mdx", text: "| `releases` | `releases[].cuts[].lane` | {v} |", count: 1, floor: "RELEASE_CUT_LANE_FLOOR" },
  { file: "packages/core/src/workspace/releases.schema.json", text: "Added by #4693, written by chant {v} and newer.", count: 1, floor: "RELEASE_CUT_OVERRIDE_FLOOR" },
  { file: "docs/src/content/docs/reference/workspace-read-contract.mdx", text: "| `releases` | `releases[].cuts[].override` | {v} |", count: 1, floor: "RELEASE_CUT_OVERRIDE_FLOOR" },
  { file: "packages/core/src/workspace/plan-stale.schema.json", text: "Contract version 1 of this document is written by chant {v} and newer.", count: 1, floor: "PLAN_STALE_FLOOR" },
  { file: "docs/src/content/docs/reference/workspace-read-contract.mdx", text: "| `--json`, floor chant {v} | `https://intentius.io/chant/schemas/workspace/plan-stale/v1/plan-stale.schema.json` |", count: 1, floor: "PLAN_STALE_FLOOR" },
  { file: "docs/src/content/docs/cli/plan.mdx", text: "a [read contract](/chant/reference/workspace-read-contract/#stale-plans) at version 1, written by chant {v} and newer.", count: 1, floor: "PLAN_STALE_FLOOR" },
  { file: "packages/core/src/gate-statement.schema.json", text: "Written by chant {v} and newer.", count: 1, floor: "GATE_EXTERNAL_SIGNATURE_FLOOR" },
  { file: "docs/src/content/docs/reference/workspace-declaration.mdx", text: "Chant {v} and newer write and read `passkeys` and passkey seals.", count: 1, floor: "GATE_EXTERNAL_SIGNATURE_FLOOR" },
  { file: "docs/src/content/docs/reference/workspace-declaration.mdx", text: "Chant {v} and newer write and check a binding.", count: 1, floor: "GATE_BINDING_FLOOR" },
  { file: "packages/core/src/workspace/declaration.schema.json", text: "Read by chant {v} and newer, so a declaration that sets it sets minReader to {v} or newer.", count: 1, floor: "CI_QUARANTINE_FLOOR" },
  { file: "docs/src/content/docs/reference/workspace-declaration.mdx", text: "Read by chant {v} and newer, so set `minReader` with it.", count: 1, floor: "CI_QUARANTINE_FLOOR" },
  { file: "docs/src/content/docs/cli/ci.mdx", text: "`quarantine` needs `minReader` {v} or newer.", count: 1, floor: "CI_QUARANTINE_FLOOR" },
  { file: "packages/core/src/notify.schema.json", text: "Sent by chant {v} and newer.", count: 1, floor: "CI_QUARANTINE_NOTIFY_FLOOR" },
  { file: "docs/src/content/docs/reference/publish-targets.mdx", text: "Another forge refuses it with `publish-forge-latest-unsupported`. Read by chant {v} and newer", count: 1, floor: "PUBLISH_FORGE_LATEST_FLOOR" },
  { file: "docs/src/content/docs/reference/publish-targets.mdx", text: "([#4676](https://github.com/INTENTIUS/chant/issues/4676)). Read by chant {v} and newer.", count: 1, floor: "PUBLISH_HOMEBREW_FLOOR" },
  { file: "docs/src/content/docs/reference/publish-targets.mdx", text: "A deploy key reaches the one repository it was added to, where a classic token reaches every repository its user can. Read by chant {v} and newer.", count: 1, floor: "PUBLISH_HOMEBREW_SSH_KEY_FLOOR" },
  { file: "docs/src/content/docs/reference/publish-targets.mdx", text: "Declare one target per marketplace. Read by chant {v} and newer.", count: 1, floor: "PUBLISH_MARKETPLACE_FLOOR" },
  { file: "docs/src/content/docs/reference/publish-targets.mdx", text: "`ovsx publish --trusted-publishing` do. Read by chant {v} and newer.", count: 1, floor: "PUBLISH_MARKETPLACE_AUTH_FLOOR" },
  { file: "docs/src/content/docs/reference/publish-targets.mdx", text: "doesn't fail the publish ([#4698](https://github.com/INTENTIUS/chant/issues/4698)). Read by chant {v} and newer.", count: 1, floor: "PUBLISH_MARKETPLACE_ON_REFUSAL_FLOOR" },
  { file: "docs/src/content/docs/reference/publish-targets.mdx", text: "The release-per-version, if there is one, is a `forge` target's. Read by chant {v} and newer.", count: 1, floor: "PUBLISH_TAURI_UPDATER_FLOOR" },
  { file: "packages/core/src/workspace/declaration.schema.json", text: "Read by chant {v} and newer, so a declaration that sets staleAfter sets minReader to {v} or newer.", count: 1, floor: "CI_STALE_NOTIFY_FLOOR" },
  { file: "docs/src/content/docs/reference/workspace-declaration.mdx", text: "it needs `minReader` {v} or newer.", count: 1, floor: "CI_STALE_NOTIFY_FLOOR" },
];

interface Args {
  rev?: string;
  release: string[];
  npm: boolean;
  set?: string;
  freeze?: string;
  next?: string;
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
    if (a === "--rev") args.rev = value();
    else if (a === "--release") args.release.push(value());
    else if (a === "--npm") args.npm = true;
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

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
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

/** Every floor constant under packages/core/src, with the version it names. */
function floors(read: (file: string) => string, rev: string | undefined, next: string): Floor[] {
  const out: Floor[] = [];
  for (const file of floorFiles(rev)) {
    const src = read(file);
    for (const m of src.matchAll(FLOOR_RE)) out.push({ name: m[1], file, version: m[2] ?? next, symbolic: m[3] !== undefined });
  }
  return out;
}

export interface Floor {
  name: string;
  file: string;
  version: string;
  /** The constant is NEXT_RELEASE, not a literal. */
  symbolic?: boolean;
}

function floorFiles(rev: string | undefined): string[] {
  return git(rev ? ["ls-tree", "-r", "--name-only", rev, "--", "packages/core/src"] : ["ls-files", "--", "packages/core/src"])
    .split("\n")
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
}

/**
 * NEXT_RELEASE and each floor still set to it, as problem lines, when
 * NEXT_RELEASE names a version that has a release (#4501): those floors
 * shipped and must be literals before NEXT_RELEASE moves on.
 */
export function shippedSymbolic(next: string, named: Floor[], known: Set<string>, stamp?: string): string[] {
  // A working tree stamped with NEXT_RELEASE is release-pack.sh packing that
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

/** The commit a release was cut from: the one its `release/npm/<v>` or `chant-v<v>` tag names. */
function releaseCommit(version: string): string | undefined {
  for (const tag of [`release/npm/${version}`, `chant-v${version}`]) {
    try {
      return git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]).trim() || undefined;
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

/**
 * The versions with a release, from a tag list (`git tag -l` output) and,
 * when given, npm's list of published versions.
 */
export function releasedVersions(tags: string[], npmVersions?: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of tags) {
    const m = /^(?:release\/npm\/|chant-v)(\d+\.\d+\.\d+)$/.exec(t.trim());
    if (m) out.add(m[1]);
  }
  for (const v of npmVersions ?? []) out.add(v);
  return out;
}

/** The versions with a release: the checkout's tags, and npm's list with --npm. */
function released(npm: boolean): Set<string> {
  const tags = git(["tag", "-l", "release/npm/*", "chant-v*"]).split("\n");
  if (!npm) return releasedVersions(tags);
  const raw = execFileSync("npm", ["view", "@intentius/chant", "versions", "--json"], { encoding: "utf-8" });
  return releasedVersions(tags, JSON.parse(raw) as string[]);
}

/** Each floor whose version is not in `allowed`, as a problem line. */
export function unreleasedFloors(
  named: { name: string; file: string; version: string }[],
  allowed: Set<string>,
  npm: boolean,
): string[] {
  return named
    .filter((f) => !allowed.has(f.version))
    .map((f) => `${f.file}: ${f.name} names ${f.version}, which has no release tag${npm ? " or npm version" : ""} and no local build stamp`);
}

/** The working tree's stamp: packages/core/package.json's version when it differs from HEAD's. */
function localStamp(): string | undefined {
  const file = "packages/core/package.json";
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
  const allowed = new Set([...known, ...args.release, ...(stamp ? [stamp] : [])]);
  const named = [{ name: "NEXT_RELEASE", file: CONSTANT_FILE, version: next }, ...floors(read, args.rev, next)];
  problems.push(...unreleasedFloors(named, allowed, args.npm));
  problems.push(...shippedSymbolic(next, named, known, stamp));

  const where = args.rev ? `at ${args.rev}` : "in the working tree";
  if (problems.length > 0) {
    console.error(`release floors ${where}: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  ${p}`);
    const sources = [`${known.size} released versions`, ...(stamp ? [`local stamp ${stamp}`] : []), ...args.release.map((r) => `--release ${r}`)];
    console.error(`  (checked against ${sources.join(", ")})`);
    return 1;
  }
  console.log(`release floors ${where}: ${named.length} floors and ${NEXT_RELEASE_TEXT.length} texts agree; NEXT_RELEASE is ${next}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = parseArgs(process.argv.slice(2));
  if (args.set) set(args.set);
  else if (args.freeze) freeze(args.freeze, args.next, args.rev);
  else process.exit(check(args));
}
