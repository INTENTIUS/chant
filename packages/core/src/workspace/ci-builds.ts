/**
 * Which commits get built, and what each one ends with (#4169).
 *
 * A `ci.green` phase declares `build: "every"` (the default) or
 * `build: "newest"`. Under `newest` the phase's workflow keeps one run
 * waiting and drops the rest, so only the newest commit is built when a
 * runner frees. This module does the tick's part of that, given the
 * verdicts {@link planTick} (./ci-green.ts) judged:
 *
 * - Superseded. A commit with no run of a `newest` phase, below a newer
 *   commit that has one, is `unbuilt` for that phase, covered by the newer
 *   commit. A cancelled run makes any phase `unbuilt` (`phaseVerdictOf`).
 * - Retry. A failed run with one attempt is run again once before the
 *   commit counts red: through the forge's re-run (`CiForge.rerun`) for
 *   check runs, or a build request for chant runs. A retry that has not
 *   started an hour on counts as the failure it was.
 * - Bisect. When the newest built commit of a `newest` phase is red, the
 *   unbuilt commits back to the last one the phase passed on are built, one
 *   request per tick: the commit halfway when more than four are left, else
 *   the one just below the red. The first red commit found is the culprit,
 *   and it and every commit after it name it.
 * - Requests. A build is asked for with an annotated tag,
 *   `ci/build/<sha>`, whose record names the phases and why. The tick
 *   starts a workflow at that tag on GitHub (`CiForge.dispatch`), and `ci
 *   serve --build-command` serves it for chant runs. A phase a request
 *   waits on is `pending`. A request no runner served in six hours leaves
 *   the phase `unbuilt`, and once its phases are decided the tick deletes
 *   the tag.
 * - Missing. A phase that declares `build: "every"` and has no run on a
 *   commit half an hour after it landed (the forge skipped the push run, as
 *   on acc9b9dbd) gets one build request, `missing`, for those phases
 *   (#4216). The record keeps `missing`, so a commit is asked for once.
 * - Records. Every first-parent commit the tick judged gets
 *   `_ci/<sha>.json` on `chant/lifecycle`, rewritten only when what it says
 *   changes: `green`, `red`, `unbuilt` or `pending`, with each required
 *   phase's verdict, runs, reason, the commit that covers it and the culprit.
 *   A commit that leaves the window still `pending` is rewritten `unbuilt`,
 *   for the reason `aged-out`. The `ci/green` and `ci/revoked` tags stay
 *   what decides a release; the records say what happened to the rest.
 */

import { execFileSync } from "node:child_process";
import type { CiBuild, CiGreen } from "./declaration";
import type { CheckRun } from "./ci-green-forge";
import { commitVerdictOf, phaseVerdictOf, type PhaseReason, type PhaseVerdict, type TickCommit, type Verdict } from "./ci-green";

export const CI_BUILD_TAG_PREFIX = "ci/build/";
/** The directory on `chant/lifecycle` holding one record per commit. */
export const CI_RECORDS_DIR = "_ci";
const LEDGER_REF = "refs/heads/chant/lifecycle";
/** The local branch the records are read from, for readers that fall back to its remote-tracking branch. */
export const CI_LEDGER_REF = LEDGER_REF;

/** How long a build request may wait for a runner before its phases count as unbuilt. */
export const BUILD_REQUEST_TTL_MS = 6 * 3_600_000;
/** How long an `every` phase may have no run on a commit before the tick asks for one (#4216). */
export const MISSING_RUN_GRACE_MS = 30 * 60_000;
/** How long a retry may take to start before the failure it was counts. */
export const RETRY_TTL_MS = 3_600_000;
/** Above this many unbuilt commits a bisect halves the range; at or below it, it steps back one commit at a time. */
export const BISECT_HALVE_ABOVE = 4;

export type BuildRequestReason = "bisect" | "retry" | "requested" | "missing";

/** A `ci/build/<sha>` tag's record: the phases to build at the commit, and why. */
export interface BuildRequest {
  schema: 1;
  tag: string;
  commit: string;
  branch: string;
  phases: string[];
  reason: BuildRequestReason;
  /** When it was asked for, ISO 8601. */
  at: string;
}

/** One record, `_ci/<sha>.json` on `chant/lifecycle`. */
export interface CiRecord {
  schema: 1;
  commit: string;
  branch: string;
  /** `green` and `red` follow the tags: a green tag, or a failed phase or a revoked tag. */
  state: "green" | "red" | "unbuilt" | "pending";
  /** When this content was written, ISO 8601. Not compared when deciding whether to write again. */
  at: string;
  /** Set when the commit has a revoked tag. */
  revoked?: true;
  phases: Record<string, CiRecordPhase>;
  /** The first required phase that failed, and its run, when the state is red. */
  failure?: { phase: string; run: CiRecordRun };
  /** The retries asked for, by run name: the run that failed and when. */
  retried?: Record<string, { run: number; at: string }>;
  /** The build request waiting on this commit, when there is one. */
  request?: { tag: string; reason: BuildRequestReason; phases: string[]; at: string; dispatched?: true };
  /** The `every` phases a `missing` request asked for, and when (#4216). A commit is asked for once. */
  missing?: { phases: string[]; at: string };
}

export interface CiRecordRun {
  name: string;
  id: number | null;
  conclusion: string | null;
  url: string | null;
}

export interface CiRecordPhase {
  verdict: Verdict;
  build: CiBuild;
  runs: CiRecordRun[];
  reason?: PhaseReason | "aged-out";
  coveredBy?: string;
  culprit?: string;
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** How a tick can run a failed job again: the forge's re-run, a build request, or not at all. */
export type RetryVia = "forge" | "request" | null;

export interface BuildsInput {
  green: CiGreen;
  /** Newest first, as {@link planTick} returns them. */
  commits: TickCommit[];
  /** Every attempt of every run, by commit. */
  runs: ReadonlyMap<string, readonly CheckRun[]>;
  requests: ReadonlyMap<string, BuildRequest>;
  records: ReadonlyMap<string, CiRecord>;
  now: Date;
  retryVia: RetryVia;
}

export interface BuildsPlan {
  /** Requests to make: bisect steps, and retries of chant runs. */
  requests: BuildRequest[];
  /** Failed check runs to run again through the forge, by commit. */
  retries: { sha: string; run: CheckRun }[];
  /** Request tags whose phases are decided, or that waited too long, or whose commit left the window. */
  resolved: string[];
}

const phaseOf = (green: CiGreen, name: string) => green.phases.find((p) => p.name === name)!;
const buildOf = (green: CiGreen, name: string): CiBuild => phaseOf(green, name).build ?? "every";
const decided = (v: Verdict | undefined) => v === "pass" || v === "fail";
const age = (at: string, now: Date) => now.getTime() - Date.parse(at);

function setPhase(c: TickCommit, phase: string, fn: (p: PhaseVerdict) => PhaseVerdict): void {
  const v = c.verdict;
  if (!v) return;
  c.verdict = commitVerdictOf(v.phases.map((p) => (p.phase === phase ? fn(p) : p)));
}

const phaseIn = (c: TickCommit, phase: string) => c.verdict?.phases.find((p) => p.phase === phase);

/**
 * Apply supersession, retries, requests and bisection to the judged commits,
 * in place, and say what the tick has to ask for. Pure: it reads and writes
 * nothing but its input.
 */
export function planBuilds(input: BuildsInput): BuildsPlan {
  const { green, commits, now } = input;
  const plan: BuildsPlan = { requests: [], retries: [], resolved: [] };
  const inWindow = new Set(commits.map((c) => c.sha));
  const live = (sha: string, phase: string): BuildRequest | undefined => {
    const r = input.requests.get(sha);
    return r && r.phases.includes(phase) && age(r.at, now) < BUILD_REQUEST_TTL_MS ? r : undefined;
  };

  // A request waits on a phase with no run yet; one no runner served in time leaves it unbuilt.
  for (const c of commits) {
    const r = input.requests.get(c.sha);
    if (!r || !c.verdict) continue;
    for (const name of r.phases) {
      const p = phaseIn(c, name);
      if (!p || p.runs.length > 0) continue;
      setPhase(c, name, (q) => (live(c.sha, name) ? { ...q, verdict: "pending", reason: "requested" } : { ...q, verdict: "unbuilt", reason: "request-unserved" }));
    }
  }

  // Missing (#4216): an `every` phase the forge never ran on a commit, asked for once per commit.
  for (const c of commits) {
    if (c.before !== "none" || !c.verdict || age(c.committed, now) < MISSING_RUN_GRACE_MS) continue;
    if (input.records.get(c.sha)?.missing || input.requests.has(c.sha) || plan.requests.some((q) => q.commit === c.sha)) continue;
    const phases = green.require.filter((name) => {
      if (phaseOf(green, name).build !== "every") return false;
      const p = phaseIn(c, name);
      return p !== undefined && p.verdict === "pending" && p.runs.length === 0 && p.reason === undefined;
    });
    if (phases.length === 0) continue;
    plan.requests.push(request(green, c.sha, phases, "missing", now));
    for (const name of phases) setPhase(c, name, (q) => ({ ...q, verdict: "pending", reason: "requested" }));
  }

  // Superseded: newest first, a newest phase with no run below a commit with one.
  for (const name of green.require) {
    if (buildOf(green, name) !== "newest") continue;
    let cover: string | undefined;
    for (const c of commits) {
      const p = phaseIn(c, name);
      if (!p) continue;
      if (p.runs.length > 0) {
        cover = c.sha;
        continue;
      }
      if (cover && p.reason !== "requested" && p.reason !== "request-unserved") setPhase(c, name, (q) => ({ ...q, verdict: "unbuilt", reason: "superseded", coveredBy: cover }));
    }
  }

  // Retry once: a commit with no tag whose failed run has one attempt.
  if (input.retryVia) {
    for (const c of commits) {
      if (c.before !== "none" || c.verdict?.verdict !== "fail") continue;
      const all = input.runs.get(c.sha) ?? [];
      const retried = input.records.get(c.sha)?.retried ?? {};
      for (const p of c.verdict.phases) {
        for (const run of p.runs.filter((r) => r.verdict === "fail")) {
          if (all.filter((r) => r.name === run.name).length > 1) continue;
          const asked = retried[run.name];
          if (asked && asked.run === run.id && age(asked.at, now) >= RETRY_TTL_MS) continue;
          if (!asked || asked.run !== run.id) {
            const checkRun = all.find((r) => r.name === run.name && r.id === run.id)!;
            if (input.retryVia === "forge") plan.retries.push({ sha: c.sha, run: checkRun });
            else if (!input.requests.has(c.sha) && !plan.requests.some((q) => q.commit === c.sha)) plan.requests.push(request(green, c.sha, [p.phase], "retry", now));
          }
          setPhase(c, p.phase, (q) => {
            const runs = q.runs.map((r) => (r.name === run.name && r.id === run.id ? { ...r, verdict: "pending" as const } : r));
            return { ...q, runs, ...phaseVerdictOf(runs, q.unmatched), reason: "retrying" };
          });
        }
      }
    }
  }

  // Culprits for every phase, and a bisect request for a newest one.
  for (const name of green.require) {
    const verdicts = commits.map((c) => phaseIn(c, name));
    const top = verdicts.findIndex((p) => decided(p?.verdict));
    if (top < 0 || verdicts[top]!.verdict !== "fail") continue;
    let oldestRed = top;
    let between: number[] = [];
    let passed = -1;
    for (let i = top + 1; i < commits.length; i++) {
      const v = verdicts[i]?.verdict;
      if (v === "fail") {
        oldestRed = i;
        between = [];
      } else if (v === "pass") {
        passed = i;
        break;
      } else if (v !== undefined) between.push(i);
    }
    if (between.length === 0) {
      if (passed < 0) continue;
      const culprit = commits[oldestRed].sha;
      for (let i = oldestRed; i >= 0; i--) {
        if (verdicts[i]?.verdict === "pass") break;
        if (verdicts[i]) setPhase(commits[i], name, (q) => ({ ...q, culprit }));
      }
      continue;
    }
    if (buildOf(green, name) !== "newest") continue;
    if (between.some((i) => live(commits[i].sha, name))) continue;
    const pick = between.length > BISECT_HALVE_ABOVE ? between[Math.floor(between.length / 2)] : between[0];
    const sha = commits[pick].sha;
    if (input.requests.has(sha) || plan.requests.some((q) => q.commit === sha)) continue;
    plan.requests.push(request(green, sha, [name], "bisect", now));
    setPhase(commits[pick], name, (q) => ({ ...q, verdict: "pending", reason: "requested", coveredBy: undefined }));
  }

  // A request is done once its phases are decided, it has waited too long, or its commit left the window.
  for (const [sha, r] of input.requests) {
    const c = commits.find((x) => x.sha === sha);
    const done = !inWindow.has(sha) || age(r.at, now) >= BUILD_REQUEST_TTL_MS || (c !== undefined && (c.before === "revoked" || r.phases.every((name) => decided(phaseIn(c, name)?.verdict))));
    if (done) plan.resolved.push(r.tag);
  }
  return plan;
}

function request(green: CiGreen, commit: string, phases: string[], reason: BuildRequestReason, now: Date): BuildRequest {
  return { schema: 1, tag: `${CI_BUILD_TAG_PREFIX}${commit}`, commit, branch: green.branch, phases, reason, at: iso(now) };
}

// ── Records ──────────────────────────────────────────────────────────────────

const recordRun = (r: { name: string; id: number; conclusion: string | null; url: string | null; opRun?: unknown }): CiRecordRun => ({ name: r.name, id: r.opRun ? null : r.id, conclusion: r.conclusion, url: r.url });

/** The record a judged commit gets, carrying the retries asked for before and now. */
export function recordOf(input: { green: CiGreen; commit: TickCommit; previous?: CiRecord; retries: readonly { sha: string; run: CheckRun }[]; requests: ReadonlyMap<string, BuildRequest>; now: Date }): CiRecord {
  const { green, commit: c, previous, now } = input;
  const retried = { ...(previous?.retried ?? {}) };
  for (const r of input.retries) if (r.sha === c.sha) retried[r.run.name] = { run: r.run.id, at: iso(now) };
  const req = input.requests.get(c.sha);
  const missing = req?.reason === "missing" ? { phases: req.phases, at: req.at } : previous?.missing;
  const extras = {
    ...(Object.keys(retried).length > 0 ? { retried } : {}),
    ...(req ? { request: { tag: req.tag, reason: req.reason, phases: req.phases, at: req.at } } : {}),
    ...(missing ? { missing } : {}),
  };
  if (c.before === "revoked" || !c.verdict) {
    return { schema: 1, commit: c.sha, branch: green.branch, state: "red", at: iso(now), revoked: true, phases: previous?.phases ?? {}, ...(previous?.failure ? { failure: previous.failure } : {}), ...extras };
  }
  const v = c.verdict;
  // A pass whose tag an ignored tag blocks (#4031) is not green until a person clears the name.
  const state: CiRecord["state"] =
    c.before === "green" ? (v.verdict === "fail" ? "red" : "green") : v.verdict === "pass" ? (c.made ? "green" : "pending") : v.verdict === "fail" ? "red" : v.verdict;
  const phases: Record<string, CiRecordPhase> = {};
  for (const p of v.phases) {
    phases[p.phase] = {
      verdict: p.verdict,
      build: buildOf(green, p.phase),
      runs: p.runs.map(recordRun),
      ...(p.reason ? { reason: p.reason } : {}),
      ...(p.coveredBy ? { coveredBy: p.coveredBy } : {}),
      ...(p.culprit ? { culprit: p.culprit } : {}),
    };
  }
  return {
    schema: 1,
    commit: c.sha,
    branch: green.branch,
    state,
    at: iso(now),
    phases,
    ...(v.failure ? { failure: { phase: v.failure.phase, run: recordRun(v.failure.run) } } : {}),
    ...extras,
  };
}

/** The record a commit that left the window still pending gets: each pending phase `unbuilt`, `aged-out`. */
export function agedOut(record: CiRecord, now: Date): CiRecord {
  const phases = Object.fromEntries(Object.entries(record.phases).map(([k, p]) => [k, p.verdict === "pending" ? { ...p, verdict: "unbuilt" as const, reason: "aged-out" as const } : p]));
  const { request: _request, ...rest } = record;
  return { ...rest, state: "unbuilt", at: iso(now), phases };
}

/** Whether two records say the same thing, the time each was written aside. */
export function sameRecord(a: CiRecord | undefined, b: CiRecord): boolean {
  if (!a) return false;
  const { at: _a, ...x } = a;
  const { at: _b, ...y } = b;
  return JSON.stringify(x) === JSON.stringify(y);
}

export const recordPath = (sha: string) => `${CI_RECORDS_DIR}/${sha}.json`;

function tryGit(top: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: top, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 }).trimEnd();
  } catch {
    return null;
  }
}

function parseRecord(text: string | null): CiRecord | undefined {
  if (!text) return undefined;
  try {
    const r = JSON.parse(text) as CiRecord;
    return r && r.schema === 1 && typeof r.commit === "string" && typeof r.state === "string" ? r : undefined;
  } catch {
    return undefined;
  }
}

/** One commit's record, from the local `chant/lifecycle` (or `ref`, such as its remote-tracking branch). */
export function readCiRecord(top: string, sha: string, ref: string = LEDGER_REF): CiRecord | undefined {
  return parseRecord(tryGit(top, ["show", `${ref}:${recordPath(sha)}`]));
}

/** Every record on the local `chant/lifecycle` (or `ref`), by commit. Empty when the branch or the directory is missing. */
export function readCiRecords(top: string, ref: string = LEDGER_REF): Map<string, CiRecord> {
  const out = new Map<string, CiRecord>();
  const names = tryGit(top, ["ls-tree", "--name-only", `${ref}:${CI_RECORDS_DIR}`]);
  if (!names) return out;
  for (const name of names.split("\n")) {
    const m = /^([0-9a-f]{40,64})\.json$/.exec(name);
    if (!m) continue;
    const r = readCiRecord(top, m[1], ref);
    if (r) out.set(m[1], r);
  }
  return out;
}

// ── Requests ─────────────────────────────────────────────────────────────────

/** Every `ci/build/<sha>` tag with a record this reads, from local refs, by commit. */
export function readBuildRequests(top: string): Map<string, BuildRequest> {
  const out = new Map<string, BuildRequest>();
  const raw = tryGit(top, ["for-each-ref", "--format=%(refname:lstrip=2)%00%(objecttype)%00%(contents)%01", `refs/tags/${CI_BUILD_TAG_PREFIX}`]);
  if (!raw) return out;
  for (const entry of raw.split("\u0001")) {
    const [tag, type, contents] = entry.replace(/^\n/, "").split("\u0000");
    if (!tag || type !== "tag" || !contents?.includes("{")) continue;
    try {
      const r = JSON.parse(contents.slice(contents.indexOf("{"))) as BuildRequest;
      const sha = tag.slice(CI_BUILD_TAG_PREFIX.length);
      if (r.schema === 1 && r.commit === sha && Array.isArray(r.phases) && typeof r.at === "string") out.set(sha, { ...r, tag });
    } catch {
      // A tag whose record does not parse asks for nothing.
    }
  }
  return out;
}

/** The annotation of a request tag: a subject line, then the record. */
export function buildRequestAnnotation(r: BuildRequest): string {
  return `ci: build ${r.phases.join(", ")} at this commit (${r.reason})\n\n${JSON.stringify(r, null, 2)}\n`;
}

/** A request for `ci run --at <sha>`: every required phase, asked for by a person. */
export function requestedBuild(green: CiGreen, commit: string, phases: readonly string[], now: Date): BuildRequest {
  return request(green, commit, [...phases], "requested", now);
}
