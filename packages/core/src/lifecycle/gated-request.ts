/**
 * Gated requests (#4551): a request for an op that has no wave, such as a
 * state export, a lock release or a standalone migration, approved and
 * spent on the gate ledger like a wave's plan.
 *
 * The records are the existing ones. The request is a pending fact in
 * `_gates/<op>.jsonl` whose `gate` is the request's subject, whose
 * `planDigest` is {@link gatedRequestDigest}, and which carries the request
 * as `request`. The approval is a plain `chant approve <op> <subject> --plan
 * <digest>`. {@link spendGatedRequest} appends an `applied` line to
 * `_gates/<op>/applied.jsonl` before the caller acts, and
 * {@link finishGatedRequest} a `finished` line after. A request applies once:
 * an applied line for its digest makes {@link requestGate} answer `spent`.
 *
 * The approval rules are the ones op waves read at base: `ledger`, `sealed`,
 * or `pr-review` (which counts ledger approvals only here, since a request
 * made from a laptop has no merged pull request to review it), with a quorum
 * whose targets match the subject. An approval by the requester never counts.
 * The workspace's `identity.gates` rule comes through the gate port as for
 * any gate.
 *
 * Every write resolves the member prefix from `cwd` and honours
 * `--no-record` through `./git.ts`.
 */
import { createHash } from "node:crypto";
import { NEXT_RELEASE } from "../release-floors";
import { sortedJsonReplacer } from "../utils";
import { approveCommand, evaluateGate, gitGateLedgerPort, type GateLedgerPort } from "../op/gate";
import type { GateApprovalSource } from "../op/op-waves";
import { quorumRulesFor, samePrincipal, trustQuorumJudge, type GateQuorumRule } from "../op/gate-quorum";
import { appliedGatePath, finishedApply, parseAppliedGateFile, type AppliedGateLine, type AppliedGateRecord, type FinishedGateRecord } from "./gate-applied";
import { readGateLedger, type GateResolutionRecord, type PendingGateRecord } from "./gate-ledger";
import { pushLifecycleReport, readBlobBySha, readBlobFromPath, readPathSha, RefCASConflictError, requireLifecycleLedger, writeBlobToPath, type LedgerLocation } from "./git";
import { samePlanDigest } from "./plan-digest";
import { gatedRequestAttachmentPath, gatedRequestDigest, type GatedRequest } from "./gated-request-digest";

export { gatedRequestAttachmentPath, gatedRequestDigest, gatedRequestOf, type GatedRequest } from "./gated-request-digest";

/** The first chant with this module (#4551). */
export { GATED_REQUEST_FLOOR } from "./gate-ledger";

/**
 * The first chant whose op-wave hold records the held gate like a gated
 * request (#4623): a hold file with `record: true` gets an applied line
 * before the approved re-run and a finished line after it, with the detail
 * the hook writes to `CHANT_HOLD_FINISHED`, and its `attachment` stored at
 * {@link gatedRequestAttachmentPath}. On the approved re-run, chant sets
 * `CHANT_HOLD_FINISHED` only once it wrote the applied line, so a hook reads
 * that variable to know chant records the gate.
 */
export const OP_WAVE_HOLD_RECORD_FLOOR = NEXT_RELEASE;

/** Which approvals count for a request: the block op waves read at base. */
export interface GatedRequestRules {
  mode: GateApprovalSource;
  /** Approval rules; a rule counts when its `targets` match the request's subject. */
  quorum?: GateQuorumRule[];
}

export interface RequestGateInput {
  op: string;
  request: GatedRequest;
  description?: string;
  /** How long the pending fact stands, as a gate's `timeout`. Default the gate default. */
  expiry?: string;
  rules: GatedRequestRules;
  /** The commit the rules were read at, for `sealed` and a quorum's roles. Default `HEAD`. */
  base?: string;
  /**
   * A file the request carries, such as a migration's proof. chant stores it
   * once at `_gates/<op>/requests/<digest>.json` before the pending fact,
   * and its SHA-256 goes in the request's `fields.proof`, so the digest binds it.
   */
  attachment?: string;
  cwd?: string;
  now?: string;
  /** The gate ledger. Default the one on `chant/lifecycle` in `cwd`. */
  gates?: GateLedgerPort;
}

export type RequestGateResult =
  | { status: "approved"; digest: string; request: GatedRequest; approval: GateResolutionRecord }
  | { status: "waiting"; digest: string; request: GatedRequest; command: string }
  /** An approval of the digest stands and does not count, such as the requester's own; the request still waits for another. */
  | { status: "refused"; digest: string; request: GatedRequest; by: string; reason: string; command: string }
  /** The request applied already under an approval; it applies once. */
  | { status: "spent"; digest: string; request: GatedRequest; finished?: FinishedGateRecord };

/** The request with its attachment's digest in `fields.proof`, when it carries one. */
function withProof(request: GatedRequest, attachment: string | undefined): GatedRequest {
  if (attachment === undefined) return request;
  return { ...request, fields: { ...request.fields, proof: `sha256:${createHash("sha256").update(attachment).digest("hex")}` } };
}


/** The applied and finished lines of `op`, as `_gates/<op>/applied.jsonl` holds them. */
async function readAppliedFile(op: string, location?: LedgerLocation): Promise<{ applied: AppliedGateLine[]; finished: FinishedGateRecord[] }> {
  const { dir, file } = appliedGatePath(op);
  const text = await readBlobFromPath(dir, file, location);
  return text ? parseAppliedGateFile(text) : { applied: [], finished: [] };
}

/** Append one line to `_gates/<op>/applied.jsonl`, retrying on a concurrent writer, and push. */
async function appendAppliedLine(op: string, line: Record<string, unknown>, message: string, opts?: { cwd?: string }): Promise<{ pushed: boolean; pushWarning?: string }> {
  const { dir, file } = appliedGatePath(op);
  const json = JSON.stringify(line, sortedJsonReplacer);
  await requireLifecycleLedger(opts);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const prior = await readPathSha(dir, file, opts);
      const existing = prior ? await readBlobBySha(prior, opts) : null;
      await writeBlobToPath(dir, file, existing ? `${existing.replace(/\n$/, "")}\n${json}\n` : `${json}\n`, message, { ...opts, expectPriorPathSha: prior });
      return pushLifecycleReport(opts);
    } catch (err) {
      if (!(err instanceof RefCASConflictError)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Ask for, or read, the approval of a request. Records the pending fact the
 * first time, and answers `approved` once an approval of its digest counts,
 * `spent` once it applied.
 */
export async function requestGate(input: RequestGateInput): Promise<RequestGateResult> {
  const { op, rules } = input;
  const cwd = input.cwd ?? process.cwd();
  const at = { cwd };
  const request = withProof(input.request, input.attachment);
  const digest = gatedRequestDigest(op, request);
  const gate = request.subject;
  const command = approveCommand(op, gate, undefined, digest, rules.mode === "sealed");

  const ledger = input.gates ?? gitGateLedgerPort(at);
  const { applied, finished } = await readAppliedFile(op, at).catch(() => ({ applied: [] as AppliedGateLine[], finished: [] as FinishedGateRecord[] }));
  const spentLine = applied.filter((a) => a.gate === gate && samePlanDigest(a.planDigest, digest)).at(-1);
  if (spentLine) {
    const done = finishedApply(finished, spentLine);
    return { status: "spent", digest, request, ...(done ? { finished: done } : {}) };
  }

  if (input.attachment !== undefined) {
    const { dir, file } = gatedRequestAttachmentPath(op, digest);
    if ((await readPathSha(dir, file, at)) === null) await writeBlobToPath(dir, file, input.attachment, `Request ${request.kind} on ${gate}`, at);
  }

  const base = input.base ?? "HEAD";
  const review = await import("../op/gate-review");
  const needsTrust = rules.mode === "sealed" || (rules.quorum?.length ?? 0) > 0;
  const trust = needsTrust ? review.trustPolicyAt(cwd, base) : undefined;
  const requester = {
    requirement: { gate, class: null },
    refuses: (r: GateResolutionRecord) => (samePrincipal(r.resolvedBy, request.by) ? `${r.resolvedBy} made the request, and a requester's own approval does not count` : null),
  };
  const sealed = rules.mode === "sealed" && trust ? review.sealedApprovalRule(gate, trust) : null;
  const port: GateLedgerPort = {
    ...ledger,
    async approvalRule(g) {
      const own = (await ledger.approvalRule?.(g, { base })) ?? null;
      return g === gate ? review.bothRules(review.bothRules(own, sealed), requester) : own;
    },
  };
  const takes = rules.quorum ? quorumRulesFor(rules.quorum, [gate]) : [];
  const check = await evaluateGate(port, {
    op,
    gate,
    planDigest: digest,
    description: input.description ?? `${request.kind} of ${gate}, requested by ${request.by}`,
    ...(input.expiry ? { timeout: input.expiry } : {}),
    ...(input.now ? { now: input.now } : {}),
    spent: applied.filter((a): a is AppliedGateLine & { kind: "applied" } => a.kind === "applied") as unknown as AppliedGateRecord[],
    fields: { request, approvalMode: rules.mode },
    ...(takes.length > 0 && trust ? { approval: { quorum: takes, mode: "log-only" as const }, judge: trustQuorumJudge({ signers: trust, roles: trust.roles }) } : {}),
  });
  if (check.satisfied) return { status: "approved", digest, request, approval: check.resolution };
  const refused = check.refused?.at(-1);
  if (refused) return { status: "refused", digest, request, by: refused.resolution.resolvedBy, reason: refused.reason, command };
  return { status: "waiting", digest, request, command };
}

/**
 * Record that the request applies under `approval`, which spends it. Throws
 * unless the line was pushed, so two jobs never act on one approval; the
 * caller acts only after this returns.
 */
export async function spendGatedRequest(input: {
  op: string;
  gate: string;
  digest: string;
  approval: Pick<GateResolutionRecord, "resolvedBy" | "timestamp">;
  runId?: string;
  commit?: string;
  cwd?: string;
  now?: string;
}): Promise<AppliedGateRecord> {
  const record: AppliedGateRecord = {
    version: 1,
    kind: "applied",
    op: input.op,
    gate: input.gate,
    planDigest: input.digest,
    approvedAt: input.approval.timestamp,
    approvedBy: input.approval.resolvedBy,
    timestamp: input.now ?? new Date().toISOString(),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.commit ? { commit: input.commit } : {}),
  };
  const pushed = await appendAppliedLine(input.op, record as unknown as Record<string, unknown>, `Applied under ${input.gate}`, input.cwd ? { cwd: input.cwd } : undefined);
  if (!pushed.pushed) throw new Error(`the approval of ${input.gate} was recorded as spent and not pushed (${pushed.pushWarning ?? "no remote"}), so nothing may apply under it`);
  return record;
}

/** Record how the request's apply ended: a `finished` line naming the applied line's time, with the product's flat facts in `detail`. */
export async function finishGatedRequest(input: {
  op: string;
  gate: string;
  digest: string;
  /** The applied line's `timestamp`. */
  applied: string;
  result: "applied" | "failed";
  detail?: Record<string, string | number | boolean>;
  cwd?: string;
  now?: string;
}): Promise<{ record: FinishedGateRecord; pushed: boolean; pushWarning?: string }> {
  const record: FinishedGateRecord = {
    version: 1,
    kind: "finished",
    op: input.op,
    gate: input.gate,
    planDigest: input.digest,
    applied: input.applied,
    result: input.result,
    timestamp: input.now ?? new Date().toISOString(),
    ...(input.detail ? { detail: input.detail } : {}),
  };
  const pushed = await appendAppliedLine(input.op, record as unknown as Record<string, unknown>, `Finished under ${input.gate}`, input.cwd ? { cwd: input.cwd } : undefined);
  return { record, ...pushed };
}

/** One request as the ledger holds it, joined with its approvals and its apply. */
export interface GatedRequestRead {
  op: string;
  gate: string;
  digest: string;
  request: GatedRequest;
  /** The newest pending fact that asked for it. */
  pending: PendingGateRecord;
  /** Approvals of its digest, oldest first. */
  approvals: GateResolutionRecord[];
  applied?: AppliedGateLine;
  finished?: FinishedGateRecord;
}

/** Every gated request of `op`, oldest first, with its approvals, applied and finished lines. Reads the local branch and never fetches. */
export async function readGatedRequests(op: string, location?: LedgerLocation): Promise<GatedRequestRead[]> {
  const { resolutions, pending } = await readGateLedger(op, location);
  const { applied, finished } = await readAppliedFile(op, location);
  const byDigest = new Map<string, PendingGateRecord>();
  for (const p of pending) if (p.request && p.planDigest) byDigest.set(`${p.gate}\u0000${p.planDigest}`, p);
  return [...byDigest.values()]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .map((p) => {
      const digest = p.planDigest!;
      const line = applied.filter((a) => a.gate === p.gate && samePlanDigest(a.planDigest, digest)).at(-1);
      const done = line ? finishedApply(finished, line) : undefined;
      return {
        op,
        gate: p.gate,
        digest,
        request: p.request!,
        pending: p,
        approvals: resolutions.filter((r) => r.gate === p.gate && samePlanDigest(r.planDigest, digest)),
        ...(line ? { applied: line } : {}),
        ...(done ? { finished: done } : {}),
      };
    });
}
