/**
 * `chant workspace upgrade [<scope>] [--to <ref>] [--allow-code] [--dry-run]
 * [--output <file>] [--json]` (#2550).
 *
 * Stages the upgrade in a worktree (see ./lineage-upgrade.ts), then decides
 * its gate. The gate is `workspace-upgrade/<scope>` on the gate ledger, and it
 * binds the digest of the patch the staging produced. The first run records
 * the pending fact and exits 3, the code `chant run` gives a gated run. After
 * `chant approve workspace-upgrade <scope>`, the same command stages the same
 * patch, finds the approval for its digest, and applies the patch to the tree.
 * A patch that differs from the approved one needs a new approval.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatError, formatInfo, formatSuccess, formatWarning } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { approveCommand, describeGateMismatch, evaluateGate, gitGateLedgerPort, type GateLedgerPort } from "../op/gate";
import { WORKSPACE_UPGRADE_GATE_OP } from "../op/gate-name";
import { LockError } from "./lineage-lock";
import { applyStagedUpgrade, describeStaged, stageUpgrade, type ChantRunner, type StagedUpgrade } from "./lineage-upgrade";

const USAGE = "chant workspace upgrade [<scope>] [--to <ref>] [--source <repo>[#<member>]] [--allow-code] [--dry-run] [--output <patch file>] [--json]";

/** The exit code of a gated upgrade: the same as `chant run`'s gated run. */
export const UPGRADE_GATED_EXIT = 3;

export interface UpgradeCommandOptions {
  root: string;
  scope?: string;
  to?: string;
  /** Move the scope to another template (#2551). */
  source?: string;
  allowCode?: boolean;
  dryRun?: boolean;
  output?: string;
  json?: boolean;
  /** For tests. */
  runChant?: ChantRunner;
  ledger?: GateLedgerPort;
  now?: string;
}

export type UpgradeOutcome = "up-to-date" | "checks-failed" | "dry-run" | "gated" | "applied";

export interface UpgradeCommandResult {
  outcome: UpgradeOutcome;
  exitCode: number;
  staged?: Omit<StagedUpgrade, "dispose" | "patch" | "worktree" | "worktreeProject" | "lock">;
}

/** The command, with its output. Returns the exit code and what happened. */
export async function upgradeCommand(opts: UpgradeCommandOptions): Promise<UpgradeCommandResult> {
  const staged = await stageUpgrade({
    root: opts.root,
    scope: opts.scope,
    to: opts.to,
    ...(opts.source !== undefined ? { source: opts.source } : {}),
    allowCode: opts.allowCode,
    runChant: opts.runChant,
  });
  try {
    const { dispose: _d, patch: _p, worktree: _w, worktreeProject: _wp, lock: _l, ...view } = staged;
    const report = (outcome: UpgradeOutcome, exitCode: number, extra: Record<string, unknown> = {}): UpgradeCommandResult => {
      if (opts.json) console.log(JSON.stringify({ outcome, ...view, ...extra }, null, 2));
      return { outcome, exitCode, staged: view };
    };
    if (!opts.json) console.log(describeStaged(staged).join("\n"));

    if (!opts.json && !staged.lock.tracked) {
      console.error(
        formatWarning({
          message: `${staged.lock.path} is not tracked by git (a .gitignore covers it), so it is written beside the patch rather than in it. Commit it with \`git add -f\` so the lineage travels with the project.`,
        }),
      );
    }
    if (!staged.changed) {
      if (!opts.json) console.error(formatSuccess(`scope "${staged.scope}" is already at ${staged.to ?? "its source"}; nothing to upgrade`));
      return report("up-to-date", 0);
    }
    if (opts.output) writeFileSync(resolve(opts.output), staged.patch);
    if (!staged.checksOk) {
      if (!opts.json) {
        for (const c of staged.checks.filter((c) => c.status === "failed")) {
          console.error(formatError({ message: `${c.name} failed in the staging worktree`, hint: c.detail }));
        }
        console.error(formatError({ message: "the upgrade was not gated: its checks must pass first. The tree is unchanged." }));
      }
      return report("checks-failed", 1);
    }
    if (opts.dryRun) {
      if (!opts.json) console.error(formatInfo("--dry-run: staged and checked; no gate recorded, the tree is unchanged"));
      return report("dry-run", 0);
    }

    const gate = staged.scope;
    const check = await evaluateGate(opts.ledger ?? gitGateLedgerPort({ cwd: staged.repo }), {
      op: WORKSPACE_UPGRADE_GATE_OP,
      gate,
      description: `upgrade ${staged.template} ${staged.from ?? ""} -> ${staged.to ?? ""} in scope ${staged.scope}`.replace(/\s+/g, " "),
      planDigest: staged.digest,
      ...(staged.governance ? { approval: staged.governance.approval } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    if (!check.satisfied) {
      if (!opts.json) {
        if (check.mismatch) console.error(formatWarning({ message: describeGateMismatch(WORKSPACE_UPGRADE_GATE_OP, gate, check.mismatch) }));
        if (check.pushWarning) console.error(formatWarning({ message: check.pushWarning }));
        if (check.quorum) console.error(formatInfo(`approvals so far: ${check.quorum.approvers.length} of ${check.quorum.need}`));
        console.error(
          formatInfo(
            `Gated: the patch ${staged.digest} waits for approval. Review it (--output <file> writes it), then run \`${approveCommand(WORKSPACE_UPGRADE_GATE_OP, gate)}\` and repeat this command to apply it.`,
          ),
        );
      }
      return report("gated", UPGRADE_GATED_EXIT, { pending: check.pending });
    }

    applyStagedUpgrade(staged);
    if (!opts.json) {
      console.error(formatSuccess(`applied the approved upgrade of "${staged.scope}" (${staged.digest}), approved by ${check.resolution.resolvedBy}. Review and commit it.`));
      if (staged.manualSteps.length > 0) {
        console.error(formatInfo(`${staged.manualSteps.length} manual step(s) are open; \`chant workspace check\` fails until each is merged and resolved.`));
      }
    }
    return report("applied", 0, { approvedBy: check.resolution.resolvedBy });
  } finally {
    staged.dispose();
  }
}

export async function runWorkspaceUpgrade(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (args.extraPositional2) {
    console.error(formatError({ message: `unexpected argument: ${args.extraPositional2}`, hint: USAGE }));
    return 1;
  }
  try {
    const result = await upgradeCommand({
      root: process.cwd(),
      scope: args.extraPositional,
      to: args.migrateTo,
      source: args.source,
      allowCode: args.allowCode,
      dryRun: args.dryRun,
      output: args.output,
      json: args.json,
    });
    return result.exitCode;
  } catch (err) {
    if (!(err instanceof LockError)) throw err;
    console.error(formatError({ message: err.message, hint: USAGE }));
    return 1;
  }
}
