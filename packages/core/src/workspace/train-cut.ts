/**
 * Cutting a release train (#5154): `chant workspace train cut <env> [--at
 * <sha>] [--levels <levels>] [--yes] [--no-push] [--json]`, run in the root of
 * a workspace whose `chant` members are the releasable units (each package
 * of a monorepo, say), with `release.train` in the root's `chant.config.ts`.
 *
 * One command does what a hand-written release script did:
 *
 * 1. The commit: `--at` (the trunk's tip without it). A commit a
 *    `release-train/<env>/<id>` tag already names is released, and nothing
 *    more happens.
 * 2. The members: those `chant release changed` lists at the commit, with
 *    its dependency closure, each at the level `--levels` types for it or,
 *    without one, the level its conventional commits and intent files give.
 *    A member already cut from this commit (a run that stopped part way) is
 *    taken at the label it was cut with, and is not cut again.
 * 3. The labels: each member's next label is floored past every version it
 *    already has: the labels in its ledger, its release tags (`release.tag`,
 *    or `release/<member>/<label>`), the `release.legacyTags` tags, the
 *    `version` of each package its `release.version` names at the commit,
 *    and every version the npm registry lists for the packages it publishes.
 *    So a label is never one a registry already holds. Under `first:
 *    "together"` the first train of the environment cuts every member at one
 *    label, one past the highest of all of them and of the root member's
 *    own ledger.
 * 4. `release.train.check`: shell lines run once the labels are known and
 *    before anything is cut, with `CHANT_RELEASE_COMMIT`, `CHANT_TRAIN_ENV`
 *    and `CHANT_TRAIN_PLAN` (a JSON file of the members and labels).
 *    With `--doctor` (#5216), `chant release doctor` then runs in each
 *    member, and a failed check stops the train with nothing cut.
 * 5. `chant release cut <label> --at <commit> --yes` in each member's
 *    directory, in publish order. Each cut pushes its record and tags the
 *    commit locally.
 * 6. The train: every member at the release this run cut, the rest at their
 *    newest, written to `chant/lifecycle` and pushed.
 * 7. One atomic push of every member's tag and `release-train/<env>/<id>` on
 *    the commit. A workflow on that tag publishes the train.
 *
 * Without `--yes` it plans: it prints the members and labels, runs each
 * cut's dry run, and cuts, records, tags and pushes nothing. `--plan-only`
 * (#5237) prints the members and labels and runs no member's dry run: what
 * a workflow's gate reads to give each per-platform build job its member's
 * label. `--planned "<member>=<label> ..."` (or `none`) then makes the cut
 * refuse (`train-plan-changed`) unless it plans exactly those members at
 * those labels, so the files the build jobs made carry the labels the cut
 * records.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { runToStderr, tailLines } from "./train-shell";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { readCuts } from "../lifecycle/release-store";
import { readDeclaration } from "./declaration";
import { bumpLabel, parseVersion, RELEASE_BUMPS, type ReleaseBump, type ReleaseChangedMember } from "./release-changed";
import { appendReleaseTrain, pickTrain, readMemberReleases, readReleaseTrains, trainDigest, type ReleaseTrainRecord } from "./release-train";
import { locateWorkspace } from "./which-chant";
import { NEXT_RELEASE } from "../release-floors";

/** The first chant with `chant workspace train cut --plan-only` and `--planned` (#5237): what the train workflow's gate and cut jobs run when a member declares `release.workflow.builds`. */
export const TRAIN_BUILDS_FLOOR = NEXT_RELEASE;

/** `release.train` in a workspace root's `chant.config.ts` (#5154). */
export interface ReleaseTrainConfig {
  /** The environment the train is recorded for, and the middle of its tag `release-train/<env>/<id>`. */
  env: string;
  /**
   * The first train of the environment: `each` (default) labels every member
   * from its own versions; `together` cuts every member at one label, one past
   * the highest version any of them has, so packages that shipped at one
   * version until now start from it together.
   */
  first?: "each" | "together";
  /** Shell lines run at the root once the labels are known and before any cut, with `CHANT_RELEASE_COMMIT`, `CHANT_TRAIN_ENV` and `CHANT_TRAIN_PLAN`. One that fails stops the train with nothing cut. */
  check?: string[];
  /**
   * The command `chant workspace train prepare` runs in each workspace
   * package a published member depends on and the train does not publish
   * here, once, dependencies first. Default: the package's `prepack` script,
   * else its `build` script. `false` builds nothing.
   */
  buildDependencies?: string | false;
}

/** Why a train cut stopped. */
export class TrainCutError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = "TrainCutError";
  }
}

/** One member of a planned train. */
export interface TrainCutMember {
  member: string;
  /** The member's directory from the workspace root. */
  dir: string;
  label: string;
  /** Why it is in the train: a `release changed` reason (`paths-changed`, `needed-by <member>`, ...), `first-train`, or `already-cut`. */
  why: string;
  /** The level its label was bumped by, or null for a resumed member. */
  bump: ReleaseBump | null;
  /** Where the level came from: `typed`, `commits`, `intents`, `default`, `first-train` or `already-cut`. */
  bumpFrom: string;
  /** The highest version the member already has anywhere, or null for none. */
  floor: string | null;
  /** True when this commit already has the member's release, from a run that stopped part way. */
  resumed: boolean;
}

export interface TrainCutPlan {
  env: string;
  commit: string;
  /** True when this is the environment's first train and `first: "together"` gave every member one label. */
  first: boolean;
  /** The `release-train/<env>/<id>` tag already on the commit, when it is released; then `members` is empty. */
  released: string | null;
  members: TrainCutMember[];
}

/** The levels typed for a train: one for every member, and one per member. */
export interface TrainLevels {
  all?: ReleaseBump;
  members: Record<string, ReleaseBump>;
}

/**
 * Parse `--levels`: words separated by spaces or commas, each `major`,
 * `minor` or `patch` (every member), `<member>=<level>`, or `auto` (the
 * levels the commits and intent files give; the same as nothing).
 */
export function parseTrainLevels(text: string | undefined): TrainLevels {
  const out: TrainLevels = { members: {} };
  for (const word of (text ?? "").split(/[\s,]+/).filter(Boolean)) {
    if (word === "auto") continue;
    const at = word.indexOf("=");
    const level = at < 0 ? word : word.slice(at + 1);
    if (!(RELEASE_BUMPS as readonly string[]).includes(level)) {
      throw new TrainCutError("train-levels-invalid", `--levels ${JSON.stringify(word)}: a level is major, minor or patch`, "Give auto, a level for every member, <member>=<level>, or several of them separated by spaces.");
    }
    if (at < 0) {
      if (out.all !== undefined && out.all !== level) throw new TrainCutError("train-levels-invalid", `--levels gives two levels for every member (${out.all}, ${level})`);
      out.all = level as ReleaseBump;
    } else {
      const m = word.slice(0, at);
      if (m === "") throw new TrainCutError("train-levels-invalid", `--levels ${JSON.stringify(word)} names no member`);
      out.members[m] = level as ReleaseBump;
    }
  }
  return out;
}

type Version = [number, number, number];
const cmp = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const show = (v: Version): string => v.join(".");

/** The highest of `versions`, or null. */
export function highestVersion(versions: Iterable<string>): string | null {
  let best: Version | null = null;
  for (const t of versions) {
    const v = parseVersion(t);
    if (v && (best === null || cmp(v, best) > 0)) best = v;
  }
  return best ? show(best) : null;
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

/** Lists the versions a registry holds for an npm package; null when it has never heard of it. Throws when the registry can't say. */
export type NpmVersionsReader = (name: string, registry: string | undefined) => string[] | null;

/** `npm view <name> versions --json`, as npm prints it: a string for one version, an array for several. */
export function npmVersions(npm = "npm", env: NodeJS.ProcessEnv = process.env): NpmVersionsReader {
  return (name, registry) => {
    const r = spawnSync(npm, ["view", name, "versions", "--json", ...(registry ? ["--registry", registry] : [])], { encoding: "utf-8", env, maxBuffer: 64 * 1024 * 1024 });
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    if (r.status !== 0) {
      if (/E404|404 Not Found/.test(out)) return null;
      throw new TrainCutError("train-registry-unreadable", `npm view ${name} versions failed, so the version floor of ${name} is unknown: ${(r.error?.message ?? out).trim().split("\n").at(-1)}`, "Check that npm can reach the registry, and run the train again.");
    }
    // npm's notices ("npm notice ...", "npm warn ...") can share stdout with the JSON.
    const text = (r.stdout ?? "")
      .split("\n")
      .filter((l) => !/^npm (notice|warn|WARN)\b/.test(l))
      .join("\n")
      .trim();
    if (text === "") return [];
    try {
      const parsed = JSON.parse(text) as unknown;
      return (Array.isArray(parsed) ? parsed : [parsed]).filter((v): v is string => typeof v === "string");
    } catch {
      throw new TrainCutError("train-registry-unreadable", `npm view ${name} versions printed something that is not JSON`);
    }
  };
}

/** What the floor of one member reads. */
interface FloorSources {
  top: string;
  commit: string;
  memberDir: string;
  registry: NpmVersionsReader;
}

/** Every version the member at `memberDir` has anywhere (#5154): ledger labels, release tags, legacy tags, package versions at the commit, registry versions. */
export async function memberVersions(s: FloorSources): Promise<string[]> {
  const out: string[] = [];
  const { cuts } = await readCuts({ cwd: s.memberDir });
  for (const c of cuts) if (c.label !== null) out.push(c.label);
  // Its own release tags, as release.tag (or the default) renders them.
  const { memberTags, tagShape } = await import("../lifecycle/release-tag");
  const { loadChantConfig } = await import("../config");
  const config = (await loadChantConfig(s.memberDir)).config;
  const tags = await memberTags(s.memberDir, { config: config.release?.tag, top: s.top });
  try {
    const shape = tagShape(tags.template.name, tags.place);
    for (const t of (tryGit(s.top, ["tag", "-l", `${shape.prefix}*${shape.suffix}`]) ?? "").split("\n").filter(Boolean)) {
      if (!t.startsWith(shape.prefix) || !t.endsWith(shape.suffix)) continue;
      const v = t.slice(shape.prefix.length, t.length - shape.suffix.length);
      if (parseVersion(v)) out.push(v);
    }
  } catch {
    // A template with no version in it has no versions to read.
  }
  // Tags of releases cut before the member had a ledger.
  const { memberReleaseSettings } = await import("./release-changed");
  for (const prefix of (await memberReleaseSettings(s.memberDir)).legacyTags) {
    for (const t of (tryGit(s.top, ["tag", "-l", `${prefix}*`]) ?? "").split("\n").filter(Boolean)) {
      const v = t.slice(prefix.length);
      if (/^v?\d+\.\d+\.\d+$/.test(v)) out.push(v);
    }
  }
  // The packages it stamps and publishes: their committed versions, and what the registry holds.
  const names = new Map<string, string | undefined>();
  const readName = (dir: string): string | null => {
    const file = resolve(s.memberDir, dir, "package.json");
    const rel = relative(realpathSync(s.top), resolve(realpathSync(s.memberDir), dir)).split(sep).join("/");
    const committed = rel.startsWith("..") ? null : tryGit(s.top, ["show", `${s.commit}:${rel ? `${rel}/` : ""}package.json`]);
    const text = committed ?? (existsSync(file) ? readFileSync(file, "utf-8") : null);
    if (text === null) return null;
    try {
      const pkg = JSON.parse(text) as { name?: unknown; version?: unknown; private?: unknown };
      if (typeof pkg.version === "string") out.push(pkg.version);
      return typeof pkg.name === "string" && pkg.private !== true ? pkg.name : null;
    } catch {
      return null;
    }
  };
  for (const p of config.release?.version?.packages ?? []) {
    const name = readName(p);
    if (name && !names.has(name)) names.set(name, undefined);
  }
  for (const t of config.release?.publish ?? []) {
    if (t.type !== "npm") continue;
    const npm = t as { packages?: string[]; registry?: string };
    for (const p of npm.packages ?? []) {
      if (!existsSync(resolve(s.memberDir, p, "package.json"))) continue;
      const name = readName(p);
      if (name) names.set(name, npm.registry);
    }
  }
  for (const [name, registry] of names) out.push(...(s.registry(name, registry) ?? []));
  return out;
}

export interface TrainCutQuery {
  /** Any directory of the workspace whose train it cuts. */
  cwd: string;
  env: string;
  /** The commit; the trunk's tip without it. */
  at?: string;
  levels?: TrainLevels;
  /**
   * The members and labels a plan made earlier gave (#5237), by member: the
   * cut refuses (`train-plan-changed`) unless its own plan names exactly
   * these, before any check, doctor or cut runs. Empty for a plan of nothing.
   */
  planned?: Record<string, string>;
  /** Reads the registry's versions. Default: {@link npmVersions}. */
  registry?: NpmVersionsReader;
}

/** The members of the workspace root at `root`, with their directories. */
function chantMembers(root: string): Array<{ name: string; dir: string }> {
  const located = locateWorkspace(root);
  return readDeclaration(located.tree, "", { rootChant: true })
    .members.filter((m) => m.kind === "chant" && m.dir !== ".")
    .map((m) => ({ name: m.name, dir: m.dir }));
}

/** The release config of the workspace root, with `release.train` checked. */
export async function trainConfigAt(root: string, env: string): Promise<ReleaseTrainConfig> {
  const { loadChantConfig } = await import("../config");
  let train: ReleaseTrainConfig | undefined;
  try {
    train = (await loadChantConfig(root)).config.release?.train;
  } catch (err) {
    throw new TrainCutError("train-config-unreadable", `the workspace root's chant.config.ts could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!train) throw new TrainCutError("train-not-declared", "the workspace root's chant.config.ts declares no release.train", 'Declare the train: release: { train: { env: "npm" } }.');
  if (train.env !== env) throw new TrainCutError("train-env-mismatch", `release.train records trains for ${train.env}, not ${env}`, `Run chant workspace train cut ${train.env}.`);
  return train;
}

/** Plan a train: the commit, the members and their labels (#5154). Writes nothing. */
export async function planTrainCut(q: TrainCutQuery): Promise<TrainCutPlan> {
  const located = locateWorkspace(q.cwd);
  const root = located.rootOnDisk;
  const top = tryGit(root, ["rev-parse", "--show-toplevel"]);
  if (!top) throw new TrainCutError("not-a-git-repository", "a train is cut from a commit, and this directory is not in a git repository");
  const config = await trainConfigAt(root, q.env);
  const levels = q.levels ?? { members: {} };
  const members = chantMembers(root);
  if (members.length === 0) throw new TrainCutError("train-no-members", "the workspace declares no chant member to release", "Declare one member per releasable unit in chant.workspace.json.");
  for (const m of Object.keys(levels.members)) {
    if (!members.some((x) => x.name === m)) throw new TrainCutError("train-levels-invalid", `--levels names ${m}, which is not a chant member of this workspace (${members.map((x) => x.name).join(", ")})`);
  }
  const { releaseChangedDocument } = await import("./release-changed");
  const flags = members.flatMap((m) => {
    const level = levels.members[m.name] ?? levels.all;
    return level ? [`${m.name}=${level}`] : [];
  });
  const changed = await releaseChangedDocument({ cwd: root, ...(q.at !== undefined ? { at: q.at } : {}), bump: flags });
  if ("error" in changed) throw new TrainCutError(changed.error.code, changed.error.message);
  const commit = changed.at;
  const released = (tryGit(top, ["tag", "--points-at", commit, "-l", `release-train/${q.env}/*`]) ?? "").split("\n").filter(Boolean)[0] ?? null;
  if (released) return { env: q.env, commit, first: false, released, members: [] };

  const registry = q.registry ?? npmVersions();
  const dirOf = (name: string) => members.find((m) => m.name === name)!.dir;
  // Each member's releases, newest first, to find one already cut from this commit.
  const releases = new Map((await readMemberReleases(root)).map((m) => [m.member, m.releases] as const));
  const cutAt = async (name: string): Promise<string | null> => (releases.get(name) ?? []).find((r) => r.commit === commit && r.label !== null)?.label ?? null;
  const floorOf = async (name: string) => highestVersion(await memberVersions({ top, commit, memberDir: resolve(root, dirOf(name)), registry }));
  const vPrefix = (m: ReleaseChangedMember | undefined) => ((m?.next ?? m?.last?.label ?? "").startsWith("v") ? "v" : "");

  const { records } = await readReleaseTrains(root, q.env);
  const together = records.length === 0 && config.first === "together";
  const out: TrainCutMember[] = [];
  if (together) {
    if (Object.keys(levels.members).length > 0) throw new TrainCutError("train-levels-invalid", "the first train cuts every member at one label, so it takes one level for all of them, not one per member");
    let label: string | null = null;
    for (const m of members) {
      const l = await cutAt(m.name);
      if (l !== null) label = highestVersion([...(label ? [label] : []), l]);
    }
    const floors = new Map<string, string | null>();
    for (const m of members) floors.set(m.name, await floorOf(m.name));
    if (label === null) {
      // The root member's own ledger: labels it spent before the members had their own.
      const own = (await readCuts({ cwd: root })).cuts.map((c) => c.label).filter((l): l is string => l !== null);
      const highest = highestVersion([...[...floors.values()].filter((v): v is string => v !== null), ...own]) ?? "0.0.0";
      label = bumpLabel(highest, levels.all ?? "patch")!;
    }
    const order = [...changed.members.map((m) => m.member), ...members.map((m) => m.name)].filter((n, i, a) => a.indexOf(n) === i);
    for (const name of order) out.push({ member: name, dir: dirOf(name), label, why: "first-train", bump: levels.all ?? "patch", bumpFrom: "first-train", floor: floors.get(name) ?? null, resumed: (await cutAt(name)) === label });
    return { env: q.env, commit, first: true, released: null, members: out };
  }
  for (const m of changed.members) {
    const resumed = await cutAt(m.member);
    const floor = await floorOf(m.member);
    const why = m.reason.member !== null ? `${m.reason.code} ${m.reason.member}` : m.reason.code;
    if (resumed !== null) {
      out.push({ member: m.member, dir: dirOf(m.member), label: resumed, why, bump: null, bumpFrom: "already-cut", floor, resumed: true });
      continue;
    }
    const fromFloor = bumpLabel(floor ?? "0.0.0", m.bump)!;
    const label = `${vPrefix(m)}${highestVersion([fromFloor, ...(m.next ? [m.next] : [])])!}`;
    out.push({ member: m.member, dir: dirOf(m.member), label, why, bump: m.bump, bumpFrom: m.bumpFrom === "flag" ? "typed" : m.bumpFrom, floor, resumed: false });
  }
  // A run that stopped after some cuts and before its train tag: those members have no change since, so release changed leaves them out.
  for (const m of members) {
    if (out.some((x) => x.member === m.name)) continue;
    const resumed = await cutAt(m.name);
    if (resumed !== null) out.push({ member: m.name, dir: m.dir, label: resumed, why: "already-cut", bump: null, bumpFrom: "already-cut", floor: null, resumed: true });
  }
  return { env: q.env, commit, first: false, released: null, members: out };
}

/** What the cut of one member printed, as `chant release cut --json` prints it. */
export interface MemberCutResult {
  /** The tag the cut made (or found) on the commit, or null when it made none. */
  tag: string | null;
}

/** Cuts one member: `chant release cut <label> --at <commit>`, with `--yes` when `yes`. */
export type MemberCutter = (m: TrainCutMember, commit: string, o: { root: string; yes: boolean }) => Promise<MemberCutResult>;

/** The chant this process runs, as a command line. */
export function ownChant(): string[] {
  return [process.execPath, ...process.execArgv, process.argv[1]!];
}

/** The default {@link MemberCutter}: this chant's `release cut` in the member's directory. */
export const spawnMemberCut: MemberCutter = async (m, commit, o) => {
  const [bin, ...pre] = ownChant();
  const args = [...pre, "release", "cut", m.label, "--at", commit, ...(o.yes ? ["--yes", "--json"] : [])];
  const r = spawnSync(bin!, args, { cwd: resolve(o.root, m.dir), encoding: "utf-8", stdio: ["ignore", "pipe", o.yes ? "pipe" : "inherit"], maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    const why = `${r.stderr ?? ""}`.trim().split("\n").filter(Boolean).slice(-3).join(" ");
    // The member's cut prints the failing check's output to its stderr; show its tail, not only the last line.
    const output = o.yes ? tailLines(`${r.stderr ?? ""}`) : "";
    const detail = output && output.includes("\n") ? `\n--- output of the cut of ${m.member} (stderr) ---\n${output}` : "";
    throw new TrainCutError("train-cut-failed", `the cut of ${m.member} at ${m.label} failed${why ? `: ${why}` : ""}${detail}`, "Fix the cause and run the train again: members already cut from this commit are taken as they are.");
  }
  if (!o.yes) {
    if (r.stdout) process.stderr.write(r.stdout);
    return { tag: null };
  }
  try {
    const doc = JSON.parse(r.stdout) as { tag?: { name?: string } | null };
    return { tag: doc.tag?.name ?? null };
  } catch {
    throw new TrainCutError("train-cut-failed", `the cut of ${m.member} printed no JSON`);
  }
};

export interface TrainCutRun extends TrainCutQuery {
  /** Cut, record, tag and push. Without it the cuts run as dry runs and nothing is written. */
  yes?: boolean;
  /** Record and tag locally, and push nothing (the cuts still push their records). */
  noPush?: boolean;
  /** The remote the tags and the record go to. Default `origin`. */
  remote?: string;
  actor?: string;
  cutter?: MemberCutter;
  /**
   * Run `chant release doctor` in each member of the train before anything is
   * cut (#5216): a target that can't publish from here stops the train with
   * nothing cut, tagged or pushed.
   */
  doctor?: boolean;
  /** Runs the doctor in a member's directory and returns its exit code. Default: this chant's `release doctor`, its stdout sent to stderr. */
  runDoctor?: (dir: string) => number | Promise<number>;
  /** Runs the `release.train.check` lines. Default: `sh -c` each one, its stdout sent to stderr. */
  runCheck?: (line: string, o: { cwd: string; env: NodeJS.ProcessEnv }) => number | Promise<number>;
  /** A line of progress. */
  say?: (line: string) => void;
  now?: () => Date;
}

export interface TrainCutOutcome extends TrainCutPlan {
  /** The tag each member's cut made, by member. */
  tags: Record<string, string>;
  /** The train recorded, or null on a plan, a released commit or an empty train. */
  train: { id: string; trainDigest: string } | null;
  /** `release-train/<env>/<id>`, or null. */
  trainTag: string | null;
  pushed: boolean;
  /** Why the record did not reach the remote, when it did not. */
  pushWarning?: string;
}

// A check's stdout goes to stderr: under --json, stdout is the cut's JSON document alone.
const defaultCheck = (line: string, o: { cwd: string; env: NodeJS.ProcessEnv }): Promise<number> => runToStderr(line, o);

/** This chant's `release doctor` in a member's directory, its stdout sent to stderr. In CI it is the train's cut job, which has no OIDC token (`--from cut`). */
const defaultDoctor = (dir: string): number => {
  const [bin, ...pre] = ownChant();
  return spawnSync(bin!, [...pre, "release", "doctor", ...(process.env.CI ? ["--from", "cut"] : [])], { cwd: dir, stdio: ["ignore", 2, 2] }).status ?? 1;
};

/**
 * Parse `--planned` (#5237): `<member>=<label>` words separated by spaces or
 * commas, as a plan's members give them, or `none` for a plan of nothing.
 */
export function parseTrainPlanned(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const words = text.split(/[\s,]+/).filter(Boolean);
  if (words.length === 1 && words[0] === "none") return out;
  if (words.length === 0) throw new TrainCutError("train-planned-invalid", "--planned names no member", 'Give the plan\'s members as <member>=<label>, separated by spaces, or none for a plan of nothing.');
  for (const word of words) {
    const at = word.indexOf("=");
    if (at <= 0 || at === word.length - 1) throw new TrainCutError("train-planned-invalid", `--planned ${JSON.stringify(word)}: each word is <member>=<label>`);
    const m = word.slice(0, at);
    if (out[m] !== undefined) throw new TrainCutError("train-planned-invalid", `--planned names ${m} twice`);
    out[m] = word.slice(at + 1);
  }
  return out;
}

/** The members and labels of a plan, as `--planned` takes them: `none` for a plan of nothing. */
export function plannedText(plan: Pick<TrainCutPlan, "members">): string {
  return plan.members.map((m) => `${m.member}=${m.label}`).join(",") || "none";
}

/** Refuse a plan that differs from the one `--planned` gave (#5237). */
function checkPlanned(plan: TrainCutPlan, planned: Record<string, string>): void {
  const got = new Map(plan.members.map((m) => [m.member, m.label] as const));
  const diffs: string[] = [];
  for (const [m, label] of Object.entries(planned)) {
    const now = got.get(m);
    if (now === undefined) diffs.push(`${m} was planned at ${label} and is not in the train now`);
    else if (now !== label) diffs.push(`${m} was planned at ${label} and is labelled ${now} now`);
  }
  for (const [m, label] of got) if (planned[m] === undefined) diffs.push(`${m} is in the train now at ${label}, and was not planned`);
  if (plan.released !== null && Object.keys(planned).length > 0) diffs.unshift(`${plan.commit.slice(0, 12)} is released now as ${plan.released}`);
  if (diffs.length > 0) {
    throw new TrainCutError(
      "train-plan-changed",
      `the train differs from the plan the build jobs built for: ${diffs.join("; ")}`,
      "Nothing was cut. A release or a tag landed between the plan and the cut; start the train again, so the builds run with the labels it cuts.",
    );
  }
}

/** Plan, and with `yes` cut, record, tag and push, a release train (#5154). */
export async function cutTrain(q: TrainCutRun): Promise<TrainCutOutcome> {
  const root = locateWorkspace(q.cwd).rootOnDisk;
  const plan = await planTrainCut(q);
  if (q.planned !== undefined) checkPlanned(plan, q.planned);
  const say = q.say ?? (() => undefined);
  const base: TrainCutOutcome = { ...plan, tags: {}, train: null, trainTag: null, pushed: false };
  if (plan.released !== null || plan.members.length === 0) return base;
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  const config = await trainConfigAt(root, q.env);

  if (q.yes && (config.check ?? []).length > 0) {
    const file = join(mkdtempSync(join(tmpdir(), "chant-train-")), "plan.json");
    writeFileSync(file, `${JSON.stringify({ env: plan.env, commit: plan.commit, members: plan.members.map((m) => ({ member: m.member, label: m.label })) }, null, 2)}\n`);
    const env = { ...process.env, CHANT_RELEASE_COMMIT: plan.commit, CHANT_TRAIN_ENV: plan.env, CHANT_TRAIN_PLAN: file };
    for (const line of config.check ?? []) {
      say(`check: ${line}`);
      const code = await (q.runCheck ?? defaultCheck)(line, { cwd: root, env });
      if (code !== 0) throw new TrainCutError("train-check-failed", `release.train.check failed (exit ${code}): ${line}`, "Nothing was cut. Fix what the check reports and run the train again.");
    }
  }

  // #5230: a member's package npm has never had can't be published by trusted publishing. Refuse before the first member is cut.
  {
    const read = q.registry ?? npmVersions();
    const { loadChantConfig } = await import("../config");
    const { checkPackagesPublished } = await import("../lifecycle/publish-npm");
    const { PublishTargetError } = await import("../lifecycle/release-publish");
    for (const m of plan.members) {
      if (m.resumed) continue;
      const dir = resolve(root, m.dir);
      try {
        checkPackagesPublished((await loadChantConfig(dir)).config.release?.publish ?? [], dir, (name, registry) => read(name, registry) !== null);
      } catch (err) {
        if (err instanceof PublishTargetError) throw new TrainCutError(err.code, `nothing was cut: ${m.member}: ${err.message}`, err.fix);
        throw err;
      }
    }
  }

  // #5216: each member's doctor, after the checks and before the first cut.
  if (q.doctor) {
    const failed: string[] = [];
    for (const m of plan.members) {
      say(`doctor: ${m.member}`);
      const code = await (q.runDoctor ?? defaultDoctor)(resolve(root, m.dir));
      if (code !== 0) failed.push(m.member);
    }
    if (failed.length > 0) throw new TrainCutError("train-doctor-failed", `release doctor found a target that can't publish from here in ${failed.join(", ")}`, "Nothing was cut. Fix what the doctor reports and run the train again.");
  }

  // #5319: a member's forge notes file needs the heading for the label the train cuts it at, before the first member is tagged.
  {
    const { loadChantConfig } = await import("../config");
    const { checkForgeNotesFiles } = await import("../lifecycle/publish-forge");
    const { PublishTargetError } = await import("../lifecycle/release-publish");
    const { memberTags, renderReleaseTag } = await import("../lifecycle/release-tag");
    for (const m of plan.members) {
      if (m.resumed) continue;
      const dir = resolve(root, m.dir);
      try {
        const decls = (await loadChantConfig(dir)).config.release?.publish ?? [];
        if (!decls.some((d) => d.type === "forge" && d.notes?.file)) continue;
        const tags = await memberTags(dir);
        checkForgeNotesFiles(decls, dir, m.label, (l) => renderReleaseTag(tags.template, tags.place, l));
      } catch (err) {
        if (err instanceof PublishTargetError) throw new TrainCutError(err.code, `nothing was cut: ${m.member}: ${err.message}`, err.fix);
        throw err;
      }
    }
  }

  const cutter = q.cutter ?? spawnMemberCut;
  const tags: Record<string, string> = {};
  for (const m of plan.members) {
    say(`${q.yes ? "cut" : "plan"} ${m.member} ${m.label}${m.resumed ? " (already cut from this commit)" : ""}`);
    const r = await cutter(m, plan.commit, { root, yes: q.yes === true });
    if (r.tag) tags[m.member] = r.tag;
  }
  if (!q.yes) return { ...base, tags };

  // The train: these members at the releases just cut, the rest at their newest.
  const pins = new Map(plan.members.map((m) => [m.member, m.label] as const));
  const picked = pickTrain(await readMemberReleases(root), pins);
  if ("problems" in picked) throw new TrainCutError("train-member-unreleased", `the members were cut, and the train can't be recorded: ${picked.problems.join("; ")}`, "Cut a release of each member listed, then run the train again.");
  const record: ReleaseTrainRecord = {
    version: 1,
    id: `train-${randomUUID()}`,
    env: q.env,
    timestamp: (q.now ?? (() => new Date()))().toISOString(),
    actor: q.actor ?? (await import("../actor")).actorFromEnv(),
    members: picked.members,
    trainDigest: trainDigest(picked.members),
  };
  await appendReleaseTrain(root, record);
  const trainTag = `release-train/${q.env}/${record.id}`;
  git(top, ["tag", trainTag, plan.commit]);
  const out: TrainCutOutcome = { ...base, tags, train: { id: record.id, trainDigest: record.trainDigest! }, trainTag };
  if (q.noPush) return out;

  // The record must be on the remote before the tag that starts the publish.
  const { pushLifecycleRebasing } = await import("../lifecycle/git");
  try {
    const pushed = await pushLifecycleRebasing({ cwd: root, requireLanded: true });
    if (pushed.pushWarning) out.pushWarning = pushed.pushWarning;
  } catch (err) {
    throw new TrainCutError("train-record-not-pushed", `the train ${record.id} was recorded and its record did not reach the remote, so no tag was pushed: ${err instanceof Error ? err.message : String(err)}`, "Run the train again once the remote takes pushes to chant/lifecycle: the members are cut and are taken as they are.");
  }
  const refs = [...Object.values(tags), trainTag].map((t) => `refs/tags/${t}`);
  try {
    git(top, ["push", "--atomic", q.remote ?? "origin", ...refs]);
  } catch (err) {
    throw new TrainCutError("train-tags-not-pushed", `the train ${record.id} was recorded, and pushing its tags failed: ${err instanceof Error ? (err as { stderr?: string }).stderr?.toString().trim() || err.message : String(err)}`, `Push them by hand: git push --atomic ${q.remote ?? "origin"} ${refs.join(" ")}`);
  }
  return { ...out, pushed: true };
}

const CUT_USAGE = "chant workspace train cut <env> [--at <sha>] [--levels <levels>] [--plan-only] [--planned <member=label ...|none>] [--doctor] [--yes] [--no-push] [--json]";

/** `chant workspace train cut <env>` (#5154). */
export async function runTrainCut(ctx: import("../cli/registry").CommandContext, words: string[]): Promise<number> {
  const { formatError, formatSuccess, formatWarning } = await import("../cli/format");
  const { WorkspaceReadError } = await import("./declaration");
  const { args } = ctx;
  const env = words[0];
  if (!env || words.length > 1) {
    console.error(formatError({ message: env ? `chant workspace train cut takes one environment, not ${words.join(" ")}` : "chant workspace train cut needs an environment", hint: CUT_USAGE }));
    return 1;
  }
  const json = args.json === true;
  const cwd = resolve(".");
  // The ledger and the tags the floors read, as the remote has them. Offline, what is here is read.
  const { fetchLifecycle } = await import("../lifecycle/git");
  await fetchLifecycle({ cwd }).catch(() => false);
  spawnSync("git", ["fetch", "--quiet", "origin", "refs/tags/*:refs/tags/*"], { cwd, stdio: "ignore" });
  let outcome: TrainCutOutcome;
  const planOnly = args.planOnly === true;
  try {
    if (planOnly && (args.yes === true || args.planned !== undefined)) throw new TrainCutError("train-plan-only", `--plan-only prints the plan and cuts nothing, so it takes no ${args.yes === true ? "--yes" : "--planned"}`, CUT_USAGE);
    const query = { cwd, env, ...(args.at ? { at: args.at } : {}), levels: parseTrainLevels(args.levels) };
    outcome = planOnly
      ? { ...(await planTrainCut(query)), tags: {}, train: null, trainTag: null, pushed: false }
      : await cutTrain({
      ...query,
      ...(args.planned !== undefined ? { planned: parseTrainPlanned(args.planned) } : {}),
      yes: args.yes === true && args.dryRun !== true,
      noPush: args.noPush === true,
      doctor: args.doctor === true,
      ...(args.actor ? { actor: args.actor } : {}),
      say: (line) => (json ? undefined : console.error(line)),
    });
  } catch (err) {
    if (err instanceof TrainCutError) {
      if (json) console.log(JSON.stringify({ status: "refused", code: err.code, message: err.message }, null, 2));
      console.error(formatError({ message: `${err.message} [${err.code}]`, hint: err.fix ?? CUT_USAGE }));
      return 1;
    }
    if (err instanceof WorkspaceReadError) {
      console.error(formatError({ message: `${err.code}: ${err.describe()}`, hint: CUT_USAGE }));
      return 1;
    }
    throw err;
  }
  if (json) {
    console.log(JSON.stringify({ dryRun: planOnly || args.yes !== true || args.dryRun === true, ...(planOnly ? { planOnly: true, planned: plannedText(outcome) } : {}), ...outcome }, null, 2));
    return 0;
  }
  const short = outcome.commit.slice(0, 12);
  if (outcome.released) {
    console.log(`${short} is already released as ${outcome.released}.`);
    return 0;
  }
  if (outcome.members.length === 0) {
    console.log(`Nothing to release at ${short}: no member changed since its last release.`);
    return 0;
  }
  console.log(`Release train for ${env} from ${short}${outcome.first ? " (the first: every member at one label)" : ""}:`);
  for (const m of outcome.members) console.log(`  ${m.member.padEnd(24)} ${m.label.padEnd(12)} ${m.why}${m.bump ? `; ${m.bump} from ${m.bumpFrom}` : ""}${m.floor ? `; floor ${m.floor}` : ""}`);
  if (planOnly) {
    console.error(`Plan only: no member's dry run ran, and nothing was cut. Cut it as planned with --planned ${JSON.stringify(plannedText(outcome))}.`);
    return 0;
  }
  if (args.yes !== true || args.dryRun === true) {
    console.error("Dry run: nothing was cut, recorded, tagged or pushed. Run again with --yes to cut the train.");
    return 0;
  }
  if (outcome.pushWarning) console.error(formatWarning({ message: outcome.pushWarning }));
  console.error(formatSuccess(`Cut release train ${outcome.train!.id} (${outcome.members.length} member(s))${outcome.pushed ? `, and pushed ${outcome.trainTag} with the member tags` : `; tagged ${outcome.trainTag} here, and pushed nothing`}`));
  return 0;
}
