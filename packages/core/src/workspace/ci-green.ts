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
 * Signed tags (#4031): when `ci.green.signedSince` is set, a tag on a commit
 * committed at or after that time counts only when its annotation carries a
 * statement signed by a runner key (`./trust/ci-tag-statement.ts`). Every
 * reader here, and the release cut, ignores a tag without a valid one and
 * reports it. A tick given a runner key signs the tags it makes. Without
 * `signedSince` every tag counts, as before.
 */

import { judgeCommits, mergeCommits, readWorkIndex, type CommitLink } from "./commit-links";
import { execFileSync } from "node:child_process";
import { readDeclaration, readerVersion, WORKSPACE_ERROR_CODES, WorkspaceReadError, type CiGreen, type CiPhase } from "./declaration";
import type { CheckRun, CiForge } from "./ci-green-forge";
import type { ReasonCode } from "./reason-codes";
import { gitTop } from "./tree";
import { locateWorkspace } from "./which-chant";
import { gitRevisionSource } from "./record-source";
import { emptyPolicy, readTrustPolicy } from "./trust/policy";
import { loadRunnerKey } from "./trust/dsse";
import { signCiTagRecord, verifyCiTagStatement, CI_TAG_SIGNER_ROLE, type CiTagFailure, type CiTagRecord, type CiTagSigner } from "./trust/ci-tag-statement";

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

export type Verdict = "pass" | "fail" | "pending";

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
}

export interface PhaseVerdict {
  phase: string;
  verdict: Verdict;
  /** The latest attempt of every run the phase's patterns match, by name. */
  runs: RunVerdict[];
  /** Patterns no check run matches yet, which leave the phase undecided. */
  unmatched: string[];
}

function runVerdict(phase: CiPhase, r: CheckRun): Verdict {
  if (r.status !== "completed") return "pending";
  if (r.conclusion === "success") return "pass";
  if (r.conclusion === "skipped") return phase.skipped === "pass" ? "pass" : "fail";
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
      runs.push({ name: r.name, id: r.id, status: r.status, conclusion: r.conclusion, url: r.url, verdict: runVerdict(phase, r) });
    }
  }
  const verdict: Verdict = runs.some((r) => r.verdict === "fail")
    ? "fail"
    : runs.some((r) => r.verdict === "pending") || unmatched.length > 0
      ? "pending"
      : "pass";
  return { phase: phase.name, verdict, runs, unmatched };
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
  const phases = green.require.map((name) => evaluatePhase(green.phases.find((p) => p.name === name)!, latest));
  const failed = phases.find((p) => p.verdict === "fail");
  if (failed) return { verdict: "fail", phases, failure: { phase: failed.phase, run: failed.runs.find((r) => r.verdict === "fail")! } };
  return { verdict: phases.some((p) => p.verdict === "pending") ? "pending" : "pass", phases, failure: null };
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

const runRecord = (r: RunVerdict) => ({ name: r.name, id: r.id, conclusion: r.conclusion, url: r.url });

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
    phases: Object.fromEntries(verdict.phases.map((p) => [p.phase, p.runs.map(runRecord)])),
  };
  return `ci: every required phase passed (${green.require.join(", ")})\n\n${recordJson(record, signer)}\n`;
}

/** The annotation of a revoked tag: the phase and the run that failed, and the time, signed when `signer` is given (#4031). */
export function revokedAnnotation(green: CiGreen, sha: string, failure: NonNullable<CommitVerdict["failure"]>, at: Date, signer?: CiTagSigner): string {
  const record: CiTagRecord = { schema: 1, tag: "revoked", commit: sha, branch: green.branch, at: iso(at), phase: failure.phase, run: runRecord(failure.run) };
  return `ci: phase ${failure.phase} failed in ${failure.run.name} (${failure.run.conclusion ?? failure.run.status})\n\n${recordJson(record, signer)}\n`;
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
  /** That commit's committer time, in seconds, or null when git can't say. */
  committed: number | null;
}

/** Every ci tag in the repository, read from local refs. */
function readCiTagRefs(top: string): CiTagRef[] {
  const out: CiTagRef[] = [];
  const format = "%(refname:lstrip=2)%00%(objecttype)%00%(objectname)%00%(*objectname)%00%(taggerdate:iso-strict)%00%(committerdate:unix)%00%(*committerdate:unix)%00%(contents)%01";
  const raw = git(top, ["for-each-ref", `--format=${format}`, `refs/tags/${CI_GREEN_TAG_PREFIX}`, `refs/tags/${CI_REVOKED_TAG_PREFIX}`]);
  for (const entry of raw.split("\u0001")) {
    const [tag, type, object, peeled, date, ct, peeledCt, contents] = entry.replace(/^\n/, "").split("\u0000");
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
    const seconds = Number(annotated ? peeledCt : ct);
    out.push({
      kind: green ? "green" : "revoked",
      sha: tag.slice((green ? CI_GREEN_TAG_PREFIX : CI_REVOKED_TAG_PREFIX).length),
      tag,
      tagged: date || null,
      record,
      target: (annotated ? peeled : object) ?? "",
      committed: (annotated ? peeledCt : ct) && Number.isFinite(seconds) ? seconds : null,
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
 * Read the ci tags and judge each one (#4031). Without `signedSince` in
 * `green` every tag counts, as before. With it, a tag on a commit committed
 * before `signedSince` counts unsigned, and any other tag counts only when it
 * points at the commit its name gives and its annotation carries a statement
 * a runner key at `base` signed for that commit, tag and branch. The runner
 * keys and roles are read from `.chant/trust.json` at `base`, the commit the
 * caller reads the branch at.
 */
export function readCiTags(top: string, green: CiGreen | null = null, base: string | null = null): CiTags {
  const out: CiTags = { green: new Map(), revoked: new Map(), ignored: new Map() };
  const since = green?.signedSince ? Date.parse(green.signedSince) / 1000 : null;
  let policy: ReturnType<typeof readTrustPolicy> | undefined;
  const policyAtBase = () => (policy ??= base ? readTrustPolicy(gitRevisionSource(top, base), base) : emptyPolicy(null));
  for (const t of readCiTagRefs(top)) {
    const counted = (signer: string | null) => (t.kind === "green" ? out.green : out.revoked).set(t.sha, { tagged: t.tagged, record: t.record, signer });
    if (since === null) {
      counted(null);
      continue;
    }
    const ignore = (status: CiTagFailure, reason: string) => out.ignored.set(t.sha, [...(out.ignored.get(t.sha) ?? []), { tag: t.tag, status, reason }]);
    if (t.target !== t.sha) {
      ignore("mismatch", `${t.tag} points at ${t.target.slice(0, 12) || "nothing"}, not at the commit its name gives`);
      continue;
    }
    if (t.committed !== null && t.committed < since) {
      counted(null);
      continue;
    }
    const p = policyAtBase();
    const v = verifyCiTagStatement(t.record, { sha: t.sha, kind: t.kind, branch: green!.branch }, p.runners, p.roles);
    if (v.status === "signed") counted(v.signer);
    else ignore(v.status, `${v.reason}; ci.green.signedSince is ${green!.signedSince}, so a tag on a commit made since needs one`);
  }
  return out;
}

/** The declaration's `ci.green`, read where `cwd` is, and the git top. */
function readGreen(cwd: string): { green: CiGreen; top: string; workspace: { name: string; root: string; file: string } } {
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
  forge: CiForge;
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
  /** The runner the tags were signed as (#4031), or null when they carry no statement. */
  signer: string | null;
}

/**
 * The signer a runner key makes (#4031): the principal `.chant/trust.json`
 * at `base` lists the key for, who must hold the `runner` role. Throws when
 * the key is not one, so a tick never makes a tag its readers would ignore.
 */
export function ciTagSigner(top: string, base: string, pem: string): CiTagSigner {
  let loaded: ReturnType<typeof loadRunnerKey>;
  try {
    loaded = loadRunnerKey(pem);
  } catch (err) {
    throw new Error(`the runner key is not an Ed25519 private key in PEM: ${err instanceof Error ? err.message : String(err)}`);
  }
  const policy = readTrustPolicy(gitRevisionSource(top, base), base);
  const at = `.chant/trust.json at ${base.slice(0, 12)}`;
  if (policy.signers.some((s) => s.key === loaded.publicKey)) {
    throw new Error(`the runner key is a signer's key in ${policy.signersPath}; ci tags are signed by a CI identity's key, never by a person's`);
  }
  const listed = policy.runners.find((r) => r.key === loaded.publicKey);
  if (!listed) throw new Error(`${at} lists no runner with this key, so the tags it signed would be ignored. Add it under "runners" first:\n  ${loaded.publicKey}`);
  const holds = (policy.roles[CI_TAG_SIGNER_ROLE] ?? []).some((p) => p.normalize("NFKC").trim().toLowerCase() === listed.principal.normalize("NFKC").trim().toLowerCase());
  if (!holds) throw new Error(`${listed.principal} holds no ${CI_TAG_SIGNER_ROLE} role in ${at}, so the tags it signed would be ignored. Grant it: "roles": { "${CI_TAG_SIGNER_ROLE}": ["${listed.principal}"] }`);
  return { principal: listed.principal, key: loaded.key, publicKey: loaded.publicKey };
}

/**
 * One tick: fetch the branch and the ci tags from the remote (pruning a ci
 * tag deleted there by hand), judge the first-parent commits within the
 * window, make the tags that are due and push them, never forced.
 */
export async function ciTick(req: TickRequest): Promise<TickResult> {
  const { green, top } = readGreen(req.cwd);
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
  const planned = await planTick({
    green,
    commits,
    greenTags: new Set(tags.green.keys()),
    revokedTags: new Set(tags.revoked.keys()),
    ignored: tags.ignored,
    checkRuns: (sha) => req.forge.checkRuns(sha),
    now,
    signer,
  });
  if (links) for (const c of planned) c.work = links.get(c.sha);
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
  return { branch: green.branch, window: green.window, ref: tracking, commits: planned, made: due.map((c) => c.made!.tag), signer: signer?.principal ?? null };
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
  const lines = [`${r.branch}, commits within ${r.window}: ${r.commits.length}`];
  for (const c of r.commits) {
    const short = c.sha.slice(0, 12);
    const before = lines.length;
    if (c.made) {
      lines.push(`  ${short}  ${dryRun ? "would make" : "made"} ${c.made.tag.slice(0, c.made.tag.lastIndexOf("/"))}${c.verdict?.failure ? `: phase ${c.verdict.failure.phase}, ${c.verdict.failure.run.name} ${c.verdict.failure.run.conclusion}` : ""}`);
    } else if (c.before === "revoked") {
      lines.push(`  ${short}  revoked`);
    } else {
      const v = c.verdict!;
      const waiting = v.phases.filter((p) => p.verdict === "pending").map((p) => p.phase);
      const what = c.before === "green" ? "green" : v.verdict === "fail" ? `failed: phase ${v.failure!.phase}, ${v.failure!.run.name} ${v.failure!.run.conclusion}` : `undecided: ${waiting.join(", ")}`;
      lines.push(`  ${short}  ${what}`);
    }
    const why = whyWorkUnknown(c.work);
    if (why) lines[before] += `; why unknown: ${why}`;
    for (const t of c.ignored ?? []) lines.push(`      ignored ${t.tag} (${t.status}): ${t.reason}`);
    if (c.blocked) lines.push(`      did not make ${c.blocked}: an ignored tag holds the name. Delete it to let the tick tag the commit: git push origin :refs/tags/${c.blocked}`);
  }
  if (r.signer && r.made.length > 0) lines.push(`signed as ${r.signer}`);
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
    }
  | { $schema: string; contract: number; chant: string; error: { code: CiGreenErrorCode; message: string } };

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
    if (tags.green.size > 0 || tags.ignored.size > 0) {
      for (const sha of git(top, ["rev-list", "--first-parent", ref]).split("\n")) {
        ignored.push(...(tags.ignored.get(sha) ?? []));
        if (!tags.green.has(sha) || tags.revoked.has(sha)) continue;
        commit = { sha, tag: `${CI_GREEN_TAG_PREFIX}${sha}`, tagged: tags.green.get(sha)!.tagged, committed: git(top, ["show", "-s", "--format=%cI", sha]) };
        break;
      }
    }
    return { ...head, workspace, branch: green.branch, ref, commit, ignored };
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
 * going or not yet reported, and `unrecorded` means no tag holds the result
 * and the forge was not asked.
 */
export type CiPhaseResult = "pass" | "fail" | "pending" | "unrecorded";

export interface CiListRun {
  name: string;
  id: number | null;
  conclusion: string | null;
  url: string | null;
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
  return { name: o.name, id: typeof o.id === "number" ? o.id : null, conclusion: typeof o.conclusion === "string" ? o.conclusion : null, url: typeof o.url === "string" ? o.url : null };
};

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
    const tags = readCiTags(top, green, git(top, ["rev-parse", `${ref}^{commit}`]));
    const out: CiListCommit[] = [];
    for (const c of commits) {
      const g = tags.green.get(c.sha);
      const r = tags.revoked.get(c.sha);
      const state: CiCommitState = r ? "revoked" : g ? "green" : "undecided";
      let phases = green.require.map((name) => recordedPhase(g, name));
      let revoked: CiListCommit["revoked"] = null;
      if (r) {
        const phase = typeof r.record?.phase === "string" ? r.record.phase : null;
        const run = asRun(r.record?.run);
        revoked = { tag: `${CI_REVOKED_TAG_PREFIX}${c.sha}`, tagged: r.tagged, phase, run, signer: r.signer };
        phases = phases.map((p) => (p.phase === phase ? { phase: p.phase, result: "fail", runs: run ? [run] : [] } : p));
      } else if (!g && req.forge) {
        const verdict = evaluateCommit(green, await req.forge.checkRuns(c.sha));
        phases = verdict.phases.map((p) => ({ phase: p.phase, result: p.verdict, runs: p.runs.map(({ name, id, conclusion, url }) => ({ name, id, conclusion, url })) }));
      }
      out.push({
        ...c,
        state,
        green: g ? { tag: `${CI_GREEN_TAG_PREFIX}${c.sha}`, tagged: g.tagged, signer: g.signer } : null,
        revoked,
        phases,
        work: links?.get(c.sha) ?? null,
        ignored: tags.ignored.get(c.sha) ?? [],
      });
    }
    return { ...head, workspace, branch: green.branch, ref, window: req.since === undefined ? green.window : null, since: req.since ?? null, require: [...green.require], commits: out };
  } catch (err) {
    if (err instanceof CiGreenError || err instanceof WorkspaceReadError) return { ...head, error: { code: err.code, message: err instanceof WorkspaceReadError ? err.describe() : err.message } };
    throw err;
  }
}

/** The text `chant ci list` prints: one line per commit. */
export function formatList(doc: Extract<CiListDocument, { branch: string }>): string {
  const lines = [`${doc.branch}, ${doc.since ? `commits after ${doc.since}` : `commits within ${doc.window}`}: ${doc.commits.length}`];
  for (const c of doc.commits) {
    const phases = c.phases.map((p) => `${p.phase}=${p.result}`).join(" ");
    const why = whyWorkUnknown(c.work);
    lines.push(`  ${c.sha.slice(0, 12)}  ${c.state.padEnd(9)}  ${phases}${why ? `; why unknown: ${why}` : ""}`);
    for (const t of c.ignored) lines.push(`      ignored ${t.tag} (${t.status}): ${t.reason}`);
  }
  return lines.join("\n");
}
