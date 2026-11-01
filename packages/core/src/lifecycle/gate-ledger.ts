/**
 * Gate resolution ledger (#1485, epic #1487) — the durable counterpart to a
 * converge tick's gate-as-fact outcome (`./converge-ledger.ts`'s
 * `ConvergeRuleOutcome.action === "gated"`). Same append-only, content-
 * addressed shape as the converge/release ledgers, reusing
 * `writeBlobToPath`/`readBlobFromPath` (./git.ts) directly — one line per
 * resolution at `_gates/<op>.jsonl` on the `chant/lifecycle` orphan branch.
 *
 * Keyed by op name rather than environment (`_gates`, not `<env>/gates...`)
 * because a gate belongs to the *dispatched* op — the thing a converge
 * rule's `run()` action names — and that op's own env, if it declares one at
 * all, isn't always the calling `ConvergeOp`'s env. `writeBlobToPath`'s own
 * doc already establishes this generic-namespace pattern
 * (`./build-ledger-store.ts`'s `_builds`); this is the same move for a
 * second non-env top-level directory.
 *
 * `chant approve <op> <gate>` (`../cli/handlers/operator.ts`) is what
 * appends a resolution — issue #1485's "resolution is an out-of-band act
 * that writes the counterpart fact". Per that issue's leaning on open
 * question 3 ("local trust in v1, signature as an additive follow-up"),
 * this record is *not* itself an authorization check — anyone who can run
 * `chant approve` locally can write one, the same trust boundary a local
 * commit already has.
 *
 * Since #2300 both halves also carry a plan identity (`./plan-digest.ts`): a
 * run records the plan it reached the gate with, `chant approve` records the
 * plan it approves, and {@link latestResolutionForPlan} matches on that
 * rather than on recency alone. Before it, an approval authorised the next
 * run of an op rather than the plan its approver had read
 * (INTENTIUS/choudoufu#1026).
 *
 * Since #2119 the file carries both halves of the loop. A `gate` step the
 * local executor reaches (`../op/local-executor.ts`) appends a
 * {@link PendingGateRecord} and ends that run with status `gated`; `chant
 * approve` appends the {@link GateResolutionRecord} that answers it; the next
 * run reads both, finds a resolution newer than the pending fact, and walks
 * through the gate carrying the approver. A resolution older than the newest
 * pending fact is not an answer to it — {@link latestResolutionSince} applies
 * that rule for the executor and for `chant operator status` alike. Both kinds
 * of line share one file, told apart by {@link GateLedgerRecord}'s `kind`
 * (absent on the resolution lines written before #2119, which is why
 * `"resolution"` is the default reading).
 */
import { isNeverOverMcpGateOp } from "../op/gate-name";
import { sortedJsonReplacer } from "../utils";
import { currentGateOrigin, type GateOrigin } from "./gate-origin";
import type { GateApprover, GatePolicyDecision, ResolvedGateApproval } from "../op/gate-approval";
import type { GateApprovalSource } from "../op/op-waves";
import type { GateRunLocator } from "../op/gate-run-locator";
import { readBlobFromPath, readPathSha, readBlobBySha, writeBlobToPath, RefCASConflictError, type LedgerLocation } from "./git";
import { gatedRequestOf, type GatedRequest } from "./gated-request-digest";

/** The first chant that writes `changeSet` on a pending fact and an approval (#4551). */
export const GATE_CHANGE_SET_FLOOR = "0.124.55";

/** The first chant that writes `request` on a pending fact and reads gated requests (#4551). */
export const GATED_REQUEST_FLOOR = "0.124.55";

// The facts a pending record is written with live apart, so a bundle can import them without git (#3816).
export { DEFAULT_GATE_EXPIRY, isApprovalUrl, resolveApprovalUrl } from "./gate-pending";

// The selection rules a gate decides by live apart, so a bundle can import them without git (#3763).
export {
  isPendingGateExpired,
  latestPendingGate,
  latestResolutionForPlan,
  latestResolutionSince,
  type PlanBoundResolution,
} from "./gate-ledger-select";

const DIR = "_gates";

/** The directory on the `chant/lifecycle` branch that holds gate ledgers, under a member's prefix when it has one. */
export const GATES_DIR = DIR;
const APPEND_RETRY_ATTEMPTS = 5;


/**
 * The answer record a gate that asks a decision point cites (#3170): the
 * point, the record's id (what `chant workspace points answer` takes) and its
 * path from the repository root. On a pending fact it is the open question
 * the run waits on; on a resolution, the answer that passed the gate, with
 * the answer, the decider that gave it and the people who did.
 */
export interface GateAnswerRef {
  point: string;
  id: string;
  path: string;
  answer?: string | boolean;
  /** `table`, `model` or `quorum`. */
  decider?: string;
  answeredBy?: string[];
  /**
   * On a pending fact: the answers the gate passes on, when the gate names
   * them (`point.pass`); absent means a noul point's yes. `chant run resume`
   * reads it to tell an answer that passes the gate from one that does not,
   * without the Op's config (#3835).
   */
  pass?: Array<string | boolean>;
}

/** One immutable gate-resolution record. */
export interface GateResolutionRecord {
  /** Schema version, so an incompatible future shape is detected before being misread. */
  version: 1;
  /** Discriminator against {@link PendingGateRecord}, which shares this file. Absent on every line written before #2119, so a reader must treat "no kind" as `"resolution"`. */
  kind?: "resolution";
  /** The dispatched op the gate belongs to. */
  op: string;
  /** The gate's signal name (matches `ConvergeRuleOutcome.gateName`). */
  gate: string;
  /** Who resolved it — an actor name, the same convention `components release --actor` and `run approve --approver` use. */
  resolvedBy: string;
  /**
   * Who carried this approval to chant for `resolvedBy` (#3402): `chant
   * approve --relayed-by`, such as a follower program relaying a person's
   * approval. The approver is still `resolvedBy`; a seal covers this field
   * too. Absent when the approver recorded it themselves.
   */
  relayedBy?: string;
  /** ISO-8601 timestamp, caller-supplied (library code never calls `Date.now()` internally). */
  timestamp: string;
  /** Optional free-text context. Before #2028 this was also where a PR link went by convention; put the link in {@link GateResolutionRecord.url} instead and leave this for prose. */
  note?: string;
  /**
   * The address this resolution happened at (#2028) — the PR that carried the
   * change, the review thread, whatever the approval surface was. Typed, so
   * "resolved by this PR" is machine-readable instead of a reader sniffing
   * `note` for something that looks like a link.
   *
   * `chant approve --url` sets it; absent when the resolver genuinely had no
   * address (a human at a terminal, no PR). Always an absolute `http`/`https`
   * URL — see {@link isApprovalUrl}.
   */
  url?: string;
  /**
   * The plan this approval is for (#2300) — `computePlanDigest`'s output
   * (`./plan-digest.ts`), normally copied off the {@link PendingGateRecord}
   * this resolution answers.
   *
   * Absent on every resolution written before #2300, and on one written for a
   * gate that binds no plan. Absent is not a wildcard: {@link
   * latestResolutionForPlan} refuses a digest-less resolution against a
   * plan-bound gate rather than letting it through, because the only thing
   * such a record proves is that somebody approved *something*.
   */
  planDigest?: string;
  /**
   * The commit the gate was waiting on (#4020), copied off the pending fact the
   * approval answers, or the run's own commit for a resolution a run writes
   * itself (a decision point's answer, a review, a carried approval). It is not
   * the approver's checkout, and a seal does not cover it. Absent on a
   * resolution written before 0.124.28 and when no commit was known.
   */
  gitSha?: string;
  /** The run the gate was waiting on (#4020), copied the same way as {@link GateResolutionRecord.gitSha}. */
  runId?: string;
  /**
   * The checkpoint this approval lets a run resume from (#3947), copied off
   * the pending fact it answers. Set only on an approval of a gate that
   * resumes (`resume: true`) whose run stored a checkpoint. A seal covers it.
   */
  checkpointDigest?: string;
  /**
   * The line the relay set for the approver's signature to bind as well
   * (#4697, `chant approve --binding`), such as a platform's deploy id and
   * an expiry. Printable text on one line; chant reads nothing in it. Set
   * only on an approval signed with --sign or --signature, whose seal (version
   * 3) signs it.
   */
  binding?: string;
  /**
   * The environment this approval is for (#2574), copied off the pending fact
   * it answers. Set for a component gate, whose ledger is keyed by component
   * rather than by environment. A component gate counts only a resolution
   * recorded for its own environment and plan.
   */
  environment?: string;
  /**
   * The release this approval is for (#4045, ws-104 question 2), copied off
   * the pending fact it answers. Set on a release gate, the gate `chant
   * components promote --release` passes for an environment. A release gate
   * counts only a resolution recorded for its own release, environment and
   * change-set document digest (`planDigest`), so it names the release it
   * admitted. Absent on every other gate, and on a resolution written before
   * 0.124.28.
   */
  releaseDigest?: string;
  /**
   * The change set this approval was asked for (#4551), copied off the
   * pending fact it answers when it approves that fact's plan: the digest of
   * a document in `_change-sets/`. Absent on an approval of another plan,
   * and on a resolution written before {@link GATE_CHANGE_SET_FLOOR}.
   */
  changeSet?: string;
  /**
   * The resolution passes a release gate over an empty change set (#4045,
   * ws-104 question 6): the promote wrote it itself, with the actor running
   * it in `resolvedBy`, because the change set its `planDigest` names changes
   * nothing. A gate counts it only after it reads the stored document under
   * `planDigest` and finds it empty, and neither a quorum nor a signing rule
   * applies to it. It never counts as a person's approval. Absent on every
   * other resolution.
   */
  empty?: true;
  /**
   * The workspace gate that stood in for this member gate (#2554, ws-039):
   * its name and the digest of the member plans it covers. Set only on the
   * resolution a run builds when a workspace approval passes the gate; it is
   * never written to the member's ledger, where the approval stays the
   * workspace's (`_members/_workspace/_gates/`).
   */
  workspaceGate?: { gate: string; digest: string };
  /**
   * The channel this resolution was authored on (chant#2384) — set by the
   * writer, never by the caller. `chant approve` records `"cli"`, the
   * `op-approve` MCP tool records `"mcp"`, an ACP-driven approve records
   * `"acp"`.
   *
   * Absent on every resolution written before chant#2384, and absent is not
   * `"cli"`: an old record simply does not say. `sameOriginRefusal`
   * (./gate-origin.ts) refuses only on a positive match, so an unlabelled
   * record is never refused on this ground.
   */
  origin?: GateOrigin;
  /**
   * This resolution was recorded from the same channel that reached the gate,
   * deliberately (chant#2384's `--allow-same-origin`).
   *
   * On the record rather than only in the console, because the point of the
   * refusal is that someone chose to bypass it. A reader auditing the ledger
   * later should see which approvals had a second party and which did not.
   */
  sameOriginOverride?: boolean;
  /**
   * Whether a person or an agent recorded this, and the roles they claimed
   * (#2508). Only a human approval counts toward a gate's quorum; an agent
   * passes a gate only through a policy permit in `enforce` mode.
   *
   * Absent on every resolution written before #2508, and read as a human with
   * no roles. Roles are claimed, not verified, the same local trust boundary
   * as `resolvedBy`.
   */
  approver?: GateApprover;
  /**
   * The gate policy's decision for this approval (#2508), evaluated when it
   * was recorded. Present only when the gate declared a policy.
   */
  policyDecision?: GatePolicyDecision;
  /**
   * An ssh signature over this approval by `resolvedBy` (#3163, ws-080):
   * `chant approve --sign`, in the `chant-gate` namespace over the op, gate,
   * environment, plan digest, approver and timestamp. Or the same made
   * elsewhere, by an ssh key or a passkey, and brought with `chant approve
   * --signature` (#4646). It attests the approver only when the signers file
   * at base lists a key for them, or `.chant/trust.json` a passkey. A gate the
   * declaration's `identity.gates` names counts only approvals whose seal
   * verifies. Absent on an unsigned approval.
   */
  seal?: GateApprovalSeal;
  /**
   * The forge review this approval came from (#3684): a wave whose approval
   * mode is `pr-review` writes it when the merged pull request's head was
   * approved by a writer other than its author and planned this digest.
   * `resolvedBy` is the first of `approvers`.
   */
  review?: { pr: number; head: string; approvers: string[] };
  /**
   * The answer record that passed the gate, on a gate that asks a decision
   * point (#3170). The run writes this resolution itself when the point's
   * question is answered with an answer the gate passes on; the record's
   * `constrains` names the gate back (`gate:<op>/<gate>`).
   */
  answer?: GateAnswerRef;
  /**
   * The line this approval was carried from (#3949): an approval recorded
   * under one of the gate's aliases, which a run counted toward the gate and
   * wrote again under its new name. `op`, `gate` and `timestamp` name that
   * line; `checkpointDigest` is the one it carried, if any, since a seal
   * signs it. `resolvedBy`, the plan, the environment and the seal are the
   * original's, and the seal verifies against the names in here. This
   * record's own `timestamp` is when it was carried.
   */
  carriedFrom?: GateCarriedFrom;
}

/** Where a carried approval came from (#3949): the original line's op, gate and time, and its checkpoint digest when it had one. */
export interface GateCarriedFrom {
  op: string;
  gate: string;
  timestamp: string;
  checkpointDigest?: string;
}

/** Whether `raw` is a {@link GateCarriedFrom}. */
export function isGateCarriedFrom(raw: unknown): raw is GateCarriedFrom {
  const c = raw as Partial<GateCarriedFrom> | null;
  return (
    !!c && typeof c === "object" && !Array.isArray(c) && typeof c.op === "string" && typeof c.gate === "string" &&
    typeof c.timestamp === "string" && (c.checkpointDigest === undefined || typeof c.checkpointDigest === "string")
  );
}

/**
 * A gate approval's seal (#3163): who signed, the key's fingerprint (reported,
 * never trusted), and the armored signature. A passkey's seal (#4646) has
 * `kind: "webauthn"`, the credential id as `key`, the assertion's signature
 * (base64url) as `signature`, and its client data and authenticator data, so
 * it can be checked again against the passkey `.chant/trust.json` lists.
 */
export interface GateApprovalSeal {
  /** `webauthn` for a passkey's assertion (#4646). Absent on an ssh signature. */
  kind?: "webauthn";
  signer: string;
  key: string;
  signature: string;
  /** A passkey's clientDataJSON, base64url (#4646). */
  clientDataJSON?: string;
  /** A passkey's authenticatorData, base64url (#4646). */
  authenticatorData?: string;
  /**
   * The seal's version (#3947). `2` on a seal over an approval that carries a
   * `checkpointDigest`, whose payload signs the digest as one more line.
   * `3` on a seal over an approval with a `binding` (#4697), which signs one
   * more line after that. Absent on every other seal, which is version 1.
   */
  version?: 2 | 3;
}

export type GateResolutionInput = Omit<GateResolutionRecord, "version" | "kind">;

/**
 * One immutable pending-gate record (#2119) — what an executor writes when a
 * run reaches a `gate` step with no resolution standing against it. The run
 * ends here with status `gated`; this line is the durable trace of that, and
 * the anchor a later {@link GateResolutionRecord} has to be newer than to
 * count as its answer.
 *
 * Idempotent by design: a run that finds a live (unexpired) pending fact for
 * the same gate reuses it rather than appending a second one, so a converge
 * loop ticking every minute against an unapproved gate does not grow the
 * ledger by a line a minute. Once `expiresAt` passes, the fact is stale and
 * the next run records a fresh one.
 */
export interface PendingGateWave {
  number: number;
  name: string;
  /** The Op waves spec's name. */
  op?: string;
}

/** The hook that holds a wave on a gate (#3886): which hook asked, at which moment, and for which run. */
export interface PendingGateHeldBy {
  hook: string;
  moment: string;
  /** The run, for a `perRun` hook. */
  target?: string;
}

export interface PendingGateRecord {
  /** Schema version, so an incompatible future shape is detected before being misread. */
  version: 1;
  kind: "pending";
  /** The op (or, on the component driver, the component) the gate belongs to. */
  op: string;
  /** The gate's name (matches `GateStep.gate`). */
  gate: string;
  /** The gate's human-readable description, when it declared one — what `chant operator status` shows a reader who wasn't there for the run. */
  description?: string;
  /**
   * The run that reached the gate. An Op run records its own id; a run with no
   * id of its own (a component gate) records the CI run id when it ran in CI
   * (#4020). Absent outside CI for a run that mints none.
   */
  runId?: string;
  /**
   * The commit the run reached the gate at (#4020): the checkout's `HEAD`, else
   * the commit the CI job started for. It is the commit the gate waits on, and
   * `chant approve` copies it onto the resolution. Absent on a record written
   * before 0.124.28 and when the run knew no commit.
   */
  gitSha?: string;
  /** ISO-8601 timestamp, caller-supplied (library code never calls `Date.now()` internally). */
  timestamp: string;
  /** ISO-8601 expiry, from the gate's `timeout` (default {@link DEFAULT_GATE_EXPIRY}). Past it, the fact is stale and a run re-records it. */
  expiresAt: string;
  /** The address approval happens at, when the run knew one — see {@link resolveApprovalUrl}. */
  url?: string;
  /**
   * The CI job that reached this gate (#3683), when it ran in one: what
   * `chant approve --resume` and `chant run resume` hand the forge to start
   * that job again (`../op/gate-resume.ts`). Absent outside CI.
   */
  resume?: GateRunLocator;
  /**
   * The plan the run reached this gate with (#2300) — `computePlanDigest`'s
   * output (`./plan-digest.ts`). This is what `chant approve` copies onto the
   * resolution by default, so approving the standing fact approves the plan
   * the approver was shown rather than the next run's.
   *
   * Absent when the gate binds no plan (an authored Op `gate` step with no
   * `plan`), which is the shape every gate had before #2300. A component gate
   * binds one since #2574.
   */
  planDigest?: string;
  /**
   * The digest of the checkpoint the run stored when it stopped here (#3947),
   * on a gate that resumes (`resume: true`). The file is at
   * `_gates/<op>/checkpoints/<runId>.json` (`./gate-checkpoint.ts`). `chant
   * approve` copies it onto the approval, and a run resumes at this gate only
   * from a checkpoint that matches it. Absent when the gate doesn't resume,
   * or when its run could not store one, such as when an output it needs is
   * secret.
   */
  checkpointDigest?: string;
  /**
   * The environment the run reached this gate in (#2574). Set by the
   * component driver, whose gate ledger is keyed by component, so pending
   * facts for staging and prod stand side by side and `chant approve --env`
   * can pick one.
   */
  environment?: string;
  /**
   * The release the run reached this gate for (#4045): on a release gate, the
   * `releaseDigest` of the release `chant components promote --release`
   * deploys. `chant approve` copies it onto the approval with the plan.
   * Absent on every other gate, and on a fact written before 0.124.28.
   */
  releaseDigest?: string;
  /**
   * The change set this gate waits on (#4551): the digest of a document in
   * `_change-sets/` (`./change-set-store.ts`), stored before this fact, so a
   * refusal or a respond job reads the plans the approval is asked for. An op
   * wave sets it from its plans file's `changeSet`; a pull-request or release
   * gate, whose `planDigest` is already a change set's digest, sets it to the
   * same value. Absent on a fact written before {@link GATE_CHANGE_SET_FLOOR}.
   */
  changeSet?: string;
  /**
   * The channel the run that reached this gate was driven from (chant#2384).
   *
   * This is the half a resolution is compared against: a gate reached over MCP
   * and resolved over MCP has one author, not two.
   */
  origin?: GateOrigin;
  /**
   * The gate is never resolved over MCP or ACP (chant#3485), whichever channel
   * reached it. The declaration travels on the record because an Op that MCP
   * cannot discover, such as `fan-out`, has no config to read it from.
   */
  neverOverMcp?: true;
  /**
   * The gate's quorum and policy (#2508), with its context resolved against
   * this run. `chant approve` reads it to evaluate the policy against the plan
   * the run produced, and `chant operator status` to show quorum progress.
   */
  approval?: ResolvedGateApproval;
  /**
   * The approval mode an Op wave asked under (#3861): `ledger`, `pr-review` or
   * `sealed`, as read at base. It says which approvals count for the gate, so a
   * reader (behold, gate-audit) decides under the mode the wave used rather
   * than inferring it from config. Not the quorum block in `approval`.
   */
  approvalMode?: GateApprovalSource;
  /**
   * The Op wave this gate belongs to (#3839): a hold on another gate or a
   * policy denial. Absent on a gate that is not a wave's.
   */
  wave?: PendingGateWave;
  /**
   * The hook that holds the wave on this gate (#3886), on a hold only: its
   * name, the moment it ran at and its run. A reader names the holder from it
   * rather than from `description`, which the hook writes.
   */
  heldBy?: PendingGateHeldBy;
  /**
   * The open question this gate waits on, on a gate that asks a decision
   * point (#3170). It is answered with `chant workspace points answer <id>`,
   * not `chant approve`.
   */
  answer?: GateAnswerRef;
  /**
   * The request this fact asks an approval of (#4551), on a gated request for
   * an op that has no wave, such as a state export or a lock release
   * (`./gated-request.ts`). `planDigest` is its `gatedRequestDigest`. Absent
   * on every other fact, and on one written before chant
   * {@link GATED_REQUEST_FLOOR}.
   */
  request?: GatedRequest;
}

export type PendingGateInput = Omit<PendingGateRecord, "version" | "kind">;

/** Either kind of line in `_gates/<op>.jsonl`. */
export type GateLedgerRecord = GateResolutionRecord | PendingGateRecord;


function filename(op: string): string {
  return `${op}.jsonl`;
}

/**
 * Where an Op's gate ledger lives, as a path a human can go and read:
 * `_gates/<op>.jsonl` on the `chant/lifecycle` orphan branch. Exported so a
 * renderer that tells someone a gate is pending can name the file the pending
 * fact was appended to (#2243) rather than describing it in prose that drifts
 * from `DIR`.
 */
export function gateLedgerPath(op: string, memberPrefix = ""): string {
  return `${memberPrefix}${DIR}/${filename(op)}`;
}

/** Append one immutable gate-resolution record. Does not push to the remote — call `pushLifecycle` (./git.ts) afterward, same two-step shape every other ledger write here uses. Retries on `RefCASConflictError` the same way `appendConvergeRecord` does (./converge-ledger.ts) — a concurrent writer to a different op's/env's file on the same orphan branch is the ordinary case, not an edge case. The baseline read must be `readPathSha` + `readBlobBySha` rather than `readBlobFromPath`, so the exact sha `existing` came from can be passed as `expectPriorPathSha` — see `writeBlobToPath` (./git.ts) for the race that closes. */
export async function appendGateResolution(
  input: GateResolutionInput,
  opts?: { cwd?: string },
): Promise<{ commit: string; record: GateResolutionRecord }> {
  const record: GateResolutionRecord = { version: 1, ...input };
  const commit = await appendGateLine(record, "Gate resolution record", opts);
  return { commit, record };
}

/**
 * Append one immutable pending-gate record (#2119) — the fact a run leaves
 * behind when it reaches a gate nobody has approved. Same file, same
 * append-and-retry discipline, same "does not push" contract as
 * {@link appendGateResolution}.
 */
export async function appendPendingGate(
  input: PendingGateInput,
  opts?: { cwd?: string },
): Promise<{ commit: string; record: PendingGateRecord }> {
  // chant#2384 — stamped here rather than at each caller, because every pending
  // fact goes through this function and a channel is a property of the process
  // rather than of the call. An explicit `origin` on the input still wins, so a
  // caller that knows better can say so.
  const record: PendingGateRecord = {
    version: 1,
    kind: "pending",
    origin: currentGateOrigin(),
    // chant#3485: an Op MCP cannot discover declares nothing, so the gate
    // records the rule for it: fan-out, workspace-upgrade (chant#3513) and
    // the pull-request gate's `pr-<number>` op.
    ...(isNeverOverMcpGateOp(input.op) ? { neverOverMcp: true as const } : {}),
    ...input,
  };
  const commit = await appendGateLine(record, "Pending gate record", opts);
  return { commit, record };
}

async function appendGateLine(
  record: GateLedgerRecord,
  message: string,
  opts?: { cwd?: string },
): Promise<string> {
  const json = JSON.stringify(record, sortedJsonReplacer);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= APPEND_RETRY_ATTEMPTS; attempt++) {
    try {
      const priorSha = await readPathSha(DIR, filename(record.op), opts);
      const existing = priorSha ? await readBlobBySha(priorSha, opts) : null;
      const content = `${existing ? `${existing.replace(/\n$/, "")}\n` : ""}${json}\n`;
      return await writeBlobToPath(DIR, filename(record.op), content, message, {
        ...opts,
        expectPriorPathSha: priorSha,
      });
    } catch (err) {
      if (!(err instanceof RefCASConflictError)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Read every line of `op`'s gate file, oldest first, split into the two kinds
 * (#2119). Malformed lines are skipped and counted, not thrown on — the same
 * graceful-degradation stance `readConvergeLedger` takes. Returns empty arrays
 * (never throws) when `op` has nothing recorded yet.
 */
export async function readGateLedger(
  op: string,
  opts?: LedgerLocation,
): Promise<{ resolutions: GateResolutionRecord[]; pending: PendingGateRecord[]; malformed: number }> {
  const content = await readBlobFromPath(DIR, filename(op), opts);
  if (!content) return { resolutions: [], pending: [], malformed: 0 };
  return parseGateLedger(content);
}

/**
 * Split the text of one gate ledger file into its two kinds of line, oldest
 * first, the way {@link readGateLedger} reads it. Exported for a reader that
 * fetches the file itself, such as `chant workspace status` (#2674), which
 * reads every member's ledger by its full path from the workspace root.
 */
export function parseGateLedger(
  content: string,
): { resolutions: GateResolutionRecord[]; pending: PendingGateRecord[]; malformed: number } {
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const resolutions: GateResolutionRecord[] = [];
  const pending: PendingGateRecord[] = [];
  let malformed = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Partial<Omit<GateResolutionRecord, "kind">> &
        Partial<Omit<PendingGateRecord, "kind">> & { kind?: string };
      const common =
        parsed.version === 1 && typeof parsed.op === "string" &&
        typeof parsed.gate === "string" && typeof parsed.timestamp === "string";
      if (!common) {
        malformed++;
        continue;
      }
      // #2300: a `planDigest` that is present but not a string is a
      // malformed line, not a line with a field to ignore. Ignoring it would
      // silently demote a plan-bound record to a digest-less one, which is
      // the shape `latestResolutionForPlan` refuses — a corrupted approval
      // must not read as an approval of anything at all.
      const rawDigest: unknown = (parsed as { planDigest?: unknown }).planDigest;
      if (rawDigest !== undefined && typeof rawDigest !== "string") {
        malformed++;
        continue;
      }
      // #2574: the same reasoning for the environment a component gate
      // approval is bound to.
      const rawEnv: unknown = (parsed as { environment?: unknown }).environment;
      if (rawEnv !== undefined && typeof rawEnv !== "string") {
        malformed++;
        continue;
      }
      // #4045: and for the release a release gate approval is bound to.
      const rawRelease: unknown = (parsed as { releaseDigest?: unknown }).releaseDigest;
      if (rawRelease !== undefined && typeof rawRelease !== "string") {
        malformed++;
        continue;
      }
      // #4045: an `empty` that is not a boolean can't be told from a pass or an approval.
      const rawEmpty: unknown = (parsed as { empty?: unknown }).empty;
      if (rawEmpty !== undefined && typeof rawEmpty !== "boolean") {
        malformed++;
        continue;
      }
      // #3947: and for the checkpoint an approval lets a run resume from.
      const rawCheckpoint: unknown = (parsed as { checkpointDigest?: unknown }).checkpointDigest;
      if (rawCheckpoint !== undefined && typeof rawCheckpoint !== "string") {
        malformed++;
        continue;
      }
      // #4697: and for the binding a seal signs. A line break would make the statement's lines ambiguous.
      const rawBinding: unknown = (parsed as { binding?: unknown }).binding;
      if (rawBinding !== undefined && (typeof rawBinding !== "string" || /[\r\n\u2028\u2029]/.test(rawBinding))) {
        malformed++;
        continue;
      }
      // #4020: a commit or run id of the wrong type is dropped, so a reader can trust the type without losing the line.
      // #4551: and so is a `changeSet` that is not a digest.
      for (const key of ["gitSha", "runId", "changeSet"] as const) {
        const v: unknown = (parsed as Record<string, unknown>)[key];
        if (v !== undefined && typeof v !== "string") delete (parsed as Record<string, unknown>)[key];
      }
      if (parsed.kind === "pending") {
        if (typeof parsed.expiresAt !== "string") {
          malformed++;
          continue;
        }
        // #3887: a `wave` or `heldBy` of the wrong shape is dropped, so a reader can trust the type.
        const rec = parsed as PendingGateRecord;
        const w = (parsed as { wave?: unknown }).wave as Partial<PendingGateWave> | null | undefined;
        if (w !== undefined && !(w && typeof w === "object" && typeof w.number === "number" && typeof w.name === "string")) delete rec.wave;
        const h = (parsed as { heldBy?: unknown }).heldBy as Partial<PendingGateHeldBy> | null | undefined;
        if (h !== undefined && !(h && typeof h === "object" && typeof h.hook === "string" && typeof h.moment === "string")) delete rec.heldBy;
        // #4551: a `request` of the wrong shape is dropped too.
        if ((parsed as { request?: unknown }).request !== undefined && !gatedRequestOf((parsed as { request?: unknown }).request)) delete rec.request;
        pending.push(rec);
        continue;
      }
      if (typeof parsed.resolvedBy !== "string") {
        malformed++;
        continue;
      }
      // #3949: a carried approval's seal is checked against the line it cites, so the citation must be whole.
      const rawCarried: unknown = (parsed as { carriedFrom?: unknown }).carriedFrom;
      if (rawCarried !== undefined && !isGateCarriedFrom(rawCarried)) {
        malformed++;
        continue;
      }
      resolutions.push(parsed as GateResolutionRecord);
    } catch {
      malformed++;
    }
  }
  return { resolutions, pending, malformed };
}

/** Read every gate-*resolution* record for `op`, oldest first — {@link readGateLedger} narrowed to the half every caller before #2119 wanted. Pending facts are not malformed lines and are not counted as such. */
export async function readGateResolutions(
  op: string,
  opts?: { cwd?: string },
): Promise<{ records: GateResolutionRecord[]; malformed: number }> {
  const { resolutions, malformed } = await readGateLedger(op, opts);
  return { records: resolutions, malformed };
}
