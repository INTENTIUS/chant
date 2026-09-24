/**
 * Gate state for `chant workspace status --json` (#2674): each member's gates
 * as its gate ledger on `chant/lifecycle` records them, so a reader such as
 * hud never runs `git show` on the branch itself.
 *
 * A member's gate ledger is the `_gates/` directory under its ledger prefix:
 * `_members/<member>/_gates/<component>.jsonl` for a member that writes the
 * member layout (#2538), and the flat `_gates/<component>.jsonl` otherwise,
 * chosen the same way as its release ledger. Each file is keyed by the
 * component, or by the op for a gate an Op run reached, and holds both the
 * pending facts a run records and the approvals `chant approve` records
 * (`../lifecycle/gate-ledger.ts`).
 *
 * A gate's state is decided the way a run decides it (`evaluateGate` in
 * `../op/gate.ts`), without writing anything: the newest pending fact for the
 * gate in its environment is the anchor, only approvals recorded since it and
 * for its plan count, and a gate with an `approval` block counts them with
 * `tallyGateApprovals`, as `describeApprovalProgress` does after an approve.
 */

import { execFileSync } from "node:child_process";
import type { GateResolutionRecord, PendingGateRecord } from "../lifecycle/gate-ledger";
import { isPendingGateExpired, latestPendingGate, latestResolutionForPlan, parseGateLedger } from "../lifecycle/gate-ledger";
import { tallyGateApprovals } from "../op/gate";
import type { ReasonCode } from "./reason-codes";

/** Why a member's gates can't be listed. Closed: a new code is a contract change. */
export const GATE_REASON_CODES = [
  /** The checkout has no `chant/lifecycle` branch, so there is no ledger to read gates from. */
  "gates-no-ledger",
  /** The branch has no gate ledger for the member: no run of it has reached a gate. */
  "gates-no-gate-ledger",
  /** Reading the member's gate ledger failed, so no gate is listed. */
  "gates-ledger-unreadable",
] as const satisfies readonly ReasonCode[];
export type GateReasonCode = (typeof GATE_REASON_CODES)[number];

export type GateState = "pending" | "approved" | "expired" | "superseded";

export interface StatusGateApproval {
  /** Who recorded it: `chant approve --approver`, or the CI or shell identity. */
  principal: string;
  /** The channel it was recorded on (`cli`, `mcp`, `acp`), or null for a record older than chant#2384. */
  channel: string | null;
  at: string;
}

export interface StatusGate {
  /** The ledger file's key: the component, or the op for a gate an Op run reached. */
  component: string;
  /** The gate's name. */
  name: string;
  /** The environment the gate was reached in, or null for a gate that records none (an Op gate). */
  env: string | null;
  /** The plan the run reached the gate with, or null for a gate that binds no plan. */
  planDigest: string | null;
  state: GateState;
  /** When the run recorded the pending fact the state is read against. */
  recordedAt: string;
  expiresAt: string;
  /** The approvals that count toward the gate for this plan, oldest first. */
  approvals: StatusGateApproval[];
  /** How many human approvals the gate needs: its quorum's count, 1 without one. */
  needed: number;
  /** The command that approves it, run in the member's directory. */
  approve: string;
}

export interface StatusGateLedger {
  /** `members` for `_members/<member>/_gates`, `flat` for `_gates`. */
  layout: "members" | "flat";
  /** The gate ledger directory on the branch. */
  path: string;
  /** True when more than one member in this output reads the same flat directory. */
  shared: boolean;
  /** Lines that are neither a pending fact nor an approval, skipped. */
  malformed: number;
  reason: { code: GateReasonCode; message: string } | null;
}

/**
 * Reads the gate ledger files in `dir` on the branch at `commit`: file name
 * without `.jsonl` to contents. Null when the directory doesn't exist; throws
 * when it can't be read.
 */
export type GateLedgerReader = (dir: string, commit: string, cwd: string) => Promise<Map<string, string> | null>;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

export const defaultGateLedgerReader: GateLedgerReader = async (dir, commit, cwd) => {
  try {
    git(cwd, ["rev-parse", "--verify", "--quiet", `${commit}:${dir}`]);
  } catch {
    return null;
  }
  const files = new Map<string, string>();
  for (const name of git(cwd, ["ls-tree", "--name-only", `${commit}:${dir}`]).split("\n")) {
    if (!name.endsWith(".jsonl")) continue;
    files.set(name.slice(0, -".jsonl".length), git(cwd, ["cat-file", "blob", `${commit}:${dir}/${name}`]));
  }
  return files;
};

/** The exact `chant approve` line for a gate. */
export function approveCommand(component: string, gate: string, env: string | null): string {
  return `chant approve ${component} ${gate}${env !== null ? ` --env ${env}` : ""}`;
}

const approvalOf = (r: GateResolutionRecord): StatusGateApproval => ({ principal: r.resolvedBy, channel: r.origin ?? null, at: r.timestamp });

/** One gate in one environment, decided against its newest pending fact. */
function decide(component: string, standing: PendingGateRecord, resolutions: GateResolutionRecord[], now: string): StatusGate {
  const gate = standing.gate;
  const env = standing.environment ?? null;
  const since = standing.timestamp;
  const planDigest = standing.planDigest;
  // #2574: an approval recorded for another environment doesn't count; one
  // that records none is kept, so it reads as a mismatch, as a run reads it.
  const own = env === null ? resolutions : resolutions.filter((r) => r.environment === undefined || r.environment === env);

  let approved: boolean;
  let approvals: GateResolutionRecord[];
  let needed = 1;
  let mismatched: GateResolutionRecord | undefined;
  if (standing.approval) {
    const tally = tallyGateApprovals(own, gate, since, planDigest, standing.approval);
    approved = tally.permit !== undefined || tally.counted.length >= tally.need;
    approvals = tally.permit && !tally.counted.includes(tally.permit) ? [...tally.counted, tally.permit] : tally.counted;
    needed = tally.need;
    mismatched = tally.mismatched;
  } else {
    const at = (r: GateResolutionRecord) => new Date(r.timestamp).getTime();
    approvals = own
      .filter((r) => r.gate === gate && at(r) >= new Date(since).getTime() && (planDigest === undefined || r.planDigest === planDigest))
      .sort((a, b) => at(a) - at(b));
    approved = approvals.length > 0;
    mismatched = latestResolutionForPlan(own, gate, since, planDigest).mismatched;
  }

  const state: GateState = approved ? "approved" : isPendingGateExpired(standing, now) ? "expired" : mismatched ? "superseded" : "pending";
  return {
    component,
    name: gate,
    env,
    planDigest: planDigest ?? null,
    state,
    recordedAt: standing.timestamp,
    expiresAt: standing.expiresAt,
    approvals: approvals.map(approvalOf),
    needed,
    approve: approveCommand(component, gate, env),
  };
}

/**
 * Every gate in one ledger file, one per gate and environment, for the
 * environments in `envs`. A gate whose facts record no environment (an Op
 * gate) is listed whatever `envs` is. A pending fact with no environment on a
 * gate whose other facts have one is left out, as a run leaves it out: such a
 * line binds no environment, and `chant approve --expire` writes one.
 */
export function gatesInLedger(component: string, content: string, envs: readonly string[], now: string): { gates: StatusGate[]; malformed: number } {
  const { pending, resolutions, malformed } = parseGateLedger(content);
  const gates: StatusGate[] = [];
  for (const gate of [...new Set(pending.map((p) => p.gate))].sort()) {
    const facts = pending.filter((p) => p.gate === gate);
    const bound = facts.some((p) => p.environment !== undefined);
    const byEnv = new Map<string | null, PendingGateRecord[]>();
    for (const p of facts) {
      const env = p.environment ?? null;
      if (bound && env === null) continue;
      if (env !== null && !envs.includes(env)) continue;
      byEnv.set(env, [...(byEnv.get(env) ?? []), p]);
    }
    for (const env of [...byEnv.keys()].sort((a, b) => envs.indexOf(a ?? "") - envs.indexOf(b ?? ""))) {
      gates.push(decide(component, latestPendingGate(byEnv.get(env)!, gate)!, resolutions, now));
    }
  }
  return { gates, malformed };
}

/** Read one member's gate ledger directory at `commit` and list its gates. */
export async function readMemberGates(
  dir: string,
  layout: "members" | "flat",
  commit: string | null,
  envs: readonly string[],
  cwd: string,
  now: string,
  read: GateLedgerReader = defaultGateLedgerReader,
): Promise<{ gates: StatusGate[]; ledger: StatusGateLedger }> {
  const ledger: StatusGateLedger = { layout, path: dir, shared: false, malformed: 0, reason: null };
  if (commit === null) {
    return { gates: [], ledger: { ...ledger, reason: { code: "gates-no-ledger", message: "the checkout has no chant/lifecycle branch, so no gate is recorded in it" } } };
  }
  let files: Map<string, string> | null;
  try {
    files = await read(dir, commit, cwd);
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return { gates: [], ledger: { ...ledger, reason: { code: "gates-ledger-unreadable", message: `${dir}: ${message}` } } };
  }
  if (files === null) {
    return { gates: [], ledger: { ...ledger, reason: { code: "gates-no-gate-ledger", message: `${dir} does not exist on chant/lifecycle: no run has reached a gate` } } };
  }
  const gates: StatusGate[] = [];
  for (const component of [...files.keys()].sort()) {
    const read = gatesInLedger(component, files.get(component)!, envs, now);
    gates.push(...read.gates);
    ledger.malformed += read.malformed;
  }
  return { gates, ledger };
}
