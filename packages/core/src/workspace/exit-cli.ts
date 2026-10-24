/**
 * `chant workspace exit [<member>...] [--dry-run] [--drill] [--output <file>] [--json]`
 * (#3177).
 *
 * Stages the exit in a git worktree (see ./exit.ts), checks the staged tree
 * with the same static checks the exit drill uses, then decides a gate. The
 * gate is `workspace-exit/<scope>` on the gate ledger and binds the digest of
 * the patch, as `workspace upgrade` does: the first run records the pending
 * fact and exits 3; after `chant approve workspace-exit <scope>` the same
 * command stages the same patch and applies it to the tree.
 *
 * `--drill` skips the worktree and the gate: it runs the exit on a scratch
 * copy and prints the per-member result, the check CI runs on every commit.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { formatError, formatInfo, formatSuccess, formatWarning } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { approveCommand, describeGateMismatch, evaluateGate, gateIsSealed, gitGateLedgerPort, type GateLedgerPort } from "../op/gate";
import { WORKSPACE_EXIT_GATE_OP } from "../op/gate-name";
import { findWorkspaceRoot } from "../project-root";
import { describeDrill, ExitError, exitInDir, planExit, runExitDrill, verifyExit, type DrillReport, type ExitBuildRunner, type ExitResult } from "./exit";
import { spawnChant } from "./lineage-upgrade";

const USAGE = "chant workspace exit [<member>...] [--member <name>] [--dry-run] [--drill] [--output <patch file>] [--json]";

/** The exit code of a gated exit: the same as `chant run`'s gated run. */
export const EXIT_GATED = 3;

const EXIT_DIR = ".chant/exit";

export interface ExitCommandOptions {
  root: string;
  members?: string[];
  dryRun?: boolean;
  drill?: boolean;
  output?: string;
  json?: boolean;
  /** For tests. */
  runBuild?: ExitBuildRunner;
  ledger?: GateLedgerPort;
  now?: string;
}

export type ExitOutcome = "drill" | "nothing-to-exit" | "checks-failed" | "dry-run" | "gated" | "applied";

export interface ExitCommandResult {
  outcome: ExitOutcome;
  exitCode: number;
  result?: ExitResult;
  report?: DrillReport;
  digest?: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
}

const defaultBuild: ExitBuildRunner = (command, cwd, args) => spawnChant(command, cwd, args);

export async function exitCommand(opts: ExitCommandOptions): Promise<ExitCommandResult> {
  const runBuild = opts.runBuild ?? defaultBuild;
  const names = opts.members ?? [];
  const print = (lines: string[]) => {
    if (!opts.json) console.log(lines.join("\n"));
  };

  if (opts.drill) {
    const report = await runExitDrill({ root: opts.root, members: names, runBuild });
    if (opts.json) console.log(JSON.stringify({ outcome: "drill", ...report }, null, 2));
    else print(describeDrill(report));
    return { outcome: "drill", exitCode: report.ok ? 0 : 1, report };
  }

  let repo: string;
  let head: string;
  try {
    repo = git(opts.root, ["rev-parse", "--show-toplevel"]).trim();
    head = git(opts.root, ["rev-parse", "HEAD"]).trim();
  } catch {
    throw new ExitError("chant workspace exit stages its change in a git worktree, so the project must be in a git repository with at least one commit");
  }
  const dirty = git(repo, ["status", "--porcelain", "--untracked-files=all"])
    .split("\n")
    .filter(Boolean)
    .filter((l) => !l.slice(3).includes(`${EXIT_DIR}/`));
  if (dirty.length > 0) {
    throw new ExitError(`the tree has uncommitted changes (${dirty.slice(0, 5).map((l) => l.slice(3)).join(", ")}${dirty.length > 5 ? ", ..." : ""}). Commit them: the exit stages from HEAD and applies its patch to the tree.`);
  }
  const rel = relative(repo, opts.root).split(sep).join("/");
  const holder = join(opts.root, EXIT_DIR);
  mkdirSync(holder, { recursive: true });
  const worktree = mkdtempSync(join(holder, "wt-"));
  rmSync(worktree, { recursive: true, force: true });
  git(repo, ["worktree", "add", "--detach", "-q", worktree, head]);
  const dispose = () => {
    try {
      git(repo, ["worktree", "remove", "--force", worktree]);
    } catch {
      rmSync(worktree, { recursive: true, force: true });
    }
  };
  try {
    const project = rel ? join(worktree, rel) : worktree;
    const plan = planExit(project, names);
    const result = await exitInDir(plan, runBuild);
    const report = verifyExit(project, result);
    git(worktree, ["add", "-A"]);
    const patch = git(worktree, ["diff", "--cached", "--binary", "HEAD"]);
    const digest = `sha256:${createHash("sha256").update(patch).digest("hex").slice(0, 16)}`;

    if (opts.json) {
      // printed once, below
    } else {
      print(describeExit(result, digest));
      print(describeDrill(report));
    }
    const out = (outcome: ExitOutcome, exitCode: number, extra: Record<string, unknown> = {}): ExitCommandResult => {
      if (opts.json) console.log(JSON.stringify({ outcome, digest, ...result, report, ...extra }, null, 2));
      return { outcome, exitCode, result, report, digest };
    };

    if (opts.output) writeFileSync(resolve(opts.output), patch);
    if (!patch) {
      if (!opts.json) console.error(formatInfo("nothing to exit: no member changed"));
      return out("nothing-to-exit", 0);
    }
    if (!report.ok) {
      if (!opts.json) console.error(formatError({ message: "the exit was not gated: its checks must pass first. The tree is unchanged." }));
      return out("checks-failed", 1);
    }
    if (opts.dryRun) {
      if (!opts.json) console.error(formatInfo("--dry-run: staged and checked; no gate recorded, the tree is unchanged"));
      return out("dry-run", 0);
    }

    const gate = names.length > 0 ? names.join("+") : "workspace";
    const check = await evaluateGate(opts.ledger ?? gitGateLedgerPort({ cwd: repo }), {
      op: WORKSPACE_EXIT_GATE_OP,
      gate,
      description: `leave chant: ${gate}`,
      planDigest: digest,
      ...(opts.now ? { now: opts.now } : {}),
    });
    if (!check.satisfied) {
      if (!opts.json) {
        const sealed = await gateIsSealed(gate);
        if (check.mismatch) console.error(formatWarning({ message: describeGateMismatch(WORKSPACE_EXIT_GATE_OP, gate, check.mismatch, sealed) }));
        console.error(
          formatInfo(
            `Gated: the patch ${digest} waits for approval. Review it (--output <file> writes it), then run \`${approveCommand(WORKSPACE_EXIT_GATE_OP, gate, undefined, undefined, sealed)}\` and repeat this command to apply it.`,
          ),
        );
      }
      return out("gated", EXIT_GATED, { pending: check.pending });
    }
    applyPatch(repo, patch);
    if (!opts.json) console.error(formatSuccess(`applied the approved exit (${digest}), approved by ${check.resolution.resolvedBy}. Review and commit it.`));
    return out("applied", 0, { approvedBy: check.resolution.resolvedBy });
  } finally {
    dispose();
  }
}

function applyPatch(repo: string, patch: string): void {
  const dir = mkdtempSync(join(tmpdir(), "chant-exit-patch-"));
  const file = join(dir, "exit.patch");
  try {
    writeFileSync(file, patch);
    git(repo, ["apply", "--binary", "--whitespace=nowarn", file]);
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr?.toString().trim();
    throw new ExitError(`the approved patch no longer applies to the tree${stderr ? `: ${stderr}` : ""}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One line per member, for the terminal. */
export function describeExit(result: ExitResult, digest: string): string[] {
  const lines: string[] = [];
  for (const m of result.members) {
    lines.push(`${m.name}  ${m.kind}  ${m.status}${m.detail ? ` (${m.detail})` : ""}`);
    for (const n of m.native) lines.push(`  native: ${n}`);
    for (const d of m.deploy) lines.push(`  deploy: ${d}`);
    for (const c of m.ci) lines.push(`  ci: ${c}`);
    for (const o of m.ops) lines.push(`  kept: ${o}`);
    for (const s of m.steps) lines.push(`  step: ${s}`);
  }
  lines.push(`  patch: ${digest}`);
  return lines;
}

export async function runWorkspaceExit(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  // positionals are ["exit", <member>...]
  const named = [...(args.positionals ?? []).slice(1), ...(args.members ?? [])];
  const root = findWorkspaceRoot(process.cwd())?.dir ?? process.cwd();
  try {
    const result = await exitCommand({
      root,
      members: [...new Set(named)],
      dryRun: args.dryRun,
      drill: args.drill,
      output: args.output,
      json: args.json,
    });
    return result.exitCode;
  } catch (err) {
    if (!(err instanceof ExitError)) throw err;
    console.error(formatError({ message: err.message, hint: USAGE }));
    return 1;
  }
}

