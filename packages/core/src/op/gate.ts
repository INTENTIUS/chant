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

import type { ChangeSetDocument } from "../change-set";
import { persistChangeSet } from "../lifecycle/change-set-store";
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
import { appliedGatePath, isApprovalSpent, parseAppliedGateLines, type AppliedGateRecord } from "../lifecycle/gate-applied";
import { sortedJsonReplacer } from "../utils";
import { gateContextDigest, type GateApprover, type GateBaseApproval, type ResolvedGateApproval } from "./gate-approval";
import {
  quorumNeed, quorumRuleProgress, quorumRules, ruleNeedsProof, samePrincipal, trustQuorumJudge, UNPROVEN_JUDGE,
  type GateQuorumJudge, type GateQuorumRuleProgress, type GateQuorumSpec,
} from "./gate-quorum";
import { pushLifecycleReport, readBlobBySha, readBlobFromPath, readPathSha, requireLifecycleLedger, writeBlobToPath, RefCASConflictError } from "../lifecycle/git";
import { parseDuration } from "./duration";
import { ciRunIdFromEnv, resolveGateRunLocator } from "./gate-run-locator";
import { resolveCommitSha } from "../lifecycle/commit-sha";
import { refuseGateWithoutRecording } from "../lifecycle/no-record";
import { gateCheckpointDigest, gateCheckpointText, readGateCheckpointText, writeGateCheckpoint, type GateCheckpoint } from "../lifecycle/gate-checkpoint";
import type { ResolvedGateAlias } from "./gate-alias";

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
   * `at.base` names that commit, as an op wave reads every rule at its
   * `--base` (#3841); absent, origin/HEAD, else `main`, else `master`.
   * Absent, every approval is judged as before.
   */
  approvalRule?(gate: string, at?: { base?: string }): Promise<GateApprovalRule | null>;
  /**
   * The judge a gate's approval rules are met by (#4290): which approvals
   * prove their approver (a seal verified against the signers at base) and
   * the roles `.chant/trust.json` at base gives them. `at.base` as for
   * {@link GateLedgerPort.approvalRule}. Absent, no approval proves anyone,
   * so a rule naming roles is never met.
   */
  quorumJudge?(gate: string, at?: { base?: string }): Promise<GateQuorumJudge>;
  /** The approvals a wave applied under (#3784), from `_gates/<op>/applied.jsonl`. Absent on a port that never spends approvals. */
  readApplied?(op: string): Promise<AppliedGateRecord[]>;
  /** Record that a wave is about to apply under an approval (#3784), which spends it. */
  appendApplied?(record: AppliedGateRecord): Promise<{ pushed: boolean; pushWarning?: string }>;
  /**
   * Store the checkpoint of a run that stops at a gate that resumes (#3947),
   * at `_gates/<op>/checkpoints/<runId>.json`. Written before the pending
   * fact that names its digest, and pushed with it. Absent on a port that
   * keeps none, and the gate then doesn't resume.
   */
  writeCheckpoint?(checkpoint: GateCheckpoint): Promise<void>;
  /** The text of a run's checkpoint, or null when there is none (#3947). */
  readCheckpoint?(op: string, runId: string): Promise<string | null>;
  /**
   * Store a change-set document under its digest in `_change-sets/`
   * (#4551), before the pending fact that cites it as `changeSet`. Throws for
   * a document that is not one or does not hash to its digest. Absent on a
   * port that keeps none, and the fact then cites none.
   */
  storeChangeSet?(doc: ChangeSetDocument): Promise<void>;
}

/** A workspace's rule for which approvals of a gate count (#3163): a signed approval, from a class when it names one. */
export interface GateApprovalRule {
  /**
   * `quorum` (#4324) is the entry's `identity.gates.<gate>.quorum` at base:
   * the rules an Op gate of that name takes in place of its own. `policy`,
   * `mode` and `context` (#4404) are read the same way. Each is absent or
   * null when the entry sets none.
   */
  requirement: { gate: string; class: string | null; quorum?: GateQuorumSpec | null } & GateBaseApproval;
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
    async approvalRule(gate, at) {
      // Loaded on demand: the rule lives in the workspace modules, which import the Op modules.
      const { gateAdmission } = await import("../workspace/identity");
      return gateAdmission(opts?.cwd ?? process.cwd(), gate, at?.base);
    },
    async quorumJudge(_gate, at) {
      // #4290: the signers and role grants at base, never the approver's claim.
      const { scopeSource } = await import("../workspace/write-scope");
      const { policy } = scopeSource(opts?.cwd ?? process.cwd(), at?.base);
      return trustQuorumJudge({ signers: policy, roles: policy.roles });
    },
    async appendResolution(input) {
      const { record } = await appendGateResolution(input, opts);
      return { record, ...(await pushLifecycleReport(opts)) };
    },
    async appendPending(input) {
      const { record } = await appendPendingGate(input, opts);
      return { record, ...(await pushLifecycleReport(opts)) };
    },
    async writeCheckpoint(checkpoint) {
      await writeGateCheckpoint(checkpoint, opts);
    },
    async readCheckpoint(op, runId) {
      await requireLifecycleLedger(opts);
      return readGateCheckpointText(op, runId, opts);
    },
    async storeChangeSet(doc) {
      // Pushed with the pending fact that cites it.
      await persistChangeSet(doc, opts);
    },
    async readApplied(op) {
      await requireLifecycleLedger(opts);
      const { dir, file } = appliedGatePath(op);
      const text = await readBlobFromPath(dir, file, opts);
      return text ? parseAppliedGateLines(text) : [];
    },
    async appendApplied(record) {
      const { dir, file } = appliedGatePath(record.op);
      const line = JSON.stringify(record, sortedJsonReplacer);
      // #3985: write on top of the remote's ledger, not a local copy another
      // writer has since moved past, so the push that follows can land.
      await requireLifecycleLedger(opts);
      let lastErr: unknown;
      // The same append-and-retry as a ledger line: another writer to the branch is the ordinary case.
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const prior = await readPathSha(dir, file, opts);
          const existing = prior ? await readBlobBySha(prior, opts) : null;
          await writeBlobToPath(dir, file, existing ? `${existing.replace(/\n$/, "")}\n${line}\n` : `${line}\n`, `Applied under ${record.gate}`, {
            ...opts,
            expectPriorPathSha: prior,
          });
          return pushLifecycleReport(opts);
        } catch (err) {
          if (!(err instanceof RefCASConflictError)) throw err;
          lastErr = err;
        }
      }
      throw lastErr;
    },
  };
}

/** A gate ledger held in memory — what a test, or a caller that has already read the ledger, hands {@link evaluateGate}. */
export function memoryGateLedgerPort(
  seed: { resolutions?: GateResolutionRecord[]; pending?: PendingGateRecord[]; applied?: AppliedGateRecord[] } = {},
): GateLedgerPort & {
  appended: PendingGateRecord[];
  resolved: GateResolutionRecord[];
  applied: AppliedGateRecord[];
  /** Checkpoint texts by `<op>/<runId>` (#3947). */
  checkpoints: Map<string, string>;
} {
  const resolutions = [...(seed.resolutions ?? [])];
  const pending = [...(seed.pending ?? [])];
  const appended: PendingGateRecord[] = [];
  const resolved: GateResolutionRecord[] = [];
  const applied: AppliedGateRecord[] = [...(seed.applied ?? [])];
  const checkpoints = new Map<string, string>();
  return {
    appended,
    resolved,
    applied,
    checkpoints,
    async writeCheckpoint(checkpoint) {
      checkpoints.set(`${checkpoint.op}/${checkpoint.runId}`, gateCheckpointText(checkpoint));
    },
    async readCheckpoint(op, runId) {
      return checkpoints.get(`${op}/${runId}`) ?? null;
    },
    async readApplied(op) {
      return applied.filter((a) => a.op === op);
    },
    async appendApplied(record) {
      applied.push(record);
      return { pushed: true };
    },
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
  /** Identifies the run that reached the gate, when the caller has one. Absent, a run in CI records the CI run id (#4020). */
  runId?: string;
  /** The commit the run is at (#4020). Absent, the checkout's `HEAD`, else the commit the CI job started for. */
  gitSha?: string;
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
  /**
   * Judges approvals for `approval.quorum`'s rules (#4290). Absent, the
   * port's {@link GateLedgerPort.quorumJudge} at its default base, else no
   * approval proves anyone. A wave passes one that knows the change's author
   * and the merged pull request's review.
   */
  judge?: GateQuorumJudge;
  /**
   * The port's {@link GateLedgerPort.approvalRule} for this gate, when the
   * caller already read it (#4324): the Op executor reads it first, for the
   * quorum at base. Absent, it is read here; null means none applies.
   */
  rule?: GateApprovalRule | null;
  /** ISO-8601 "now" — supplied by the caller, so the decision is deterministic under test. */
  now?: string;
  /**
   * The approvals a wave already applied under (#3784). Given, an approval
   * one of them spent counts for nothing: it neither satisfies the gate nor
   * stands as a mismatch. Absent, nothing is spent.
   */
  spent?: readonly AppliedGateRecord[];
  /**
   * Fields a caller adds to the pending fact it records (#3821), such as an
   * Op waves product's commit and members. Every field this function writes
   * itself wins over one of the same name.
   */
  fields?: Record<string, unknown>;
  /** The pending fact it records carries `neverOverMcp` (#3821, chant#3485). */
  neverOverMcp?: boolean;
  /**
   * The checkpoint of a run at a gate that resumes (#3947). Given, a pending
   * fact this records first stores it through the port's `writeCheckpoint`
   * and carries its digest as `checkpointDigest`. A standing fact with no
   * checkpoint is recorded again, so the gate gets one.
   */
  checkpoint?: GateCheckpoint;
  /**
   * The gate's old names (#3949), each with its Op filled in
   * (`resolveGateAliases` in `./gate-alias.ts`). Read only on a gate bound
   * to a plan. A person's approval recorded under one counts toward this
   * gate when it answers that name's standing pending fact, the fact hasn't
   * expired, it is for `planDigest` and `environment`, neither name has
   * spent it, and it passes this gate's approval rule. An approval this
   * counts is written again under this gate (`carriedFrom`), and a line
   * carried earlier counts only while its alias is still declared.
   */
  aliases?: readonly ResolvedGateAlias[];
  /**
   * The release this gate binds (#4045, ws-104 question 2): set on a release
   * gate, the gate `chant components promote --release` passes for an
   * environment, with `planDigest` the change-set document's digest and
   * `environment` the environment. Set, a resolution counts only when it was
   * recorded for this release as well as this plan and environment, and the
   * pending fact it records carries it. Absent, a resolution recorded for a
   * release never counts.
   */
  releaseDigest?: string;
  /**
   * Whether the change set stored under a digest is empty (#4045, ws-104
   * question 6): read back from `chant/lifecycle` and recomputed, never
   * taken from the resolution. Given, an `empty: true` resolution for this
   * gate, environment, release and plan passes the gate when this says its
   * document is empty; quorum and approval rules don't apply to it. Absent,
   * no `empty` resolution counts.
   */
  verifyEmpty?: (planDigest: string) => Promise<boolean>;
  /**
   * A workspace gate that may stand in for this gate (#2554, #2524 D17,
   * ws-039). Read only on a gate bound to a plan, and only when the gate's
   * own approvals don't pass it. The stand-in decides: it answers an approval
   * only when the member opted in at base and the workspace approval's
   * digest covers this member's plan. Absent, a workspace gate never
   * satisfies this gate.
   */
  workspace?: WorkspaceGateStandIn;
}

/** What a workspace gate approval that stands in for a member gate names (#2554). */
export interface WorkspaceGateStood {
  /** The workspace gate's name. */
  gate: string;
  /** The digest of the member plans the approval covers. */
  digest: string;
  approvedBy: string;
  /** When the workspace approval was recorded. */
  timestamp: string;
}

/** See {@link GateCheckInput.workspace}. */
export interface WorkspaceGateStandIn {
  standIn(q: { op: string; gate: string; planDigest: string; environment?: string }): Promise<WorkspaceGateStood | null>;
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
  /** Where each approval rule the gate takes stands (#4290). Absent when it takes none. */
  rules?: GateQuorumRuleProgress[];
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
       * passed it on its own. `"alias"` (#3949) when an approval recorded
       * under one of the gate's aliases counted, on any gate. `"empty"`
       * (#4045) when a release gate passed over an empty change set, on the
       * `empty: true` resolution the promote wrote, after the stored
       * document was read back and found empty. `"workspace"` (#2554) when a
       * workspace gate's approval stood in for it ({@link GateCheckInput.workspace}).
       */
      via?: "quorum" | "policy" | "alias" | "empty" | "workspace";
      /** Every approval that counted toward the quorum. Set with `via`. */
      approvals?: GateResolutionRecord[];
      /** The approvals this run carried from an alias and wrote under the gate's name (#3949). Set when `via` is `"alias"`. */
      carried?: GateResolutionRecord[];
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
      /**
       * Approvals of this gate and plan, newer than the standing pending fact,
       * that the port's approval rule did not count, and why (#3841), oldest
       * first. Absent when there are none.
       */
      refused?: GateRefusedApproval[];
    };

/** An approval the port's {@link GateLedgerPort.approvalRule} did not count, and why. */
export interface GateRefusedApproval {
  resolution: GateResolutionRecord;
  reason: string;
}

/** How a recorded approval reads: its own `approver`, or for a record written before #2508, a human unless a model-authored channel wrote it. */
export function approverOf(record: GateResolutionRecord): GateApprover {
  if (record.approver) return record.approver;
  return { kind: isModelAuthored(record.origin) ? "agent" : "human" };
}

/** What {@link tallyGateApprovals} found. */
export interface GateTally {
  /** Distinct human approvers of this plan who count toward the quorum, one record each (their newest), oldest first. */
  counted: GateResolutionRecord[];
  /** The most approvers a rule needs, 1 when the gate declares none. */
  need: number;
  /** Every rule is met (#4290); with no rules, one human approved. */
  met: boolean;
  /** Where each rule stands (#4290). Absent when the gate takes no rule. */
  rules?: GateQuorumRuleProgress[];
  /** The newest approval whose recorded permit passes the gate on its own. Only in `enforce` mode, only for a permit recorded under `enforce`, and only under the gate's current policy version and resolved context. */
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
 * set for a single approval. A human's approval may be older than the
 * standing fact, back to `humansSinceIso` ({@link humanQuorumSince}), so a
 * pending fact re-recorded for a changed mode or context keeps a partly
 * filled quorum (#3206). It defaults to `sinceIso`.
 *
 * Of those, only a human's counts toward the quorum, once per `resolvedBy`.
 * The quorum is a list of rules (#4290, `./gate-quorum.ts`), already the ones
 * the gate takes: each is met by distinct humans, counting toward `roles`
 * only an approver `judge` proves and gives one of them (roles from
 * `.chant/trust.json` at base, never the approver's claim), and the gate
 * passes when every rule is met. With no rule, one human passes it. An agent counts
 * only through a recorded `allow` in `enforce` mode, evaluated under the
 * policy version the gate declares now, recorded while the gate was in
 * `enforce` (#2512), and evaluated under the context the gate resolves now
 * (#3774). A `log-only` decision never changes the outcome, even
 * after the gate switches to `enforce`, and a `deny` never removes a human's approval: a policy can add
 * a way through the gate but cannot take one away.
 */
export function tallyGateApprovals(
  records: GateResolutionRecord[],
  gate: string,
  sinceIso: string,
  planDigest: string | undefined,
  approval: ResolvedGateApproval,
  humansSinceIso: string = sinceIso,
  judge: GateQuorumJudge = UNPROVEN_JUDGE,
): GateTally {
  const since = new Date(sinceIso).getTime();
  const humansSince = Math.min(since, new Date(humansSinceIso).getTime());
  const at = (r: GateResolutionRecord) => new Date(r.timestamp).getTime();
  const rules = quorumRules(approval.quorum);
  const context = gateContextDigest(approval.context);

  // Each human once: their newest approval, or their newest proven one when they have one.
  const byActor = new Map<string, { record: GateResolutionRecord; proven: boolean }>();
  let permit: GateResolutionRecord | undefined;
  let mismatched: GateResolutionRecord | undefined;
  for (const r of records) {
    if (r.gate !== gate || at(r) < humansSince) continue;
    if (planDigest !== undefined && !samePlanDigest(r.planDigest, planDigest)) {
      if (at(r) >= since && (!mismatched || at(r) >= at(mismatched))) mismatched = r;
      continue;
    }

    const decision = r.policyDecision;
    // #3206: an approval from before the standing fact can only be a human's
    // toward the quorum. A permit is anchored on the standing fact, the one
    // `chant approve` evaluated it under.
    const sinceStanding = at(r) >= since;
    // #2512: the decision must also have been recorded under `enforce`. An
    // allow recorded while the gate was log-only was never binding, and a
    // later switch to enforce does not make it binding. #3774: and under
    // the context this run resolved, since the run checks approvals before it
    // re-records the pending fact for a changed context.
    if (
      sinceStanding && approval.mode === "enforce" && approval.policy && decision?.decision === "allow" &&
      decision.mode === "enforce" && decision.version === approval.policy.version &&
      decision.contextDigest === context && (!permit || at(r) >= at(permit))
    ) {
      permit = r;
    }

    if (approverOf(r).kind !== "human") continue;
    const key = r.resolvedBy.normalize("NFKC").trim().toLowerCase();
    const proven = rules.some(ruleNeedsProof) && judge(r).proven;
    const prior = byActor.get(key);
    if (!prior || (proven && !prior.proven) || (proven === prior.proven && at(r) >= at(prior.record))) byActor.set(key, { record: r, proven });
  }

  const humans = [...byActor.values()].map((v) => v.record).sort((a, b) => at(a) - at(b));
  const extra = { ...(permit ? { permit } : {}), ...(mismatched ? { mismatched } : {}) };
  if (rules.length === 0) return { counted: humans, need: 1, met: humans.length >= 1, ...extra };
  const approvers = humans.map((r) => ({ who: r.resolvedBy, at: r.timestamp, judged: judge(r) }));
  const progress = rules.map((rule) => quorumRuleProgress(rule, approvers));
  const counted = humans.filter((r) => progress.some((p) => p.approvers.some((a) => samePrincipal(a, r.resolvedBy))));
  return { counted, need: quorumNeed(rules), met: progress.every((p) => p.met), rules: progress, ...extra };
}

/**
 * Where a gate's human quorum starts counting (#3206): the oldest pending fact
 * in the unbroken run of facts, newest first from `standing`, recorded for
 * `standing`'s plan and policy version.
 *
 * A pending fact is re-recorded when anything in the approval block changes,
 * the mode and the context included, so `chant approve` evaluates the policy
 * under what the gate now declares. A human's approval counts for the plan
 * it names whatever the mode or context was, so re-recording for one of
 * those must not drop it. The run stops at a fact for another plan or policy
 * version, which needs fresh approvals, and at one that had expired by the
 * time the next was recorded, which expiry already closed.
 *
 * `pending` may hold every pending fact in the ledger; only `standing`'s gate
 * and environment are read.
 */
export function humanQuorumSince(pending: readonly PendingGateRecord[], standing: PendingGateRecord): string {
  const at = (p: PendingGateRecord) => new Date(p.timestamp).getTime();
  const version = (p: PendingGateRecord) => p.approval?.policy?.version;
  const sameKey = (p: PendingGateRecord) =>
    samePlanDigest(p.planDigest, standing.planDigest) && version(p) === version(standing);
  const older = pending
    .filter((p) => p !== standing && p.gate === standing.gate && p.environment === standing.environment && at(p) <= at(standing))
    .sort((a, b) => at(b) - at(a));
  let anchor = standing;
  for (const p of older) {
    if (!sameKey(p) || isPendingGateExpired(p, anchor.timestamp)) break;
    anchor = p;
  }
  return anchor.timestamp;
}

/**
 * The approvals that answer `standing` (#3949): of its gate, environment and
 * plan, recorded since it, or on a gate with an `approval` block since the
 * human quorum's anchor ({@link humanQuorumSince}). The rule
 * `resolutionAnswering` (`./gate-resume.ts`) decides by, without the tally:
 * each one counts on its own toward a gate an alias names.
 */
export function approvalsAnswering(
  resolutions: readonly GateResolutionRecord[],
  standing: PendingGateRecord,
  pending: readonly PendingGateRecord[] = [standing],
): GateResolutionRecord[] {
  const since = new Date(standing.approval ? humanQuorumSince(pending, standing) : standing.timestamp).getTime();
  return resolutions.filter(
    (r) =>
      r.gate === standing.gate && r.environment === standing.environment && samePlanDigest(r.planDigest, standing.planDigest) &&
      new Date(r.timestamp).getTime() >= since,
  );
}

/**
 * The line a run writes for an approval it carries from an alias (#3949):
 * the approval under `op`/`gate` at `now`, citing the line it came from.
 * The approver, plan, environment, relay and seal are the original's. A
 * policy decision is left behind, since it was evaluated against another
 * gate, and so is a checkpoint digest, which moves onto `carriedFrom`: the
 * approver saw that checkpoint, not one this gate stores, so a carried
 * approval never lets a run resume.
 */
export function carriedApproval(r: GateResolutionRecord, op: string, gate: string, now: string): GateResolutionInput {
  return {
    op,
    gate,
    resolvedBy: r.resolvedBy,
    ...(r.relayedBy !== undefined ? { relayedBy: r.relayedBy } : {}),
    timestamp: now,
    ...(r.note ? { note: r.note } : {}),
    ...(r.url ? { url: r.url } : {}),
    ...(r.planDigest !== undefined ? { planDigest: r.planDigest } : {}),
    ...(r.environment !== undefined ? { environment: r.environment } : {}),
    ...(r.releaseDigest !== undefined ? { releaseDigest: r.releaseDigest } : {}),
    ...(r.origin ? { origin: r.origin } : {}),
    ...(r.sameOriginOverride ? { sameOriginOverride: true } : {}),
    approver: approverOf(r),
    ...(r.seal ? { seal: r.seal } : {}),
    carriedFrom: {
      op: r.op,
      gate: r.gate,
      timestamp: r.timestamp,
      ...(r.checkpointDigest !== undefined ? { checkpointDigest: r.checkpointDigest } : {}),
    },
  };
}

/**
 * The approvals recorded under `input.aliases` that may count toward this
 * gate (#3949), oldest first. Each answers its alias's standing pending
 * fact, which hasn't expired and was recorded for this plan and
 * environment. Each is a person's, is spent under neither name, hasn't been
 * carried already (`ledger` is this gate's own, so a carried line that was
 * spent keeps its original from being carried again), and passes `rule`,
 * whose seal check reads the names the approval was signed under. One the
 * rule refuses is added to `refused`.
 */
async function aliasApprovals(
  port: GateLedgerPort,
  input: GateCheckInput & { aliases: readonly ResolvedGateAlias[] },
  ledger: readonly GateResolutionRecord[],
  rule: GateApprovalRule | null,
  now: string,
  refused: GateRefusedApproval[],
): Promise<GateResolutionRecord[]> {
  const at = (iso: string) => new Date(iso).getTime();
  const carried = ledger.filter((r) => r.gate === input.gate && r.carriedFrom !== undefined);
  const wasCarried = (r: GateResolutionRecord) =>
    carried.some((c) => c.carriedFrom!.op === r.op && c.carriedFrom!.gate === r.gate && at(c.carriedFrom!.timestamp) === at(r.timestamp) && c.resolvedBy === r.resolvedBy);
  const ledgers = new Map<string, Awaited<ReturnType<GateLedgerPort["read"]>>>();
  const out: GateResolutionRecord[] = [];
  for (const alias of input.aliases) {
    let other = ledgers.get(alias.op);
    if (!other) ledgers.set(alias.op, (other = await port.read(alias.op)));
    const pending = other.pending.filter((p) => p.environment === input.environment);
    const standing = latestPendingGate(pending, alias.gate);
    if (!standing || isPendingGateExpired(standing, now) || !samePlanDigest(standing.planDigest, input.planDigest)) continue;
    const spent = alias.op === input.op && input.spent ? input.spent : ((await port.readApplied?.(alias.op)) ?? []);
    for (const r of approvalsAnswering(other.resolutions, standing, pending)) {
      if (r.carriedFrom !== undefined || approverOf(r).kind !== "human" || isApprovalSpent(spent, r) || wasCarried(r)) continue;
      const reason = rule?.refuses(r) ?? null;
      if (reason !== null) {
        refused.push({ resolution: r, reason: `carried from ${alias.op}/${alias.gate}: ${reason}` });
        continue;
      }
      out.push(r);
    }
  }
  return out.sort((a, b) => at(a.timestamp) - at(b.timestamp));
}

/**
 * The commit and run a gate record names (#4020): the input's own, else the
 * checkout's commit and, in CI, the CI run id. Fields nobody knows are left out.
 */
async function runStamp(input: { runId?: string; gitSha?: string }): Promise<{ runId?: string; gitSha?: string }> {
  const runId = input.runId ?? ciRunIdFromEnv();
  const gitSha = input.gitSha ?? (await resolveCommitSha());
  return { ...(runId ? { runId } : {}), ...(gitSha ? { gitSha } : {}) };
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
  // #3955: a run that records nothing cannot be approved or spend an approval.
  refuseGateWithoutRecording(input.op, input.gate);
  const now = input.now ?? new Date().toISOString();
  const ledger = await port.read(input.op);
  // #2574: a component's ledger holds every environment's facts. This run
  // answers only to its own environment's pending facts and approvals. An
  // approval that records no environment at all is kept, so it comes back as
  // a mismatch with a message instead of silently not counting.
  const env = input.environment;
  const pending = env === undefined ? ledger.pending : ledger.pending.filter((p) => p.environment === env);
  // #4045: an approval is for one release. On this gate, a resolution for
  // another release (or for one, on a gate that binds none) never counts; the
  // newest one since the standing fact comes back as a mismatch instead.
  const forOtherRelease = (r: GateResolutionRecord) => r.gate === input.gate && r.releaseDigest !== input.releaseDigest;
  // #3163: a gate the workspace's identity.gates names counts only signed approvals from its class.
  const rule = input.rule !== undefined ? input.rule : ((await port.approvalRule?.(input.gate)) ?? null);
  const standing = latestPendingGate(pending, input.gate);
  const since = standing?.timestamp ?? EPOCH;

  // #4045: a pass over an empty change set. The promote wrote it, and it
  // counts only once the document stored under its plan reads back empty.
  const envResolutions = env === undefined ? ledger.resolutions : ledger.resolutions.filter((r) => r.environment === env);
  if (input.verifyEmpty && input.planDigest !== undefined) {
    const passes = envResolutions
      .filter(
        (r) =>
          r.empty === true && r.gate === input.gate && !forOtherRelease(r) && samePlanDigest(r.planDigest, input.planDigest) &&
          new Date(r.timestamp).getTime() >= new Date(since).getTime() &&
          (input.spent === undefined || !isApprovalSpent(input.spent, r)),
      )
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const pass = passes[passes.length - 1];
    if (pass && (await input.verifyEmpty(input.planDigest))) return { satisfied: true, resolution: pass, via: "empty" };
  }
  // #3949: aliases admit only approvals of this run's plan, and carrying one writes a line.
  const aliases = input.planDigest !== undefined && port.appendResolution ? (input.aliases ?? []) : [];
  const aliased = (from: { op: string; gate: string }) => aliases.some((a) => a.op === from.op && a.gate === from.gate);
  // #3841: an approval of this plan the rule refuses is named, so a wait says why.
  const refused: GateRefusedApproval[] = [];
  const otherRelease: GateResolutionRecord[] = [];
  const resolutions = (
    env === undefined
      ? ledger.resolutions
      : ledger.resolutions.filter((r) => r.environment === undefined || r.environment === env)
  )
    // #4045: an `empty` pass is never an approval; it counts only above.
    .filter((r) => r.empty !== true)
    .filter((r) => {
      if (!forOtherRelease(r)) return true;
      otherRelease.push(r);
      return false;
    })
    // #3949: a carried approval counts only while the gate still names its alias.
    .filter((r) => r.gate !== input.gate || r.carriedFrom === undefined || aliased(r.carriedFrom))
    .filter((r) => input.spent === undefined || r.gate !== input.gate || !isApprovalSpent(input.spent, r))
    .filter((r) => {
      if (rule === null || r.gate !== input.gate) return true;
      const reason = rule.refuses(r);
      if (reason === null) return true;
      if (samePlanDigest(r.planDigest, input.planDigest) && new Date(r.timestamp).getTime() >= new Date(since).getTime()) refused.push({ resolution: r, reason });
      return false;
    });
  const fromAliases = aliases.length > 0 ? await aliasApprovals(port, { ...input, aliases }, ledger.resolutions, rule, now, refused) : [];
  refused.sort((a, b) => new Date(a.resolution.timestamp).getTime() - new Date(b.resolution.timestamp).getTime());

  // #3949: write the approvals that counted from an alias under this gate.
  const carry = async (records: readonly GateResolutionRecord[]): Promise<GateResolutionRecord[]> => {
    const written: GateResolutionRecord[] = [];
    if (records.length === 0) return written;
    // #4020: a carried approval is for this run's gate, so it names this run's commit and run.
    const at = await runStamp(input);
    for (const r of records) written.push((await port.appendResolution!({ ...carriedApproval(r, input.op, input.gate, now), ...at })).record);
    return written;
  };

  let mismatched: GateResolutionRecord | undefined;
  let quorum: GateQuorumProgress | undefined;
  if (input.approval) {
    // #3206: the humans' anchor reaches back past facts re-recorded for this
    // plan and policy version, so a mode or context change keeps the quorum.
    const humansSince =
      standing && samePlanDigest(standing.planDigest, input.planDigest) &&
      standing.approval?.policy?.version === input.approval.policy?.version
        ? humanQuorumSince(pending, standing)
        : since;
    // #4290: who an approval proves, and their roles at base, for rules that read them.
    // #4333: a caller's judge applies to every rule, since it may leave out everyone involved in the change.
    const judge = input.judge ?? (quorumRules(input.approval.quorum).some(ruleNeedsProof) ? ((await port.quorumJudge?.(input.gate)) ?? UNPROVEN_JUDGE) : UNPROVEN_JUDGE);
    const tally = tallyGateApprovals(resolutions, input.gate, since, input.planDigest, input.approval, humansSince, judge);
    if (tally.permit) {
      return { satisfied: true, resolution: tally.permit, via: "policy", approvals: tally.counted };
    }
    if (tally.met) {
      return {
        satisfied: true,
        resolution: tally.counted[tally.counted.length - 1]!,
        via: "quorum",
        approvals: tally.counted,
      };
    }
    mismatched = tally.mismatched;
    quorum = { approvers: tally.counted.map((r) => r.resolvedBy), need: tally.need, ...(tally.rules ? { rules: tally.rules } : {}) };
    // #3949: old and new approvals add up toward one quorum, each approver once.
    const counted = new Set(tally.counted.map((r) => r.resolvedBy));
    const extra = fromAliases.filter((r) => !counted.has(r.resolvedBy));
    if (extra.length > 0) {
      const asCarried = new Map(extra.map((r) => [{ version: 1, ...carriedApproval(r, input.op, input.gate, now) } as GateResolutionRecord, r]));
      const combined = tallyGateApprovals([...resolutions, ...asCarried.keys()], input.gate, since, input.planDigest, input.approval, humansSince, judge);
      if (combined.met) {
        const written = await carry(combined.counted.filter((r) => asCarried.has(r)).map((r) => asCarried.get(r)!));
        const approvals = [...combined.counted.filter((r) => !asCarried.has(r)), ...written];
        return { satisfied: true, resolution: written[written.length - 1]!, via: "alias", approvals, carried: written };
      }
      quorum = { approvers: combined.counted.map((r) => r.resolvedBy), need: combined.need, ...(combined.rules ? { rules: combined.rules } : {}) };
    }
  } else {
    const found = latestResolutionForPlan(resolutions, input.gate, since, input.planDigest);
    if (found.resolution) return { satisfied: true, resolution: found.resolution };
    // #3949: else the newest approval an alias admits passes it, written under this gate.
    const newest = fromAliases[fromAliases.length - 1];
    if (newest) {
      const written = await carry([newest]);
      return { satisfied: true, resolution: written[0]!, via: "alias", carried: written };
    }
    mismatched = found.mismatched;
  }

  // #2554, ws-039: a workspace gate stands in only when the member opted in
  // at base and the workspace approval's digest covers this plan.
  if (input.workspace && input.planDigest !== undefined) {
    const stood = await input.workspace.standIn({ op: input.op, gate: input.gate, planDigest: input.planDigest, ...(env !== undefined ? { environment: env } : {}) });
    if (stood) {
      return {
        satisfied: true,
        via: "workspace",
        resolution: {
          version: 1,
          kind: "resolution",
          op: input.op,
          gate: input.gate,
          resolvedBy: stood.approvedBy,
          timestamp: stood.timestamp,
          planDigest: input.planDigest,
          ...(env !== undefined ? { environment: env } : {}),
          workspaceGate: { gate: stood.gate, digest: stood.digest },
        },
      };
    }
  }

  // #4045: an approval of this gate for another release stands as a mismatch
  // when nothing closer does, so the refusal says an approval exists.
  if (!mismatched && input.planDigest !== undefined) {
    const sinceMs = new Date(since).getTime();
    mismatched = otherRelease
      .filter((r) => new Date(r.timestamp).getTime() >= sinceMs)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      .at(-1);
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
  const asMismatch = { ...(mismatch ? { mismatch } : {}), ...(quorum ? { quorum } : {}), ...(refused.length > 0 ? { refused } : {}) };

  // A standing fact only stands for the plan it was recorded against. When
  // the plan has moved, re-recording is what gives `chant approve` (which
  // defaults to the newest pending fact's digest) the current plan to
  // approve; leaving the old fact standing would make the common path
  // approve a plan that is no longer the one being run.
  // The same holds for the approval block (#2508): a pending fact recorded
  // under another policy version or another context would have `chant
  // approve` evaluate the policy against something this run no longer has.
  // #3947: and for the checkpoint, so a gate that resumes gets one. A fact
  // that already carries a checkpoint stands: an approval copies that one.
  if (
    standing && !isPendingGateExpired(standing, now) && samePlanDigest(standing.planDigest, input.planDigest) &&
    standing.releaseDigest === input.releaseDigest &&
    sameApproval(standing.approval, input.approval) &&
    (input.checkpoint === undefined || port.writeCheckpoint === undefined || standing.checkpointDigest !== undefined)
  ) {
    return { satisfied: false, pending: standing, recorded: false, ...asMismatch };
  }

  // The checkpoint is written before the fact that names it, so a fact never
  // points at a file that isn't there.
  let checkpointDigest: string | undefined;
  if (input.checkpoint !== undefined && port.writeCheckpoint) {
    checkpointDigest = gateCheckpointDigest(input.checkpoint);
    await port.writeCheckpoint(input.checkpoint);
  }

  const url = resolveApprovalUrl();
  // #3683: in CI, where this job runs, so an approval can start it again.
  const resume = resolveGateRunLocator();
  // #4020: the commit and run the gate waits on, so a reader can join it to both.
  const stamp = await runStamp(input);
  const { record, pushed, pushWarning } = await port.appendPending({
    ...(input.fields as Partial<PendingGateInput> | undefined),
    op: input.op,
    gate: input.gate,
    timestamp: now,
    expiresAt: new Date(
      new Date(now).getTime() + parseDuration(input.timeout ?? DEFAULT_GATE_EXPIRY),
    ).toISOString(),
    ...(input.description ? { description: input.description } : {}),
    ...stamp,
    ...(url ? { url } : {}),
    ...(resume ? { resume } : {}),
    ...(input.planDigest !== undefined ? { planDigest: input.planDigest } : {}),
    ...(checkpointDigest !== undefined ? { checkpointDigest } : {}),
    ...(env !== undefined ? { environment: env } : {}),
    ...(input.releaseDigest !== undefined ? { releaseDigest: input.releaseDigest } : {}),
    ...(input.approval ? { approval: input.approval } : {}),
    ...(input.neverOverMcp ? { neverOverMcp: true as const } : {}),
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
