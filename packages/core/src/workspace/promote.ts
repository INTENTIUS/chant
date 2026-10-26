/**
 * `chant workspace promote <member>` (#3178): move one member one rung up the
 * kind ladder, `other` or `terraform`, then `choudoufu`, then `chant`.
 *
 * The change is staged the way `workspace upgrade` stages one (#2550): in a
 * git worktree at HEAD, so the tree is never touched until the gate passes.
 * The gate is `workspace-promote/<member>` on the gate ledger and binds the
 * digest of the patch the staging produced. The first run records a pending
 * fact and exits 3. After `chant approve workspace-promote <member>`, the same
 * command stages again, finds the approval for the same digest, applies the
 * patch, and runs the rung's follow-up (for `choudoufu`, stamping the
 * ownership markers with `live-import -approve`).
 *
 * Rungs:
 *
 * - `terraform` to `choudoufu`: `choudoufu init -backend=false` installs the
 *   providers in the staging worktree, which has no `.terraform/` of its own
 *   (#4461: `live-import` reads each resource through its provider), then
 *   `choudoufu live-check` in the member's
 *   directory must pass, then `choudoufu live-import -state=<--state>
 *   -estate=<member>` prints its ratification report (read-only: it stamps
 *   nothing without `-approve`). The patch changes the member's kind. The
 *   report, one entry per resource with its status, rides on `--json` as
 *   `adoption` (INTENTIUS/behold#999, ./adoption-report.ts), so
 *   `--dry-run --json` is the read-only way to ask what adopting would claim.
 * - `choudoufu` or `other` to `chant`: `chant import` writes TypeScript into
 *   the member's directory. The patch holds those files and the kind change.
 *
 * The digest covers the member, the rung, what the staging changed outside
 * the declaration, and (for `choudoufu`) the digest of the `live-import`
 * report, so an approval is for the report the approver read. The kind change
 * itself is written into the tree's declaration on apply rather than carried
 * as a hunk, so promoting one member never conflicts with another member's
 * uncommitted promotion (#4461: `--all` promotes a workspace in waves, see
 * `./promote-waves.ts`).
 *
 * When `live-import -approve` fails after the kind change is written, the
 * promote leaves a stamp record under `.chant/workspace-promote/` (#4485). A
 * re-run finds the member already of kind `choudoufu` and the record, and
 * retries the stamp ({@link retryPendingStamp}) rather than reporting it
 * promoted or starting the next rung. The record goes once a stamp passes.
 *
 * Commands run through an injectable runner, so a test never starts a binary.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { formatError, formatInfo, formatSuccess, formatWarning } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { contentDigest } from "../content-digest";
import { computePlanDigest } from "../lifecycle/plan-digest";
import { LIFECYCLE_LOCAL_NOTE, isLifecycleLocalNote } from "../lifecycle/local-note";
import { approveCommand, describeGateMismatch, evaluateGate, gateIsSealed, gitGateLedgerPort, type GateLedgerPort } from "../op/gate";
import { WORKSPACE_PROMOTE_GATE_OP } from "../op/gate-name";
import { parseLiveImportReport, type AdoptionReport } from "./adoption-report";
import { DECLARATION_FILES, readDeclaration } from "./declaration";
import { setProperty } from "./json-edit";
import { workingTree } from "./tree";

export const PROMOTE_PLAN_KIND = "workspace-promote";
export const PROMOTE_GATED_EXIT = 3;
const USAGE = [
  "chant workspace promote <member> [--state <terraform.tfstate>] [--lexicon <lexicon>] [--dry-run] [--output <patch file>] [--json]",
  "chant workspace promote --all [--state-dir <dir>] [--state <member>=<terraform.tfstate>]... [--canary <member>] [--wave-size <n>] [--dry-run] [--json]",
].join("\n");

export class PromoteError extends Error {}

/** The ladder, lowest rung first. `other` and `terraform` share the bottom rung. */
export const LADDER = ["terraform", "choudoufu", "chant"] as const;

export interface Rung {
  from: string;
  to: "choudoufu" | "chant";
}

/** The next rung for a member of `kind`, or undefined at the top or off the ladder. */
export function nextRung(kind: string): Rung | undefined {
  if (kind === "terraform") return { from: kind, to: "choudoufu" };
  if (kind === "choudoufu" || kind === "other") return { from: kind, to: "chant" };
  return undefined;
}

export interface CommandRun {
  label: string;
  argv: string[];
  /** Directory relative to the project root. */
  cwd: string;
  /** The `live-import` ratification report: its output is digested into the gate. */
  report?: boolean;
}
export type PromoteRunner = (argv: string[], cwd: string) => Promise<{ exitCode: number; output: string }>;

export const spawnRunner: PromoteRunner = (argv, cwd) =>
  new Promise((done) => {
    const [bin, ...rest] = argv;
    const child = spawn(bin, rest, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const out: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => out.push(c));
    child.on("error", (e) => done({ exitCode: 127, output: String(e.message) }));
    child.on("close", (code) => done({ exitCode: code ?? 1, output: Buffer.concat(out).toString("utf-8") }));
  });

/** The commands the rung runs in the staging worktree. */
export function stagingRuns(rung: Rung, member: { name: string; dir: string }, opts: { state?: string; lexicon?: string }): CommandRun[] {
  if (rung.to === "choudoufu") {
    if (!opts.state) throw new PromoteError(`promoting ${member.name} to choudoufu reads its state for the adoption report: pass --state <terraform.tfstate>`);
    return [
      { label: "choudoufu init", argv: ["choudoufu", "init", "-input=false", "-backend=false", "-no-color"], cwd: member.dir },
      { label: "choudoufu live-check", argv: ["choudoufu", "live-check"], cwd: member.dir },
      { label: "choudoufu live-import (report)", argv: ["choudoufu", "live-import", `-state=${opts.state}`, `-estate=${member.name}`], cwd: member.dir, report: true },
    ];
  }
  const lexicon = opts.lexicon ?? (rung.from === "choudoufu" ? "terraform" : undefined);
  if (!lexicon) throw new PromoteError(`promoting ${member.name} (kind other) to chant needs --lexicon <lexicon>: what chant import should read it as`);
  return [{ label: "chant import", argv: ["chant", "import", ".", "--lexicon", lexicon, "--output", "src/"], cwd: member.dir }];
}

/** After the approved patch is applied: stamping ownership markers on the live resources. */
export function followUpRuns(rung: Rung, member: { name: string; dir: string }, opts: { state?: string }): CommandRun[] {
  if (rung.to !== "choudoufu") return [];
  return [{ label: "choudoufu live-import -approve", argv: ["choudoufu", "live-import", `-state=${opts.state}`, `-estate=${member.name}`, "-approve"], cwd: member.dir }];
}

/** Where a promote keeps what a re-run needs, relative to the project root. */
export const PROMOTE_RECORD_DIR = ".chant/workspace-promote";
export const PENDING_STAMP_SCHEMA = "chant-workspace-promote-stamp/v1";

/** A stamp the kind change was written for and that did not pass (#4485). */
export interface PendingStamp {
  schema: typeof PENDING_STAMP_SCHEMA;
  member: string;
  /** The member's directory, relative to the project root. */
  dir: string;
  /** The state `live-import -approve` read, absolute. */
  state: string;
  /** The follow-up that failed. */
  failed: string;
  /** ISO 8601. */
  at: string;
}

function pendingStampPath(root: string, member: string): string {
  return join(root, PROMOTE_RECORD_DIR, `${member}.stamp.json`);
}

/** The stamp a promote of `member` left failed, or undefined when none is pending. */
export function readPendingStamp(root: string, member: string): PendingStamp | undefined {
  const file = pendingStampPath(root, member);
  if (!existsSync(file)) return undefined;
  try {
    const record = JSON.parse(readFileSync(file, "utf-8")) as PendingStamp;
    return record.schema === PENDING_STAMP_SCHEMA && record.member === member ? record : undefined;
  } catch {
    return undefined;
  }
}

function writePendingStamp(root: string, record: PendingStamp): void {
  mkdirSync(join(root, PROMOTE_RECORD_DIR), { recursive: true });
  writeFileSync(pendingStampPath(root, record.member), `${JSON.stringify(record, null, 2)}\n`);
}

function clearPendingStamp(root: string, member: string): void {
  rmSync(pendingStampPath(root, member), { force: true });
}

/** The `live-import -approve` line to run by hand for a pending stamp. */
export function stampCommand(member: { name: string; dir: string }, state: string): string {
  return `\`choudoufu live-import -state=${state} -estate=${member.name} -approve\` in ${member.dir || "."}`;
}

/**
 * Run the stamps of the `choudoufu` rung's follow-up in the tree, keep a
 * {@link PendingStamp} when one fails and drop it when they pass. The result
 * is `applied`, exit 0 when every stamp passed, else exit 1 with the failed
 * follow-up named.
 */
async function stampInTree(input: {
  root: string;
  member: { name: string; dir: string };
  state: string | undefined;
  run: PromoteRunner;
  ran: { label: string; exitCode: number }[];
  say: (m: string) => void;
}): Promise<{ exitCode: number; followUpFailed?: string; failureOutput?: string; followUpOutput?: string }> {
  const rung: Rung = { from: "terraform", to: "choudoufu" };
  let followUpOutput: string | undefined;
  for (const step of followUpRuns(rung, input.member, { state: input.state })) {
    const result = await input.run(step.argv, join(input.root, step.cwd));
    input.ran.push({ label: step.label, exitCode: result.exitCode });
    followUpOutput = result.output;
    if (result.exitCode !== 0) {
      const tail = result.output.trimEnd().split("\n").slice(-20).join("\n");
      input.say(formatError({ message: `${step.label} failed after the patch was applied`, hint: tail }));
      writePendingStamp(input.root, {
        schema: PENDING_STAMP_SCHEMA,
        member: input.member.name,
        dir: input.member.dir,
        state: input.state ?? "",
        failed: step.label,
        at: new Date().toISOString(),
      });
      input.say(formatInfo(`the stamp is kept as pending in ${join(PROMOTE_RECORD_DIR, `${input.member.name}.stamp.json`)}: run the same promote again to retry it, or ${stampCommand(input.member, input.state ?? "<terraform.tfstate>")}`));
      return { exitCode: 1, followUpFailed: step.label, failureOutput: tail, followUpOutput };
    }
  }
  clearPendingStamp(input.root, input.member.name);
  return { exitCode: 0, ...(followUpOutput !== undefined ? { followUpOutput } : {}) };
}

/**
 * Retry the stamp an earlier promote of `member` left failed (#4485), or
 * undefined when none is pending. The member is already of kind
 * `choudoufu`: its kind change was written, so only the stamp runs, against
 * `state` when given, else the state the record names. The result is
 * `applied`: exit 0 once the stamp passed, exit 1 with the failed follow-up
 * when it failed again.
 */
export async function retryPendingStamp(opts: {
  root: string;
  member: string;
  state?: string;
  json?: boolean;
  runner?: PromoteRunner;
}): Promise<PromoteResult | undefined> {
  const root = realpathSync(resolve(opts.root));
  const pending = readPendingStamp(root, opts.member);
  if (!pending) return undefined;
  const say = (m: string): void => {
    if (!opts.json) console.error(m);
  };
  const state = opts.state ? resolve(opts.state) : pending.state || undefined;
  if (!state) throw new PromoteError(`${opts.member}'s stamp is pending and its record names no state: pass --state <terraform.tfstate>`);
  say(formatInfo(`${opts.member}: kind choudoufu, but the stamp ${pending.at} failed (${pending.failed}); retrying it`));
  const ran: { label: string; exitCode: number }[] = [];
  const stamped = await stampInTree({ root, member: { name: opts.member, dir: pending.dir }, state, run: opts.runner ?? spawnRunner, ran, say });
  if (stamped.exitCode === 0) say(formatSuccess(`stamped "${opts.member}"; its promotion to choudoufu is complete`));
  return { outcome: "applied", member: opts.member, from: "terraform", to: "choudoufu", ran, retriedStamp: true, ...stamped };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
}

export interface PromoteOptions {
  root: string;
  member: string;
  state?: string;
  lexicon?: string;
  dryRun?: boolean;
  output?: string;
  json?: boolean;
  /** Run by `promote --all` (#4461): print no JSON of its own, the wave summary does. */
  nested?: boolean;
  /** For tests. */
  runner?: PromoteRunner;
  ledger?: GateLedgerPort;
  now?: string;
}

export type PromoteOutcome = "top-of-ladder" | "checks-failed" | "dry-run" | "gated" | "applied";
export interface PromoteResult {
  outcome: PromoteOutcome;
  exitCode: number;
  member: string;
  from?: string;
  to?: string;
  digest?: string;
  patch?: string;
  /** Digest of the `live-import` report the gate binds (terraform to choudoufu). */
  reportDigest?: string;
  ran?: { label: string; exitCode: number }[];
  /** The `terraform` to `choudoufu` rung's adoption report, from `live-import` without `-approve`. */
  adoption?: AdoptionReport;
  /** The label of the follow-up that failed after the patch was applied. */
  followUpFailed?: string;
  /** The last output of the failed check or follow-up. */
  failureOutput?: string;
  /** The follow-up's output when it ran (the stamp report). */
  followUpOutput?: string;
  /** Set when this run only retried the stamp an earlier one left failed (#4485). */
  retriedStamp?: true;
}

/** What a staging writes that no patch carries: the providers and modules `init` installs (#4461). */
const NOT_STAGED = [":(exclude,glob)**/.terraform/**"];

/** The staging step whose output is the adoption report. */
const REPORT_STEP = "choudoufu live-import (report)";

function declarationFile(root: string): string {
  const f = DECLARATION_FILES.find((n) => existsSync(join(root, n)));
  if (!f) throw new PromoteError(`no ${DECLARATION_FILES.join(" or ")} in ${root}`);
  return f;
}

/** Rewrite the member's `kind` in the declaration text. */
export function setMemberKind(text: string, file: string, member: string, kind: string): string {
  const raw = (file.endsWith(".jsonc") ? text.replace(/^\s*\/\/.*$/gm, "") : text);
  const parsed = JSON.parse(raw) as { members?: { name?: string }[] };
  const i = (parsed.members ?? []).findIndex((m) => m.name === member);
  if (i < 0) throw new PromoteError(`the declaration has no member "${member}"`);
  return setProperty(text, file.endsWith(".jsonc"), `/members/${i}`, "kind", kind);
}

export async function promoteCommand(opts: PromoteOptions): Promise<PromoteResult> {
  const root = realpathSync(resolve(opts.root));
  const run = opts.runner ?? spawnRunner;
  const decl = readDeclaration(workingTree(root));
  const found = decl.members.find((m) => m.name === opts.member);
  if (!found) throw new PromoteError(`the declaration has no member "${opts.member}"; chant workspace ls lists them`);
  const say = (m: string): void => {
    if (!opts.json) console.error(m);
  };
  // #4485: the choudoufu rung is not done until its stamp passed; retry that before any next rung.
  if (found.kind === "choudoufu" && !opts.dryRun) {
    const retried = await retryPendingStamp({ root, member: found.name, ...(opts.state ? { state: opts.state } : {}), ...(opts.json !== undefined ? { json: opts.json } : {}), ...(opts.runner ? { runner: opts.runner } : {}) });
    if (retried) {
      if (opts.json && !opts.nested) console.log(JSON.stringify(retried, null, 2));
      return retried;
    }
  }
  const rung = nextRung(found.kind);
  if (!rung) {
    say(formatInfo(`${found.name} is kind ${found.kind}, which has no rung above it on the ladder (terraform or other, choudoufu, chant)`));
    return { outcome: "top-of-ladder", exitCode: 0, member: found.name, from: found.kind };
  }
  const member = { name: found.name, dir: found.dir === "." ? "" : found.dir };
  // The staging runs in a worktree, so a relative --state would resolve there.
  const state = opts.state ? resolve(opts.state) : undefined;
  const staging = stagingRuns(rung, member, { ...opts, state });
  const emitJson = opts.json && !opts.nested;

  let repo: string;
  let head: string;
  try {
    repo = git(root, ["rev-parse", "--show-toplevel"]).trim();
    head = git(root, ["rev-parse", "HEAD"]).trim();
  } catch {
    throw new PromoteError("chant workspace promote stages its change in a git worktree, so the project must be in a git repository with at least one commit");
  }
  const projectRel = relative(repo, root).split(sep).join("/");
  const declFile = declarationFile(root);
  // The declaration is not watched: the kind change is written into the
  // tree's declaration on apply, so another member's uncommitted promotion
  // there does not block this one (#4461).
  const inProject = (p: string): string => [projectRel, p].filter(Boolean).join("/") || ".";
  const watched = [inProject(member.dir), `:(exclude)${inProject(declFile)}`];
  const dirty = git(repo, ["status", "--porcelain", "--untracked-files=all", "--", ...watched]).split("\n").filter(Boolean);
  if (dirty.length > 0) {
    throw new PromoteError(`${found.name} has uncommitted changes (${dirty.slice(0, 5).map((l) => l.slice(3)).join(", ")}). Commit them: promote stages from HEAD and applies its patch to the tree.`);
  }

  const holder = mkdtempSync(join(tmpdir(), "chant-promote-"));
  const worktree = join(holder, "wt");
  const dispose = (): void => {
    try {
      git(repo, ["worktree", "remove", "--force", worktree]);
    } catch {
      // Fall through to the directory removal and a prune.
    }
    rmSync(holder, { recursive: true, force: true });
    try {
      git(repo, ["worktree", "prune"]);
    } catch {
      // Nothing to prune.
    }
  };

  try {
    git(repo, ["worktree", "add", "-q", "--detach", worktree, head]);
    const project = projectRel ? join(worktree, projectRel) : worktree;
    const ran: { label: string; exitCode: number }[] = [];
    let adoption: AdoptionReport | undefined;
    let reportOutput: string | undefined;
    for (const step of staging) {
      const cwd = join(project, step.cwd);
      mkdirSync(cwd, { recursive: true });
      const result = await run(step.argv, cwd);
      ran.push({ label: step.label, exitCode: result.exitCode });
      if (!opts.json) say(formatInfo(`${step.label}: exit ${result.exitCode}`));
      if (step.label === REPORT_STEP) {
        adoption = parseLiveImportReport(result.output);
        // The report is what the gate asks a person to review, so it is shown, not only counted.
        if (result.exitCode === 0 && result.output.trim()) say(result.output.trimEnd());
      }
      if (result.exitCode !== 0) {
        const tail = result.output.trimEnd().split("\n").slice(-20).join("\n");
        say(formatError({ message: `${step.label} failed in the staging worktree`, hint: tail }));
        say(formatError({ message: "the promotion was not gated: its checks must pass first. The tree is unchanged." }));
        if (emitJson) console.log(JSON.stringify({ outcome: "checks-failed", member: found.name, from: rung.from, to: rung.to, ran, ...(adoption ? { adoption } : {}), failed: { label: step.label, output: tail } }, null, 2));
        return { outcome: "checks-failed", exitCode: 1, member: found.name, from: rung.from, to: rung.to, ran, ...(adoption ? { adoption } : {}), failureOutput: tail };
      }
      if (step.report) reportOutput = result.output;
    }
    const reportDigest = reportOutput === undefined ? undefined : contentDigest(reportOutput.trimEnd());
    const declRel = inProject(declFile);
    // What the staging wrote outside the declaration: the hunks the apply
    // carries. The kind change is described by from and to. The providers
    // `choudoufu init` installed under `.terraform/` are never part of it.
    git(worktree, ["add", "-A", "--", ".", ...NOT_STAGED]);
    const memberPatch = git(worktree, ["diff", "--cached", "--binary", "HEAD", "--", ".", `:(exclude)${declRel}`]);
    const declPath = join(project, declFile);
    writeFileSync(declPath, setMemberKind(readFileSync(declPath, "utf-8"), declFile, found.name, rung.to));
    git(worktree, ["add", "-A", "--", ".", ...NOT_STAGED]);
    const patch = git(worktree, ["diff", "--cached", "--binary", "HEAD"]);
    const digest = computePlanDigest(PROMOTE_PLAN_KIND, {
      member: found.name,
      from: rung.from,
      to: rung.to,
      patch: memberPatch,
      ...(reportDigest ? { report: reportDigest } : {}),
    });
    const base: PromoteResult = {
      outcome: "dry-run",
      exitCode: 0,
      member: found.name,
      from: rung.from,
      to: rung.to,
      digest,
      patch,
      ran,
      ...(reportDigest ? { reportDigest } : {}),
      ...(adoption ? { adoption } : {}),
    };
    const report = (outcome: PromoteOutcome, exitCode: number, extra: Record<string, unknown> = {}): PromoteResult => {
      if (emitJson) console.log(JSON.stringify({ outcome, member: found.name, from: rung.from, to: rung.to, digest, ...(reportDigest ? { reportDigest } : {}), ran, ...(adoption ? { adoption } : {}), ...extra }, null, 2));
      return { ...base, outcome, exitCode, ...extra };
    };
    say(formatInfo(`${found.name}: ${rung.from} to ${rung.to}, patch ${digest}${reportDigest ? `, live-import report ${reportDigest}` : ""}`));
    if (opts.output) writeFileSync(resolve(opts.output), patch);
    if (opts.dryRun) {
      say(formatInfo("--dry-run: staged and checked; no gate recorded, the tree is unchanged"));
      return report("dry-run", 0);
    }

    const check = await evaluateGate(opts.ledger ?? gitGateLedgerPort({ cwd: repo }), {
      op: WORKSPACE_PROMOTE_GATE_OP,
      gate: found.name,
      description: `promote ${found.name} from ${rung.from} to ${rung.to}${reportDigest ? ` (live-import report ${reportDigest})` : ""}`,
      planDigest: digest,
      ...(opts.now ? { now: opts.now } : {}),
    });
    if (!check.satisfied) {
      if (!opts.json) {
        const sealed = await gateIsSealed(found.name);
        if (check.mismatch) console.error(formatWarning({ message: describeGateMismatch(WORKSPACE_PROMOTE_GATE_OP, found.name, check.mismatch, sealed) }));
        if (isLifecycleLocalNote(check.pushWarning)) console.error(formatInfo(LIFECYCLE_LOCAL_NOTE));
        else if (check.pushWarning) console.error(formatWarning({ message: check.pushWarning }));
        console.error(
          formatInfo(
            `Gated: the patch ${digest} waits for approval. Review it (--output <file> writes it), then run \`${approveCommand(WORKSPACE_PROMOTE_GATE_OP, found.name, undefined, undefined, sealed)}\` and repeat this command to apply it.`,
          ),
        );
      }
      return report("gated", PROMOTE_GATED_EXIT, { pending: check.pending });
    }

    if (memberPatch.trim()) {
      const patchDir = mkdtempSync(join(tmpdir(), "chant-promote-patch-"));
      try {
        const file = join(patchDir, "promote.patch");
        writeFileSync(file, memberPatch);
        try {
          git(repo, ["apply", "--binary", "--whitespace=nowarn", file]);
        } catch (err) {
          const stderr = (err as { stderr?: Buffer | string }).stderr?.toString().trim();
          throw new PromoteError(`the approved patch no longer applies to the tree${stderr ? `: ${stderr}` : ""}`);
        }
      } finally {
        rmSync(patchDir, { recursive: true, force: true });
      }
    }
    const treeDecl = join(root, declFile);
    writeFileSync(treeDecl, setMemberKind(readFileSync(treeDecl, "utf-8"), declFile, found.name, rung.to));
    let followUpOutput: string | undefined;
    if (rung.to === "choudoufu") {
      const stamped = await stampInTree({ root, member, state, run, ran, say });
      if (stamped.exitCode !== 0) {
        return report("applied", 1, { followUpFailed: stamped.followUpFailed, failureOutput: stamped.failureOutput, followUpOutput: stamped.followUpOutput });
      }
      followUpOutput = stamped.followUpOutput;
    }
    say(formatSuccess(`applied the approved promotion of "${found.name}" to ${rung.to} (${digest}). Review and commit it.`));
    return report("applied", 0, followUpOutput === undefined ? {} : { followUpOutput });
  } finally {
    dispose();
  }
}

export async function runWorkspacePromote(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const mapped = (args.statePaths ?? []).some((s) => s.includes("="));
  if (args.all || args.stateDir || args.waveSize !== undefined || mapped) {
    // #4461: a workspace of roots, in waves.
    if (args.extraPositional) {
      console.error(formatError({ message: "promote --all takes no member: name roots with --state <member>=<path>, the canary with --canary <member>", hint: USAGE }));
      return 1;
    }
    if (args.output || args.lexicon) {
      console.error(formatError({ message: "--output and --lexicon promote one member; promote --all adopts terraform roots into choudoufu and writes no patch file", hint: USAGE }));
      return 1;
    }
    try {
      const { parseStateMappings, promoteWavesCommand } = await import("./promote-waves");
      const result = await promoteWavesCommand({
        root: process.cwd(),
        all: args.all,
        states: parseStateMappings(args.statePaths ?? []),
        stateDir: args.stateDir,
        canary: args.canary,
        waveSize: args.waveSize,
        dryRun: args.dryRun,
        json: args.json,
      });
      return result.exitCode;
    } catch (err) {
      if (err instanceof PromoteError) {
        console.error(formatError({ message: err.message, hint: USAGE }));
        return 1;
      }
      throw err;
    }
  }
  if (!args.extraPositional || args.extraPositional2) {
    console.error(formatError({ message: "promote takes exactly one member", hint: USAGE }));
    return 1;
  }
  try {
    const result = await promoteCommand({
      root: process.cwd(),
      member: args.extraPositional,
      state: args.statePath,
      lexicon: args.lexicon,
      dryRun: args.dryRun,
      output: args.output,
      json: args.json,
    });
    return result.exitCode;
  } catch (err) {
    if (err instanceof PromoteError) {
      console.error(formatError({ message: err.message, hint: USAGE }));
      return 1;
    }
    throw err;
  }
}
