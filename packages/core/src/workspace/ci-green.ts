/**
 * Which commits passed CI (#3573, ws-103).
 *
 * The declaration's `ci.green` names a branch, a window and phases, each
 * phase a list of check-run name patterns. A phase passes when every check
 * run its patterns match finished with success, judged by each run's latest
 * attempt. A run that finished as skipped passes only in a phase declared
 * `skipped: pass`. A run still going, or a pattern no run matches yet, leaves
 * the phase undecided. A commit passes when every phase in `require` passes,
 * and fails when one of them fails.
 *
 * What chant concluded is kept in git as two kinds of annotated tag, each
 * made once and never moved or deleted by chant:
 *
 *   ci/green/<sha>     every required phase passed; the annotation gives the
 *                      time and each phase's runs
 *   ci/revoked/<sha>   a green commit later failed a required phase (a re-run
 *                      that went red); the annotation gives the phase, the
 *                      run and the time
 *
 * {@link ciTick} walks the branch's first-parent commits within the window,
 * tags the ones that turned green and revokes the green ones that turned red.
 * It is idempotent: a second tick over the same check runs changes nothing.
 * A revoked commit is never looked at again, so it goes green again only
 * when someone deletes its revoked tag by hand, which leaves its green tag
 * standing. {@link lastGreen} reads the tags alone, with no forge.
 *
 * The forge is asked only for check runs (`./ci-green-forge.ts`). The tags
 * are fetched from and pushed to the remote with git.
 *
 * Signed tags (#4031): when `ci.green.signedSince` names a commit, a tag on
 * any commit that is not a strict first-parent ancestor of it counts only
 * when its annotation carries a statement signed by a runner key (`./trust/ci-tag-statement.ts`). Every
 * reader here, and the release cut, ignores a tag without a valid one and
 * reports it. A tick given a runner key signs the tags it makes. Without
 * `signedSince` every tag counts, as before.
 *
 * Chant runs as the source (#4044): with `ci.green.source: "runs"` (or
 * `--source runs`) the tick reads chant's own Op runs from the run ledger on
 * `chant/lifecycle` in place of the forge's check runs, so a project whose
 * pipelines run as chant Ops, such as one on GitLab or Forgejo, gets green
 * and revoked tags with no forge check runs. A phase's patterns then match
 * Op names, a run counts for the commit its record names as `gitSha`, and
 * the latest run of each Op decides, by its end time. Signing is opt-in
 * (#4156): an unsigned run counts, with no signer, and a run whose statement
 * a runner key holding the `runner` role at base signed counts with that
 * signer (`./trust/op-run-statement.ts`). A run whose statement is there and
 * does not verify is ignored and reported, so it neither greens nor revokes
 * a commit. With `ci.green.signedSince`, an unsigned run counts only on a
 * strict first-parent ancestor of that commit, as an unsigned tag does. A
 * tick given a runner key signs the tags it makes, and each run in the
 * tag's record names the Op run's id and carries its statement when it has
 * one.
 */

import { judgeCommits, mergeCommits, readWorkIndex, type CommitLink } from "./commit-links";
import { execFileSync } from "node:child_process";
import { readDeclaration, readerVersion, WORKSPACE_ERROR_CODES, WorkspaceReadError, type CiGreen, type CiPhase, type CiSource } from "./declaration";
import type { CheckRun, CiForge, OpRunRef } from "./ci-green-forge";
import type { OpRunRecord } from "../op/runtime";
import { readRunLedger } from "../lifecycle/run-ledger";
import { fetchLifecycleStatus, listFilesInDir, listLedgerTrees, pushLifecycleStatus, writeLedgerFiles } from "../lifecycle/git";
import { ledgerRecordingOff } from "../lifecycle/no-record";
import { agedOut, buildRequestAnnotation, CI_BUILD_TAG_PREFIX, planBuilds, readBuildRequests, readCiRecords, recordOf, recordPath, requestedBuild, sameRecord, type BuildRequest, type CiRecord } from "./ci-builds";
import { dispatchableWorkflows, readWorkflowSources } from "./ci-green-workflow";
import { signOpRunRecord, verifyOpRunStatement } from "./trust/op-run-statement";
import type { ReasonCode } from "./reason-codes";
import { gitTop } from "./tree";
import { locateWorkspace } from "./which-chant";
import { gitRevisionSource } from "./record-source";
import { emptyPolicy, readTrustPolicy } from "./trust/policy";
import { loadRunnerKey } from "./trust/dsse";
import { signCiTagRecord, verifyCiTagStatement, CI_TAG_SIGNER_ROLE, type CiTagFailure, type CiTagRecord, type CiTagSigner } from "./trust/ci-tag-statement";

/** The environment variable a tick (#4031) and `chant run` (#4044) read a runner key from, as PEM, when `--key` is not given. */
export const RUNNER_KEY_ENV = "CHANT_RUNNER_KEY";

export const CI_GREEN_TAG_PREFIX = "ci/green/";
export const CI_REVOKED_TAG_PREFIX = "ci/revoked/";

export const CI_LAST_GREEN_CONTRACT_VERSION = 1;
export const CI_LAST_GREEN_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/ci-last-green/v1/ci-last-green.schema.json";

/** Why `ci last-green` or `ci tick` could not start. Closed. */
export const CI_GREEN_ERROR_CODES = [...WORKSPACE_ERROR_CODES, "ci-green-undeclared", "ci-branch-unknown"] as const satisfies readonly ReasonCode[];
export type CiGreenErrorCode = (typeof CI_GREEN_ERROR_CODES)[number];

export class CiGreenError extends Error {
  constructor(
    readonly code: CiGreenErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CiGreenError";
  }
}

// ── Judging check runs ───────────────────────────────────────────────────────

/**
 * `unbuilt` (#4169): the phase's runs were cancelled, or, for a phase that
 * builds only the newest commit, a newer commit's run superseded this one's.
 * Neither is a failure, and neither is a pass.
 */
export type Verdict = "pass" | "fail" | "pending" | "unbuilt";

/** Conclusions that say a run was stopped, or never started, rather than that it failed (#4169). */
const UNBUILT_CONCLUSIONS = new Set(["cancelled", "stale"]);

/** Whether a check run's name matches a pattern: the whole name, `*` standing for any run of characters. */
export function matchesCheckRun(pattern: string, name: string): boolean {
  const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");
  return re.test(name);
}

/** Each check run's latest attempt, by name: the run with the largest id. */
export function latestAttempts(runs: readonly CheckRun[]): CheckRun[] {
  const byName = new Map<string, CheckRun>();
  for (const r of runs) {
    const seen = byName.get(r.name);
    if (!seen || r.id > seen.id) byName.set(r.name, r);
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export interface RunVerdict {
  name: string;
  id: number;
  status: string;
  conclusion: string | null;
  url: string | null;
  verdict: Verdict;
  /** The Op run this is, when the source is chant runs (#4044). */
  opRun?: OpRunRef;
  /** Why the Op run failed, its record's `failure.code` (#4094), when it says. */
  failureCode?: string;
}

export interface PhaseVerdict {
  phase: string;
  verdict: Verdict;
  /** The latest attempt of every run the phase's patterns match, by name. */
  runs: RunVerdict[];
  /** Patterns no check run matches yet, which leave the phase undecided. */
  unmatched: string[];
  /**
   * Why an `unbuilt` or held `pending` phase is so (#4169): its runs were
   * `cancelled`, a newer commit's run `superseded` it, its retry or a
   * requested build is still to come (`retrying`, `requested`), or a
   * request no runner served (`request-unserved`).
   */
  reason?: PhaseReason;
  /** For a superseded phase, the newer commit whose run covers it (#4169). */
  coveredBy?: string;
  /** The commit a bisect found broke this phase, on that commit and the commits after it (#4169). */
  culprit?: string;
}

/** Why a phase is `unbuilt`, or held `pending` (#4169). */
export type PhaseReason = "cancelled" | "superseded" | "retrying" | "requested" | "request-unserved";

function runVerdict(phase: CiPhase, r: CheckRun): Verdict {
  if (r.status !== "completed") return "pending";
  if (r.conclusion === "success") return "pass";
  if (r.conclusion === "skipped") return phase.skipped === "pass" ? "pass" : "fail";
  if (r.conclusion !== null && UNBUILT_CONCLUSIONS.has(r.conclusion)) return "unbuilt";
  return "fail";
}

/** Judge one phase against a commit's latest attempts. */
export function evaluatePhase(phase: CiPhase, latest: readonly CheckRun[]): PhaseVerdict {
  const runs: RunVerdict[] = [];
  const unmatched: string[] = [];
  for (const pattern of phase.runs) {
    const matched = latest.filter((r) => matchesCheckRun(pattern, r.name));
    if (matched.length === 0) unmatched.push(pattern);
    for (const r of matched) {
      if (runs.some((x) => x.name === r.name)) continue;
      runs.push({ name: r.name, id: r.id, status: r.status, conclusion: r.conclusion, url: r.url, verdict: runVerdict(phase, r), ...(r.opRun ? { opRun: r.opRun } : {}), ...(r.failureCode ? { failureCode: r.failureCode } : {}) });
    }
  }
  return { phase: phase.name, ...phaseVerdictOf(runs, unmatched), runs, unmatched };
}

/** A phase's verdict from its runs: a failure wins, then a run still going or a pattern no run matches, then a cancelled run. */
export function phaseVerdictOf(runs: readonly RunVerdict[], unmatched: readonly string[]): { verdict: Verdict; reason?: PhaseReason } {
  if (runs.some((r) => r.verdict === "fail")) return { verdict: "fail" };
  if (runs.some((r) => r.verdict === "pending") || unmatched.length > 0) return { verdict: "pending" };
  if (runs.some((r) => r.verdict === "unbuilt")) return { verdict: "unbuilt", reason: "cancelled" };
  return { verdict: "pass" };
}

export interface CommitVerdict {
  verdict: Verdict;
  /** Each required phase, in `require` order. */
  phases: PhaseVerdict[];
  /** The first required phase that failed, and its first failed run, when the commit fails. */
  failure: { phase: string; run: RunVerdict } | null;
}

/** Judge a commit: it fails when a required phase fails, and passes when every one passes. */
export function evaluateCommit(green: CiGreen, runs: readonly CheckRun[]): CommitVerdict {
  const latest = latestAttempts(runs);
  return commitVerdictOf(green.require.map((name) => evaluatePhase(green.phases.find((p) => p.name === name)!, latest)));
}

/**
 * A commit's verdict from its required phases: it fails when one fails, is
 * pending while one is, is unbuilt when one is unbuilt (#4169), and passes
 * when every one passes.
 */
export function commitVerdictOf(phases: PhaseVerdict[]): CommitVerdict {
  const failed = phases.find((p) => p.verdict === "fail");
  if (failed) return { verdict: "fail", phases, failure: { phase: failed.phase, run: failed.runs.find((r) => r.verdict === "fail")! } };
  const verdict: Verdict = phases.some((p) => p.verdict === "pending") ? "pending" : phases.some((p) => p.verdict === "unbuilt") ? "unbuilt" : "pass";
  return { verdict, phases, failure: null };
}

// ── The tick ─────────────────────────────────────────────────────────────────

/** A commit's tags before a tick: none, green, or green and revoked. A lone revoked tag counts as revoked. */
export type TagState = "none" | "green" | "revoked";

export interface TickCommit {
  sha: string;
  /** Committer time, ISO 8601. */
  committed: string;
  before: TagState;
  /** Undefined for a revoked commit, which is not judged again. */
  verdict?: CommitVerdict;
  /** The tag the tick made, if any. */
  made: { tag: string; message: string } | null;
  /** Whether the commit names its work item (#4029), or undefined when the workspace declares no work kind. */
  work?: CommitLink;
  /** The commit's ci tags that were ignored, each without a valid statement (#4031). Absent when none were. */
  ignored?: IgnoredCiTag[];
  /** The tag the tick would have made, when an ignored tag already holds its name (#4031). Nothing is made until a person deletes that tag. */
  blocked?: string;
  /** The Op runs on this commit that were ignored, each without a valid statement (#4044). Absent when none were. */
  ignoredRuns?: IgnoredOpRun[];
}

/** An Op run on a commit that does not count (#4044), and why. */
export interface IgnoredOpRun {
  run: string;
  op: string;
  env: string;
  /** `unsigned`, `invalid`, `untrusted` or `mismatch`, as for a ci tag. */
  status: CiTagFailure;
  reason: string;
}

export interface TickPlanInput {
  green: CiGreen;
  commits: readonly { sha: string; committed: string }[];
  greenTags: ReadonlySet<string>;
  revokedTags: ReadonlySet<string>;
  /** Tags that exist but were ignored (#4031), by commit. The tick does not make a tag whose name one of them holds. */
  ignored?: ReadonlyMap<string, readonly IgnoredCiTag[]>;
  checkRuns(sha: string): Promise<CheckRun[]>;
  now: Date;
  /** Signs each tag's record (#4031). Without it the tags carry no statement. */
  signer?: CiTagSigner;
}

/** A time as an annotation and a tick report write it: UTC, to the second. */
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** `window` (`90m`, `24h`, `7d`) in milliseconds. */
export function windowMs(window: string): number {
  const m = /^([1-9][0-9]*)(m|h|d)$/.exec(window);
  if (!m) throw new Error(`ci.green.window must be a number of minutes, hours or days, such as 24h, not ${JSON.stringify(window)}`);
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
}

/**
 * A run as a tag's record holds it. An Op run (#4044) has no forge id; it
 * names the Op run's id, env and signer, and carries the run's statement.
 */
const runRecord = (r: RunVerdict) =>
  r.opRun
    ? { name: r.name, id: null, conclusion: r.conclusion, url: r.url, opRun: { id: r.opRun.id, env: r.opRun.env, signer: r.opRun.signer, ...(r.opRun.statement ? { statement: r.opRun.statement } : {}) } }
    : { name: r.name, id: r.id, conclusion: r.conclusion, url: r.url };

/** `source: "runs"` on a record made from chant runs (#4044); nothing for check runs, so their records read as before. */
const sourceField = (green: CiGreen) => (green.source === "runs" ? { source: "runs" as const } : {});

/** The record as JSON, with the statement that signs it when a signer is given (#4031). */
function recordJson(record: CiTagRecord, signer: CiTagSigner | undefined): string {
  return JSON.stringify(signer ? { ...record, statement: signCiTagRecord(record, signer) } : record, null, 2);
}

/** The annotation of a green tag: a subject line, then the record as JSON, signed when `signer` is given (#4031). */
export function greenAnnotation(green: CiGreen, sha: string, verdict: CommitVerdict, at: Date, signer?: CiTagSigner): string {
  const record: CiTagRecord = {
    schema: 1,
    tag: "green",
    commit: sha,
    branch: green.branch,
    at: iso(at),
    ...sourceField(green),
    phases: Object.fromEntries(verdict.phases.map((p) => [p.phase, p.runs.map(runRecord)])),
  };
  return `ci: every required phase passed (${green.require.join(", ")})\n\n${recordJson(record, signer)}\n`;
}

/** The annotation of a revoked tag: the phase and the run that failed, and the time, signed when `signer` is given (#4031). */
export function revokedAnnotation(green: CiGreen, sha: string, failure: NonNullable<CommitVerdict["failure"]>, at: Date, signer?: CiTagSigner): string {
  const record: CiTagRecord = { schema: 1, tag: "revoked", commit: sha, branch: green.branch, at: iso(at), ...sourceField(green), phase: failure.phase, run: runRecord(failure.run) };
  const code = failure.run.failureCode ? `, ${failure.run.failureCode}` : "";
  return `ci: phase ${failure.phase} failed in ${failure.run.name} (${failure.run.conclusion ?? failure.run.status}${code})\n\n${recordJson(record, signer)}\n`;
}

/**
 * Decide what a tick does, without touching git: a commit with no green tag
 * whose required phases all passed gets one, and a green commit with no
 * revoked tag that now fails a required phase gets revoked. A revoked commit
 * is skipped without asking the forge.
 */
export async function planTick(input: TickPlanInput): Promise<TickCommit[]> {
  const out: TickCommit[] = [];
  for (const c of input.commits) {
    const before: TagState = input.revokedTags.has(c.sha) ? "revoked" : input.greenTags.has(c.sha) ? "green" : "none";
    if (before === "revoked") {
      const ignored = input.ignored?.get(c.sha);
      out.push({ ...c, before, made: null, ...(ignored && ignored.length > 0 ? { ignored: [...ignored] } : {}) });
      continue;
    }
    const verdict = evaluateCommit(input.green, await input.checkRuns(c.sha));
    let made: TickCommit["made"] = null;
    if (before === "none" && verdict.verdict === "pass") {
      made = { tag: `${CI_GREEN_TAG_PREFIX}${c.sha}`, message: greenAnnotation(input.green, c.sha, verdict, input.now, input.signer) };
    } else if (before === "green" && verdict.verdict === "fail") {
      made = { tag: `${CI_REVOKED_TAG_PREFIX}${c.sha}`, message: revokedAnnotation(input.green, c.sha, verdict.failure!, input.now, input.signer) };
    }
    const ignored = input.ignored?.get(c.sha);
    // A tag is never moved or deleted by chant, so an ignored tag holding the name stops the tick making it.
    const blocked = made !== null && ignored?.some((t) => t.tag === made!.tag) ? made.tag : undefined;
    out.push({ ...c, before, verdict, made: blocked ? null : made, ...(ignored && ignored.length > 0 ? { ignored: [...ignored] } : {}), ...(blocked ? { blocked } : {}) });
  }
  return out;
}

function git(top: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: top,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 256 * 1024 * 1024,
  }).trimEnd();
}

function tryGit(top: string, args: string[]): string | null {
  try {
    return git(top, args);
  } catch {
    return null;
  }
}

/** A ci tag as git holds it, before it is judged. */
interface CiTagRef {
  kind: "green" | "revoked";
  /** The commit the tag's name gives. */
  sha: string;
  tag: string;
  /** The tagger's date, or null for a lightweight tag. */
  tagged: string | null;
  /** The annotation's JSON record, when the tag is annotated and it parses. */
  record: Record<string, unknown> | null;
  /** The commit the tag points at. */
  target: string;
}

/** Every ci tag in the repository, read from local refs. */
function readCiTagRefs(top: string): CiTagRef[] {
  const out: CiTagRef[] = [];
  const format = "%(refname:lstrip=2)%00%(objecttype)%00%(objectname)%00%(*objectname)%00%(taggerdate:iso-strict)%00%(contents)%01";
  const raw = git(top, ["for-each-ref", `--format=${format}`, `refs/tags/${CI_GREEN_TAG_PREFIX}`, `refs/tags/${CI_REVOKED_TAG_PREFIX}`]);
  for (const entry of raw.split("\u0001")) {
    const [tag, type, object, peeled, date, contents] = entry.replace(/^\n/, "").split("\u0000");
    if (!tag) continue;
    const annotated = type === "tag";
    let record: CiTagRef["record"] = null;
    // A lightweight tag has no tagger date, and its "contents" are the commit's message.
    if (annotated && date && contents && contents.includes("{")) {
      try {
        const parsed = JSON.parse(contents.slice(contents.indexOf("{")));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) record = parsed as Record<string, unknown>;
      } catch {
        record = null;
      }
    }
    const green = tag.startsWith(CI_GREEN_TAG_PREFIX);
    out.push({
      kind: green ? "green" : "revoked",
      sha: tag.slice((green ? CI_GREEN_TAG_PREFIX : CI_REVOKED_TAG_PREFIX).length),
      tag,
      tagged: date || null,
      record,
      target: (annotated ? peeled : object) ?? "",
    });
  }
  return out;
}

/** A ci tag that exists and does not count (#4031), and why. */
export interface IgnoredCiTag {
  tag: string;
  /** `unsigned`, `invalid`, `untrusted` or `mismatch`, as a run statement's attestation says it. */
  status: CiTagFailure;
  reason: string;
}

/** A tag that counts, with what its annotation recorded. */
export interface CountedCiTag {
  tagged: string | null;
  /** The annotation's JSON record, when the tag is annotated and it parses. */
  record: Record<string, unknown> | null;
  /** The runner whose statement it carries, or null when it counts unsigned (#4031). */
  signer: string | null;
}

/** The ci tags as readers count them (#4031). */
export interface CiTags {
  green: Map<string, CountedCiTag>;
  revoked: Map<string, CountedCiTag>;
  /** Tags that exist and do not count, by the commit their name gives. */
  ignored: Map<string, IgnoredCiTag[]>;
}

/**
 * The commits whose tags count unsigned under `signedSince` (#4031): its
 * strict first-parent ancestors, the history the green branch had before the
 * first commit whose tags must be signed. Position in history is something a
 * committer can't set, unlike a commit's or a tag's date (ws-069 d). Throws
 * `declaration-invalid` when `signedSince` names no commit here.
 */
export function unsignedHistory(top: string, signedSince: string): Set<string> {
  if (tryGit(top, ["rev-parse", "--verify", "--quiet", `${signedSince}^{commit}`]) === null) {
    throw new WorkspaceReadError(
      "declaration-invalid",
      `ci.green.signedSince names ${signedSince}, which is not a commit in this repository; it must be the full sha of the first commit on the green branch whose tags must be signed (fetch the branch if it is newer than this clone)`,
    );
  }
  return new Set(git(top, ["rev-list", "--first-parent", `${signedSince}^@`]).split("\n").filter(Boolean));
}

/**
 * Read the ci tags and judge each one (#4031). Without `signedSince` in
 * `green` every tag counts, as before. With it, a tag on a strict
 * first-parent ancestor of `signedSince` counts unsigned, and any other tag
 * counts only when it points at the commit its name gives and its annotation
 * carries a statement a runner key at `base` signed for that commit, tag and
 * branch. The runner keys and roles are read from `.chant/trust.json` at
 * `base`, the commit the caller reads the branch at. Throws
 * `declaration-invalid` when `signedSince` names no commit here.
 */
export function readCiTags(top: string, green: CiGreen | null = null, base: string | null = null): CiTags {
  const out: CiTags = { green: new Map(), revoked: new Map(), ignored: new Map() };
  const before = green?.signedSince ? unsignedHistory(top, green.signedSince) : null;
  let policy: ReturnType<typeof readTrustPolicy> | undefined;
  const policyAtBase = () => (policy ??= base ? readTrustPolicy(gitRevisionSource(top, base), base) : emptyPolicy(null));
  for (const t of readCiTagRefs(top)) {
    const counted = (signer: string | null) => (t.kind === "green" ? out.green : out.revoked).set(t.sha, { tagged: t.tagged, record: t.record, signer });
    if (before === null) {
      counted(null);
      continue;
    }
    const ignore = (status: CiTagFailure, reason: string) => out.ignored.set(t.sha, [...(out.ignored.get(t.sha) ?? []), { tag: t.tag, status, reason }]);
    if (t.target !== t.sha) {
      ignore("mismatch", `${t.tag} points at ${t.target.slice(0, 12) || "nothing"}, not at the commit its name gives`);
      continue;
    }
    if (before.has(t.sha)) {
      counted(null);
      continue;
    }
    const p = policyAtBase();
    const v = verifyCiTagStatement(t.record, { sha: t.sha, kind: t.kind, branch: green!.branch }, p.runners, p.roles);
    if (v.status === "signed") counted(v.signer);
    else ignore(v.status, `${v.reason}; ci.green.signedSince is ${green!.signedSince}, so a tag on a commit that is not a strict first-parent ancestor of it needs one`);
  }
  return out;
}

/**
 * Whether the workspace at `cwd` requires signed runs (#4156): its
 * `ci.green.signedSince`, or null when it sets none, declares no
 * `ci.green`, or has no declaration chant can read. Signing is opt-in, so
 * only this makes `ci serve` refuse to start without a trusted runner key
 * and `ci run` and `chant run` warn about a run they leave unsigned.
 */
export function signedRunsRequired(cwd: string): string | null {
  try {
    return readDeclaration(locateWorkspace(cwd).tree).ci?.green?.signedSince ?? null;
  } catch {
    return null;
  }
}

/** The declaration's `ci.green`, read where `cwd` is, and the git top. */
export function readGreen(cwd: string): { green: CiGreen; top: string; workspace: { name: string; root: string; file: string } } {
  const located = locateWorkspace(cwd);
  const declaration = readDeclaration(located.tree);
  const green = declaration.ci?.green ?? null;
  if (!green) throw new CiGreenError("ci-green-undeclared", `${declaration.file} declares no ci.green, so chant does not know which check runs make a commit green`);
  const top = located.top ?? gitTop(cwd);
  if (!top) throw new WorkspaceReadError("not-a-git-repository", "the ci tags are git tags, and this directory is not in a git repository");
  return { green, top, workspace: { name: declaration.name, root: located.root, file: declaration.file } };
}

export interface TickRequest {
  cwd: string;
  /**
   * Where check runs come from. A function is called only when the source
   * is `checks`, so a tick from runs needs no forge token. Required for
   * `checks`.
   */
  forge?: CiForge | (() => CiForge);
  /** Where phase results come from (#4044): overrides `ci.green.source`. */
  source?: CiSource;
  /** The git remote the branch and the tags are fetched from and pushed to. Default `origin`. */
  remote?: string;
  /** Decide and report, and make and push no tag. */
  dryRun?: boolean;
  now?: Date;
  /**
   * A runner's Ed25519 private key in PEM (#4031). The tick signs each tag
   * it makes with it, and refuses a key `.chant/trust.json` at the branch tip
   * does not list as a runner whose principal holds the `runner` role. When
   * `ci.green.signedSince` is set the tick needs one.
   */
  runnerKey?: string;
}

export interface TickResult {
  branch: string;
  window: string;
  /** The ref the commits were read from. */
  ref: string;
  commits: TickCommit[];
  /** The tags made and pushed, or that would be under `dryRun`. */
  made: string[];
  /** The builds asked for (#4169), as `ci/build/<sha>` tags made and pushed, or that would be under `dryRun`. */
  requested: BuildRequest[];
  /** The failed runs asked to run again through the forge (#4169). */
  retried: { sha: string; run: string }[];
  /** The `_ci/<sha>.json` records written (#4169). Empty under `dryRun`, or when recording is off. */
  recorded: string[];
  /** What the tick could not do and carried on without: a retry, a request, a record. */
  warnings: string[];
  /** The runner the tags were signed as (#4031), or null when they carry no statement. */
  signer: string | null;
  /** Where the phase results came from (#4044). */
  source: CiSource;
}

/**
 * The signer a runner key makes (#4031): the principal `.chant/trust.json`
 * at `base` lists the key for, who must hold the `runner` role. Throws when
 * the key is not one, so a tick never makes a tag its readers would ignore.
 */
export function ciTagSigner(top: string, base: string, pem: string, what = "the tags it signed"): CiTagSigner {
  let loaded: ReturnType<typeof loadRunnerKey>;
  try {
    loaded = loadRunnerKey(pem);
  } catch (err) {
    throw new Error(`the runner key is not an Ed25519 private key in PEM: ${err instanceof Error ? err.message : String(err)}`);
  }
  const policy = readTrustPolicy(gitRevisionSource(top, base), base);
  const at = `.chant/trust.json at ${base.slice(0, 12)}`;
  if (policy.signers.some((s) => s.key === loaded.publicKey)) {
    throw new Error(`the runner key is a signer's key in ${policy.signersPath}; ci tags and runs are signed by a CI identity's key, never by a person's`);
  }
  const listed = policy.runners.find((r) => r.key === loaded.publicKey);
  if (!listed) throw new Error(`${at} lists no runner with this key, so ${what} would be ignored. Add it under "runners" first:\n  ${loaded.publicKey}`);
  const holds = (policy.roles[CI_TAG_SIGNER_ROLE] ?? []).some((p) => p.normalize("NFKC").trim().toLowerCase() === listed.principal.normalize("NFKC").trim().toLowerCase());
  if (!holds) throw new Error(`${listed.principal} holds no ${CI_TAG_SIGNER_ROLE} role in ${at}, so ${what} would be ignored. Grant it: "roles": { "${CI_TAG_SIGNER_ROLE}": ["${listed.principal}"] }`);
  return { principal: listed.principal, key: loaded.key, publicKey: loaded.publicKey };
}

/**
 * One tick: fetch the branch and the ci tags from the remote (pruning a ci
 * tag deleted there by hand), judge the first-parent commits within the
 * window, make the tags that are due and push them, never forced.
 */
export async function ciTick(req: TickRequest): Promise<TickResult> {
  const read = readGreen(req.cwd);
  const top = read.top;
  const green: CiGreen = { ...read.green, source: req.source ?? read.green.source };
  const forge = green.source === "checks" ? (typeof req.forge === "function" ? req.forge() : req.forge) : undefined;
  if (green.source === "checks" && !forge) throw new Error("ci.green.source is checks, so the tick reads check runs and needs a forge");
  const remote = req.remote ?? "origin";
  const now = req.now ?? new Date();
  const tracking = `refs/remotes/${remote}/${green.branch}`;
  try {
    git(top, ["fetch", "--quiet", "--no-tags", "--prune", remote, `+refs/heads/${green.branch}:${tracking}`, "+refs/tags/ci/*:refs/tags/ci/*"]);
  } catch (err) {
    throw new Error(`could not fetch ${green.branch} and the ci tags from ${remote}: ${stderrOf(err)}`);
  }
  if (tryGit(top, ["rev-parse", "--verify", "--quiet", `${tracking}^{commit}`]) === null) {
    throw new CiGreenError("ci-branch-unknown", `${remote} has no branch ${green.branch}`);
  }

  const cutoff = Math.floor((now.getTime() - windowMs(green.window)) / 1000);
  const commits = git(top, ["log", "--first-parent", `--max-age=${cutoff}`, "--format=%H %ct", tracking])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" "))
    .filter(([, ct]) => Number(ct) >= cutoff)
    .map(([sha, ct]) => ({ sha, committed: iso(new Date(Number(ct) * 1000)) }));

  const base = git(top, ["rev-parse", `${tracking}^{commit}`]);
  if (green.signedSince && req.runnerKey === undefined && !req.dryRun) {
    throw new Error(
      `ci.green.signedSince is ${green.signedSince}, so every tag the tick makes needs a statement signed by a runner key, and none was given: pass --key <runner key.pem> or set CHANT_RUNNER_KEY`,
    );
  }
  const signer = req.runnerKey !== undefined ? ciTagSigner(top, base, req.runnerKey) : undefined;
  const links = await commitLinks(req.cwd, top, tracking, commits.map((c) => c.sha));
  const tags = readCiTags(top, green, base);
  const warnings: string[] = [];
  let runs: OpRunSource | undefined;
  // The runs and the records (#4169) live on chant/lifecycle, which a CI checkout may not have yet.
  const fetched = await fetchLifecycleStatus({ cwd: top });
  const ledgerOk = fetched.status !== "diverged" && fetched.status !== "unreachable";
  if (!ledgerOk) {
    const why = `could not fetch chant/lifecycle from ${fetched.remote}: ${fetched.status === "diverged" ? "the local branch and the remote's have diverged" : fetched.stderr}`;
    if (green.source === "runs") throw new Error(why.replace("chant/lifecycle", "chant/lifecycle, where the Op runs are recorded,"));
    warnings.push(`${why}; no _ci records were read or written`);
  }
  if (green.source === "runs") runs = await readOpRunSource(req.cwd, top, base, green.signedSince);
  const runsBy = new Map<string, CheckRun[]>();
  const planned = await planTick({
    green,
    commits,
    greenTags: new Set(tags.green.keys()),
    revokedTags: new Set(tags.revoked.keys()),
    ignored: tags.ignored,
    checkRuns: async (sha) => {
      const got = runs ? runs.checkRuns(sha) : await forge!.checkRuns(sha);
      runsBy.set(sha, got);
      return got;
    },
    now,
    signer,
  });
  if (links) for (const c of planned) c.work = links.get(c.sha);
  if (runs) {
    for (const c of planned) {
      const ignored = runs.ignored.get(c.sha);
      if (ignored && ignored.length > 0) c.ignoredRuns = ignored;
    }
  }
  const records = ledgerOk ? readCiRecords(top) : new Map<string, CiRecord>();
  const requests = readBuildRequests(top);
  const retryVia = green.source === "runs" ? "request" : forge?.rerun ? "forge" : null;
  const builds = planBuilds({ green, commits: planned, runs: runsBy, requests, records, now, retryVia });
  const due = planned.filter((c) => c.made !== null);
  if (!req.dryRun && due.length > 0) {
    const ident = taggerConfig(top);
    for (const c of due) git(top, [...ident, "tag", "-a", "-m", c.made!.message, c.made!.tag, c.sha]);
    try {
      git(top, ["push", "--quiet", remote, ...due.map((c) => `refs/tags/${c.made!.tag}`)]);
    } catch (err) {
      // The local tags stay until the next tick's fetch prunes the ones the remote lacks.
      const stderr = stderrOf(err);
      const cause = pushRefusalCause(stderr);
      throw new Error(`could not push ${due.map((c) => c.made!.tag).join(", ")} to ${remote}: ${cause ? `${cause}\n` : ""}${stderr}`);
    }
  }
  const retried = builds.retries.map((r) => ({ sha: r.sha, run: r.run.name }));
  let recorded: string[] = [];
  if (!req.dryRun) {
    const asked = await askForBuilds({ top, remote, green, forge, builds, requests, records, planned, warnings });
    recorded = ledgerOk && !ledgerRecordingOff() ? await writeRecords({ top, green, planned, records, builds, requests: asked.live, dispatched: asked.dispatched, now, warnings }) : [];
  }
  return {
    branch: green.branch,
    window: green.window,
    ref: tracking,
    commits: planned,
    made: due.map((c) => c.made!.tag),
    requested: builds.requests,
    retried,
    recorded,
    warnings,
    signer: signer?.principal ?? null,
    source: green.source,
  };
}

/**
 * Make what the plan asks for (#4169): push each new request tag and start
 * the workflows holding its phases at it on GitHub, start any older request
 * no tick has started yet, run the failed jobs again, and delete the tags of
 * requests that are done. Each step that fails is a warning, never the
 * tick's failure: the green tags are already pushed.
 */
async function askForBuilds(input: {
  top: string;
  remote: string;
  green: CiGreen;
  forge: CiForge | undefined;
  builds: ReturnType<typeof planBuilds>;
  requests: Map<string, BuildRequest>;
  records: Map<string, CiRecord>;
  planned: TickCommit[];
  warnings: string[];
}): Promise<{ live: Map<string, BuildRequest>; dispatched: Set<string> }> {
  const { top, remote, green, forge, builds, warnings } = input;
  const live = new Map(input.requests);
  for (const tag of builds.resolved) live.delete(tag.slice(CI_BUILD_TAG_PREFIX.length));
  if (builds.requests.length > 0) {
    const ident = taggerConfig(top);
    const made: BuildRequest[] = [];
    for (const r of builds.requests) {
      if (tryGit(top, [...ident, "tag", "-a", "-m", buildRequestAnnotation(r), r.tag, r.commit]) === null) warnings.push(`could not make ${r.tag}`);
      else made.push(r);
    }
    if (made.length > 0) {
      try {
        git(top, ["push", "--quiet", remote, ...made.map((r) => `refs/tags/${r.tag}`)]);
        for (const r of made) live.set(r.commit, r);
      } catch (err) {
        for (const r of made) tryGit(top, ["tag", "-d", r.tag]);
        const stderr = stderrOf(err);
        warnings.push(`could not push ${made.map((r) => r.tag).join(", ")} to ${remote}: ${pushRefusalCause(stderr) ?? stderr}`);
      }
    }
  }
  const dispatched = new Set<string>();
  if (green.source === "checks" && forge?.dispatch) {
    const sources = readWorkflowSources(top, "");
    for (const r of live.values()) {
      if (input.records.get(r.commit)?.request?.dispatched && input.records.get(r.commit)?.request?.tag === r.tag) continue;
      // A run already going at the commit was started for it, by the tick before or by `ci run --at`.
      const c = input.planned.find((x) => x.sha === r.commit);
      if (c?.verdict?.phases.some((p) => r.phases.includes(p.phase) && p.runs.some((x) => x.status !== "completed"))) {
        dispatched.add(r.commit);
        continue;
      }
      const { dispatchable, without } = dispatchableWorkflows(green, r.phases, sources);
      for (const w of without) warnings.push(`${w} holds a run of ${r.phases.join(", ")} and has no workflow_dispatch trigger, so ${r.tag} can't start it; regenerate it with chant ci workflow`);
      let ok = dispatchable.length > 0;
      for (const w of dispatchable) {
        try {
          await forge.dispatch(w, r.tag);
        } catch (err) {
          ok = false;
          warnings.push(`could not start ${w} at ${r.tag}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (ok) dispatched.add(r.commit);
    }
  }
  if (forge?.rerun) {
    for (const r of builds.retries) {
      try {
        await forge.rerun(r.run);
      } catch (err) {
        warnings.push(`could not run ${r.run.name} at ${r.sha.slice(0, 12)} again, so its failure counts once the retry's hour is up: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (builds.resolved.length > 0) {
    for (const tag of builds.resolved) tryGit(top, ["tag", "-d", tag]);
    if (tryGit(top, ["push", "--quiet", remote, ...builds.resolved.map((t) => `:refs/tags/${t}`)]) === null) {
      warnings.push(`could not delete ${builds.resolved.join(", ")} on ${remote}; a done request asks for nothing, so they can stay`);
    }
  }
  return { live, dispatched };
}

/**
 * Write each judged commit's record, and rewrite a record whose commit left
 * the window still pending as unbuilt (#4169), in one commit on
 * `chant/lifecycle`, and push it. Only records whose content changed are
 * written. A push another writer beat is tried once more on the new tip.
 */
async function writeRecords(input: {
  top: string;
  green: CiGreen;
  planned: TickCommit[];
  records: Map<string, CiRecord>;
  builds: ReturnType<typeof planBuilds>;
  requests: Map<string, BuildRequest>;
  dispatched: Set<string>;
  now: Date;
  warnings: string[];
}): Promise<string[]> {
  const { top, green, planned, records, builds, requests, now, warnings } = input;
  const writes: { path: string; content: string }[] = [];
  const inWindow = new Set(planned.map((c) => c.sha));
  for (const c of planned) {
    const previous = records.get(c.sha);
    let record = recordOf({ green, commit: c, previous, retries: builds.retries, requests, now });
    if (record.request) {
      const started = input.dispatched.has(c.sha) || (previous?.request?.tag === record.request.tag && previous.request.dispatched === true);
      if (started) record = { ...record, request: { ...record.request, dispatched: true } };
    }
    if (!sameRecord(previous, record)) writes.push({ path: recordPath(c.sha), content: `${JSON.stringify(record, null, 2)}\n` });
  }
  for (const [sha, r] of records) {
    if (inWindow.has(sha) || r.state !== "pending") continue;
    writes.push({ path: recordPath(sha), content: `${JSON.stringify(agedOut(r, now), null, 2)}\n` });
  }
  if (writes.length === 0) return [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeLedgerFiles(writes, `ci: ${writes.length} commit record${writes.length === 1 ? "" : "s"}`, { cwd: top });
    } catch (err) {
      warnings.push(`could not write the _ci records: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
    const pushed = await pushLifecycleStatus({ cwd: top });
    if (pushed.status === "pushed" || pushed.status === "no-remote" || pushed.status === "not-recorded") return writes.map((w) => w.path);
    if (pushed.status !== "stale" || attempt === 1) {
      warnings.push(`could not push the _ci records: ${pushed.stderr}`);
      return [];
    }
    // Another writer pushed first: drop this commit, follow the remote, and write again on its tip.
    tryGit(top, ["update-ref", "refs/heads/chant/lifecycle", "refs/heads/chant/lifecycle^"]);
    const again = await fetchLifecycleStatus({ cwd: top });
    if (again.status === "diverged" || again.status === "unreachable") {
      warnings.push(`could not push the _ci records: chant/lifecycle moved on the remote and could not be fetched again`);
      return [];
    }
  }
  return [];
}

// ── A build on demand (#4169) ────────────────────────────────────────────────

export interface RequestBuildResult {
  request: BuildRequest;
  /** Whether a request tag for the commit was already there, in which case nothing was made. */
  existed: boolean;
  /** The workflows started at the tag now, on GitHub. Empty when the next tick or `ci serve` starts it. */
  dispatched: string[];
  warnings: string[];
}

/**
 * `chant ci run --at <sha>`: ask for every required phase to be built at a
 * commit of the branch, by pushing `ci/build/<sha>`. Given a forge that can
 * start workflows, and with the source check runs, it starts the workflows
 * holding the phases at the tag now; otherwise the next tick does, or `ci
 * serve --build-command` for chant runs. Once the phases pass, the tick tags
 * the commit green like any other, so it can be cut.
 */
export async function requestBuild(req: { cwd: string; at: string; remote?: string; forge?: CiForge; now?: Date }): Promise<RequestBuildResult> {
  const read = readGreen(req.cwd);
  const { green, top } = read;
  const remote = req.remote ?? "origin";
  const tracking = `refs/remotes/${remote}/${green.branch}`;
  try {
    git(top, ["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${green.branch}:${tracking}`, `+refs/tags/${CI_BUILD_TAG_PREFIX}*:refs/tags/${CI_BUILD_TAG_PREFIX}*`]);
  } catch (err) {
    throw new Error(`could not fetch ${green.branch} and the build requests from ${remote}: ${stderrOf(err)}`);
  }
  if (req.at.startsWith("-") || tryGit(top, ["rev-parse", "--verify", "--quiet", `${req.at}^{commit}`]) === null) throw new WorkspaceReadError("revision-unknown", `--at ${req.at} names no commit in this repository`);
  const sha = git(top, ["rev-parse", `${req.at}^{commit}`]);
  const onBranch = git(top, ["rev-list", "--first-parent", tracking]).split("\n").includes(sha);
  if (!onBranch) throw new Error(`${sha.slice(0, 12)} is not a first-parent commit of ${remote}/${green.branch}, and only those are judged green`);
  const existing = readBuildRequests(top).get(sha);
  const request = existing ?? requestedBuild(green, sha, green.require, req.now ?? new Date());
  const warnings: string[] = [];
  if (!existing) {
    git(top, [...taggerConfig(top), "tag", "-a", "-m", buildRequestAnnotation(request), request.tag, sha]);
    try {
      git(top, ["push", "--quiet", remote, `refs/tags/${request.tag}`]);
    } catch (err) {
      tryGit(top, ["tag", "-d", request.tag]);
      const stderr = stderrOf(err);
      throw new Error(`could not push ${request.tag} to ${remote}: ${pushRefusalCause(stderr) ?? stderr}`);
    }
  }
  const dispatched: string[] = [];
  if (green.source === "checks" && req.forge?.dispatch) {
    const { dispatchable, without } = dispatchableWorkflows(green, request.phases, readWorkflowSources(top, ""));
    for (const w of without) warnings.push(`${w} holds a run of a required phase and has no workflow_dispatch trigger, so it can't be started at ${request.tag}`);
    for (const w of dispatchable) {
      try {
        await req.forge.dispatch(w, request.tag);
        dispatched.push(w);
      } catch (err) {
        warnings.push(`could not start ${w} at ${request.tag}: ${err instanceof Error ? err.message : String(err)}; the next tick tries again`);
      }
    }
  }
  return { request, existed: existing !== undefined, dispatched, warnings };
}

// ── Chant runs as the source (#4044) ─────────────────────────────────────────

/** The Op runs on the ledger, judged, as check runs by commit. */
export interface OpRunSource {
  /** The runs on `sha` that count, each as a check run named for its Op. */
  checkRuns(sha: string): CheckRun[];
  /** The runs on each commit that do not count, by commit. */
  ignored: Map<string, IgnoredOpRun[]>;
}

const RUN_LEDGER_FILE = /^runs__(.+)\.jsonl$/;

/**
 * An Op run as a check run (#4044): `ok` passes and `fail` fails once the
 * run has settled; a run stopped at a gate or a decision point is still
 * going. The id is the run's end time in milliseconds, so the latest run of
 * an Op is its latest attempt.
 */
export function opRunCheckRun(record: OpRunRecord, signer: string | null): CheckRun {
  const settled = record.status === "ok" || record.status === "fail";
  const ended = Date.parse(record.ended);
  return {
    id: Number.isFinite(ended) ? ended : 0,
    name: record.op,
    status: settled ? "completed" : record.status,
    conclusion: settled ? (record.status === "ok" ? "success" : "failure") : null,
    completedAt: settled ? record.ended : null,
    url: record.runOrigin?.url ?? null,
    opRun: { id: record.id, env: record.env, signer, ...(signer !== null && record.statement ? { statement: record.statement } : {}) },
    ...(record.status === "fail" && record.failure ? { failureCode: record.failure.code } : {}),
  };
}

/**
 * Judge every Op run record that names a commit against `.chant/trust.json`
 * at `base` (#4044), from the run ledger the project at `cwd` writes to. A
 * record with a valid statement becomes a check run on its `gitSha` with
 * its signer, and an unsigned one becomes a check run with signer null
 * (#4156). A record whose statement does not verify is kept as an ignored
 * run. With `signedSince` (`ci.green.signedSince`) an unsigned record counts
 * only on a strict first-parent ancestor of that commit, and is ignored
 * elsewhere. Reads local refs only.
 */
export async function readOpRunSource(cwd: string, top: string, base: string, signedSince: string | null = null): Promise<OpRunSource> {
  const policy = readTrustPolicy(gitRevisionSource(top, base), base);
  const before = signedSince ? unsignedHistory(top, signedSince) : null;
  const byCommit = new Map<string, CheckRun[]>();
  const ignored = new Map<string, IgnoredOpRun[]>();
  for (const env of await listLedgerTrees({ cwd })) {
    for (const file of await listFilesInDir(env, { cwd })) {
      const op = RUN_LEDGER_FILE.exec(file)?.[1];
      if (!op) continue;
      const { records } = await readRunLedger(env, op, { cwd });
      for (const record of records) {
        if (!record.gitSha) continue;
        // #4161: a job `ci run --local` ran stays on the machine that ran it, and is never CI's verdict.
        if (record.runOrigin?.forge === "local") continue;
        const v = verifyOpRunStatement(record, policy.runners, policy.roles);
        const counts = v.status === "signed" || (v.status === "unsigned" && (before === null || before.has(record.gitSha)));
        if (counts) byCommit.set(record.gitSha, [...(byCommit.get(record.gitSha) ?? []), opRunCheckRun(record, v.status === "signed" ? v.signer : null)]);
        else {
          const reason = v.status === "unsigned" ? `${v.reason}; ci.green.signedSince is ${signedSince}, so a run on a commit that is not a strict first-parent ancestor of it needs one` : v.reason;
          ignored.set(record.gitSha, [...(ignored.get(record.gitSha) ?? []), { run: record.id, op: record.op, env: record.env, status: v.status, reason }]);
        }
      }
    }
  }
  return { checkRuns: (sha) => byCommit.get(sha) ?? [], ignored };
}

/**
 * Judge `ci.green.preMerge` on `commit` from the Op run records on the ledger
 * (#4168 4.4), as `ci serve --land` does before it moves the target. The
 * trust policy is read at `base`, the target's head. An unsigned run counts
 * as the tick counts one: always, unless `ci.green.signedSince` asks for a
 * signature. Throws {@link CiGreenError} when the declaration has no
 * `ci.green` or names no pre-merge phase.
 */
export async function judgePreMerge(req: { cwd: string; commit: string; base: string }): Promise<CommitVerdict> {
  const { green, top } = readGreen(req.cwd);
  const pre = green.preMerge ?? [];
  if (pre.length === 0) throw new CiGreenError("ci-green-undeclared", "ci.green.preMerge names no phase, so nothing says which checks must pass before the branch moves");
  const runs = await readOpRunSource(req.cwd, top, req.base, green.signedSince);
  const latest = latestAttempts(runs.checkRuns(req.commit));
  return commitVerdictOf(pre.map((name) => evaluatePhase(green.phases.find((p) => p.name === name)!, latest)));
}

/**
 * What `chant run <op> --key` signs a run's record with (#4044): the runner
 * key `.chant/trust.json` at the checkout's `HEAD` lists for a principal
 * holding the `runner` role. Throws when the key is not one, or `cwd` is in
 * no git checkout.
 */
export function opRunSigner(cwd: string, pem: string): (record: OpRunRecord) => NonNullable<OpRunRecord["statement"]> {
  const top = gitTop(cwd);
  if (!top) throw new Error("a run is signed against .chant/trust.json at HEAD, and this directory is not in a git repository");
  const head = tryGit(top, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (head === null) throw new Error("a run is signed against .chant/trust.json at HEAD, and this repository has no commit yet");
  const signer = ciTagSigner(top, head, pem, "the runs it signed");
  return (record) => signOpRunRecord(record, signer);
}

/**
 * Why the remote refused a tag push, when chant can tell. GitHub refuses a
 * new ref to a commit whose workflow files differ from the default branch's
 * unless the token may update workflows, and the Actions token never may.
 */
export function pushRefusalCause(stderr: string): string | null {
  if (!/without [`']?workflows?[`']? (permission|scope)/i.test(stderr)) return null;
  return (
    "GitHub refused the tag push because the tagged commit changes workflow files, and GITHUB_TOKEN can't update workflows: " +
    "regenerate the workflow with --token-secret <NAME>, naming a secret that holds a fine-grained token with Contents and Workflows read and write, " +
    "or with --app-id-var <VAR> --app-key-secret <NAME> for a GitHub App's token"
  );
}

/** A tagger for an annotated tag when git has none configured, as on a fresh CI runner. The environment's GIT_COMMITTER_* still win. */
function taggerConfig(top: string): string[] {
  const out: string[] = [];
  if (tryGit(top, ["config", "user.name"]) === null) out.push("-c", "user.name=chant");
  if (tryGit(top, ["config", "user.email"]) === null) out.push("-c", "user.email=chant@localhost");
  return out;
}

function stderrOf(err: unknown): string {
  const e = err as { stderr?: string | Buffer; message?: string };
  return String(e.stderr ?? e.message ?? err).trim();
}

/**
 * Whether each commit names its work item (#4029), judged against the work
 * records at `ref`. Undefined when the workspace declares no work kind or
 * they can't be read: then no commit has a link state to report.
 */
async function commitLinks(cwd: string, top: string, ref: string, shas: string[]): Promise<Map<string, CommitLink> | undefined> {
  if (shas.length === 0) return undefined;
  try {
    const index = await readWorkIndex(cwd, top, ref);
    if (!index) return undefined;
    return judgeCommits(top, shas, index, mergeCommits(top, shas));
  } catch {
    // A tag and a green list stand without the link, which only explains a commit.
    return undefined;
  }
}

/** Why a commit's work item is unknown, for the text of `ci tick` and `ci list`; undefined for a commit that names one. */
export function whyWorkUnknown(work: CommitLink | null | undefined): string | undefined {
  if (!work) return undefined;
  if (work.state === "unlinked") return "no Chant-Record or Chant-Lease trailer names a work item";
  if (work.state === "wrong") return `the work item named is not there: ${work.problems.map((p) => `${p.trailer} (${p.message})`).join("; ")}`;
  return undefined;
}

/** The text `chant ci tick` prints. */
export function formatTick(r: TickResult, dryRun = false): string {
  const lines = [`${r.branch}, commits within ${r.window}${r.source === "runs" ? ", judged from chant runs" : ""}: ${r.commits.length}`];
  for (const c of r.commits) {
    const short = c.sha.slice(0, 12);
    const before = lines.length;
    if (c.made) {
      lines.push(`  ${short}  ${dryRun ? "would make" : "made"} ${c.made.tag.slice(0, c.made.tag.lastIndexOf("/"))}${c.verdict?.failure ? `: phase ${c.verdict.failure.phase}, ${c.verdict.failure.run.name} ${c.verdict.failure.run.conclusion}` : ""}`);
    } else if (c.before === "revoked") {
      lines.push(`  ${short}  revoked`);
    } else {
      const v = c.verdict!;
      const why = (p: PhaseVerdict) => `${p.phase}${p.reason ? ` (${p.reason}${p.coveredBy ? `, covered by ${p.coveredBy.slice(0, 12)}` : ""})` : ""}`;
      const waiting = v.phases.filter((p) => p.verdict === "pending").map(why);
      const unbuilt = v.phases.filter((p) => p.verdict === "unbuilt").map(why);
      const culprit = v.phases.find((p) => p.culprit)?.culprit;
      const what =
        c.before === "green"
          ? "green"
          : v.verdict === "fail"
            ? `failed: phase ${v.failure!.phase}, ${v.failure!.run.name} ${v.failure!.run.conclusion}${culprit ? `; culprit ${culprit.slice(0, 12)}` : ""}`
            : v.verdict === "unbuilt"
              ? `unbuilt: ${unbuilt.join(", ")}`
              : `undecided: ${waiting.join(", ")}`;
      lines.push(`  ${short}  ${what}`);
    }
    const why = whyWorkUnknown(c.work);
    if (why) lines[before] += `; why unknown: ${why}`;
    for (const t of c.ignored ?? []) lines.push(`      ignored ${t.tag} (${t.status}): ${t.reason}`);
    for (const r of c.ignoredRuns ?? []) lines.push(`      ignored run ${r.run} of ${r.op} in ${r.env} (${r.status}): ${r.reason}`);
    if (c.blocked) lines.push(`      did not make ${c.blocked}: an ignored tag holds the name. Delete it to let the tick tag the commit: git push origin :refs/tags/${c.blocked}`);
  }
  if (r.signer && r.made.length > 0) lines.push(`signed as ${r.signer}`);
  for (const q of r.requested) lines.push(`${dryRun ? "would ask" : "asked"} for ${q.phases.join(", ")} at ${q.commit.slice(0, 12)} (${q.reason}): ${q.tag}`);
  for (const x of r.retried) lines.push(`${dryRun ? "would run" : "ran"} ${x.run} at ${x.sha.slice(0, 12)} again`);
  if (r.recorded.length > 0) lines.push(`recorded ${r.recorded.length} commit${r.recorded.length === 1 ? "" : "s"} on chant/lifecycle`);
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  return lines.join("\n");
}

// ── last-green ───────────────────────────────────────────────────────────────

/** The ref a reader walks: the remote-tracking branch when there is one, else the local branch. */
function branchRefOf(top: string, green: CiGreen, remote = "origin"): string {
  const candidates = [`refs/remotes/${remote}/${green.branch}`, `refs/heads/${green.branch}`];
  const ref = candidates.find((r) => tryGit(top, ["rev-parse", "--verify", "--quiet", `${r}^{commit}`]) !== null);
  if (!ref) throw new CiGreenError("ci-branch-unknown", `this repository has neither ${candidates.join(" nor ")}`);
  return ref;
}

export type LastGreenDocument =
  | {
      $schema: string;
      contract: number;
      chant: string;
      workspace: { name: string; root: string; file: string };
      branch: string;
      /** The ref walked: the remote-tracking branch when there is one, else the local branch, or the revision `from` named. */
      ref: string;
      commit: { sha: string; tag: string; tagged: string | null; committed: string } | null;
      /** Tags on the commits walked, down to the one found, that were ignored for want of a valid statement (#4031). Newest first. */
      ignored: IgnoredCiTag[];
      /** The commits walked past above the one found, newest first, each with its record (#4169). At most {@link LAST_GREEN_NEWER}. */
      newer: { sha: string; record: CiRecordSummary | null }[];
    }
  | { $schema: string; contract: number; chant: string; error: { code: CiGreenErrorCode; message: string } };

/** How many commits above the green one `ci last-green` reports with their records. */
export const LAST_GREEN_NEWER = 50;

/**
 * `chant ci last-green`: the newest first-parent commit of the branch with a
 * green tag and no revoked tag. It reads local refs and tags and never
 * fetches, so a reader fetches first (`git fetch origin --tags`).
 */
export function lastGreen(req: { cwd: string; remote?: string; from?: string }): LastGreenDocument {
  const head = { $schema: CI_LAST_GREEN_SCHEMA_ID, contract: CI_LAST_GREEN_CONTRACT_VERSION, chant: readerVersion() };
  try {
    const { green, top, workspace } = readGreen(req.cwd);
    const branchRef = branchRefOf(top, green, req.remote);
    let ref = branchRef;
    if (req.from !== undefined) {
      if (req.from.startsWith("-") || tryGit(top, ["rev-parse", "--verify", "--quiet", `${req.from}^{commit}`]) === null) {
        throw new WorkspaceReadError("revision-unknown", `--from ${req.from} names no commit in this repository`);
      }
      ref = req.from;
    }
    // The runner keys are read where the branch is, whichever commit the walk starts from.
    const tags = readCiTags(top, green, git(top, ["rev-parse", `${branchRef}^{commit}`]));
    let commit: Extract<LastGreenDocument, { branch: string }>["commit"] = null;
    const ignored: IgnoredCiTag[] = [];
    const newer: { sha: string; record: CiRecordSummary | null }[] = [];
    const records = readCiRecords(top);
    if (tags.green.size > 0 || tags.ignored.size > 0 || records.size > 0) {
      for (const sha of git(top, ["rev-list", "--first-parent", ref]).split("\n")) {
        ignored.push(...(tags.ignored.get(sha) ?? []));
        if (!tags.green.has(sha) || tags.revoked.has(sha)) {
          if (newer.length < LAST_GREEN_NEWER) newer.push({ sha, record: recordSummary(green, records.get(sha)) });
          continue;
        }
        commit = { sha, tag: `${CI_GREEN_TAG_PREFIX}${sha}`, tagged: tags.green.get(sha)!.tagged, committed: git(top, ["show", "-s", "--format=%cI", sha]) };
        break;
      }
    }
    return { ...head, workspace, branch: green.branch, ref, commit, ignored, newer: commit ? newer : [] };
  } catch (err) {
    if (err instanceof CiGreenError || err instanceof WorkspaceReadError) return { ...head, error: { code: err.code, message: err instanceof WorkspaceReadError ? err.describe() : err.message } };
    throw err;
  }
}

// ── list ─────────────────────────────────────────────────────────────────────

export const CI_LIST_CONTRACT_VERSION = 1;
export const CI_LIST_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/ci-list/v1/ci-list.schema.json";

/** A commit's state from its tags: `green`, `revoked` (a revoked tag wins), or `undecided` (no ci tag). */
export type CiCommitState = "green" | "revoked" | "undecided";

/**
 * One required phase's result on a commit. `pass` and `fail` are what a tag
 * recorded or a live read found, `pending` is a live read with runs still
 * going or not yet reported, `unbuilt` (#4169) is a live read whose runs
 * were cancelled, and `unrecorded` means no tag holds the result and the
 * forge was not asked.
 */
export type CiPhaseResult = "pass" | "fail" | "pending" | "unbuilt" | "unrecorded";

export interface CiListRun {
  name: string;
  id: number | null;
  conclusion: string | null;
  url: string | null;
  /** The Op run, when the run is a chant run (#4044): its id, env and the runner whose statement it carries. Absent for a check run. */
  opRun?: { id: string; env: string; signer: string | null };
}

export interface CiListPhase {
  phase: string;
  result: CiPhaseResult;
  runs: CiListRun[];
}

export interface CiListCommit {
  sha: string;
  /** Committer time, ISO 8601. */
  committed: string;
  state: CiCommitState;
  /**
   * The green tag's name and time, or null when the commit has none that
   * counts. `tagged` is null for a lightweight tag. `signer` is the runner
   * whose statement it carries, or null when it counts unsigned (#4031).
   */
  green: { tag: string; tagged: string | null; signer: string | null } | null;
  /** The revoked tag's name, time, the phase and run its annotation names, and its signer as for `green`. */
  revoked: { tag: string; tagged: string | null; phase: string | null; run: CiListRun | null; signer: string | null } | null;
  /** The commit's ci tags that do not count, each for want of a valid statement (#4031). Empty unless ci.green.signedSince is set. */
  ignored: IgnoredCiTag[];
  /** Each required phase in `require` order. */
  phases: CiListPhase[];
  /**
   * Whether the commit names its work item (#4029), or null when the checkout
   * is in no workspace that declares a work kind.
   */
  work: CommitLink | null;
  /** The Op runs on the commit that do not count, each for want of a valid statement (#4044). Present only when the source is chant runs. */
  ignoredRuns?: IgnoredOpRun[];
  /** What the commit's `_ci/<sha>.json` record says (#4169), or null when it has none. */
  record: CiRecordSummary | null;
}

/** A commit's record (#4169), as `ci list` and `ci last-green` show it: its state, and the first phase's reason, covering commit and culprit. */
export interface CiRecordSummary {
  state: CiRecord["state"];
  reason?: string;
  coveredBy?: string;
  culprit?: string;
}

/** The summary of a record, from its required phases in `require` order. */
export function recordSummary(green: CiGreen, r: CiRecord | undefined): CiRecordSummary | null {
  if (!r) return null;
  const phases = green.require.map((name) => r.phases[name]).filter((p) => p !== undefined);
  const first = <K extends "reason" | "coveredBy" | "culprit">(k: K) => phases.find((p) => p[k] !== undefined)?.[k];
  const reason = first("reason");
  const coveredBy = first("coveredBy");
  const culprit = first("culprit");
  return { state: r.state, ...(reason ? { reason } : {}), ...(coveredBy ? { coveredBy } : {}), ...(culprit ? { culprit } : {}) };
}

export type CiListDocument =
  | {
      $schema: string;
      contract: number;
      chant: string;
      workspace: { name: string; root: string; file: string };
      branch: string;
      ref: string;
      /** ci.green.window, or null when `since` replaced it. */
      window: string | null;
      /** The revision the walk stopped at (exclusive), when `since` was given. */
      since: string | null;
      /** ci.green.require. */
      require: string[];
      /** Newest first. */
      commits: CiListCommit[];
    }
  | { $schema: string; contract: number; chant: string; error: { code: CiGreenErrorCode; message: string } };

const asRun = (r: unknown): CiListRun | null => {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  if (typeof o.name !== "string") return null;
  const op = o.opRun as Record<string, unknown> | undefined;
  const signer = op && typeof op === "object" ? (typeof op.signer === "string" ? op.signer : op.signer === null ? null : undefined) : undefined;
  const opRun = op && typeof op === "object" && typeof op.id === "string" && typeof op.env === "string" && signer !== undefined ? { opRun: { id: op.id, env: op.env, signer } } : {};
  return { name: o.name, id: typeof o.id === "number" ? o.id : null, conclusion: typeof o.conclusion === "string" ? o.conclusion : null, url: typeof o.url === "string" ? o.url : null, ...opRun };
};

/** The revoked tag on a commit as `ci list` shows it, which the release reads of #4033 (ws-105) reuse. */
export type RevokedTagView = NonNullable<CiListCommit["revoked"]>;

/**
 * A counted revoked tag as `ci list` shows it: its name and time, the phase
 * and run its annotation names, and its signer. A tag made from chant runs
 * (#4044) names its run with `id: null` and the Op run in `opRun`.
 */
export function revokedTagView(sha: string, r: CountedCiTag): RevokedTagView {
  return { tag: `${CI_REVOKED_TAG_PREFIX}${sha}`, tagged: r.tagged, phase: typeof r.record?.phase === "string" ? r.record.phase : null, run: asRun(r.record?.run), signer: r.signer };
}

/** A judged run as `ci list` shows it. */
const listRun = (r: RunVerdict): CiListRun => ({ name: r.name, id: r.opRun ? null : r.id, conclusion: r.conclusion, url: r.url, ...(r.opRun ? { opRun: { id: r.opRun.id, env: r.opRun.env, signer: r.opRun.signer } } : {}) });

/** What the green tag's annotation recorded for a phase: its runs, all of which passed when the tag was made. */
function recordedPhase(green: CountedCiTag | undefined, phase: string): CiListPhase {
  const runs = (green?.record?.phases as Record<string, unknown> | undefined)?.[phase];
  if (!Array.isArray(runs)) return { phase, result: "unrecorded", runs: [] };
  return { phase, result: "pass", runs: runs.map(asRun).filter((r): r is CiListRun => r !== null) };
}

export interface ListRequest {
  cwd: string;
  remote?: string;
  /** Keep only the newest n commits. */
  limit?: number;
  /** Walk back to this revision, exclusive, instead of the declared window. */
  since?: string;
  /** Judge undecided commits from the forge's check runs. Without it they list as `unrecorded`. */
  forge?: CiForge;
  /**
   * Where phase results come from (#4044): overrides `ci.green.source`. With
   * `runs`, undecided commits are judged from the signed Op runs on the
   * local `chant/lifecycle`, and `forge` is refused.
   */
  source?: CiSource;
  now?: Date;
}

/**
 * `chant ci list`: the branch's first-parent commits within the window, each
 * with its state from the ci tags and each required phase's result. Tags
 * give the green and revoked results offline; only undecided commits need
 * the forge, and only when a `forge` is given. It never fetches.
 */
export async function ciList(req: ListRequest): Promise<CiListDocument> {
  const head = { $schema: CI_LIST_SCHEMA_ID, contract: CI_LIST_CONTRACT_VERSION, chant: readerVersion() };
  try {
    const { green, top, workspace } = readGreen(req.cwd);
    const ref = branchRefOf(top, green, req.remote);

    const logArgs = ["log", "--first-parent", "--format=%H %ct"];
    let cutoff = 0;
    if (req.since !== undefined) {
      if (tryGit(top, ["rev-parse", "--verify", "--quiet", `${req.since}^{commit}`]) === null) throw new WorkspaceReadError("revision-unknown", `--since ${req.since} names no commit in this repository`);
      logArgs.push(`${req.since}..${ref}`);
    } else {
      cutoff = Math.floor(((req.now ?? new Date()).getTime() - windowMs(green.window)) / 1000);
      logArgs.push(`--max-age=${cutoff}`, ref);
    }
    let commits = git(top, logArgs)
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" "))
      .filter(([, ct]) => Number(ct) >= cutoff)
      .map(([sha, ct]) => ({ sha, committed: iso(new Date(Number(ct) * 1000)) }));
    if (req.limit !== undefined) commits = commits.slice(0, req.limit);

    const links = await commitLinks(req.cwd, top, ref, commits.map((c) => c.sha));
    const base = git(top, ["rev-parse", `${ref}^{commit}`]);
    const tags = readCiTags(top, green, base);
    const source = req.source ?? green.source;
    if (source === "runs" && req.forge) throw new Error("--forge reads check runs, and the source is chant runs (ci.green.source or --source runs); drop one");
    const runs = source === "runs" ? await readOpRunSource(req.cwd, top, base, green.signedSince) : undefined;
    const records = readCiRecords(top);
    const out: CiListCommit[] = [];
    for (const c of commits) {
      const g = tags.green.get(c.sha);
      const r = tags.revoked.get(c.sha);
      const state: CiCommitState = r ? "revoked" : g ? "green" : "undecided";
      let phases = green.require.map((name) => recordedPhase(g, name));
      let revoked: CiListCommit["revoked"] = null;
      if (r) {
        revoked = revokedTagView(c.sha, r);
        const { phase, run } = revoked;
        phases = phases.map((p) => (p.phase === phase ? { phase: p.phase, result: "fail", runs: run ? [run] : [] } : p));
      } else if (!g && (runs || req.forge)) {
        const verdict = evaluateCommit(green, runs ? runs.checkRuns(c.sha) : await req.forge!.checkRuns(c.sha));
        phases = verdict.phases.map((p) => ({ phase: p.phase, result: p.verdict, runs: p.runs.map(listRun) }));
      }
      out.push({
        ...c,
        state,
        green: g ? { tag: `${CI_GREEN_TAG_PREFIX}${c.sha}`, tagged: g.tagged, signer: g.signer } : null,
        revoked,
        phases,
        work: links?.get(c.sha) ?? null,
        ignored: tags.ignored.get(c.sha) ?? [],
        ...(runs ? { ignoredRuns: runs.ignored.get(c.sha) ?? [] } : {}),
        record: recordSummary(green, records.get(c.sha)),
      });
    }
    return { ...head, workspace, branch: green.branch, ref, window: req.since === undefined ? green.window : null, since: req.since ?? null, require: [...green.require], commits: out };
  } catch (err) {
    if (err instanceof CiGreenError || err instanceof WorkspaceReadError) return { ...head, error: { code: err.code, message: err instanceof WorkspaceReadError ? err.describe() : err.message } };
    throw err;
  }
}

/** A record summary in words, for `ci list` and the tick. */
export function describeRecord(r: CiRecordSummary): string {
  const parts = [r.state, ...(r.reason ? [r.reason] : []), ...(r.coveredBy ? [`covered by ${r.coveredBy.slice(0, 12)}`] : []), ...(r.culprit ? [`culprit ${r.culprit.slice(0, 12)}`] : [])];
  return parts.join(", ");
}

/** The text `chant ci list` prints: one line per commit. */
export function formatList(doc: Extract<CiListDocument, { branch: string }>): string {
  const lines = [`${doc.branch}, ${doc.since ? `commits after ${doc.since}` : `commits within ${doc.window}`}: ${doc.commits.length}`];
  for (const c of doc.commits) {
    const phases = c.phases.map((p) => `${p.phase}=${p.result}`).join(" ");
    const why = whyWorkUnknown(c.work);
    lines.push(`  ${c.sha.slice(0, 12)}  ${c.state.padEnd(9)}  ${phases}${why ? `; why unknown: ${why}` : ""}`);
    if (c.record && c.state === "undecided") lines.push(`      recorded ${describeRecord(c.record)}`);
    for (const t of c.ignored) lines.push(`      ignored ${t.tag} (${t.status}): ${t.reason}`);
    for (const r of c.ignoredRuns ?? []) lines.push(`      ignored run ${r.run} of ${r.op} in ${r.env} (${r.status}): ${r.reason}`);
  }
  return lines.join("\n");
}
