/**
 * The next release's label, chosen from the commits and the intent files
 * since the member's previous release (#5159): `chant release next` prints
 * it, and `chant release cut auto` cuts it.
 *
 * The previous release is found in the member's ledger, never from a tag:
 * the nearest release cut from the commit or an ancestor of it whose label
 * is a semver version without a prerelease part. The commits are those
 * after it, up to the commit, that touch the member's directory (or, for a
 * release member under a nested workspace, the directory of the outer
 * member of its name). Each is classified as {@link changelogBump} does: a
 * `type!:` subject or a `BREAKING CHANGE` footer is a major, `feat` a minor,
 * anything else a patch. The intent files that name the member and that no
 * cut of it consumed (./release-intents.ts) give their own levels, and the
 * bump is the highest of them all.
 *
 * Prereleases (#5166): a prerelease cut since that version whose own
 * version is higher than the bumped one raises it to that version, so
 * `2.0.0-rc.1` is followed by `2.0.0` even when only fixes landed since.
 * With `pre`, the label is `<version>-<pre>.<n>`, `n` one past the highest
 * the member's ledger holds for that version and id, else 0.
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
  /** The previous release the label follows. */
  from: { label: string; commit: string };
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
export function nextLabel(input: { stable: string; bump: ReleaseBumpLevel | null; since: readonly string[]; labels: readonly string[]; pre?: string }): string {
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
  const { memberSourcePath } = await import("../workspace/release-changed");
  const ledger = await resolveMemberLedger(req.cwd);
  const names = ledger.members.length > 0 ? [ledger.members.at(-1)!, ledger.members.join("/")] : [];
  const { cuts } = await readCuts({ cwd: req.cwd });
  const ancestors = await ancestorReleases(top, at, req.cwd);
  const here = ancestors.find((a) => a.release.commit === at && a.label !== null);
  const stableAt = ancestors.findIndex((a) => a.release.commit !== at && a.label !== null && parse(a.label)?.pre === null);
  const stable = stableAt >= 0 ? ancestors[stableAt]! : null;

  const intents = await memberPendingIntents(req.cwd, top, at, names, cuts);
  const path = relative(realpathSync(top), realpathOr(memberSourcePath(req.cwd))).split("\\").join("/");
  const commits = stable ? commitsTouching(top, stable.release.commit, at, path) : [];

  if (here) {
    return { label: here.label!, at, bump: null, alreadyCut: true, from: stable ? { label: stable.label!, commit: stable.release.commit } : { label: here.label!, commit: at }, commits, intents: [] };
  }
  if (!stable) {
    const pre = ancestors.find((a) => a.label !== null && parse(a.label) !== null);
    throw new ReleaseNextError(
      "release-next-no-previous",
      pre ? `the member has no release with a version label before ${at.slice(0, 12)}, only the prerelease ${pre.label}, so there is no version to bump` : `the member has no release with a version label before ${at.slice(0, 12)}, so there is no version to bump`,
      "Cut the first release with the label you choose, such as: chant release cut 1.0.0",
    );
  }
  // The prerelease labels cut since the stable one.
  const since = ancestors.slice(0, stableAt).map((a) => a.label).filter((l): l is string => l !== null);
  const bump = maxBump(commitsBump(commits), intents.reduce<ReleaseBumpLevel | null>((b, i) => maxBump(b, i.bump), null));
  if (bump === null && !since.some((l) => parse(l)?.pre !== null)) {
    throw new ReleaseNextError(
      "release-next-unchanged",
      `no commit since ${stable.label} (${stable.release.commit.slice(0, 12)}) touches ${path || "the repository"}, and no intent file names the member, so there is nothing to release`,
      "Cut with a label you choose if this commit should still be released.",
    );
  }
  const labels = cuts.map((c) => c.label).filter((l): l is string => l !== null);
  const label = nextLabel({ stable: stable.label!, bump, since, labels, ...(req.pre !== undefined ? { pre: req.pre } : {}) });
  return { label, at, bump, alreadyCut: false, from: { label: stable.label!, commit: stable.release.commit }, commits, intents };
}
