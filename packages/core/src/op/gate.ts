/**
 * Gate-as-fact (#2119, epic #2114) — the one place that decides what happens
 * when a run reaches a `gate`, shared by the Op executor
 * (`./local-executor.ts`) and the component driver
 * (`../components/driver.ts`) so the two can never drift.
 *
 * A gate used to be a wait, which meant a runtime that cannot wait had to
 * refuse the whole op before its first step (`LocalGateUnsupportedError`,
 * deleted with this). It is a fact now: the run reads the gate ledger
 * (`../lifecycle/gate-ledger.ts`) for a resolution someone wrote with `chant
 * approve`, and either walks through carrying the approver, or records a
 * pending fact and ends. Nothing blocks, nothing is queued, nothing has to be
 * resumed — the next run re-evaluates from the ledger, which is exactly the
 * level-triggered shape a converge tick already has.
 *
 * The staleness rule is the same one `chant operator status` has applied since
 * #1485: a resolution counts only if it is newer than the newest pending fact
 * for that gate. Approving before the gate was ever reached does not
 * pre-authorize a future run's gate that has since been recorded pending; a
 * resolution from last month does not answer the fact this run just wrote.
 *
 * Since #2300 a gate can also bind a plan. `GateCheckInput.planDigest` is
 * what this run's Plan phase produced (`../lifecycle/plan-digest.ts`), and a
 * resolution counts only when it was recorded for that same plan — recency
 * demoted from the criterion to the tiebreak. Approve, edit the root, re-run,
 * and the gate refuses by name instead of applying something no approver saw,
 * which is what INTENTIUS/choudoufu#1026 measured it doing. A gate with no
 * `planDigest` decides exactly as it did before.
 *
 * Ledger access goes through {@link GateLedgerPort} rather than straight to
 * git, so a test (and the operator's own in-memory paths) can drive the
 * decision without an orphan branch on disk.
 */

import {
  appendGateResolution,
  appendPendingGate,
  isPendingGateExpired,
  latestPendingGate,
  latestResolutionForPlan,
  readGateLedger,
  resolveApprovalUrl,
  DEFAULT_GATE_EXPIRY,
  type GateResolutionInput,
  type GateResolutionRecord,
  type PendingGateInput,
  type PendingGateRecord,
} from "../lifecycle/gate-ledger";
import { describePlanDigest, samePlanDigest } from "../lifecycle/plan-digest";
import { isModelAuthored } from "../lifecycle/gate-origin";
import { sortedJsonReplacer } from "../utils";
import type { GateApprover, ResolvedGateApproval } from "./gate-approval";
import { pushLifecycleReport, requireLifecycleLedger } from "../lifecycle/git";
import { parseDuration } from "./duration";
import { resolveGateRunLocator } from "./gate-resume";

/**
 * What appending a pending fact learned about reaching the remote.
 *
 * The append to the local `chant/lifecycle` branch always lands — that half
 * was fixed by #2309's fetch-before-append. This is the other half: whether
 * the push that follows it did, and why not when it didn't, in one line a
 * renderer can show directly (#2310).
 */
export interface PendingGatePush {
  record: PendingGateRecord;
  /**
   * True when the push reached the remote. False when there was no remote
   * configured, or the push was rejected — `pushWarning` says which.
   */
  pushed: boolean;
  /**
   * Set when `pushed` is false. With no remote it is the lifecycle module's
   * `LIFECYCLE_LOCAL_NOTE`, which renderers show as a note, not a warning (#3677).
   */
  pushWarning?: string;
}

/** The gate ledger, as the two executors need it: read both kinds of line, append a pending fact. */
export interface GateLedgerPort {
  read(op: string): Promise<{ resolutions: GateResolutionRecord[]; pending: PendingGateRecord[] }>;
  appendPending(input: PendingGateInput): Promise<PendingGatePush>;
  /**
   * Append a resolution the run itself writes (#3170): a gate that asks a
   * decision point records the answer that passed it. Absent on a port that
   * only plain gates use.
   */
  appendResolution?(input: GateResolutionInput): Promise<{ record: GateResolutionRecord; pushed: boolean; pushWarning?: string }>;
  /**
   * The rule a workspace sets for approvals of `gate` (#3163, ws-080), or
   * null when none applies: the declaration's `identity.gates`, read at base.
   * Absent, every approval is judged as before.
   */
  approvalRule?(gate: string): Promise<GateApprovalRule | null>;
}

/** A workspace's rule for which approvals of a gate count (#3163): a signed approval, from a class when it names one. */
export interface GateApprovalRule {
  requirement: { gate: string; class: string | null };
  /** Why `approval` doesn't count, or null when it does. */
  refuses(approval: GateResolutionRecord): string | null;
}

/**
 * The real port: the `chant/lifecycle` orphan branch.
 *
 * Appending is always local-first and always lands (#2309's fetch-before-
 * append). The push that follows is reported rather than swallowed (#2310):
 * a pending fact that never reaches the remote is still a correct local
 * answer — the run is right to gate, and does — but an operator elsewhere
 * cannot approve a gate whose pending record they cannot see, so the caller
 * gets `pushed: false` and a reason instead of silence. Mirrors the shape
 * `chant approve` reports through (`../cli/handlers/operator.ts`'s
 * `reportedPush`, #2309 review).
 */
export function gitGateLedgerPort(opts?: { cwd?: string }): GateLedgerPort {
  return {
    async read(op) {
      // The ledger branch has to be in the checkout before it is read
      // (#2303): a CI clone fetches the pipeline's own ref and nothing else,
      // and an unfetched branch reads as an empty ledger — which is
      // indistinguishable from "nothing has been approved" and makes a
      // retried job record a second pending fact for a gate that was already
      // approved. Refuses rather than guessing when the fetch cannot settle
      // it; see `requireLifecycleLedger`.
      await requireLifecycleLedger(opts);
      const { resolutions, pending } = await readGateLedger(op, opts);
      return { resolutions, pending };
    },
    async approvalRule(gate) {
      // Loaded on demand: the rule lives in the workspace modules, which import the Op modules.
      const { gateAdmission } = await import("../workspace/identity");
      return gateAdmission(opts?.cwd ?? process.cwd(), gate);
    },
    async appendResolution(input) {
      const { record } = await appendGateResolution(input, opts);
      return { record, ...(await pushLifecycleReport(opts)) };
    },
    async appendPending(input) {
      const { record } = await appendPendingGate(input, opts);
      return { record, ...(await pushLifecycleReport(opts)) };
    },
  };
}

/** A gate ledger held in memory — what a test, or a caller that has already read the ledger, hands {@link evaluateGate}. */
export function memoryGateLedgerPort(
  seed: { resolutions?: GateResolutionRecord[]; pending?: PendingGateRecord[] } = {},
): GateLedgerPort & { appended: PendingGateRecord[]; resolved: GateResolutionRecord[] } {
  const resolutions = [...(seed.resolutions ?? [])];
  const pending = [...(seed.pending ?? [])];
  const appended: PendingGateRecord[] = [];
  const resolved: GateResolutionRecord[] = [];
  return {
    appended,
    resolved,
    async read() {
      return { resolutions: [...resolutions], pending: [...pending] };
    },
    async appendResolution(input) {
      const record: GateResolutionRecord = { version: 1, ...input };
      resolutions.push(record);
      resolved.push(record);
      return { record, pushed: true };
    },
    async appendPending(input) {
      const record: PendingGateRecord = { version: 1, kind: "pending", ...input };
      pending.push(record);
      appended.push(record);
      // No remote in an in-memory ledger — there is nothing to fail to reach.
      return { record, pushed: true };
    },
  };
}

/** What a caller has to say about the gate it just reached. */
export interface GateCheckInput {
  /** The op the gate belongs to — the component's name, on the driver. */
  op: string;
  /** The gate's signal name. */
  gate: string;
  description?: string;
  /** The gate's authored `timeout`, which becomes the pending fact's expiry. Default {@link DEFAULT_GATE_EXPIRY}. */
  timeout?: string;
  /** Identifies the run that reached the gate, when the caller has one. */
  runId?: string;
  /**
   * The plan this run reached the gate with (#2300) — `computePlanDigest`'s
   * output (`../lifecycle/plan-digest.ts`), from the Plan phase that ran a
   * moment ago.
   *
   * Supplying it makes the gate plan-bound: only a resolution recorded for
   * this exact digest satisfies it, and one recorded for a different plan (or
   * for no plan at all) is reported as a {@link GateDigestMismatch} instead.
   * Omitting it keeps the pre-#2300 rule, where the newest resolution since
   * the standing pending fact satisfies the gate whatever has changed since.
   */
  planDigest?: string;
  /**
   * The environment this run deploys to (#2574). The component driver sets it,
   * because a component's gate ledger is keyed by component and holds every
   * environment's facts. Set, the gate reads only this environment's pending
   * facts and resolutions (plus resolutions that record no environment, which
   * come back as a mismatch), and the pending fact it records carries it.
   */
  environment?: string;
  /**
   * The gate's quorum and policy (#2508), context already resolved. Absent,
   * one approval passes the gate, which is the rule every gate had before.
   * Present, {@link tallyGateApprovals} decides, and the pending fact carries
   * it so `chant approve` can evaluate the policy.
   */
  approval?: ResolvedGateApproval;
  /** ISO-8601 "now" — supplied by the caller, so the decision is deterministic under test. */
  now?: string;
}

/**
 * A standing resolution that answers this gate but not this plan (#2300) —
 * what a refusal names.
 */
export interface GateDigestMismatch {
  /** The plan that was approved. `undefined` for a resolution written before #2300, which recorded no plan at all. */
  approved?: string;
  /** The plan this run's Plan phase produced. */
  planned: string;
  /** Who recorded the approval that does not apply here. */
  resolvedBy: string;
  /** When they recorded it. */
  timestamp: string;
  /** The environment this run deploys to, on a component gate (#2574). The approve command a refusal prints names it. */
  environment?: string;
}

/**
 * The refusal line for a {@link GateDigestMismatch}: which plan was approved,
 * which was planned, and what closes the gap. One function so the executor's
 * step record, the human render and the CI summary say the same thing.
 *
 * The two cases get different prose because they are different facts. A
 * resolution for another plan means something changed between the approval
 * and this run. A resolution with no plan on it means nothing is known to
 * have changed — the record simply never said what it approved, which is
 * every record written before #2300.
 */
export function describeGateMismatch(op: string, gate: string, mismatch: GateDigestMismatch, sealed = false): string {
  const why =
    mismatch.approved === undefined
      ? mismatch.environment !== undefined
        ? "That approval predates environment- and plan-bound component gates (#2574) and records neither, " +
          "so it cannot answer for this one. Approving again binds it:"
        : "That resolution predates plan-bound gates (#2300) and records no plan at all, so it cannot " +
          "answer for this one. Approving again binds it:"
      : "The configuration or the live system changed between that approval and this plan, so it needs " +
        "a fresh one:";
  return (
    `Gate "${gate}" is approved, but not for this plan. ` +
    `approved: ${describePlanDigest(mismatch.approved)} (by ${mismatch.resolvedBy} at ${mismatch.timestamp}); ` +
    `planned: ${mismatch.planned}. ` +
    `${why} ${approveCommand(op, gate, mismatch.environment, undefined, sealed)}`
  );
}

/** How far a gate with a quorum has got (#2508). */
export interface GateQuorumProgress {
  /** Approvers whose approval counts toward the quorum, oldest first. */
  approvers: string[];
  need: number;
}

/** Either the gate is answered, or it is a standing fact. */
export type GateCheck =
  | {
      satisfied: true;
      /** The approval that completed the gate: the newest counted one, or the permit that passed it. */
      resolution: GateResolutionRecord;
      /**
       * Set on a gate that declares `approval` (#2508). `"quorum"` when enough
       * human approvals were recorded, `"policy"` when an `enforce`-mode permit
       * passed it on its own.
       */
      via?: "quorum" | "policy";
      /** Every approval that counted toward the quorum. Set with `via`. */
      approvals?: GateResolutionRecord[];
    }
  | {
      satisfied: false;
      pending: PendingGateRecord;
      recorded: boolean;
      /**
       * Whether this run's own append reached the remote — set only when
       * `recorded` is true. A gate left standing from an earlier run pushed
       * (or didn't) on that run; this one wrote nothing, so it has nothing
       * new to report (#2310).
       */
      pushed?: boolean;
      /** Set when `pushed` is false. */
      pushWarning?: string;
      /** Present when a resolution stands for this gate but for another plan (#2300). */
      mismatch?: GateDigestMismatch;
      /** Present on a gate with a quorum (#2508): who has approved this plan so far. */
      quorum?: GateQuorumProgress;
    };

/** How a recorded approval reads: its own `approver`, or for a record written before #2508, a human unless a model-authored channel wrote it. */
export function approverOf(record: GateResolutionRecord): GateApprover {
  if (record.approver) return record.approver;
  return { kind: isModelAuthored(record.origin) ? "agent" : "human" };
}

/** What {@link tallyGateApprovals} found. */
export interface GateTally {
  /** Distinct human approvers of this plan who count toward the quorum, one record each (their newest), oldest first. */
  counted: GateResolutionRecord[];
  /** The quorum's count, 1 when the gate declares none. */
  need: number;
  /** The newest approval whose recorded permit passes the gate on its own. Only in `enforce` mode, only for a permit recorded under `enforce`, and only under the gate's current policy version. */
  permit?: GateResolutionRecord;
  /** The newest approval of this gate for a different plan, when the gate binds one. */
  mismatched?: GateResolutionRecord;
}

/**
 * Tally the approvals that answer a gate with an `approval` block (#2508).
 *
 * An approval counts only if it is newer than `sinceIso` (the standing pending
 * fact) and, on a plan-bound gate, recorded for `planDigest`. So a changed
 * plan invalidates every approval collected for the old one, the rule #2300
 * set for a single approval.
 *
 * Of those, only a human's counts toward the quorum, once per `resolvedBy`,
 * and only with one of the quorum's roles when it names any. An agent counts
 * only through a recorded `allow` in `enforce` mode, evaluated under the
 * policy version the gate declares now and recorded while the gate was in
 * `enforce` (#2512). A `log-only` decision never changes the outcome, even
 * after the gate switches to `enforce`, and a `deny` never removes a human's approval: a policy can add
 * a way through the gate but cannot take one away.
 */
export function tallyGateApprovals(
  records: GateResolutionRecord[],
  gate: string,
  sinceIso: string,
  planDigest: string | undefined,
  approval: ResolvedGateApproval,
): GateTally {
  const since = new Date(sinceIso).getTime();
  const at = (r: GateResolutionRecord) => new Date(r.timestamp).getTime();
  const roles = approval.quorum?.roles;

  const byActor = new Map<string, GateResolutionRecord>();
  let permit: GateResolutionRecord | undefined;
  let mismatched: GateResolutionRecord | undefined;
  for (const r of records) {
    if (r.gate !== gate || at(r) < since) continue;
    if (planDigest !== undefined && !samePlanDigest(r.planDigest, planDigest)) {
      if (!mismatched || at(r) >= at(mismatched)) mismatched = r;
      continue;
    }

    const decision = r.policyDecision;
    // #2512: the decision must also have been recorded under `enforce`. An
    // allow recorded while the gate was log-only was never binding, and a
    // later switch to enforce does not make it binding.
    if (
      approval.mode === "enforce" && approval.policy && decision?.decision === "allow" &&
      decision.mode === "enforce" &&
      decision.version === approval.policy.version && (!permit || at(r) >= at(permit))
    ) {
      permit = r;
    }

    const approver = approverOf(r);
    if (approver.kind !== "human") continue;
    if (roles && !(approver.roles ?? []).some((role) => roles.includes(role))) continue;
    const prior = byActor.get(r.resolvedBy);
    if (!prior || at(r) >= at(prior)) byActor.set(r.resolvedBy, r);
  }

  const counted = [...byActor.values()].sort((a, b) => at(a) - at(b));
  return {
    counted,
    need: approval.quorum?.count ?? 1,
    ...(permit ? { permit } : {}),
    ...(mismatched ? { mismatched } : {}),
  };
}

/** Whether two resolved approval blocks are the same, so a standing pending fact still describes this gate. */
function sameApproval(a: ResolvedGateApproval | undefined, b: ResolvedGateApproval | undefined): boolean {
  return JSON.stringify(a ?? null, sortedJsonReplacer) === JSON.stringify(b ?? null, sortedJsonReplacer);
}

/** The beginning of time — the anchor for a gate that has never been recorded pending, so any resolution for it counts. */
const EPOCH = new Date(0).toISOString();

/**
 * Decide a gate against the ledger, recording the pending fact when it isn't
 * answered.
 *
 * - A resolution recorded for this run's own plan, newer than the newest
 *   pending fact, satisfies the gate. On a gate that binds no plan
 *   (`input.planDigest` absent) the plan half of that drops out and the rule
 *   is the pre-#2300 one: any resolution newer than the pending fact.
 * - A resolution that stands for the gate but for a different plan does not
 *   satisfy it (#2300). The run is gated, `mismatch` names both plans, and a
 *   fresh pending fact is recorded for the plan that actually ran — so
 *   `chant approve` has something current to approve and the loop closes in
 *   one more command rather than needing the digest typed out.
 * - Otherwise, a pending fact that hasn't expired *and was recorded for this
 *   same plan* stands as it is: the run ends `gated` and the ledger is left
 *   alone, so an operator ticking every minute against an unapproved gate
 *   does not append a line a minute. A pending fact for a different plan is
 *   stale in the way that matters and is replaced.
 * - Otherwise (no pending fact, or the newest one has expired, or it is for
 *   another plan) a fresh pending fact is appended and the run ends `gated`.
 *   `recorded` says which of the two happened, so a renderer can tell "just
 *   recorded" from "still standing".
 */
export async function evaluateGate(port: GateLedgerPort, input: GateCheckInput): Promise<GateCheck> {
  const now = input.now ?? new Date().toISOString();
  const ledger = await port.read(input.op);
  // #2574: a component's ledger holds every environment's facts. This run
  // answers only to its own environment's pending facts and approvals. An
  // approval that records no environment at all is kept, so it comes back as
  // a mismatch with a message instead of silently not counting.
  const env = input.environment;
  const pending = env === undefined ? ledger.pending : ledger.pending.filter((p) => p.environment === env);
  // #3163: a gate the workspace's identity.gates names counts only signed approvals from its class.
  const rule = (await port.approvalRule?.(input.gate)) ?? null;
  const resolutions = (
    env === undefined
      ? ledger.resolutions
      : ledger.resolutions.filter((r) => r.environment === undefined || r.environment === env)
  ).filter((r) => rule === null || r.gate !== input.gate || rule.refuses(r) === null);

  const standing = latestPendingGate(pending, input.gate);
  const since = standing?.timestamp ?? EPOCH;

  let mismatched: GateResolutionRecord | undefined;
  let quorum: GateQuorumProgress | undefined;
  if (input.approval) {
    const tally = tallyGateApprovals(resolutions, input.gate, since, input.planDigest, input.approval);
    if (tally.permit) {
      return { satisfied: true, resolution: tally.permit, via: "policy", approvals: tally.counted };
    }
    if (tally.counted.length >= tally.need) {
      return {
        satisfied: true,
        resolution: tally.counted[tally.counted.length - 1]!,
        via: "quorum",
        approvals: tally.counted,
      };
    }
    mismatched = tally.mismatched;
    quorum = { approvers: tally.counted.map((r) => r.resolvedBy), need: tally.need };
  } else {
    const found = latestResolutionForPlan(resolutions, input.gate, since, input.planDigest);
    if (found.resolution) return { satisfied: true, resolution: found.resolution };
    mismatched = found.mismatched;
  }

  // `input.planDigest` is defined whenever `mismatched` is — `latestResolutionForPlan`
  // returns a mismatch only on the plan-bound path.
  const mismatch: GateDigestMismatch | undefined = mismatched
    ? {
        ...(mismatched.planDigest !== undefined ? { approved: mismatched.planDigest } : {}),
        planned: input.planDigest!,
        resolvedBy: mismatched.resolvedBy,
        timestamp: mismatched.timestamp,
        ...(env !== undefined ? { environment: env } : {}),
      }
    : undefined;
  const asMismatch = { ...(mismatch ? { mismatch } : {}), ...(quorum ? { quorum } : {}) };

  // A standing fact only stands for the plan it was recorded against. When
  // the plan has moved, re-recording is what gives `chant approve` (which
  // defaults to the newest pending fact's digest) the current plan to
  // approve; leaving the old fact standing would make the common path
  // approve a plan that is no longer the one being run.
  // The same holds for the approval block (#2508): a pending fact recorded
  // under another policy version or another context would have `chant
  // approve` evaluate the policy against something this run no longer has.
  if (
    standing && !isPendingGateExpired(standing, now) && samePlanDigest(standing.planDigest, input.planDigest) &&
    sameApproval(standing.approval, input.approval)
  ) {
    return { satisfied: false, pending: standing, recorded: false, ...asMismatch };
  }

  const url = resolveApprovalUrl();
  // #3683: in CI, where this job runs, so an approval can start it again.
  const resume = resolveGateRunLocator();
  const { record, pushed, pushWarning } = await port.appendPending({
    op: input.op,
    gate: input.gate,
    timestamp: now,
    expiresAt: new Date(
      new Date(now).getTime() + parseDuration(input.timeout ?? DEFAULT_GATE_EXPIRY),
    ).toISOString(),
    ...(input.description ? { description: input.description } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(url ? { url } : {}),
    ...(resume ? { resume } : {}),
    ...(input.planDigest !== undefined ? { planDigest: input.planDigest } : {}),
    ...(env !== undefined ? { environment: env } : {}),
    ...(input.approval ? { approval: input.approval } : {}),
  });
  return {
    satisfied: false,
    pending: record,
    recorded: true,
    pushed,
    ...(pushWarning ? { pushWarning } : {}),
    ...asMismatch,
  };
}

/**
 * The line every renderer prints to say how a pending gate is cleared. A
 * component gate names its environment (#2574), so the approval picks that
 * environment's pending fact when others stand beside it. A gate bound to a
 * plan (#2300) gets `--plan <digest>` too (#2832), so the line approves the
 * plan the reader was shown and not whatever is pending by the time they run
 * it.
 */
export function approveCommand(op: string, gate: string, environment?: string, planDigest?: string, sealed = false): string {
  return `chant approve ${op} ${gate}` +
    (environment === undefined ? "" : ` --env ${environment}`) +
    (planDigest === undefined ? "" : ` --plan ${planDigest}`) +
    (sealed ? " --sign" : "");
}

/**
 * Whether the workspace seals `gate` (`identity.gates`), so an approval
 * without `--sign` doesn't count. Callers pass the answer to
 * {@link approveCommand} so the hint names the flag. Loaded on demand, as the
 * git ledger port does: the workspace modules import the Op modules. A read
 * that throws counts as unsealed, since the hint is advice and not the check.
 */
export async function gateIsSealed(gate: string, cwd: string = process.cwd()): Promise<boolean> {
  try {
    const { gateAdmission } = await import("../workspace/identity");
    return gateAdmission(cwd, gate) !== null;
  } catch {
    return false;
  }
}
