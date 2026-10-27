/**
 * `chant approve` at a terminal (#4575): show the plan the gate waits on and
 * ask the person to type the target's name before anything is recorded.
 *
 * Ruled on INTENTIUS/sql-yodeler#285 (F): the type-the-name confirmation
 * lives in chant core, so every product's approve word gets it from here and
 * drops its own prompt. `yodel approve` is the model: it prints the plan and
 * its digest, asks "Type <env> to approve", refuses a wrong answer, and reads
 * the plan again after the answer so the approval is for the plan the person
 * saw.
 *
 * Only a person at a terminal is asked: stdin and stdout both a TTY, no
 * `--yes`, no `--json`, no `CI` in the environment, and a channel a person
 * types on (not MCP or ACP). Every other run records as it did before.
 *
 * The plan shown is the stored change set (`_change-sets/<digest>.json`,
 * `../../lifecycle/change-set-store.ts`) the pending fact cites: its
 * `changeSet` field once chant#4551 adds one, else its `planDigest` when that
 * is a change-set digest (pull-request and release gates). When none is
 * stored, the pending fact's own lines are shown and the person is told where
 * the plan was printed.
 */
import type { ParsedArgs } from "../registry";
import type { PendingGateRecord } from "../../lifecycle/gate-ledger";
import { CHANT_EXIT } from "../../exit-codes";

/** The streams the terminal check reads. `process` in the CLI; tests pass their own. */
export interface ApprovalTerminal {
  stdin: { isTTY?: boolean };
  stdout: { isTTY?: boolean };
  env: Record<string, string | undefined>;
}

/**
 * Whether `chant approve` asks before recording: a person at a terminal, on
 * a shell channel, who did not pass `--yes` or `--json`.
 */
export async function interactiveApproval(
  args: Pick<ParsedArgs, "yes" | "json">,
  terminal: ApprovalTerminal = process,
): Promise<boolean> {
  if (args.yes || args.json) return false;
  const ci = terminal.env.CI;
  if (ci !== undefined && ci !== "" && ci !== "false" && ci !== "0") return false;
  if (terminal.stdin.isTTY !== true || terminal.stdout.isTTY !== true) return false;
  const { currentGateOrigin, isModelAuthored } = await import("../../lifecycle/gate-origin");
  return !isModelAuthored(currentGateOrigin());
}

/** What the confirmation decided. */
export type ApprovalConfirmation =
  /** Nothing to show (no plan, a bad `--plan`, a ledger that can't be read): record as before, which reports the problem. */
  | { status: "skipped" }
  /** The person typed the target's name; approve exactly `plan`. */
  | { status: "confirmed"; plan: string; target: string }
  /** Nothing is recorded; exit with `code`. */
  | { status: "refused"; code: number };

export interface ConfirmApprovalOptions {
  /** `--plan`, when given. */
  plan?: string;
  /** `--env`, when given. */
  environment?: string;
  /** Where the ledger is read from. Defaults to the process's directory. */
  cwd?: string;
  /** Asks one question and resolves to the answer, or null at end of input. Defaults to a readline prompt on stderr. */
  ask?: (question: string) => Promise<string | null>;
  /** Where the plan is printed. Defaults to stdout. */
  out?: (text: string) => void;
  /** Where the questions' surroundings and refusals go. Defaults to stderr. */
  err?: (text: string) => void;
}

/** Ask one line on the terminal; null when input ends before an answer. */
export async function askLine(question: string): Promise<string | null> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolveAnswer) => {
    let answered = false;
    rl.question(question, (answer) => {
      answered = true;
      resolveAnswer(answer);
      rl.close();
    });
    rl.on("close", () => {
      if (!answered) resolveAnswer(null);
    });
  });
}

/** The standing pending fact `chant approve` answers: the same pick `recordGateApproval` makes. */
function standingFact(pending: PendingGateRecord[], gate: string, environment: string | undefined, latest: (all: PendingGateRecord[], gate: string) => PendingGateRecord | undefined): PendingGateRecord | undefined {
  const bound = pending.some((p) => p.gate === gate && p.environment !== undefined);
  return latest(bound && environment !== undefined ? pending.filter((p) => p.environment === environment) : pending, gate);
}

/**
 * The name a person types to approve: the environment the pending fact was
 * recorded in, else the one `--env` names, else the gate's own name.
 */
export function approvalTarget(gate: string, standing: Pick<PendingGateRecord, "environment"> | undefined, environment?: string): string {
  return standing?.environment ?? environment ?? gate;
}

/**
 * Show the plan `chant approve <op> <gate>` would approve and ask for the
 * target's name. The caller has already decided the run is interactive
 * ({@link interactiveApproval}).
 */
export async function confirmApproval(opName: string, gate: string, opts: ConfirmApprovalOptions = {}): Promise<ApprovalConfirmation> {
  const out = opts.out ?? ((t: string) => void process.stdout.write(t));
  const err = opts.err ?? ((t: string) => void process.stderr.write(t));
  const ask = opts.ask ?? askLine;
  const cwd = opts.cwd ?? process.cwd();

  const { ledgerRecordingOff } = await import("../../lifecycle/no-record");
  if (ledgerRecordingOff()) return { status: "skipped" };
  const { requireLifecycleLedger } = await import("../../lifecycle/git");
  const { readGateLedger, latestPendingGate } = await import("../../lifecycle/gate-ledger");
  const { isPlanDigest, samePlanDigest } = await import("../../lifecycle/plan-digest");

  let standing: PendingGateRecord | undefined;
  try {
    await requireLifecycleLedger();
    standing = standingFact((await readGateLedger(opName)).pending, gate, opts.environment, latestPendingGate);
  } catch {
    // The record that follows reads the same ledger and says what is wrong.
    return { status: "skipped" };
  }
  if (opts.plan !== undefined && !isPlanDigest(opts.plan)) return { status: "skipped" };
  const digest = opts.plan ?? standing?.planDigest;
  if (digest === undefined) return { status: "skipped" };
  const ofStanding = standing?.planDigest !== undefined && samePlanDigest(digest, standing.planDigest);
  const target = approvalTarget(gate, standing, opts.environment);

  const lines: string[] = [`Gate "${gate}" on "${opName}"${standing?.environment !== undefined ? ` in ${standing.environment}` : ""}`];
  if (standing && ofStanding) {
    if (standing.description) lines.push(`  ${standing.description}`);
    lines.push(`  waiting since ${standing.timestamp}${standing.gitSha ? ` at ${standing.gitSha.slice(0, 12)}` : ""}`);
    if (standing.url) lines.push(`  ${standing.url}`);
  } else if (standing?.planDigest !== undefined) {
    lines.push(`  --plan names ${digest}; the gate's pending fact waits on ${standing.planDigest}`);
  } else {
    lines.push(`  no pending fact stands; --plan names ${digest}`);
  }
  lines.push(`  plan ${digest}`);
  out(`${lines.join("\n")}\n\n`);

  // chant#4551: a pending fact cites the change set it was asked for. Read
  // structurally so this compiles before and after that field lands.
  const cited = ofStanding ? (standing as { changeSet?: unknown } | undefined)?.changeSet : undefined;
  const changeSet = typeof cited === "string" ? cited : digest;
  const { CHANGE_SET_DIGEST_PATTERN } = await import("../../workspace/change-set-show");
  let shown = false;
  if (CHANGE_SET_DIGEST_PATTERN.test(changeSet)) {
    try {
      const { readStoredChangeSet } = await import("../../lifecycle/change-set-store");
      const read = await readStoredChangeSet(changeSet, { cwd });
      if (read.status === "found") {
        const { groupChangeSet, renderPlanSummaryText } = await import("../../plan-summary");
        out(renderPlanSummaryText(groupChangeSet(read.document)));
        shown = true;
      } else if (read.status === "malformed") {
        err(`The stored plan can't be shown: ${read.message}\n`);
      }
    } catch (e) {
      err(`The stored plan can't be read: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  if (!shown) {
    err(
      `No plan is stored on chant/lifecycle under ${changeSet}. The run that stopped at the gate printed it; ` +
        `the digest above is what this approval binds.\n`,
    );
  }

  const answer = await ask(`\nApprove this plan for ${target}, ${digest}? Type ${target} to approve: `);
  if (answer === null || answer.trim() !== target) {
    err(`Not approved: the answer was not ${target}.\n`);
    return { status: "refused", code: CHANT_EXIT.declined };
  }

  // Read the fact again: what is approved is what the person saw.
  if (opts.plan === undefined) {
    let now: PendingGateRecord | undefined;
    try {
      now = standingFact((await readGateLedger(opName)).pending, gate, opts.environment, latestPendingGate);
    } catch {
      return { status: "confirmed", plan: digest, target };
    }
    if (now?.planDigest === undefined || !samePlanDigest(now.planDigest, digest)) {
      err(
        `Not approved: the plan moved while you were asked (now ${now?.planDigest ?? "no pending plan"}); ` +
          `run chant approve ${opName} ${gate} again.\n`,
      );
      return { status: "refused", code: CHANT_EXIT.moved };
    }
  }
  return { status: "confirmed", plan: digest, target };
}
