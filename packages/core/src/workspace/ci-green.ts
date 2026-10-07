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
 */

import { execFileSync } from "node:child_process";
import { readDeclaration, readerVersion, WORKSPACE_ERROR_CODES, WorkspaceReadError, type CiGreen, type CiPhase } from "./declaration";
import type { CheckRun, CiForge } from "./ci-green-forge";
import type { ReasonCode } from "./reason-codes";
import { gitTop } from "./tree";
import { locateWorkspace } from "./which-chant";

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
}

export interface TickPlanInput {
  green: CiGreen;
  commits: readonly { sha: string; committed: string }[];
  greenTags: ReadonlySet<string>;
  revokedTags: ReadonlySet<string>;
  checkRuns(sha: string): Promise<CheckRun[]>;
  now: Date;
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

/** The annotation of a green tag: a subject line, then the record as JSON. */
export function greenAnnotation(green: CiGreen, sha: string, verdict: CommitVerdict, at: Date): string {
  const record = {
    schema: 1,
    tag: "green",
    commit: sha,
    branch: green.branch,
    at: iso(at),
    phases: Object.fromEntries(verdict.phases.map((p) => [p.phase, p.runs.map(runRecord)])),
  };
  return `ci: every required phase passed (${green.require.join(", ")})\n\n${JSON.stringify(record, null, 2)}\n`;
}

/** The annotation of a revoked tag: the phase and the run that failed, and the time. */
export function revokedAnnotation(green: CiGreen, sha: string, failure: NonNullable<CommitVerdict["failure"]>, at: Date): string {
  const record = { schema: 1, tag: "revoked", commit: sha, branch: green.branch, at: iso(at), phase: failure.phase, run: runRecord(failure.run) };
  return `ci: phase ${failure.phase} failed in ${failure.run.name} (${failure.run.conclusion ?? failure.run.status})\n\n${JSON.stringify(record, null, 2)}\n`;
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
      out.push({ ...c, before, made: null });
      continue;
    }
    const verdict = evaluateCommit(input.green, await input.checkRuns(c.sha));
    let made: TickCommit["made"] = null;
    if (before === "none" && verdict.verdict === "pass") {
      made = { tag: `${CI_GREEN_TAG_PREFIX}${c.sha}`, message: greenAnnotation(input.green, c.sha, verdict, input.now) };
    } else if (before === "green" && verdict.verdict === "fail") {
      made = { tag: `${CI_REVOKED_TAG_PREFIX}${c.sha}`, message: revokedAnnotation(input.green, c.sha, verdict.failure!, input.now) };
    }
    out.push({ ...c, before, verdict, made });
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

/** The ci tags in the repository: the commits with a green tag, and those with a revoked one. */
export function readCiTags(top: string): { green: Map<string, string>; revoked: Set<string> } {
  const green = new Map<string, string>();
  const revoked = new Set<string>();
  const lines = git(top, ["for-each-ref", "--format=%(refname:lstrip=2)%09%(taggerdate:iso-strict)", `refs/tags/${CI_GREEN_TAG_PREFIX}`, `refs/tags/${CI_REVOKED_TAG_PREFIX}`]);
  for (const line of lines.split("\n").filter(Boolean)) {
    const [tag, date] = line.split("\t");
    if (tag.startsWith(CI_GREEN_TAG_PREFIX)) green.set(tag.slice(CI_GREEN_TAG_PREFIX.length), date ?? "");
    else revoked.add(tag.slice(CI_REVOKED_TAG_PREFIX.length));
  }
  return { green, revoked };
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
}

export interface TickResult {
  branch: string;
  window: string;
  /** The ref the commits were read from. */
  ref: string;
  commits: TickCommit[];
  /** The tags made and pushed, or that would be under `dryRun`. */
  made: string[];
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

  const tags = readCiTags(top);
  const planned = await planTick({
    green,
    commits,
    greenTags: new Set(tags.green.keys()),
    revokedTags: tags.revoked,
    checkRuns: (sha) => req.forge.checkRuns(sha),
    now,
  });
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
  return { branch: green.branch, window: green.window, ref: tracking, commits: planned, made: due.map((c) => c.made!.tag) };
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

/** The text `chant ci tick` prints. */
export function formatTick(r: TickResult, dryRun = false): string {
  const lines = [`${r.branch}, commits within ${r.window}: ${r.commits.length}`];
  for (const c of r.commits) {
    const short = c.sha.slice(0, 12);
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
  }
  return lines.join("\n");
}

// ── last-green ───────────────────────────────────────────────────────────────

export type LastGreenDocument =
  | {
      $schema: string;
      contract: number;
      chant: string;
      workspace: { name: string; root: string; file: string };
      branch: string;
      /** The ref walked: the remote-tracking branch when there is one, else the local branch. */
      ref: string;
      commit: { sha: string; tag: string; tagged: string | null; committed: string } | null;
    }
  | { $schema: string; contract: number; chant: string; error: { code: CiGreenErrorCode; message: string } };

/**
 * `chant ci last-green`: the newest first-parent commit of the branch with a
 * green tag and no revoked tag. It reads local refs and tags and never
 * fetches, so a reader fetches first (`git fetch origin --tags`).
 */
export function lastGreen(req: { cwd: string; remote?: string }): LastGreenDocument {
  const head = { $schema: CI_LAST_GREEN_SCHEMA_ID, contract: CI_LAST_GREEN_CONTRACT_VERSION, chant: readerVersion() };
  try {
    const { green, top, workspace } = readGreen(req.cwd);
    const candidates = [`refs/remotes/${req.remote ?? "origin"}/${green.branch}`, `refs/heads/${green.branch}`];
    const ref = candidates.find((r) => tryGit(top, ["rev-parse", "--verify", "--quiet", `${r}^{commit}`]) !== null);
    if (!ref) throw new CiGreenError("ci-branch-unknown", `this repository has neither ${candidates.join(" nor ")}`);
    const tags = readCiTags(top);
    let commit: Extract<LastGreenDocument, { branch: string }>["commit"] = null;
    if (tags.green.size > 0) {
      for (const sha of git(top, ["rev-list", "--first-parent", ref]).split("\n")) {
        if (!tags.green.has(sha) || tags.revoked.has(sha)) continue;
        commit = { sha, tag: `${CI_GREEN_TAG_PREFIX}${sha}`, tagged: tags.green.get(sha) || null, committed: git(top, ["show", "-s", "--format=%cI", sha]) };
        break;
      }
    }
    return { ...head, workspace, branch: green.branch, ref, commit };
  } catch (err) {
    if (err instanceof CiGreenError || err instanceof WorkspaceReadError) return { ...head, error: { code: err.code, message: err instanceof WorkspaceReadError ? err.describe() : err.message } };
    throw err;
  }
}
