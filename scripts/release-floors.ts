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
 *   npx tsx scripts/release-floors.ts --freeze <v> [--next <n>]
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
 * (#4501). `--freeze <v>`, run on main once <v> is published and while
 * NEXT_RELEASE is still <v>, writes "<v>" in place of NEXT_RELEASE in every
 * floor constant (dropping an import of NEXT_RELEASE the file no longer
 * uses), empties NEXT_RELEASE_TEXT (the texts already carry "<v>"), and sets
 * NEXT_RELEASE to `--next`, or <v> with its patch number raised. The check
 * fails while a floor is still NEXT_RELEASE and NEXT_RELEASE names a version
 * that has a release, so a shipped floor can't stay symbolic and move with
 * the next `--set`.
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
  { file: "packages/core/src/workspace/change-set.schema.json", text: "by #4440, written by chant {v} and newer", count: 1, floor: "CHANGE_SET_GROUP_FLOOR" },
  { file: "packages/core/src/workspace/pr-report.schema.json", text: "#4440, written by chant {v} and newer", count: 1, floor: "PR_REPORT_NOT_STARTED_FLOOR" },
  { file: "packages/core/src/workspace/pr-report.schema.json", text: "#4446, written by chant {v} and newer", count: 4, floor: "PR_REPORT_GROUPS_FLOOR" },
  { file: "docs/src/content/docs/reference/change-set.mdx", text: "Part of the digest when present. Written by chant {v} and newer", count: 1, floor: "CHANGE_SET_GROUP_FLOOR" },
  { file: "docs/src/content/docs/reference/workspace-read-contract.mdx", text: "`members[].status` value `not-started` | {v} |", count: 1, floor: "PR_REPORT_GROUPS_FLOOR" },
  { file: "packages/core/src/workspace/change-set.schema.json", text: "by #4463, written by chant {v} and newer", count: 1, floor: "change-set placeholders (#4463)" },
  { file: "docs/src/content/docs/reference/change-set.mdx", text: "Absent otherwise. Written by chant {v} and newer", count: 1, floor: "change-set placeholders (#4463)" },
  { file: "docs/src/content/docs/reference/workspace-read-contract.mdx", text: "`members[].placeholders` | {v} |", count: 1, floor: "change-set placeholders (#4463)" },
  { file: "docs/src/content/docs/reference/workspace-read-contract.mdx", text: "`entries[].instanceOf` | {v} |", count: 1, floor: "instance nodes (#4454)" },
  { file: "docs/src/content/docs/reference/workspace-read-contract.mdx", text: "`nodes[].instanceOf`, `nodes[].instanceKey` | {v} |", count: 1, floor: "instance nodes (#4454)" },
  { file: "docs/src/content/docs/reference/workspace-read-contract.mdx", text: "`nodes[].instanceScope` | {v} |", count: 1, floor: "instance nodes under a module call (#4486)" },
  { file: "docs/src/content/docs/reference/workspace-read-contract.mdx", text: "`nodes[].instanceRollup` | {v} |", count: 1, floor: "instance rollups (#4489)" },
  { file: "packages/core/src/workspace/graph.schema.json", text: "by #4489, written by chant {v} and newer", count: 1, floor: "instance rollups (#4489)" },
  { file: "docs/src/content/docs/reference/workspace-read-contract.mdx", text: "the `root_member` column of `chant query`'s `runs` | {v} |", count: 1, floor: "LEDGER_ROOT_MEMBER_FLOOR" },
  { file: "packages/core/src/workspace/ledger.schema.json", text: "by #4500, written by chant {v} and newer", count: 1, floor: "LEDGER_ROOT_MEMBER_FLOOR" },
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

interface Floor {
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
export function shippedSymbolic(next: string, named: Floor[], known: Set<string>): string[] {
  if (!known.has(next)) return [];
  return named
    .filter((f) => f.symbolic)
    .map((f) => `${f.file}: ${f.name} is NEXT_RELEASE, and ${next} has shipped; run \`just release-floors --freeze ${next}\``);
}

/**
 * One source file with every `<NAME>_FLOOR = NEXT_RELEASE;` written as the
 * literal `version`, and its import of NEXT_RELEASE dropped when nothing else
 * in it names NEXT_RELEASE.
 */
export function freezeFloorSource(src: string, version: string): string {
  let out = src.replace(/(export const [A-Z0-9_]+_FLOOR = )NEXT_RELEASE;/g, `$1"${version}";`);
  if (out === src) return src;
  const importRe = /^import \{ NEXT_RELEASE \} from "[^"]*release-floors(?:\.js)?";\n/m;
  const rest = out.replace(importRe, "");
  if (!/\bNEXT_RELEASE\b/.test(rest)) out = rest;
  return out;
}

/** This script's source with NEXT_RELEASE_TEXT emptied: every line between its opening and closing bracket that holds an entry goes. */
export function freezeTextList(src: string): string {
  const open = src.indexOf("const NEXT_RELEASE_TEXT:");
  if (open === -1) throw new Error("no NEXT_RELEASE_TEXT list");
  const start = src.indexOf("[\n", open) + 2;
  const end = src.indexOf("\n];\n", start - 1);
  if (start < 2 || end === -1) throw new Error("NEXT_RELEASE_TEXT is not a bracketed list");
  const lines = src.slice(start, end + 1).split("\n");
  const kept = lines.filter((l) => !/^\s*\{ file: /.test(l));
  return src.slice(0, start) + kept.join("\n") + src.slice(end + 1);
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

function freeze(version: string, next: string | undefined): void {
  const read = reader(undefined);
  const current = nextRelease(read);
  if (current !== version) throw new Error(`NEXT_RELEASE is ${current}, not ${version}; --freeze takes the version that shipped`);
  const to = next ?? nextPatch(version);
  let frozen = 0;
  for (const file of floorFiles(undefined)) {
    const src = read(file);
    const out = freezeFloorSource(src, version);
    if (out === src) continue;
    writeFileSync(join(ROOT, file), out);
    frozen++;
  }
  const self = "scripts/release-floors.ts";
  writeFileSync(join(ROOT, self), freezeTextList(read(self)));
  writeFileSync(join(ROOT, CONSTANT_FILE), read(CONSTANT_FILE).replace(CONSTANT_RE, `export const NEXT_RELEASE = "${to}";`));
  console.log(`froze the floors at ${version} in ${frozen} files, emptied NEXT_RELEASE_TEXT, NEXT_RELEASE ${version} -> ${to}`);
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
  problems.push(...shippedSymbolic(next, named, known));

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
  else if (args.freeze) freeze(args.freeze, args.next);
  else process.exit(check(args));
}
