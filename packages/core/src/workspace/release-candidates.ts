/**
 * The `release-candidates` read (#4168 4.2): which green commits of trunk a
 * person can cut a release from, and what each one would ship.
 *
 * `chant release candidates [--env <env>] [--json]` prints this document.
 * It walks the first-parent line of the trunk (`ci.green.branch`, else what
 * `origin/HEAD` names, as `release cut` resolves it) from its tip back to the
 * oldest commit an environment of the member runs, or `limit` commits when an
 * environment runs no release yet. An environment runs the releases its
 * latest deploy records name in `releaseDigest`, as the `releases` read
 * (./releases.ts) says.
 *
 * Every green commit that is not revoked is a candidate. With a lane (#4692),
 * green and revoked are that lane's tags, `ci/green-<lane>/<sha>` and
 * `ci/revoked-<lane>/<sha>`, as `release cut --lane` checks them. Its `changes` are
 * the first-parent commits after the previous candidate up to and including
 * it, so the candidates partition the walk. A revoked commit is listed under
 * `skipped`, and its changes carry on into the next candidate. Commits after
 * the newest candidate are listed under `pending`: they are not green yet, or
 * went red.
 *
 * For each change it names the work items and other records its
 * `Chant-Record` trailers name, the pull request a forge's squash subject
 * names (`... (#123)`), and the merge record `_merges/<sha>.json` on
 * `chant/lifecycle` when one exists (#4168 4.1). Each candidate lists the
 * flags whose record files changed in its range, from the declared flag kinds
 * (#4024).
 *
 * Each candidate also groups its changes (#4168 4.4) by work item, then by
 * pull request, then by commit: a change lands under every work item its
 * trailers name, or under no work item, and within that under its pull
 * request, or under none for a commit that landed without one.
 *
 * Asked to (`forgeIssues`, `--forge-issues`, #4649), it also asks the forge
 * which issues each change's pull request closes (./forge-work.ts), once per
 * pull request, and puts the answer in the change's `closes`. A change no
 * `Chant-Record` trailer gives a work item then lands under each issue its
 * pull request closes. Without a forge or a token the pull request number
 * stands alone, `resolved: false`.
 *
 * Otherwise it reads local refs and tags only and never fetches. Git is read
 * through a local `git` subprocess.
 */

import { execFileSync } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import { NEXT_RELEASE } from "../release-floors";
import { latestPerComponent, readReleaseLedger } from "../lifecycle/release-ledger";
import { readAllReleases, readCuts } from "../lifecycle/release-store";
import { resolveMemberLedger } from "../lifecycle/member-ledger";
import { readBlobFromPath } from "../lifecycle/git";
import { greenBranches, readerVersion } from "./declaration";
import type { ForgeWorkOptions, PullRequestCloses } from "./forge-work";

export const RELEASE_CANDIDATES_CONTRACT_VERSION = 1;
/** The first chant whose candidates carry `changes[].closes` and `groups[].issue` (#4649). */
export const RELEASE_CANDIDATES_CLOSES_FLOOR = NEXT_RELEASE;
/** The first chant whose candidates document carries `lane` and reads a lane's tags (#4692). */
export const RELEASE_CANDIDATES_LANE_FLOOR = NEXT_RELEASE;
export const RELEASE_CANDIDATES_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/release-candidates/v1/release-candidates.schema.json";

/** Why the read stopped. Closed; each code is in `reason-codes.ts`. */
export const RELEASE_CANDIDATES_ERROR_CODES = ["not-a-git-repository", "ledger-unreadable"] as const;

/** How many first-parent commits the walk reads when no environment bounds it. */
export const DEFAULT_CANDIDATE_LIMIT = 50;

/** A release an environment runs, by the components whose latest deploy names it. */
export interface RunningRelease {
  releaseDigest: string;
  label: string | null;
  /** The commit it was cut from, or null when its release file is not on this clone's branch. */
  commit: string | null;
  components: string[];
}

export interface CandidateEnvironment {
  env: string;
  /** Newest cut first. Empty when no deploy there names a release. */
  running: RunningRelease[];
}

/** One first-parent commit in a candidate's range. */
export interface CandidateChange {
  commit: string;
  subject: string;
  /** Author date, ISO 8601. */
  date: string;
  /** The ids its `Chant-Record: work:<id>` trailers name. */
  work: string[];
  /** Every `Chant-Record` trailer, as `<kind>:<id>`. */
  records: string[];
  /** The pull request the subject names (`(#123)` at its end), the merge record's, or null. */
  pr: number | null;
  /** The merge record `_merges/<sha>.json` (#4168 4.1), as stored, or null when there is none. */
  merge: Record<string, unknown> | null;
  /**
   * The issues the forge says `pr` closes (#4649), or null when the read was
   * not asked to (`--forge-issues`) or the change has no pull request. Added
   * within contract 1 by chant {@link RELEASE_CANDIDATES_CLOSES_FLOOR}.
   */
  closes: PullRequestCloses | null;
}

/** A candidate's changes under one pull request, or under none (`pr: null`) for commits that landed without one. */
export interface CandidatePullRequestGroup {
  pr: number | null;
  /** Newest first. */
  commits: string[];
}

/**
 * A candidate's changes under one work item: a `Chant-Record` work id
 * (`work`), or an issue the change's pull request closes (`issue`, #4649), or
 * under none (both null). Work ids come first, then issues, each in the order
 * the oldest change names them.
 */
export interface CandidateGroup {
  work: string | null;
  /** The issue the forge says the changes' pull request closes, for changes with no work id; null otherwise. */
  issue: number | null;
  /** Pull requests in the order their oldest commit landed, then `pr: null`. */
  pullRequests: CandidatePullRequestGroup[];
}

export interface CandidateFlag {
  id: string;
  member: string;
  param: string;
  /** The record file from the workspace root. */
  path: string;
  /** The value per environment, as the working tree's record writes it. */
  values: Record<string, string | number | boolean>;
}

export interface Candidate {
  commit: string;
  subject: string;
  date: string;
  /** The environments that don't run this commit or a later one yet. */
  newFor: string[];
  /** The labels of releases already cut from it. */
  cut: string[];
  changes: CandidateChange[];
  /** The same changes by work item, then pull request, then commit (#4168 4.4). */
  groups: CandidateGroup[];
  flags: CandidateFlag[];
}

export type ReleaseCandidatesDocument =
  | {
      $schema: string;
      contract: number;
      chant: string;
      member: string | null;
      branch: string;
      /** The green lane whose tags were read (#4692), or null for `ci/green/<sha>`. Added within contract 1 by chant {@link RELEASE_CANDIDATES_LANE_FLOOR}. */
      lane: string | null;
      /** The tip of the branch as this clone knows it. */
      tip: string | null;
      environments: CandidateEnvironment[];
      /** The oldest commit an environment runs, where the walk stopped, or null when it read `limit` commits. */
      since: string | null;
      /** Newest first. */
      candidates: Candidate[];
      /** Revoked green commits, newest first. */
      skipped: Array<{ commit: string; subject: string; reason: "revoked" }>;
      /** Commits after the newest candidate, newest first. */
      pending: CandidateChange[];
    }
  | { $schema: string; contract: number; chant: string; error: { code: (typeof RELEASE_CANDIDATES_ERROR_CODES)[number]; message: string } };

export interface ReleaseCandidatesQuery {
  cwd: string;
  /** Only this environment's view: the walk stops at what it runs, and `newFor` names only it. */
  env?: string;
  limit?: number;
  /** Walk this branch of `ci.green.branch` (#4325) instead of the first. */
  branch?: string;
  /** Read this lane's tags (#4692), one `ci.green.lanes` declares, in place of `ci/green/` and `ci/revoked/`. */
  lane?: string;
  /** Ask the forge which issues each pull request closes (#4649), with these options. Left out, the forge is not read. */
  forgeIssues?: ForgeWorkOptions;
}

function git(top: string, args: string[]): string {
  return execFileSync("git", args, { cwd: top, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
}

function tryGit(top: string, args: string[]): string | null {
  try {
    return git(top, args);
  } catch {
    return null;
  }
}

const PR_IN_SUBJECT = /\(#(\d+)\)\s*$/;

/** The work ids and `<kind>:<id>` records a commit's `Chant-Record` trailers name. */
export function recordTrailers(trailers: Record<string, string[]>): { work: string[]; records: string[] } {
  const values = Object.entries(trailers)
    .filter(([k]) => k.toLowerCase() === "chant-record")
    .flatMap(([, v]) => v);
  const records = values.map((v) => v.trim()).filter((v) => /^[^:\s]+:\S+$/.test(v));
  const work = records.filter((r) => r.startsWith("work:")).map((r) => r.slice("work:".length));
  return { work, records };
}

/** The pull request number at the end of a squash subject, or null. */
export function prFromSubject(subject: string): number | null {
  const m = PR_IN_SUBJECT.exec(subject);
  return m ? Number(m[1]) : null;
}

/** The pull request a merge record names in its `source`, or null. */
export function mergeRecordPr(merge: Record<string, unknown> | null): number | null {
  const source = merge?.source as { kind?: unknown; pr?: unknown } | undefined;
  return source?.kind === "pull-request" && typeof source.pr === "number" ? source.pr : null;
}

/**
 * Group changes, given newest first, by work item, then pull request, then
 * commit. A change with work ids lands in each one's group; one without
 * lands in the group of each issue its pull request closes (#4649); the rest
 * land in the group of neither, last. Work ids come before issues. Within a
 * group, pull requests come in the order their oldest commit landed, and
 * commits without one last.
 */
export function groupChanges(changes: readonly CandidateChange[]): CandidateGroup[] {
  const oldestFirst = [...changes].reverse();
  const groups = new Map<string, { work: string | null; issue: number | null; byPr: Map<number | null, string[]> }>();
  const add = (work: string | null, issue: number | null, pr: number | null, commit: string): void => {
    const key = work !== null ? `work:${work}` : issue !== null ? `issue:${issue}` : "";
    const g = groups.get(key) ?? { work, issue, byPr: new Map<number | null, string[]>() };
    groups.set(key, g);
    g.byPr.set(pr, [commit, ...(g.byPr.get(pr) ?? [])]);
  };
  for (const c of oldestFirst) {
    const issues = c.closes?.issues ?? [];
    if (c.work.length > 0) for (const work of c.work) add(work, null, c.pr, c.commit);
    else if (issues.length > 0) for (const issue of issues) add(null, issue, c.pr, c.commit);
    else add(null, null, c.pr, c.commit);
  }
  const nullLast = <K>(keys: K[]): K[] => [...keys.filter((k) => k !== null), ...keys.filter((k) => k === null)];
  const all = [...groups.values()];
  return [...all.filter((g) => g.work !== null), ...all.filter((g) => g.issue !== null), ...all.filter((g) => g.work === null && g.issue === null)].map((g) => ({
    work: g.work,
    issue: g.issue,
    pullRequests: nullLast([...g.byPr.keys()]).map((pr) => ({ pr, commits: g.byPr.get(pr)! })),
  }));
}

/** Read the release candidates of the member at `query.cwd`. */
export async function releaseCandidatesDocument(query: ReleaseCandidatesQuery): Promise<ReleaseCandidatesDocument> {
  const head = { $schema: RELEASE_CANDIDATES_SCHEMA_ID, contract: RELEASE_CANDIDATES_CONTRACT_VERSION, chant: readerVersion() };
  const cwd = resolve(query.cwd);
  const top = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) return { ...head, error: { code: "not-a-git-repository", message: "candidates are read from trunk's commits and tags, and this directory is not in a git repository" } };
  try {
    const { scopeSource } = await import("./write-scope");
    const { resolveTrunk } = await import("../lifecycle/release-workstation");
    const { judgedCiTags } = await import("../lifecycle/release-revocation");
    const { commitDetails } = await import("./intent");
    const source = scopeSource(cwd);
    const green = source.declaration?.ci?.green ?? null;
    if (query.branch !== undefined && !(green && greenBranches(green).includes(query.branch))) {
      throw new Error(`--branch ${query.branch} is not a branch ci.green judges${green ? ` (${greenBranches(green).join(", ")})` : ", and the declaration has no ci.green"}`);
    }
    // #4692: an unknown lane, or one with no ci.green, stops the read with the lanes declared.
    let lane: string | null = null;
    if (query.lane !== undefined) {
      if (!green) throw new Error(`--lane ${query.lane} names a ci.green lane, and the declaration has no ci.green`);
      const { laneOf } = await import("./declaration");
      lane = laneOf(green, query.lane).name;
    }
    const trunk = resolveTrunk(top, query.branch ?? green?.branch ?? null);
    const tip =
      tryGit(top, ["rev-parse", "--verify", "--quiet", `refs/remotes/${trunk.remote}/${trunk.branch}^{commit}`]) ??
      tryGit(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${trunk.branch}^{commit}`]);
    const ledger = await resolveMemberLedger(cwd);
    const loc = { cwd };

    // What each environment runs.
    const { readMemberPromotionOrder } = await import("./promotion-order");
    const order = ((await readMemberPromotionOrder(cwd)) ?? []).map((s) => s.name);
    const envNames = query.env !== undefined ? [query.env] : order;
    const { releases } = await readAllReleases(loc);
    const { cuts } = await readCuts(loc);
    const commitOf = new Map(releases.map((r) => [r.releaseDigest, r.commit]));
    const labelOf = new Map<string, string>();
    const cutAt = new Map<string, string>();
    for (const c of cuts) {
      if (c.label !== null && !labelOf.has(c.releaseDigest)) labelOf.set(c.releaseDigest, c.label);
      if (!cutAt.has(c.releaseDigest) || c.timestamp > cutAt.get(c.releaseDigest)!) cutAt.set(c.releaseDigest, c.timestamp);
    }
    const environments: CandidateEnvironment[] = [];
    for (const env of envNames) {
      const { records } = await readReleaseLedger(env, loc);
      const byDigest = new Map<string, string[]>();
      for (const record of latestPerComponent(records).values()) {
        const digest = (record as { releaseDigest?: unknown }).releaseDigest;
        if (typeof digest !== "string") continue;
        byDigest.set(digest, [...(byDigest.get(digest) ?? []), record.component].sort());
      }
      const running = [...byDigest]
        .map(([releaseDigest, components]) => ({ releaseDigest, label: labelOf.get(releaseDigest) ?? null, commit: commitOf.get(releaseDigest) ?? null, components }))
        .sort((a, b) => ((cutAt.get(b.releaseDigest) ?? "") < (cutAt.get(a.releaseDigest) ?? "") ? -1 : 1));
      environments.push({ env, running });
    }

    const empty = { ...head, member: ledger.members.length > 0 ? ledger.members.join("/") : null, branch: trunk.branch, lane, tip, environments, since: null, candidates: [], skipped: [], pending: [] };
    if (!tip) return empty;

    // The oldest commit any environment runs bounds the walk, when every environment runs one.
    const limit = query.limit ?? DEFAULT_CANDIDATE_LIMIT;
    const line = git(top, ["rev-list", "--first-parent", `--max-count=${Math.max(limit, 1) * 20}`, tip]).split("\n").filter(Boolean);
    const position = new Map(line.map((sha, i) => [sha, i]));
    const runningCommits = (e: CandidateEnvironment): string[] => e.running.map((r) => r.commit).filter((c): c is string => c !== null && position.has(c));
    const bounded = environments.length > 0 && environments.every((e) => runningCommits(e).length > 0);
    let since: string | null = null;
    let walk = line.slice(0, limit);
    if (bounded) {
      const oldest = Math.max(...environments.flatMap((e) => runningCommits(e).map((c) => position.get(c)!)));
      since = line[oldest];
      walk = line.slice(0, oldest);
    }
    // An environment's newest running commit on the line, by position (smaller is newer).
    const newestRun = new Map(environments.map((e) => [e.env, Math.min(...runningCommits(e).map((c) => position.get(c)!), Number.POSITIVE_INFINITY)]));

    const tags = await judgedCiTags(top, green, lane ?? undefined);
    const details = commitDetails(top, walk);
    const merges = new Map<string, Record<string, unknown>>();
    for (const sha of walk) {
      const text = (await readBlobFromPath("_merges", `${sha}.json`, loc)) ?? (ledger.prefix !== "" ? await readBlobFromPath("_merges", `${sha}.json`, { cwd, ledgerPrefix: "" }) : null);
      if (text === null) continue;
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) merges.set(sha, parsed as Record<string, unknown>);
      } catch {
        // A merge record that is not JSON is left out.
      }
    }
    // The merge record names its pull request in `source` (../lifecycle/merge-record.ts).
    const prOf = (sha: string): number | null => mergeRecordPr(merges.get(sha) ?? null) ?? prFromSubject(details.get(sha)?.subject ?? "");
    // What each pull request closes, asked of the forge once each, when asked to (#4649).
    let closed = new Map<number, PullRequestCloses>();
    if (query.forgeIssues) {
      const { forgeWorkReader } = await import("./forge-work");
      closed = await forgeWorkReader(top, query.forgeIssues).closesAll(walk.map(prOf).filter((n): n is number => n !== null));
    }
    const change = (sha: string): CandidateChange => {
      const d = details.get(sha);
      const { work, records } = recordTrailers(d?.trailers ?? {});
      const merge = merges.get(sha) ?? null;
      const pr = prOf(sha);
      return { commit: sha, subject: d?.subject ?? "", date: d?.date ?? "", work, records, pr, merge, closes: pr !== null ? (closed.get(pr) ?? null) : null };
    };

    const flagReader = await flagsReader(top, source.rootOnDisk);
    const cutLabels = new Map<string, string[]>();
    for (const r of releases) {
      const label = labelOf.get(r.releaseDigest);
      if (label !== undefined) cutLabels.set(r.commit, [...(cutLabels.get(r.commit) ?? []), label].sort());
    }

    // Oldest first, so each candidate closes the commits since the previous one.
    const candidates: Candidate[] = [];
    const skipped: Array<{ commit: string; subject: string; reason: "revoked" }> = [];
    let open: string[] = [];
    for (let i = walk.length - 1; i >= 0; i--) {
      const sha = walk[i];
      open.push(sha);
      if (tags.revoked.has(sha)) {
        skipped.push({ commit: sha, subject: details.get(sha)?.subject ?? "", reason: "revoked" });
        continue;
      }
      if (!tags.green.has(sha)) continue;
      const own = change(sha);
      const changes = open.map(change).reverse();
      candidates.push({
        commit: sha,
        subject: own.subject,
        date: own.date,
        newFor: environments.filter((e) => i < newestRun.get(e.env)!).map((e) => e.env),
        cut: cutLabels.get(sha) ?? [],
        changes,
        groups: groupChanges(changes),
        flags: flagReader(open),
      });
      open = [];
    }
    return {
      ...empty,
      since,
      candidates: candidates.reverse(),
      skipped: skipped.reverse(),
      pending: open.map(change).reverse(),
    };
  } catch (err) {
    return { ...head, error: { code: "ledger-unreadable", message: `reading the candidates failed: ${err instanceof Error ? err.message : String(err)}` } };
  }
}

/** The flags whose record files the given commits change, or a reader that finds none when no flag kind can be read. */
async function flagsReader(top: string, root: string | null): Promise<(shas: string[]) => CandidateFlag[]> {
  if (!root) return () => [];
  let flags: Awaited<ReturnType<typeof import("./flags-read").readWorkspaceFlags>>["flags"];
  try {
    const { readWorkspaceFlags } = await import("./flags-read");
    flags = (await readWorkspaceFlags(root)).flags;
  } catch {
    return () => [];
  }
  if (flags.length === 0) return () => [];
  const fromTop = (p: string): string => relative(top, resolve(root, p)).split(sep).join("/");
  const byPath = new Map(flags.map((f) => [fromTop(f.path), f]));
  return (shas) => {
    const touched = new Set<string>();
    for (const sha of shas) {
      const names = tryGit(top, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha]) ?? "";
      for (const n of names.split("\n")) if (byPath.has(n)) touched.add(n);
    }
    return [...touched]
      .sort()
      .map((p) => byPath.get(p)!)
      .map((f) => ({ id: f.id, member: f.member, param: f.param, path: f.path, values: f.values }));
  };
}
