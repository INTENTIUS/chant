/**
 * The next release's label, chosen from the commits and the intent files
 * since the member's previous release (#5159): `chant release next` prints
 * it, and `chant release cut auto` cuts it.
 *
 * The previous release is found in the member's ledger: the nearest
 * release cut from the commit or an ancestor of it whose label is a semver
 * version without a prerelease part and that is not yanked (#5163:
 * `chant release yank` sets that status in `_releases/release-status.jsonl`).
 * A member whose ledger has none (a project that just adopted
 * `chant release`) falls back to its tag history (#5200): the newest tag on
 * the commit or an ancestor that the member's `release.tag` template or one
 * of its `release.legacyTags` prefixes makes of a stable version that no
 * yanked release holds, matched by `tagHistoryRelease`. The commits are those
 * after it, up to the commit, that touch the member's directory (or, for a
 * release member under a nested workspace, the directory of the outer
 * member of its name). Each is classified as {@link changelogBump} does: a
 * `type!:` subject or a `BREAKING CHANGE` footer is a major, `feat` a minor,
 * anything else a patch. On a 0.x version each commit's level drops one
 * step, a major to a minor and a minor to a patch, unless
 * `release.breakingOnZero` is `major` (#5191). The intent files that name
 * the member and that no cut of it consumed (./release-intents.ts) give
 * their own levels, unshifted, and the bump is the highest of them all.
 *
 * Prereleases (#5166): a prerelease cut since that version whose own
 * version is higher than the bumped one raises it to that version, so
 * `2.0.0-rc.1` is followed by `2.0.0` even when only fixes landed since.
 * With `pre`, the label is `<version>-<pre>.<n>`, `n` one past the highest
 * the member's ledger holds for that version and id, else 0.
 *
 * A yanked stable release passed over still holds its version, which no
 * registry takes twice, so a label at or below it becomes its next patch:
 * `1.1.0` yanked after `1.0.0` is followed by `1.1.1`.
 *
 * A label written with a leading `v` gives labels with one. A commit the
 * member already has a labelled release of answers that label, so a run
 * started again cuts what it cut before.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { classifyCommit } from "./release-changelog";
import { consumedIntents, maxBump, pendingIntents, readIntents, type ReleaseBumpLevel } from "./release-intents";
import type { ReleaseCutIntent } from "./release-store";
import { NEXT_RELEASE } from "../release-floors";

/** The first chant with `chant release next` and `chant release cut auto`, the label from the conventional commits and the `.chant/release/*.md` intent files since the member's previous release; a cut records the intent files it consumed (`intents` on its cut line), `release changed` computes each member's bump from them (`bumpFrom`, `intents`, `intent-pending`), notes generated from commits lead with their summaries, and a dispatched release workflow takes the label `auto` (#5159); with no release in the ledger the previous one is the newest version tag `release.tag` or `release.legacyTags` matches (#5200), and on 0.x a breaking commit bumps minor unless `release.breakingOnZero` is `major` (#5191). */
export const RELEASE_NEXT_FLOOR = NEXT_RELEASE;

export type ReleaseNextCode =
  | "not-a-git-repository"
  | "revision-unknown"
  | "release-next-no-previous"
  | "release-next-unchanged"
  | "release-next-pre-invalid"
  | "release-next-history-shallow"
  | "release-intent-invalid";

export class ReleaseNextError extends Error {
  constructor(
    readonly code: ReleaseNextCode,
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = "ReleaseNextError";
  }
}

/** One commit counted, with the level it implies. */
export interface NextCommit {
  sha: string;
  subject: string;
  bump: ReleaseBumpLevel;
}

export interface NextRelease {
  /** The label the next release carries. */
  label: string;
  /** The full sha it was read at. */
  at: string;
  /** The level applied to `from`, or null when the label is a release already cut at `at`, or a prerelease's version carried on. */
  bump: ReleaseBumpLevel | null;
  /** True when `at` already has a labelled release of the member, whose label this is. */
  alreadyCut: boolean;
  /** The previous release the label follows: a cut in the member's ledger, or a version tag when the ledger has none (#5200), with that tag. */
  from: { label: string; commit: string; source: "ledger" | "tag"; tag?: string };
  /** The commits after `from` that touch the member, newest first. */
  commits: NextCommit[];
  /** The intent files the release consumes, with their summaries. */
  intents: Array<ReleaseCutIntent & { summary: string }>;
}

const SEMVER = /^(v?)(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

type Core = [number, number, number];
const cmp = (a: Core, b: Core): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function parse(label: string): { v: string; core: Core; pre: string | null } | null {
  const m = SEMVER.exec(label);
  return m ? { v: m[1]!, core: [Number(m[2]), Number(m[3]), Number(m[4])], pre: m[5] ?? null } : null;
}

/** `p` with its links resolved, or as given when it does not exist. */
function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const PRE_ID = /^[A-Za-z][0-9A-Za-z-]*$/;

/**
 * The next label from the previous stable label, the bump, the prerelease
 * labels cut since it, and every label the member's ledger holds. Pure.
 */
export function nextLabel(input: { stable: string; bump: ReleaseBumpLevel | null; since: readonly string[]; labels: readonly string[]; pre?: string; yanked?: readonly string[] }): string {
  const base = parse(input.stable);
  if (!base || base.pre !== null) throw new Error(`${input.stable} is not a release version`);
  let core: Core = [...base.core];
  if (input.bump === "major") core = [core[0] + 1, 0, 0];
  else if (input.bump === "minor") core = [core[0], core[1] + 1, 0];
  else if (input.bump === "patch") core = [core[0], core[1], core[2] + 1];
  for (const l of input.since) {
    const p = parse(l);
    if (p && p.pre !== null && cmp(p.core, core) > 0) core = p.core;
  }
  // #5163: a yanked version can't be published again, so the label goes past it.
  for (const l of input.yanked ?? []) {
    const p = parse(l);
    if (p && p.pre === null && cmp(p.core, core) >= 0) core = [p.core[0], p.core[1], p.core[2] + 1];
  }
  const version = core.join(".");
  if (input.pre === undefined) return `${base.v}${version}`;
  let n = -1;
  for (const l of input.labels) {
    const p = parse(l);
    if (!p || cmp(p.core, core) !== 0 || p.pre === null) continue;
    const m = new RegExp(`^${input.pre.replace(/[-]/g, "\\-")}\\.(\\d+)$`).exec(p.pre);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `${base.v}${version}-${input.pre}.${n + 1}`;
}

function git(top: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: top, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** The commits in `from..to` touching `path` (from the repository root), newest first, merges left out. */
export function commitsTouching(top: string, from: string, to: string, path: string): NextCommit[] {
  const out = git(top, ["log", "--no-merges", "--format=%H%x00%B%x1e", `${from}..${to}`, "--", path === "" ? "." : `:(top,literal)${path}`]);
  if (out === null) throw new ReleaseNextError("revision-unknown", `git could not list the commits ${from.slice(0, 12)}..${to.slice(0, 12)}`, "Fetch the full history of the branch.");
  return out
    .split("\x1e")
    .map((r) => r.replace(/^\n+/, ""))
    .filter((r) => r.includes("\0"))
    .map((r) => {
      const [sha, message] = r.split("\0") as [string, string];
      const { kind } = classifyCommit(message.trim());
      return { sha, subject: message.trim().split("\n", 1)[0]!, bump: kind === "breaking" ? "major" : kind === "feat" ? "minor" : "patch" };
    });
}

/** The highest level of `commits`, or null when there are none. */
export function commitsBump(commits: readonly NextCommit[]): ReleaseBumpLevel | null {
  let out: ReleaseBumpLevel | null = null;
  for (const c of commits) out = maxBump(out, c.bump);
  return out;
}

/**
 * The intent files at `commit` that name the member at `cwd` and that none
 * of its cuts consumed: what a cut of `commit` consumes. Throws
 * {@link ReleaseNextError} `release-intent-invalid` for a file that can't be read.
 */
export async function memberPendingIntents(cwd: string, top: string, commit: string, names?: readonly string[], cuts?: readonly import("./release-store").ReleaseCut[]): Promise<NextRelease["intents"]> {
  if (names === undefined) {
    const { resolveMemberLedger } = await import("./member-ledger");
    const ledger = await resolveMemberLedger(cwd);
    names = ledger.members.length > 0 ? [ledger.members.at(-1)!, ledger.members.join("/")] : [];
  }
  if (cuts === undefined) cuts = (await (await import("./release-store")).readCuts({ cwd })).cuts;
  try {
    return pendingIntents(readIntents(top, commit), names, consumedIntents(cuts));
  } catch (err) {
    if (err instanceof Error && (err as { code?: string }).code === "release-intent-invalid") {
      throw new ReleaseNextError("release-intent-invalid", err.message, "Write the front matter as lines of <member>: major|minor|patch between two --- lines.");
    }
    throw err;
  }
}

/**
 * The commits with their levels as they apply to the version `label`
 * (#5191): on 0.x, unless `breakingOnZero` is `major`, a major counts as a
 * minor and a minor as a patch.
 */
export function shiftOnZero(commits: NextCommit[], label: string, breakingOnZero: "minor" | "major"): NextCommit[] {
  const base = parse(label);
  if (breakingOnZero === "major" || !base || base.core[0] !== 0) return commits;
  return commits.map((c) => ({ ...c, bump: c.bump === "major" ? "minor" : "patch" }));
}

/** The tag shapes of the member's earlier releases: its `release.tag` template, then each `release.legacyTags` prefix. */
async function historyShapes(cwd: string, top: string, legacyTags: readonly string[]): Promise<import("../workspace/release-changed").VersionTagShape[]> {
  const shapes: import("../workspace/release-changed").VersionTagShape[] = [];
  try {
    const t = await import("./release-tag");
    const mt = await t.memberTags(cwd, { top });
    shapes.push({ ...t.tagShape(mt.template.name, mt.place), render: (l) => t.renderReleaseTag(mt.template, mt.place, l) });
  } catch {
    // A config that can't be read, or a template refused here, is refused by the cut; the legacy prefixes still count.
  }
  for (const prefix of legacyTags) shapes.push({ prefix, suffix: "" });
  return shapes;
}

/** Read the next label of the member at `cwd`, at `at` (default `HEAD`). */
export async function nextRelease(req: { cwd: string; at?: string; pre?: string }): Promise<NextRelease> {
  if (req.pre !== undefined && !PRE_ID.test(req.pre)) {
    throw new ReleaseNextError("release-next-pre-invalid", `--pre ${req.pre} is not a prerelease id: a letter, then letters, digits and -`, "Name it as in --pre rc or --pre beta.");
  }
  const top = git(req.cwd, ["rev-parse", "--show-toplevel"])?.trim();
  if (!top) throw new ReleaseNextError("not-a-git-repository", "the next label is read from commits and the ledger, and this directory is not in a git repository");
  const at = git(top, ["rev-parse", "--verify", "--quiet", `${req.at ?? "HEAD"}^{commit}`])?.trim();
  if (!at) throw new ReleaseNextError("revision-unknown", `${req.at ?? "HEAD"} names no commit in this clone`);
  if (git(top, ["rev-parse", "--is-shallow-repository"])?.trim() === "true") {
    throw new ReleaseNextError("release-next-history-shallow", "the next label is read from the commits since the previous release, and this clone is shallow", "Fetch the full history: fetch-depth: 0 on actions/checkout, GIT_DEPTH: 0 on GitLab.");
  }
  const { ancestorReleases } = await import("./release-cut");
  const { readCuts } = await import("./release-store");
  const { resolveMemberLedger } = await import("./member-ledger");
  const { memberSourcePath, memberReleaseSettings, tagHistoryRelease } = await import("../workspace/release-changed");
  const ledger = await resolveMemberLedger(req.cwd);
  const names = ledger.members.length > 0 ? [ledger.members.at(-1)!, ledger.members.join("/")] : [];
  const { cuts } = await readCuts({ cwd: req.cwd });
  const ancestors = await ancestorReleases(top, at, req.cwd);
  // #5163: a yanked release is never the previous release.
  const { readReleaseStatus, statusOf } = await import("./release-status");
  const statusRecords = (await readReleaseStatus("_releases", { cwd: req.cwd }).catch(() => ({ records: [] }))).records;
  const component = ledger.members.length > 0 ? ledger.members.join("/") : ".";
  const yanked = (a: { release: { releaseDigest: string } }) => statusOf(statusRecords, component, a.release.releaseDigest).status === "yanked";
  const here = ancestors.find((a) => a.release.commit === at && a.label !== null);
  const stableAt = ancestors.findIndex((a) => a.release.commit !== at && a.label !== null && parse(a.label)?.pre === null && !yanked(a));
  const settings = await memberReleaseSettings(req.cwd);
  let stable: NextRelease["from"] | null = stableAt >= 0 ? { label: ancestors[stableAt]!.label!, commit: ancestors[stableAt]!.release.commit, source: "ledger" } : null;
  // #5200: a member whose ledger has no stable release reads its tag history,
  // passing over the tag of a release the ledger holds as yanked.
  if (!stable && !here) {
    const yankedVersions = ancestors.filter((a) => a.label !== null && yanked(a)).map((a) => a.label!.replace(/^v/, ""));
    const hit = tagHistoryRelease(top, await historyShapes(req.cwd, top, settings.legacyTags), { at, stable: true, skip: yankedVersions });
    if (hit) stable = { label: hit.label!, commit: hit.commit, source: "tag", tag: hit.tag };
  }

  const intents = await memberPendingIntents(req.cwd, top, at, names, cuts);
  const path = relative(realpathSync(top), realpathOr(memberSourcePath(req.cwd))).split("\\").join("/");
  const commits = stable ? shiftOnZero(commitsTouching(top, stable.commit, at, path), stable.label, settings.breakingOnZero) : [];

  if (here) {
    return { label: here.label!, at, bump: null, alreadyCut: true, from: stable ?? { label: here.label!, commit: at, source: "ledger" }, commits, intents: [] };
  }
  if (!stable) {
    const pre = ancestors.find((a) => a.label !== null && parse(a.label) !== null);
    throw new ReleaseNextError(
      "release-next-no-previous",
      pre
        ? `the member has no release with a version label before ${at.slice(0, 12)}, only the prerelease ${pre.label}, and no version tag its release.tag or release.legacyTags matches, so there is no version to bump`
        : `the member has no release with a version label before ${at.slice(0, 12)}, and no version tag its release.tag or release.legacyTags matches, so there is no version to bump`,
      "Cut the first release with the label you choose, such as: chant release cut 1.0.0. If earlier releases were tagged by hand, name their tag prefix in release.legacyTags.",
    );
  }
  // The prerelease labels cut since the stable one: all the ledger holds when the previous release is a tag.
  const since = (stable.source === "ledger" ? ancestors.slice(0, stableAt) : ancestors).map((a) => a.label).filter((l): l is string => l !== null);
  const bump = maxBump(commitsBump(commits), intents.reduce<ReleaseBumpLevel | null>((b, i) => maxBump(b, i.bump), null));
  if (bump === null && !since.some((l) => parse(l)?.pre !== null)) {
    throw new ReleaseNextError(
      "release-next-unchanged",
      `no commit since ${stable.label} (${stable.commit.slice(0, 12)}) touches ${path || "the repository"}, and no intent file names the member, so there is nothing to release`,
      "Cut with a label you choose if this commit should still be released.",
    );
  }
  const labels = cuts.map((c) => c.label).filter((l): l is string => l !== null);
  // #5163: the yanked releases passed over; with a tag as the previous release, every yanked one the ledger holds.
  const passed = (stable.source === "ledger" ? ancestors.slice(0, stableAt) : ancestors).filter((a) => a.label !== null && yanked(a)).map((a) => a.label!);
  const label = nextLabel({ stable: stable.label, bump, since, labels, yanked: passed, ...(req.pre !== undefined ? { pre: req.pre } : {}) });
  return { label, at, bump, alreadyCut: false, from: stable, commits, intents };
}
