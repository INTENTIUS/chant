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
 * - `terraform` to `choudoufu`: `choudoufu live-check` in the member's
 *   directory must pass, then `choudoufu live-import -state=<--state>
 *   -estate=<member>` prints its ratification report (read-only: it stamps
 *   nothing without `-approve`). The patch changes the member's kind.
 * - `choudoufu` or `other` to `chant`: `chant import` writes TypeScript into
 *   the member's directory. The patch holds those files and the kind change.
 *
 * Commands run through an injectable runner, so a test never starts a binary.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { formatError, formatInfo, formatSuccess, formatWarning } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { computePlanDigest } from "../lifecycle/plan-digest";
import { LIFECYCLE_LOCAL_NOTE, isLifecycleLocalNote } from "../lifecycle/local-note";
import { approveCommand, describeGateMismatch, evaluateGate, gateIsSealed, gitGateLedgerPort, type GateLedgerPort } from "../op/gate";
import { WORKSPACE_PROMOTE_GATE_OP } from "../op/gate-name";
import { DECLARATION_FILES, readDeclaration } from "./declaration";
import { setProperty } from "./json-edit";
import { workingTree } from "./tree";

export const PROMOTE_PLAN_KIND = "workspace-promote";
export const PROMOTE_GATED_EXIT = 3;
const USAGE = "chant workspace promote <member> [--state <terraform.tfstate>] [--lexicon <lexicon>] [--dry-run] [--output <patch file>] [--json]";

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
      { label: "choudoufu live-check", argv: ["choudoufu", "live-check"], cwd: member.dir },
      { label: "choudoufu live-import (report)", argv: ["choudoufu", "live-import", `-state=${opts.state}`, `-estate=${member.name}`], cwd: member.dir },
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
  ran?: { label: string; exitCode: number }[];
}

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
  const rung = nextRung(found.kind);
  if (!rung) {
    say(formatInfo(`${found.name} is kind ${found.kind}, which has no rung above it on the ladder (terraform or other, choudoufu, chant)`));
    return { outcome: "top-of-ladder", exitCode: 0, member: found.name, from: found.kind };
  }
  const member = { name: found.name, dir: found.dir === "." ? "" : found.dir };
  const staging = stagingRuns(rung, member, opts);

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
  const watched = [declFile, member.dir].filter(Boolean).map((p) => [projectRel, p].filter(Boolean).join("/"));
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
    for (const step of staging) {
      const cwd = join(project, step.cwd);
      mkdirSync(cwd, { recursive: true });
      const result = await run(step.argv, cwd);
      ran.push({ label: step.label, exitCode: result.exitCode });
      if (!opts.json) say(formatInfo(`${step.label}: exit ${result.exitCode}`));
      if (result.exitCode !== 0) {
        say(formatError({ message: `${step.label} failed in the staging worktree`, hint: result.output.trimEnd().split("\n").slice(-20).join("\n") }));
        say(formatError({ message: "the promotion was not gated: its checks must pass first. The tree is unchanged." }));
        if (opts.json) console.log(JSON.stringify({ outcome: "checks-failed", member: found.name, ran }, null, 2));
        return { outcome: "checks-failed", exitCode: 1, member: found.name, from: rung.from, to: rung.to, ran };
      }
    }
    const declPath = join(project, declFile);
    writeFileSync(declPath, setMemberKind(readFileSync(declPath, "utf-8"), declFile, found.name, rung.to));
    git(worktree, ["add", "-A"]);
    const patch = git(worktree, ["diff", "--cached", "--binary", "HEAD"]);
    const digest = computePlanDigest(PROMOTE_PLAN_KIND, { member: found.name, from: rung.from, to: rung.to, patch });
    const base: PromoteResult = { outcome: "dry-run", exitCode: 0, member: found.name, from: rung.from, to: rung.to, digest, patch, ran };
    const report = (outcome: PromoteOutcome, exitCode: number, extra: Record<string, unknown> = {}): PromoteResult => {
      if (opts.json) console.log(JSON.stringify({ outcome, member: found.name, from: rung.from, to: rung.to, digest, ran, ...extra }, null, 2));
      return { ...base, outcome, exitCode };
    };
    say(formatInfo(`${found.name}: ${rung.from} to ${rung.to}, patch ${digest}`));
    if (opts.output) writeFileSync(resolve(opts.output), patch);
    if (opts.dryRun) {
      say(formatInfo("--dry-run: staged and checked; no gate recorded, the tree is unchanged"));
      return report("dry-run", 0);
    }

    const check = await evaluateGate(opts.ledger ?? gitGateLedgerPort({ cwd: repo }), {
      op: WORKSPACE_PROMOTE_GATE_OP,
      gate: found.name,
      description: `promote ${found.name} from ${rung.from} to ${rung.to}`,
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

    const patchDir = mkdtempSync(join(tmpdir(), "chant-promote-patch-"));
    try {
      const file = join(patchDir, "promote.patch");
      writeFileSync(file, patch);
      try {
        git(repo, ["apply", "--binary", "--whitespace=nowarn", file]);
      } catch (err) {
        const stderr = (err as { stderr?: Buffer | string }).stderr?.toString().trim();
        throw new PromoteError(`the approved patch no longer applies to the tree${stderr ? `: ${stderr}` : ""}`);
      }
    } finally {
      rmSync(patchDir, { recursive: true, force: true });
    }
    for (const step of followUpRuns(rung, member, opts)) {
      const result = await run(step.argv, join(root, step.cwd));
      ran.push({ label: step.label, exitCode: result.exitCode });
      if (result.exitCode !== 0) {
        say(formatError({ message: `${step.label} failed after the patch was applied`, hint: result.output.trimEnd().split("\n").slice(-20).join("\n") }));
        return report("applied", 1, { followUpFailed: step.label });
      }
    }
    say(formatSuccess(`applied the approved promotion of "${found.name}" to ${rung.to} (${digest}). Review and commit it.`));
    return report("applied", 0);
  } finally {
    dispose();
  }
}

export async function runWorkspacePromote(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
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
