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
 * Its human quorum reaches back to `humanQuorumSince` (#3206), as a run's does.
 */

import { execFileSync } from "node:child_process";
import { samePlanDigest } from "../lifecycle/plan-digest";
import type { GateResolutionRecord, PendingGateRecord } from "../lifecycle/gate-ledger";
import { isPendingGateExpired, latestPendingGate, latestResolutionForPlan, parseGateLedger } from "../lifecycle/gate-ledger";
import { humanQuorumSince, tallyGateApprovals, type GateApprovalRule } from "../op/gate";
import type { ReasonCode } from "./reason-codes";
import type { ReleaseRevocation } from "../lifecycle/release-revocation";
import { CHANGE_SETS_DIR, changeSetFile } from "../lifecycle/change-set-store";

/** The stored change-set directory beside a gate ledger directory: `<prefix>_change-sets`. */
function changeSetDirFor(gatesDir: string): string {
  const at = gatesDir.lastIndexOf("/");
  return at < 0 ? CHANGE_SETS_DIR : `${gatesDir.slice(0, at)}/${CHANGE_SETS_DIR}`;
}

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
  /** Who relayed it for `principal` (`chant approve --relayed-by`, #3402), or null when nobody did. */
  relayedBy: string | null;
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
  /**
   * The release the gate binds (#4045), from the pending fact: on a release
   * gate, the one `chant components promote --release` passes, recorded
   * under the op `release`. Absent on every other gate and on a fact written
   * before chant 0.124.28.
   */
  releaseDigest?: string;
  state: GateState;
  /**
   * Set on a release gate whose release was cut from a revoked commit
   * (#4033, ws-105): the revoked tag on that commit. The gate is then
   * `superseded` (or `expired`), and `chant approve` refuses it with
   * `release-revoked`. Added by `workspace status`; absent otherwise.
   */
  revoked?: ReleaseRevocation;
  /** When the run recorded the pending fact the state is read against. */
  recordedAt: string;
  /** The commit the run reached the gate at (#4020), from the pending fact. Absent on a fact written before chant 0.124.28. */
  gitSha?: string;
  /** The run that reached the gate (#4020), from the pending fact: an Op run id, or the CI run id. Absent when the run had none. */
  runId?: string;
  /**
   * The change set the gate binds (#4022): `planDigest`, when a change-set
   * document is stored under it in the member's `_change-sets/`, read with
   * `chant change-set show <digest>`. Absent when none is stored, as for a
   * component gate, which binds a lifecycle-plan digest.
   */
  changeSet?: string;
  expiresAt: string;
  /** The approvals that count toward the gate for this plan, oldest first. */
  approvals: StatusGateApproval[];
  /** How many human approvals the gate needs: its quorum's count, 1 without one. */
  needed: number;
  /**
   * The declaration's rule for the gate (#3163, ws-080): set when
   * `identity.gates` names it, so only an approval sealed by a signer at
   * base (from `class`, when it names one) counts, and `approve` carries
   * `--sign`. Null when any approval counts.
   */
  signed: { class: string | null } | null;
  /**
   * The command that approves it, run in the member's directory. For a gate
   * that asks a decision point (#3170), the `chant workspace points answer`
   * line for its open question.
   */
  approve: string;
  /**
   * The open question the gate waits on, when it asks a decision point
   * (#3170): the point, the answer record's id and its path. Absent on a
   * gate `chant approve` passes.
   */
  answer?: { point: string; id: string; path: string };
}

/** The rule for a gate, by name, as `identity.gates` at base sets it (#3163). Null when it sets none. */
export type GateRuleLookup = (gate: string) => GateApprovalRule | null;

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

/**
 * Lists the file names in a stored change-set directory on the branch at
 * `commit`, or an empty set when it doesn't exist or can't be read: a gate
 * then shows no link, and its state is read the same.
 */
export type ChangeSetLister = (dir: string, commit: string, cwd: string) => Promise<Set<string>>;

export const defaultChangeSetLister: ChangeSetLister = async (dir, commit, cwd) => {
  try {
    return new Set(git(cwd, ["ls-tree", "--name-only", `${commit}:${dir}`]).split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
};

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

/**
 * The exact `chant approve` line for a gate. A gate bound to a plan (#2300)
 * gets `--plan <digest>` too (#2832), so running the line back approves the
 * plan this read showed and not whatever happens to be pending by the time
 * someone runs it.
 */
export function approveCommand(component: string, gate: string, env: string | null, planDigest?: string | null, signed = false): string {
  return `chant approve ${component} ${gate}${env !== null ? ` --env ${env}` : ""}${planDigest ? ` --plan ${planDigest}` : ""}${signed ? " --sign" : ""}`;
}

const approvalOf = (r: GateResolutionRecord): StatusGateApproval => ({ principal: r.resolvedBy, channel: r.origin ?? null, relayedBy: r.relayedBy ?? null, at: r.timestamp });

/** One gate in one environment, decided against its newest pending fact. */
function decide(component: string, standing: PendingGateRecord, facts: PendingGateRecord[], all: GateResolutionRecord[], now: string, rule: GateApprovalRule | null): StatusGate {
  const gate = standing.gate;
  // #3163: under identity.gates, an unsigned approval, or one from outside the class, doesn't count, as a run reads it.
  // #4045: nor does an approval for another release, and an `empty` pass is never an approval.
  const resolutions = all
    .filter((r) => r.gate !== gate || (r.empty !== true && r.releaseDigest === standing.releaseDigest))
    .filter((r) => rule === null || r.gate !== gate || rule.refuses(r) === null);
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
    // #3206: a human approval from before a fact re-recorded for a mode or context change still counts.
    const tally = tallyGateApprovals(own, gate, since, planDigest, standing.approval, humanQuorumSince(facts, standing));
    approved = tally.permit !== undefined || tally.met;
    approvals = tally.permit && !tally.counted.includes(tally.permit) ? [...tally.counted, tally.permit] : tally.counted;
    needed = tally.need;
    mismatched = tally.mismatched;
  } else {
    const at = (r: GateResolutionRecord) => new Date(r.timestamp).getTime();
    approvals = own
      .filter((r) => r.gate === gate && at(r) >= new Date(since).getTime() && (planDigest === undefined || samePlanDigest(r.planDigest, planDigest)))
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
    ...(standing.releaseDigest !== undefined ? { releaseDigest: standing.releaseDigest } : {}),
    state,
    recordedAt: standing.timestamp,
    ...(standing.gitSha ? { gitSha: standing.gitSha } : {}),
    ...(standing.runId ? { runId: standing.runId } : {}),
    expiresAt: standing.expiresAt,
    approvals: approvals.map(approvalOf),
    needed,
    signed: rule === null ? null : { class: rule.requirement.class },
    approve: standing.answer ? `chant workspace points answer ${standing.answer.id} --answer <value> --by <name>` : approveCommand(component, gate, env, planDigest, rule !== null),
    ...(standing.answer ? { answer: { point: standing.answer.point, id: standing.answer.id, path: standing.answer.path } } : {}),
  };
}

/**
 * Every gate in one ledger file, one per gate and environment, for the
 * environments in `envs`. A gate whose facts record no environment (an Op
 * gate) is listed whatever `envs` is. A pending fact with no environment on a
 * gate whose other facts have one is left out, as a run leaves it out: such a
 * line binds no environment, and `chant approve --expire` writes one.
 */
export function gatesInLedger(component: string, content: string, envs: readonly string[], now: string, rules: GateRuleLookup = () => null): { gates: StatusGate[]; malformed: number } {
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
      const envFacts = byEnv.get(env)!;
      gates.push(decide(component, latestPendingGate(envFacts, gate)!, envFacts, resolutions, now, rules(gate)));
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
  rules: GateRuleLookup = () => null,
  listChangeSets: ChangeSetLister = defaultChangeSetLister,
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
    const read = gatesInLedger(component, files.get(component)!, envs, now, rules);
    gates.push(...read.gates);
    ledger.malformed += read.malformed;
  }
  // #4022: link each gate to the change set stored under its plan digest,
  // in the same member's `_change-sets/` beside `_gates/`.
  if (gates.some((g) => g.planDigest !== null)) {
    const stored = await listChangeSets(changeSetDirFor(dir), commit, cwd);
    for (const g of gates) {
      if (g.planDigest !== null && stored.has(changeSetFile(g.planDigest))) g.changeSet = g.planDigest;
    }
  }
  return { gates, ledger };
}
